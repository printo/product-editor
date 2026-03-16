"""
Blend Engine for Realistic Design Blending
Provides opacity and multiply blend modes for realistic texture integration
"""
import cv2
import numpy as np
from PIL import Image, ImageEnhance
from enum import Enum
from typing import Optional
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)


class BlendMode(Enum):
    """Available blend modes"""
    OPACITY = "opacity"
    MULTIPLY = "multiply"
    OVERLAY = "overlay"
    SOFT_LIGHT = "soft_light"


@dataclass
class BlendSettings:
    """Settings for blending operation"""
    mode: BlendMode
    opacity: float  # 0.0 to 1.0
    preserve_colors: bool = True
    texture_intensity: float = 0.8  # 0.0 to 1.0
    quality_level: str = "export"  # "preview" or "export"


class BlendEngine:
    """Engine for blending designs with product textures"""
    
    def __init__(self):
        self.supported_modes = [BlendMode.OPACITY, BlendMode.MULTIPLY, 
                               BlendMode.OVERLAY, BlendMode.SOFT_LIGHT]
    
    def blend_design(self, design: Image.Image, background: Image.Image, 
                    mode: BlendMode, opacity: float) -> Image.Image:
        """
        Blend design with product texture
        
        Args:
            design: Design image to blend
            background: Product/texture image
            mode: Blend mode to use
            opacity: Blend opacity (0.0 to 1.0)
            
        Returns:
            Blended image showing design with texture
        """
        try:
            # Validate inputs
            if not 0.0 <= opacity <= 1.0:
                raise ValueError(f"Opacity must be between 0.0 and 1.0, got {opacity}")
            
            if mode not in self.supported_modes:
                raise ValueError(f"Unsupported blend mode: {mode}")
            
            # Ensure images are the same size
            if design.size != background.size:
                background = background.resize(design.size, Image.Resampling.LANCZOS)
            
            # Convert to RGBA for proper blending
            design_rgba = design.convert('RGBA')
            background_rgba = background.convert('RGBA')
            
            # Apply blend mode
            if mode == BlendMode.OPACITY:
                result = self._blend_opacity(design_rgba, background_rgba, opacity)
            elif mode == BlendMode.MULTIPLY:
                result = self._blend_multiply(design_rgba, background_rgba, opacity)
            elif mode == BlendMode.OVERLAY:
                result = self._blend_overlay(design_rgba, background_rgba, opacity)
            elif mode == BlendMode.SOFT_LIGHT:
                result = self._blend_soft_light(design_rgba, background_rgba, opacity)
            else:
                result = self._blend_opacity(design_rgba, background_rgba, opacity)
            
            return result
            
        except Exception as e:
            logger.error(f"Blend operation failed: {e}")
            # Return original design as fallback
            return design
    
    def preview_blend(self, design: Image.Image, background: Image.Image, 
                     settings: BlendSettings) -> Image.Image:
        """
        Generate real-time blend preview with optimized settings
        
        Args:
            design: Design image
            background: Product texture image
            settings: Blend settings configuration
            
        Returns:
            Preview image with applied blending
        """
        try:
            # Optimize for preview performance
            if settings.quality_level == "preview":
                # Reduce size for faster preview
                max_preview_size = 800
                if max(design.size) > max_preview_size:
                    ratio = max_preview_size / max(design.size)
                    new_size = (int(design.width * ratio), int(design.height * ratio))
                    design = design.resize(new_size, Image.Resampling.LANCZOS)
                    background = background.resize(new_size, Image.Resampling.LANCZOS)
            
            # Apply texture intensity adjustment
            if settings.texture_intensity != 1.0:
                background = self._adjust_texture_intensity(background, settings.texture_intensity)
            
            # Perform blending
            result = self.blend_design(design, background, settings.mode, settings.opacity)
            
            # Preserve design colors if requested
            if settings.preserve_colors:
                result = self._preserve_design_colors(design, result, 0.8)
            
            return result
            
        except Exception as e:
            logger.error(f"Preview blend failed: {e}")
            return design
    
    def _blend_opacity(self, design: Image.Image, background: Image.Image, 
                      opacity: float) -> Image.Image:
        """Simple opacity blending"""
        # Convert to numpy arrays
        design_array = np.array(design, dtype=np.float32)
        background_array = np.array(background, dtype=np.float32)
        
        # Apply opacity blending
        result_array = design_array * opacity + background_array * (1 - opacity)
        
        # Convert back to PIL
        result_array = np.clip(result_array, 0, 255).astype(np.uint8)
        return Image.fromarray(result_array, 'RGBA')
    
    def _blend_multiply(self, design: Image.Image, background: Image.Image, 
                       opacity: float) -> Image.Image:
        """Multiply blend mode - shows texture through design"""
        # Convert to numpy arrays (0-1 range for multiply)
        design_array = np.array(design, dtype=np.float32) / 255.0
        background_array = np.array(background, dtype=np.float32) / 255.0
        
        # Multiply blend
        multiplied = design_array * background_array
        
        # Mix with original design based on opacity
        result_array = design_array * (1 - opacity) + multiplied * opacity
        
        # Convert back to PIL
        result_array = np.clip(result_array * 255, 0, 255).astype(np.uint8)
        return Image.fromarray(result_array, 'RGBA')
    
    def _blend_overlay(self, design: Image.Image, background: Image.Image, 
                      opacity: float) -> Image.Image:
        """Overlay blend mode"""
        design_array = np.array(design, dtype=np.float32) / 255.0
        background_array = np.array(background, dtype=np.float32) / 255.0
        
        # Overlay formula
        mask = background_array < 0.5
        overlay = np.where(
            mask,
            2 * design_array * background_array,
            1 - 2 * (1 - design_array) * (1 - background_array)
        )
        
        # Mix with original design
        result_array = design_array * (1 - opacity) + overlay * opacity
        
        result_array = np.clip(result_array * 255, 0, 255).astype(np.uint8)
        return Image.fromarray(result_array, 'RGBA')
    
    def _blend_soft_light(self, design: Image.Image, background: Image.Image, 
                         opacity: float) -> Image.Image:
        """Soft light blend mode"""
        design_array = np.array(design, dtype=np.float32) / 255.0
        background_array = np.array(background, dtype=np.float32) / 255.0
        
        # Soft light formula (simplified)
        mask = design_array < 0.5
        soft_light = np.where(
            mask,
            background_array - (1 - 2 * design_array) * background_array * (1 - background_array),
            background_array + (2 * design_array - 1) * (np.sqrt(background_array) - background_array)
        )
        
        # Mix with original design
        result_array = design_array * (1 - opacity) + soft_light * opacity
        
        result_array = np.clip(result_array * 255, 0, 255).astype(np.uint8)
        return Image.fromarray(result_array, 'RGBA')
    
    def _adjust_texture_intensity(self, texture: Image.Image, intensity: float) -> Image.Image:
        """Adjust texture intensity for blending"""
        if intensity == 1.0:
            return texture
        
        # Enhance or reduce texture contrast
        enhancer = ImageEnhance.Contrast(texture)
        return enhancer.enhance(intensity)
    
    def _preserve_design_colors(self, original_design: Image.Image, 
                               blended: Image.Image, preservation: float) -> Image.Image:
        """Preserve original design colors while showing texture"""
        # Convert to numpy arrays
        original_array = np.array(original_design, dtype=np.float32)
        blended_array = np.array(blended, dtype=np.float32)
        
        # Mix to preserve colors
        preserved_array = blended_array * (1 - preservation) + original_array * preservation
        
        preserved_array = np.clip(preserved_array, 0, 255).astype(np.uint8)
        return Image.fromarray(preserved_array, 'RGBA')
    
    def get_supported_modes(self) -> list:
        """Get list of supported blend modes"""
        return [mode.value for mode in self.supported_modes]


# Global instance
_blend_engine = None

def get_blend_engine() -> BlendEngine:
    """Get the global blend engine instance"""
    global _blend_engine
    if _blend_engine is None:
        _blend_engine = BlendEngine()
    return _blend_engine