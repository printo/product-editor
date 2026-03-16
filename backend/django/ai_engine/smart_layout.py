"""
AI-Enhanced Layout Engine with Advanced Product Detection
Provides smart image placement and product detection (upgraded from face detection)
"""
import cv2
import numpy as np
from PIL import Image
from typing import List, Tuple, Optional
import logging
from datetime import datetime
from .model_manager import get_model_manager
from .background_removal import get_background_remover
from .product_detection import get_product_detector, DetectedProduct
from .design_placement import get_design_placer
from .blend_engine import get_blend_engine, BlendMode, BlendSettings

logger = logging.getLogger(__name__)


class SmartLayoutEngine:
    """AI-enhanced layout engine with product detection and smart processing"""
    
    def __init__(self):
        # Upgraded AI capabilities (replaces basic face detection)
        self.model_manager = get_model_manager()
        self.background_remover = get_background_remover()
        self.product_detector = get_product_detector()
        self.design_placer = get_design_placer()
        self.blend_engine = get_blend_engine()
        self.ai_enabled = True
        
        logger.info("Smart Layout Engine upgraded with AI product detection and blending")
    
    def detect_products(self, image_path: str) -> List[DetectedProduct]:
        """
        Detect products in an image (replaces detect_faces)
        Returns list of detected products with bounding boxes and confidence
        """
        if not self.ai_enabled:
            return []
        
        try:
            return self.product_detector.detect_products(image_path)
        except Exception as e:
            logger.error(f"Product detection error: {e}")
            return []
    
    def get_product_placement_point(self, image_path: str) -> Tuple[float, float]:
        """
        Get the optimal placement point for designs (replaces get_image_focus_point)
        Returns (x_ratio, y_ratio) where 0.5, 0.5 is center
        """
        products = self.detect_products(image_path)
        
        if products:
            # Focus on the first (highest confidence) product
            product = products[0]
            
            # Get image dimensions
            img = cv2.imread(image_path)
            img_h, img_w = img.shape[:2]
            
            # Calculate product center as ratio
            center_x, center_y = product.center_point
            placement_x = center_x / img_w
            placement_y = center_y / img_h
            
            return (placement_x, placement_y)
        
        # Default to center if no products detected
        return (0.5, 0.5)
    
    def smart_process_and_place(self, image_path: str, target_width: int, target_height: int, 
                               remove_bg: bool = False) -> Image.Image:
        """
        Smart process and place image with optional background removal (upgraded from smart_crop_and_resize)
        """
        # Remove background if requested
        processed_path = image_path
        if remove_bg:
            result = self.background_remover.remove_background(image_path)
            if result.success:
                processed_path = result.processed_image_path
        
        img = Image.open(processed_path).convert("RGB")
        original_width, original_height = img.size
        
        # Get optimal placement point (replaces focus point)
        placement_x, placement_y = self.get_product_placement_point(processed_path)
        
        # Calculate target aspect ratio
        target_ratio = target_width / target_height
        original_ratio = original_width / original_height
        
        if original_ratio > target_ratio:
            # Image is wider - crop width
            new_width = int(original_height * target_ratio)
            
            # Calculate crop position based on placement point
            placement_pixel_x = int(placement_x * original_width)
            crop_start_x = max(0, min(
                placement_pixel_x - new_width // 2,
                original_width - new_width
            ))
            
            img = img.crop((crop_start_x, 0, crop_start_x + new_width, original_height))
        
        elif original_ratio < target_ratio:
            # Image is taller - crop height
            new_height = int(original_width / target_ratio)
            
            # Calculate crop position based on placement point
            placement_pixel_y = int(placement_y * original_height)
            crop_start_y = max(0, min(
                placement_pixel_y - new_height // 2,
                original_height - new_height
            ))
            
            img = img.crop((0, crop_start_y, original_width, crop_start_y + new_height))
        
        # Resize to target dimensions
        img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
        
        return img
    
    def analyze_image_content(self, image_path: str) -> dict:
        """
        Analyze image content and return metadata (upgraded with product detection)
        """
        products = self.detect_products(image_path)
        placement_x, placement_y = self.get_product_placement_point(image_path)
        
        # Get image properties
        img = Image.open(image_path)
        width, height = img.size
        
        return {
            'has_products': len(products) > 0,
            'product_count': len(products),
            'detected_categories': [p.category for p in products],
            'highest_confidence': max([p.confidence for p in products]) if products else 0.0,
            'placement_point': (placement_x, placement_y),
            'aspect_ratio': width / height,
            'is_portrait': height > width,
            'is_landscape': width > height,
            'dimensions': (width, height),
            'products': [
                {
                    'category': p.category,
                    'confidence': p.confidence,
                    'center': p.center_point,
                    'bbox': (p.bounding_box.x, p.bounding_box.y, 
                            p.bounding_box.width, p.bounding_box.height)
                } for p in products
            ]
        }
    
    def optimize_image_placement(self, images: List[str], frames: List[dict]) -> List[Tuple[str, dict]]:
        """
        Optimize which image goes in which frame based on product analysis (upgraded)
        Returns list of (image_path, frame) tuples
        """
        if len(images) != len(frames):
            # Simple assignment if counts don't match
            return list(zip(images, frames))
        
        # Analyze all images for products
        image_analysis = []
        for img_path in images:
            analysis = self.analyze_image_content(img_path)
            image_analysis.append((img_path, analysis))
        
        # Analyze all frames
        frame_analysis = []
        for frame in frames:
            frame_ratio = frame['width'] / frame['height']
            frame_analysis.append({
                'frame': frame,
                'aspect_ratio': frame_ratio,
                'is_portrait': frame_ratio < 1.0,
                'is_landscape': frame_ratio > 1.0
            })
        
        # Enhanced optimization: match products to appropriate frames
        assignments = []
        used_frames = set()
        
        # First pass: match images with products to portrait frames
        for img_path, img_data in image_analysis:
            if img_data['has_products'] and img_data['is_portrait']:
                for i, frame_data in enumerate(frame_analysis):
                    if i not in used_frames and frame_data['is_portrait']:
                        assignments.append((img_path, frame_data['frame']))
                        used_frames.add(i)
                        break
        
        # Second pass: match landscape product images to landscape frames
        remaining_images = [
            (img_path, img_data) for img_path, img_data in image_analysis
            if not any(img_path == assigned[0] for assigned in assignments)
        ]
        
        for img_path, img_data in remaining_images:
            if img_data['has_products'] and img_data['is_landscape']:
                for i, frame_data in enumerate(frame_analysis):
                    if i not in used_frames and frame_data['is_landscape']:
                        assignments.append((img_path, frame_data['frame']))
                        used_frames.add(i)
                        break
        
        # Third pass: assign remaining images to remaining frames
        remaining_images = [
            (img_path, img_data) for img_path, img_data in image_analysis
            if not any(img_path == assigned[0] for assigned in assignments)
        ]
        
        for img_path, img_data in remaining_images:
            for i, frame_data in enumerate(frame_analysis):
                if i not in used_frames:
                    assignments.append((img_path, frame_data['frame']))
                    used_frames.add(i)
                    break
        
        return assignments


