"""
Comprehensive Image Format Handler
Supports JPEG, PNG, WebP, TIFF with transparency handling and format conversion
"""
import os
import logging
from typing import Optional, Dict, Any, Tuple, List
from dataclasses import dataclass
from PIL import Image, ImageFile
from PIL.ExifTags import TAGS
import io

logger = logging.getLogger(__name__)

# Enable loading of truncated images
ImageFile.LOAD_TRUNCATED_IMAGES = True


@dataclass
class ImageInfo:
    """Information about an image file"""
    format: str
    mode: str
    size: Tuple[int, int]
    has_transparency: bool
    file_size_mb: float
    color_profile: Optional[str]
    exif_data: Dict[str, Any]
    is_animated: bool
    frame_count: int


class ImageFormatHandler:
    """Handles multiple image formats with transparency and quality preservation"""
    
    # Supported formats with their characteristics
    SUPPORTED_FORMATS = {
        'JPEG': {
            'extensions': ['.jpg', '.jpeg', '.jpe', '.jfif'],
            'supports_transparency': False,
            'supports_animation': False,
            'quality_param': 'quality',
            'default_quality': 85
        },
        'PNG': {
            'extensions': ['.png'],
            'supports_transparency': True,
            'supports_animation': False,
            'quality_param': 'compress_level',
            'default_quality': 6
        },
        'WEBP': {
            'extensions': ['.webp'],
            'supports_transparency': True,
            'supports_animation': True,
            'quality_param': 'quality',
            'default_quality': 80
        },
        'TIFF': {
            'extensions': ['.tiff', '.tif'],
            'supports_transparency': True,
            'supports_animation': False,
            'quality_param': 'compression',
            'default_quality': 'lzw'
        }
    }
    
    MAX_FILE_SIZE_MB = 50
    MAX_DIMENSION = 8192  # Maximum width or height
    
    def __init__(self):
        logger.info("Image Format Handler initialized")
    
    def validate_image(self, image_path: str) -> Tuple[bool, str, Optional[ImageInfo]]:
        """
        Validate image file format, size, and characteristics
        
        Returns:
            (is_valid, error_message, image_info)
        """
        try:
            # Check file existence
            if not os.path.exists(image_path):
                return False, "Image file not found", None
            
            # Check file size
            file_size_bytes = os.path.getsize(image_path)
            file_size_mb = file_size_bytes / (1024 * 1024)
            
            if file_size_mb > self.MAX_FILE_SIZE_MB:
                return False, f"Image file too large: {file_size_mb:.1f}MB (max: {self.MAX_FILE_SIZE_MB}MB)", None
            
            # Try to open and analyze the image
            with Image.open(image_path) as img:
                # Check format support
                if img.format not in self.SUPPORTED_FORMATS:
                    return False, f"Unsupported image format: {img.format}", None
                
                # Check dimensions
                width, height = img.size
                if width > self.MAX_DIMENSION or height > self.MAX_DIMENSION:
                    return False, f"Image dimensions too large: {width}x{height} (max: {self.MAX_DIMENSION})", None
                
                # Get image information
                image_info = self._extract_image_info(img, image_path, file_size_mb)
                
                return True, "Image is valid", image_info
                
        except Exception as e:
            return False, f"Invalid image file: {str(e)}", None
    
    def _extract_image_info(self, img: Image.Image, image_path: str, file_size_mb: float) -> ImageInfo:
        """Extract comprehensive information about an image"""
        
        # Check for transparency
        has_transparency = False
        if img.mode in ('RGBA', 'LA'):
            has_transparency = True
        elif img.mode == 'P' and 'transparency' in img.info:
            has_transparency = True
        elif 'transparency' in img.info:
            has_transparency = True
        
        # Extract EXIF data
        exif_data = {}
        try:
            if hasattr(img, '_getexif') and img._getexif() is not None:
                exif = img._getexif()
                for tag_id, value in exif.items():
                    tag = TAGS.get(tag_id, tag_id)
                    exif_data[tag] = value
        except Exception:
            pass
        
        # Check for animation
        is_animated = False
        frame_count = 1
        try:
            if hasattr(img, 'is_animated'):
                is_animated = img.is_animated
                frame_count = getattr(img, 'n_frames', 1)
        except Exception:
            pass
        
        # Get color profile
        color_profile = None
        try:
            if 'icc_profile' in img.info:
                color_profile = 'ICC'
            elif img.mode == 'CMYK':
                color_profile = 'CMYK'
            elif img.mode in ('RGB', 'RGBA'):
                color_profile = 'RGB'
        except Exception:
            pass
        
        return ImageInfo(
            format=img.format,
            mode=img.mode,
            size=img.size,
            has_transparency=has_transparency,
            file_size_mb=file_size_mb,
            color_profile=color_profile,
            exif_data=exif_data,
            is_animated=is_animated,
            frame_count=frame_count
        )
    
    def convert_format(self, input_path: str, output_path: str, target_format: str,
                      quality: Optional[int] = None, preserve_transparency: bool = True,
                      preserve_metadata: bool = True) -> Tuple[bool, str]:
        """
        Convert image to target format with quality and transparency preservation
        
        Args:
            input_path: Path to input image
            output_path: Path for output image
            target_format: Target format (JPEG, PNG, WEBP, TIFF)
            quality: Quality setting (format-specific)
            preserve_transparency: Whether to preserve transparency
            preserve_metadata: Whether to preserve EXIF and other metadata
            
        Returns:
            (success, error_message)
        """
        try:
            # Validate input
            is_valid, error_msg, image_info = self.validate_image(input_path)
            if not is_valid:
                return False, error_msg
            
            # Check target format support
            if target_format not in self.SUPPORTED_FORMATS:
                return False, f"Unsupported target format: {target_format}"
            
            format_info = self.SUPPORTED_FORMATS[target_format]
            
            with Image.open(input_path) as img:
                # Handle transparency
                converted_img = self._handle_transparency_conversion(
                    img, target_format, preserve_transparency
                )
                
                # Prepare save parameters
                save_kwargs = {}
                
                # Set quality parameters
                if quality is not None:
                    if target_format == 'JPEG':
                        save_kwargs['quality'] = min(100, max(1, quality))
                        save_kwargs['optimize'] = True
                    elif target_format == 'PNG':
                        save_kwargs['compress_level'] = min(9, max(0, quality))
                        save_kwargs['optimize'] = True
                    elif target_format == 'WEBP':
                        save_kwargs['quality'] = min(100, max(1, quality))
                        save_kwargs['method'] = 6  # Best compression
                    elif target_format == 'TIFF':
                        save_kwargs['compression'] = 'lzw'
                else:
                    # Use default quality settings
                    if target_format == 'JPEG':
                        save_kwargs['quality'] = format_info['default_quality']
                        save_kwargs['optimize'] = True
                    elif target_format == 'PNG':
                        save_kwargs['compress_level'] = format_info['default_quality']
                        save_kwargs['optimize'] = True
                    elif target_format == 'WEBP':
                        save_kwargs['quality'] = format_info['default_quality']
                        save_kwargs['method'] = 6
                    elif target_format == 'TIFF':
                        save_kwargs['compression'] = format_info['default_quality']
                
                # Preserve metadata if requested
                if preserve_metadata and img.info:
                    # Copy compatible metadata
                    for key, value in img.info.items():
                        if key not in ['transparency', 'gamma']:  # Skip problematic keys
                            try:
                                save_kwargs[key] = value
                            except Exception:
                                pass
                
                # Save converted image
                converted_img.save(output_path, format=target_format, **save_kwargs)
                
                logger.info(f"Converted {input_path} to {target_format} format: {output_path}")
                return True, "Conversion successful"
                
        except Exception as e:
            error_msg = f"Image conversion failed: {str(e)}"
            logger.error(error_msg)
            return False, error_msg
    
    def _handle_transparency_conversion(self, img: Image.Image, target_format: str, 
                                     preserve_transparency: bool) -> Image.Image:
        """Handle transparency when converting between formats"""
        
        format_info = self.SUPPORTED_FORMATS[target_format]
        supports_transparency = format_info['supports_transparency']
        
        # If target format doesn't support transparency, handle it
        if not supports_transparency and img.mode in ('RGBA', 'LA', 'P'):
            if preserve_transparency:
                # Convert to RGB with white background
                if img.mode == 'P':
                    img = img.convert('RGBA')
                
                # Create white background
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'RGBA':
                    background.paste(img, mask=img.split()[-1])  # Use alpha channel as mask
                else:
                    background.paste(img)
                
                return background
            else:
                # Simply convert to RGB
                return img.convert('RGB')
        
        # If target format supports transparency, preserve it
        elif supports_transparency and img.mode in ('RGBA', 'LA', 'P'):
            if target_format == 'PNG' and img.mode != 'RGBA':
                return img.convert('RGBA')
            elif target_format == 'WEBP' and img.mode not in ('RGBA', 'RGB'):
                return img.convert('RGBA')
            else:
                return img
        
        # For non-transparent images or when transparency is not needed
        else:
            if target_format == 'JPEG' and img.mode != 'RGB':
                return img.convert('RGB')
            else:
                return img
    
    def optimize_for_web(self, input_path: str, output_path: str, 
                        max_width: int = 1920, max_height: int = 1080,
                        quality: int = 80, format: str = 'WEBP') -> Tuple[bool, str, Dict[str, Any]]:
        """
        Optimize image for web delivery with size and quality constraints
        
        Returns:
            (success, error_message, optimization_info)
        """
        try:
            # Validate input
            is_valid, error_msg, image_info = self.validate_image(input_path)
            if not is_valid:
                return False, error_msg, {}
            
            optimization_info = {
                'original_size': image_info.size,
                'original_format': image_info.format,
                'original_file_size_mb': image_info.file_size_mb
            }
            
            with Image.open(input_path) as img:
                # Calculate new dimensions if resizing is needed
                width, height = img.size
                if width > max_width or height > max_height:
                    ratio = min(max_width / width, max_height / height)
                    new_width = int(width * ratio)
                    new_height = int(height * ratio)
                    
                    # Resize with high-quality resampling
                    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                    optimization_info['resized'] = True
                    optimization_info['new_size'] = (new_width, new_height)
                else:
                    optimization_info['resized'] = False
                    optimization_info['new_size'] = (width, height)
                
                # Convert format and save
                success, error_msg = self.convert_format(
                    input_path, output_path, format, quality, 
                    preserve_transparency=True, preserve_metadata=False
                )
                
                if success:
                    # Get final file size
                    final_size_mb = os.path.getsize(output_path) / (1024 * 1024)
                    optimization_info['final_file_size_mb'] = final_size_mb
                    optimization_info['compression_ratio'] = final_size_mb / image_info.file_size_mb
                    optimization_info['space_saved_mb'] = image_info.file_size_mb - final_size_mb
                
                return success, error_msg, optimization_info
                
        except Exception as e:
            error_msg = f"Web optimization failed: {str(e)}"
            logger.error(error_msg)
            return False, error_msg, {}
    
    def get_supported_extensions(self) -> List[str]:
        """Get list of all supported file extensions"""
        extensions = []
        for format_info in self.SUPPORTED_FORMATS.values():
            extensions.extend(format_info['extensions'])
        return extensions
    
    def detect_format_from_extension(self, filename: str) -> Optional[str]:
        """Detect image format from file extension"""
        ext = os.path.splitext(filename)[1].lower()
        
        for format_name, format_info in self.SUPPORTED_FORMATS.items():
            if ext in format_info['extensions']:
                return format_name
        
        return None
    
    def get_format_capabilities(self, format_name: str) -> Optional[Dict[str, Any]]:
        """Get capabilities of a specific format"""
        return self.SUPPORTED_FORMATS.get(format_name)


# Global instance
_format_handler = None

def get_format_handler() -> ImageFormatHandler:
    """Get the global image format handler instance"""
    global _format_handler
    if _format_handler is None:
        _format_handler = ImageFormatHandler()
    return _format_handler