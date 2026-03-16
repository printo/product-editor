"""
Product Detection Service using YOLO
Replaces basic face detection with comprehensive product detection
Enhanced with comprehensive failure handling and graceful degradation
"""
import os
import cv2
import numpy as np
import logging
from PIL import Image
from typing import List, Tuple, Optional
from dataclasses import dataclass
from datetime import datetime
from .model_manager import get_model_manager
from .failure_handler import get_failure_handler
from .background_processor import get_background_processor, JobPriority

logger = logging.getLogger(__name__)


@dataclass
class BoundingBox:
    """Bounding box coordinates"""
    x: int
    y: int
    width: int
    height: int
    
    def center(self) -> Tuple[int, int]:
        """Get center point of bounding box"""
        return (self.x + self.width // 2, self.y + self.height // 2)


@dataclass
class DetectedProduct:
    """Detected product information"""
    category: str
    confidence: float
    bounding_box: BoundingBox
    center_point: Tuple[int, int]
    orientation_angle: float
    surface_normal: Optional[Tuple[float, float, float]] = None


class ProductDetectionService:
    """Service for detecting products in lifestyle photos using YOLO"""
    
    def __init__(self):
        self.model_manager = get_model_manager()
        self.failure_handler = get_failure_handler()
        self.background_processor = get_background_processor()
        self.supported_categories = ['shirt', 'hoodie', 'hat', 'bag', 't-shirt', 'jacket']
        self.confidence_threshold = 0.5
        
        # Register background processing function
        self.background_processor.register_service_function(
            'product_detection', 'detect_products_bg', self._detect_products_internal
        )
    
    @get_failure_handler().with_failure_handling('product_detection', timeout=10)
    def detect_products(self, image_path: str, background_processing: bool = False, 
                       user_id: str = None) -> List[DetectedProduct]:
        """
        Detect products in image using YOLO model
        
        Args:
            image_path: Path to input image
            background_processing: If True, queue for background processing on timeout
            user_id: User ID for background job tracking
            
        Returns:
            List of detected products with confidence > 0.5
        """
        # If background processing is requested and service is overloaded, queue immediately
        if background_processing and not self.is_available():
            # For detection, we return empty list and provide manual override options
            logger.warning(f"Product detection unavailable, providing manual override options")
            return []
        
        return self._detect_products_internal(image_path)
    
    def _detect_products_internal(self, image_path: str) -> List[DetectedProduct]:
        """
        Internal product detection implementation
        
        Args:
            image_path: Path to input image
            
        Returns:
            List of detected products with confidence > 0.5
        """
        try:
            if not os.path.exists(image_path):
                raise FileNotFoundError(f"Input image not found: {image_path}")
            
            # Load YOLO model
            model = self.model_manager.load_model("yolo")
            
            # Run detection
            results = model(image_path)
            
            detected_products = []
            
            # Process results
            for result in results:
                boxes = result.boxes
                if boxes is not None:
                    for box in boxes:
                        # Get detection data
                        confidence = float(box.conf[0])
                        class_id = int(box.cls[0])
                        
                        # Filter by confidence threshold
                        if confidence < self.confidence_threshold:
                            continue
                        
                        # Get class name
                        class_name = model.names[class_id].lower()
                        
                        # Filter by supported categories
                        if not any(cat in class_name for cat in self.supported_categories):
                            continue
                        
                        # Get bounding box coordinates
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        bbox = BoundingBox(
                            x=int(x1),
                            y=int(y1),
                            width=int(x2 - x1),
                            height=int(y2 - y1)
                        )
                        
                        # Calculate orientation (simplified)
                        orientation = self._estimate_orientation(bbox)
                        
                        detected_product = DetectedProduct(
                            category=self._normalize_category(class_name),
                            confidence=confidence,
                            bounding_box=bbox,
                            center_point=bbox.center(),
                            orientation_angle=orientation
                        )
                        
                        detected_products.append(detected_product)
            
            # Sort by confidence (highest first)
            detected_products.sort(key=lambda x: x.confidence, reverse=True)
            
            logger.info(f"Detected {len(detected_products)} products in {image_path}")
            return detected_products
            
        except Exception as e:
            logger.error(f"Product detection failed for {image_path}: {str(e)}")
            return []
    
    def _normalize_category(self, class_name: str) -> str:
        """Normalize detected class name to standard categories"""
        class_name = class_name.lower()
        
        if any(term in class_name for term in ['shirt', 't-shirt', 'tshirt']):
            return 'shirt'
        elif 'hoodie' in class_name or 'sweatshirt' in class_name:
            return 'hoodie'
        elif 'hat' in class_name or 'cap' in class_name:
            return 'hat'
        elif 'bag' in class_name or 'backpack' in class_name:
            return 'bag'
        elif 'jacket' in class_name:
            return 'jacket'
        else:
            return class_name
    
    def _estimate_orientation(self, bbox: BoundingBox) -> float:
        """Estimate product orientation angle (simplified)"""
        # Simple heuristic based on aspect ratio
        aspect_ratio = bbox.width / bbox.height
        
        if aspect_ratio > 1.2:
            return 0.0  # Horizontal orientation
        elif aspect_ratio < 0.8:
            return 90.0  # Vertical orientation
        else:
            return 0.0  # Default to horizontal
    
    def get_supported_categories(self) -> List[str]:
        """Return list of detectable product types"""
        return self.supported_categories.copy()
    
    def is_available(self) -> bool:
        """Check if product detection service is available"""
        try:
            status = self.model_manager.get_model_status("yolo")
            return status.is_healthy and not self.failure_handler._is_circuit_open('product_detection')
        except:
            return False
    
    def get_manual_override_options(self) -> dict:
        """Get manual override options for product detection"""
        return {
            'available': True,
            'options': [
                {
                    'name': 'manual_selection',
                    'display_name': 'Manual Product Selection',
                    'description': 'Manually draw bounding boxes around products in the image',
                    'tools_required': ['rectangle_tool', 'selection_tool'],
                    'instructions': [
                        'Click and drag to draw a rectangle around each product',
                        'Select the product category from the dropdown',
                        'Adjust the bounding box if needed'
                    ]
                },
                {
                    'name': 'predefined_areas',
                    'display_name': 'Use Predefined Product Areas',
                    'description': 'Choose from common product placement areas',
                    'tools_required': [],
                    'options': [
                        {'name': 'center_shirt', 'display': 'Center Shirt Area', 'bounds': {'x': 0.2, 'y': 0.15, 'width': 0.6, 'height': 0.4}},
                        {'name': 'left_chest', 'display': 'Left Chest Area', 'bounds': {'x': 0.1, 'y': 0.2, 'width': 0.3, 'height': 0.25}},
                        {'name': 'full_front', 'display': 'Full Front Area', 'bounds': {'x': 0.15, 'y': 0.1, 'width': 0.7, 'height': 0.6}}
                    ]
                },
                {
                    'name': 'skip_detection',
                    'display_name': 'Skip Product Detection',
                    'description': 'Continue without product detection and place designs manually',
                    'tools_required': []
                }
            ],
            'tutorials': [
                {
                    'title': 'Manual Product Selection Guide',
                    'url': '/help/manual-product-selection',
                    'duration': '3 minutes'
                }
            ]
        }
    
    def create_manual_product(self, category: str, bounds: dict, confidence: float = 0.8) -> DetectedProduct:
        """Create a manually defined product detection result"""
        bbox = BoundingBox(
            x=int(bounds['x']),
            y=int(bounds['y']),
            width=int(bounds['width']),
            height=int(bounds['height'])
        )
        
        return DetectedProduct(
            category=self._normalize_category(category),
            confidence=confidence,
            bounding_box=bbox,
            center_point=bbox.center(),
            orientation_angle=0.0  # Default orientation for manual selection
        )
    
    def get_detection_suggestions(self, image_path: str) -> dict:
        """Provide suggestions for manual product detection based on image analysis"""
        try:
            # Basic image analysis without AI
            img = Image.open(image_path)
            width, height = img.size
            aspect_ratio = width / height
            
            suggestions = {
                'image_info': {
                    'width': width,
                    'height': height,
                    'aspect_ratio': aspect_ratio,
                    'orientation': 'landscape' if aspect_ratio > 1 else 'portrait'
                },
                'suggested_areas': []
            }
            
            # Suggest common product areas based on image orientation
            if aspect_ratio > 1:  # Landscape
                suggestions['suggested_areas'] = [
                    {
                        'name': 'center_product',
                        'category': 'shirt',
                        'bounds': {'x': width * 0.3, 'y': height * 0.2, 'width': width * 0.4, 'height': height * 0.5},
                        'confidence': 0.7,
                        'reason': 'Common center placement for landscape images'
                    }
                ]
            else:  # Portrait
                suggestions['suggested_areas'] = [
                    {
                        'name': 'upper_center',
                        'category': 'shirt',
                        'bounds': {'x': width * 0.2, 'y': height * 0.15, 'width': width * 0.6, 'height': height * 0.4},
                        'confidence': 0.8,
                        'reason': 'Common shirt area for portrait images'
                    },
                    {
                        'name': 'hat_area',
                        'category': 'hat',
                        'bounds': {'x': width * 0.25, 'y': height * 0.05, 'width': width * 0.5, 'height': height * 0.2},
                        'confidence': 0.6,
                        'reason': 'Potential hat area at top of image'
                    }
                ]
            
            return suggestions
            
        except Exception as e:
            logger.error(f"Failed to generate detection suggestions: {e}")
            return {
                'image_info': {},
                'suggested_areas': [],
                'error': str(e)
            }


# Global instance
_product_detector = None

def get_product_detector() -> ProductDetectionService:
    """Get the global product detection service instance"""
    global _product_detector
    if _product_detector is None:
        _product_detector = ProductDetectionService()
    return _product_detector