# Global instance
smart_engine = SmartLayoutEngine()


def get_smart_engine() -> SmartLayoutEngine:
    """Get the global smart layout engine instance"""
    return smart_engine
    
    def create_realistic_preview(self, design_path: str, product_path: str, 
                               blend_mode: str = "multiply", opacity: float = 0.8) -> Image.Image:
        """
        Create realistic preview with design placed on product using blending
        
        Args:
            design_path: Path to design image
            product_path: Path to product image
            blend_mode: Blend mode to use ("opacity", "multiply", "overlay", "soft_light")
            opacity: Blend opacity (0.0 to 1.0)
            
        Returns:
            PIL Image with realistic preview
        """
        try:
            # Detect products in the product image
            products = self.detect_products(product_path)
            
            if not products:
                logger.warning("No products detected for realistic preview")
                # Return simple overlay as fallback
                design = Image.open(design_path)
                product = Image.open(product_path)
                return self.blend_engine.blend_design(
                    design, product, BlendMode.OPACITY, opacity
                )
            
            # Use the highest confidence product
            main_product = products[0]
            
            # Load images
            design = Image.open(design_path)
            product = Image.open(product_path)
            
            # Calculate design placement
            placement_result = self.design_placer.calculate_placement(
                design, main_product.bounding_box, main_product.category
            )
            
            # Apply perspective transformation
            transformed_design = self.design_placer.apply_perspective_transform(
                design, placement_result.transform_matrix
            )
            
            # Create blend settings
            blend_settings = BlendSettings(
                mode=BlendMode(blend_mode),
                opacity=opacity,
                preserve_colors=True,
                texture_intensity=0.8,
                quality_level="export"
            )
            
            # Generate realistic blend
            result = self.blend_engine.preview_blend(
                transformed_design, product, blend_settings
            )
            
            return result
            
        except Exception as e:
            logger.error(f"Realistic preview generation failed: {e}")
            # Fallback to simple blend
            design = Image.open(design_path)
            product = Image.open(product_path)
            return self.blend_engine.blend_design(
                design, product, BlendMode.OPACITY, 0.5
            )
    
    def generate_blend_preview(self, design: Image.Image, background: Image.Image,
                             settings: BlendSettings) -> Image.Image:
        """
        Generate real-time blend preview for UI
        
        Args:
            design: Design image
            background: Background/product image
            settings: Blend settings
            
        Returns:
            Preview image with blending applied
        """
        return self.blend_engine.preview_blend(design, background, settings)
    
    def get_recommended_blend_settings(self, product_category: str) -> BlendSettings:
        """
        Get recommended blend settings for a product category
        
        Args:
            product_category: Type of product (shirt, hoodie, hat, etc.)
            
        Returns:
            Recommended BlendSettings for the product type
        """
        recommendations = {
            'shirt': BlendSettings(
                mode=BlendMode.MULTIPLY,
                opacity=0.85,
                preserve_colors=True,
                texture_intensity=0.9,
                quality_level="export"
            ),
            'hoodie': BlendSettings(
                mode=BlendMode.MULTIPLY,
                opacity=0.8,
                preserve_colors=True,
                texture_intensity=0.8,
                quality_level="export"
            ),
            'hat': BlendSettings(
                mode=BlendMode.OVERLAY,
                opacity=0.75,
                preserve_colors=True,
                texture_intensity=0.7,
                quality_level="export"
            ),
            'bag': BlendSettings(
                mode=BlendMode.MULTIPLY,
                opacity=0.9,
                preserve_colors=True,
                texture_intensity=0.85,
                quality_level="export"
            ),
            'jacket': BlendSettings(
                mode=BlendMode.MULTIPLY,
                opacity=0.8,
                preserve_colors=True,
                texture_intensity=0.8,
                quality_level="export"
            )
        }
        
        return recommendations.get(product_category, recommendations['shirt'])
    
    def process_design_for_product(self, design_path: str, product_path: str,
                                 remove_bg: bool = True, 
                                 blend_mode: str = "multiply") -> dict:
        """
        Complete AI processing pipeline for design placement on product
        
        Args:
            design_path: Path to design image
            product_path: Path to product image  
            remove_bg: Whether to remove background from design
            blend_mode: Blend mode for realistic preview
            
        Returns:
            Dictionary with processing results and preview image
        """
        try:
            results = {
                'success': False,
                'processed_design_path': None,
                'detected_products': [],
                'placement_result': None,
                'preview_image': None,
                'blend_settings': None,
                'processing_time': 0.0
            }
            
            start_time = datetime.now()
            
            # Step 1: Remove background if requested
            processed_design_path = design_path
            if remove_bg:
                bg_result = self.background_remover.remove_background(design_path)
                if bg_result.success:
                    processed_design_path = bg_result.processed_image_path
                    results['processed_design_path'] = processed_design_path
            
            # Step 2: Detect products in product image
            products = self.detect_products(product_path)
            results['detected_products'] = [
                {
                    'category': p.category,
                    'confidence': p.confidence,
                    'center': p.center_point,
                    'bbox': (p.bounding_box.x, p.bounding_box.y, 
                            p.bounding_box.width, p.bounding_box.height)
                } for p in products
            ]
            
            if products:
                # Step 3: Calculate design placement
                main_product = products[0]
                design = Image.open(processed_design_path)
                
                placement_result = self.design_placer.calculate_placement(
                    design, main_product.bounding_box, main_product.category
                )
                results['placement_result'] = {
                    'confidence': placement_result.confidence,
                    'fallback_used': placement_result.fallback_used,
                    'recommended_blend_mode': placement_result.recommended_blend_mode
                }
                
                # Step 4: Generate realistic preview
                blend_settings = self.get_recommended_blend_settings(main_product.category)
                if blend_mode != "multiply":
                    blend_settings.mode = BlendMode(blend_mode)
                
                results['blend_settings'] = {
                    'mode': blend_settings.mode.value,
                    'opacity': blend_settings.opacity,
                    'preserve_colors': blend_settings.preserve_colors,
                    'texture_intensity': blend_settings.texture_intensity
                }
                
                preview = self.create_realistic_preview(
                    processed_design_path, product_path, 
                    blend_settings.mode.value, blend_settings.opacity
                )
                results['preview_image'] = preview
                
                results['success'] = True
            
            processing_time = (datetime.now() - start_time).total_seconds()
            results['processing_time'] = processing_time
            
            return results
            
        except Exception as e:
            logger.error(f"Complete AI processing failed: {e}")
            return {
                'success': False,
                'error': str(e),
                'processing_time': 0.0
            }