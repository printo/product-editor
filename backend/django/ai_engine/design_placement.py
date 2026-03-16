"""
Design Placement Service using OpenCV
Handles perspective transformation and intelligent design placement
"""
import cv2
import numpy as np
from PIL import Image
import logging
from typing import Tuple, Optional
from dataclasses import dataclass
from .product_detection import DetectedProduct, BoundingBox

logger = logging.getLogger(__name__)


@dataclass
class PlacementResult:
    """Result of design placement calculation"""
    transform_matrix: np.ndarray
    placement_bounds: BoundingBox
    confidence: float
    fallback_used: bool
    recommended_blend_mode: str


class DesignPlacementService:
    """Service for calculating optimal design placement and perspective transformation"""
    
    def __init__(self):
        self.min_confidence = 0.7
    
    def calculate_placement(self, design: Image.Image, product_bounds: BoundingBox, 
                          product_category: str = "shirt") -> PlacementResult:
        """
        Calculate optimal design placement and transformation matrix
        
        Args:
            design: PIL Image of the design to place
            product_bounds: Bounding box of detected product
            product_category: Type of product for placement optimization
            
        Returns:
            PlacementResult with transformation matrix and placement info
        """
        try:
            # Calculate design placement area within product bounds
            placement_bounds = self._calculate_design_area(product_bounds, product_category)
            
            # Calculate perspective transformation matrix
            transform_matrix = self._calculate_perspective_transform(
                design, placement_bounds, product_category
            )
            
            # Determine confidence based on product bounds size and aspect ratio
            confidence = self._calculate_placement_confidence(design, placement_bounds)
            
            # Recommend blend mode based on product type
            blend_mode = self._recommend_blend_mode(product_category)
            
            return PlacementResult(
                transform_matrix=transform_matrix,
                placement_bounds=placement_bounds,
                confidence=confidence,
                fallback_used=False,
                recommended_blend_mode=blend_mode
            )
            
        except Exception as e:
            logger.warning(f"Perspective calculation failed, using fallback: {e}")
            return self._fallback_placement(design, product_bounds, product_category)
    
    def apply_perspective_transform(self, design: Image.Image, 
                                  transform_matrix: np.ndarray) -> Image.Image:
        """
        Apply perspective transformation to design using OpenCV
        
        Args:
            design: PIL Image to transform
            transform_matrix: 3x3 transformation matrix
            
        Returns:
            Transformed PIL Image
        """
        try:
            # Convert PIL to OpenCV format
            design_cv = cv2.cvtColor(np.array(design), cv2.COLOR_RGB2BGR)
            
            # Get output dimensions from transform matrix
            h, w = design_cv.shape[:2]
            corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
            transformed_corners = cv2.perspectiveTransform(
                corners.reshape(-1, 1, 2), transform_matrix
            ).reshape(-1, 2)
            
            # Calculate output size
            x_coords = transformed_corners[:, 0]
            y_coords = transformed_corners[:, 1]
            output_w = int(np.ceil(x_coords.max() - x_coords.min()))
            output_h = int(np.ceil(y_coords.max() - y_coords.min()))
            
            # Apply perspective transformation
            transformed = cv2.warpPerspective(
                design_cv, transform_matrix, (output_w, output_h),
                flags=cv2.INTER_LANCZOS4,
                borderMode=cv2.BORDER_TRANSPARENT
            )
            
            # Convert back to PIL
            transformed_rgb = cv2.cvtColor(transformed, cv2.COLOR_BGR2RGB)
            return Image.fromarray(transformed_rgb)
            
        except Exception as e:
            logger.error(f"Perspective transform failed: {e}")
            # Return original design as fallback
            return design
    
    def _calculate_design_area(self, product_bounds: BoundingBox, 
                              product_category: str) -> BoundingBox:
        """Calculate the area within product bounds where design should be placed"""
        
        # Define placement ratios for different product types
        placement_ratios = {
            'shirt': {'x_offset': 0.2, 'y_offset': 0.15, 'width': 0.6, 'height': 0.4},
            'hoodie': {'x_offset': 0.25, 'y_offset': 0.2, 'width': 0.5, 'height': 0.35},
            'hat': {'x_offset': 0.15, 'y_offset': 0.3, 'width': 0.7, 'height': 0.4},
            'bag': {'x_offset': 0.2, 'y_offset': 0.2, 'width': 0.6, 'height': 0.6},
            'jacket': {'x_offset': 0.2, 'y_offset': 0.15, 'width': 0.6, 'height': 0.4}
        }
        
        ratios = placement_ratios.get(product_category, placement_ratios['shirt'])
        
        # Calculate design area within product bounds
        design_x = product_bounds.x + int(product_bounds.width * ratios['x_offset'])
        design_y = product_bounds.y + int(product_bounds.height * ratios['y_offset'])
        design_w = int(product_bounds.width * ratios['width'])
        design_h = int(product_bounds.height * ratios['height'])
        
        return BoundingBox(design_x, design_y, design_w, design_h)
    
    def _calculate_perspective_transform(self, design: Image.Image, 
                                       placement_bounds: BoundingBox,
                                       product_category: str) -> np.ndarray:
        """Calculate perspective transformation matrix"""
        
        design_w, design_h = design.size
        
        # Source points (corners of original design)
        src_points = np.array([
            [0, 0],
            [design_w, 0],
            [design_w, design_h],
            [0, design_h]
        ], dtype=np.float32)
        
        # Destination points (where design should be placed)
        # Add slight perspective distortion based on product type
        perspective_factors = {
            'shirt': 0.05,    # Slight curve for shirt surface
            'hoodie': 0.03,   # Less curve for thicker fabric
            'hat': 0.15,      # More curve for hat surface
            'bag': 0.08,      # Medium curve for bag surface
            'jacket': 0.04    # Slight curve for jacket
        }
        
        factor = perspective_factors.get(product_category, 0.05)
        
        # Calculate destination points with perspective
        x1, y1 = placement_bounds.x, placement_bounds.y
        x2, y2 = x1 + placement_bounds.width, y1 + placement_bounds.height
        
        # Add perspective distortion
        perspective_offset = int(placement_bounds.width * factor)
        
        dst_points = np.array([
            [x1 + perspective_offset, y1],
            [x2 - perspective_offset, y1],
            [x2, y2],
            [x1, y2]
        ], dtype=np.float32)
        
        # Calculate perspective transformation matrix
        return cv2.getPerspectiveTransform(src_points, dst_points)
    
    def _calculate_placement_confidence(self, design: Image.Image, 
                                      placement_bounds: BoundingBox) -> float:
        """Calculate confidence score for placement quality"""
        
        design_w, design_h = design.size
        design_ratio = design_w / design_h
        
        placement_ratio = placement_bounds.width / placement_bounds.height
        
        # Higher confidence for better aspect ratio match
        ratio_diff = abs(design_ratio - placement_ratio)
        ratio_confidence = max(0.0, 1.0 - ratio_diff)
        
        # Higher confidence for larger placement areas
        area_confidence = min(1.0, (placement_bounds.width * placement_bounds.height) / 10000)
        
        # Combined confidence
        return (ratio_confidence * 0.7 + area_confidence * 0.3)
    
    def _recommend_blend_mode(self, product_category: str) -> str:
        """Recommend blend mode based on product type"""
        
        blend_recommendations = {
            'shirt': 'multiply',      # Show fabric texture
            'hoodie': 'multiply',     # Show fabric texture
            'hat': 'overlay',         # Balance between design and material
            'bag': 'multiply',        # Show material texture
            'jacket': 'multiply'      # Show fabric texture
        }
        
        return blend_recommendations.get(product_category, 'multiply')
    
    def _fallback_placement(self, design: Image.Image, product_bounds: BoundingBox,
                           product_category: str) -> PlacementResult:
        """Fallback to simple scaling when perspective calculation fails"""
        
        # Simple identity matrix for no transformation
        transform_matrix = np.eye(3, dtype=np.float32)
        
        # Calculate simple centered placement
        design_w, design_h = design.size
        
        # Scale design to fit within product bounds with padding
        scale_factor = min(
            (product_bounds.width * 0.6) / design_w,
            (product_bounds.height * 0.4) / design_h
        )
        
        scaled_w = int(design_w * scale_factor)
        scaled_h = int(design_h * scale_factor)
        
        # Center within product bounds
        center_x = product_bounds.x + product_bounds.width // 2
        center_y = product_bounds.y + int(product_bounds.height * 0.3)
        
        placement_x = center_x - scaled_w // 2
        placement_y = center_y - scaled_h // 2
        
        placement_bounds = BoundingBox(placement_x, placement_y, scaled_w, scaled_h)
        
        return PlacementResult(
            transform_matrix=transform_matrix,
            placement_bounds=placement_bounds,
            confidence=0.5,  # Lower confidence for fallback
            fallback_used=True,
            recommended_blend_mode=self._recommend_blend_mode(product_category)
        )


# Global instance
_design_placer = None

def get_design_placer() -> DesignPlacementService:
    """Get the global design placement service instance"""
    global _design_placer
    if _design_placer is None:
        _design_placer = DesignPlacementService()
    return _design_placer