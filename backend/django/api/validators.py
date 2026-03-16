"""
File validators for upload validation with comprehensive format support.
Validates file size, type, and content for JPEG, PNG, WebP, TIFF formats.
"""
import mimetypes
import logging
from PIL import Image
from django.core.exceptions import ValidationError
from io import BytesIO
from ai_engine.image_format_handler import get_format_handler

logger = logging.getLogger(__name__)

# Configuration
MAX_FILE_SIZE_MB = 50  # Increased to support larger images
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

# Comprehensive format support
ALLOWED_IMAGE_TYPES = {
    'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
    'image/png': ['png'],
    'image/webp': ['webp'],
    'image/tiff': ['tiff', 'tif'],
    'image/gif': ['gif'],  # For compatibility, but will be converted
}

MIN_IMAGE_DIMENSION = 50   # Reduced minimum for flexibility
MAX_IMAGE_DIMENSION = 8192  # Increased maximum for high-res support


def validate_image_file(file_obj, max_size_mb=MAX_FILE_SIZE_MB):
    """
    Validate an image file for upload with comprehensive format support.
    Checks:
    - File size (up to 50MB)
    - MIME type and format support
    - File extension
    - Image dimensions and integrity
    - Format-specific validation
    
    Args:
        file_obj: Django UploadedFile object
        max_size_mb: Maximum file size in MB
    
    Raises:
        ValidationError: If validation fails
    """
    
    if not file_obj:
        raise ValidationError("No file provided")
    
    # Check file size
    if file_obj.size > (max_size_mb * 1024 * 1024):
        raise ValidationError(
            f"File size exceeds maximum of {max_size_mb}MB. "
            f"Your file is {file_obj.size / (1024*1024):.1f}MB"
        )
    
    # Check file extension
    file_ext = file_obj.name.rsplit('.', 1)[-1].lower() if '.' in file_obj.name else ''
    
    if file_ext.lower() not in [ext for exts in ALLOWED_IMAGE_TYPES.values() for ext in exts]:
        allowed = ', '.join([ext for exts in ALLOWED_IMAGE_TYPES.values() for ext in exts])
        raise ValidationError(
            f"Invalid file type '.{file_ext}'. Allowed types: {allowed}"
        )
    
    # Check MIME type
    mime_type, _ = mimetypes.guess_type(file_obj.name)
    if mime_type and mime_type not in ALLOWED_IMAGE_TYPES:
        # Be more lenient with MIME type detection
        logger.warning(f"Unrecognized MIME type: {mime_type} for file {file_obj.name}")
    
    # Validate image integrity and dimensions using format handler
    try:
        file_obj.seek(0)  # Reset file pointer
        
        # Create temporary file for format handler validation
        import tempfile
        import os
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=f'.{file_ext}') as temp_file:
            temp_file.write(file_obj.read())
            temp_path = temp_file.name
        
        try:
            # Use format handler for comprehensive validation
            format_handler = get_format_handler()
            is_valid, error_msg, image_info = format_handler.validate_image(temp_path)
            
            if not is_valid:
                raise ValidationError(error_msg)
            
            # Additional dimension checks
            width, height = image_info.size
            
            if width < MIN_IMAGE_DIMENSION or height < MIN_IMAGE_DIMENSION:
                raise ValidationError(
                    f"Image dimensions too small. Minimum {MIN_IMAGE_DIMENSION}x{MIN_IMAGE_DIMENSION}px. "
                    f"Your image is {width}x{height}px"
                )
            
            if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
                raise ValidationError(
                    f"Image dimensions too large. Maximum {MAX_IMAGE_DIMENSION}x{MAX_IMAGE_DIMENSION}px. "
                    f"Your image is {width}x{height}px"
                )
            
            # Log format information for debugging
            logger.info(f"Validated {image_info.format} image: {image_info.size}, "
                       f"transparency: {image_info.has_transparency}, "
                       f"size: {image_info.file_size_mb:.1f}MB")
            
        finally:
            # Clean up temporary file
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        
        file_obj.seek(0)  # Reset again for subsequent reads
        
    except ValidationError:
        raise
    except Exception as e:
        logger.error(f"Image validation error: {str(e)}")
        raise ValidationError(
            f"Invalid image file or corrupted image data: {str(e)}"
        )
    
    return True


def validate_image_files(file_list):
    """
    Validate a list of image files.
    
    Args:
        file_list: List of Django UploadedFile objects
    
    Returns:
        True if all files are valid
    
    Raises:
        ValidationError: If any file is invalid
    """
    
    if not file_list or len(file_list) == 0:
        raise ValidationError("No files provided")
    
    for idx, file_obj in enumerate(file_list):
        try:
            validate_image_file(file_obj)
        except ValidationError as e:
            raise ValidationError(f"File {idx + 1} ({file_obj.name}): {str(e)}")
    
    return True


def get_file_extension(filename):
    """Get file extension safely."""
    return filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
