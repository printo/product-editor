"""
File validators for upload validation.
Validates file size, type, and content for JPEG, PNG, WebP, TIFF formats.
"""
import mimetypes
import logging
from PIL import Image
from django.conf import settings
from django.core.exceptions import ValidationError

logger = logging.getLogger(__name__)

# Configuration — single source via settings.MAX_UPLOAD_FILE_SIZE_MB (env-driven)
MAX_FILE_SIZE_MB = settings.MAX_UPLOAD_FILE_SIZE_MB
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

# Comprehensive format support
ALLOWED_IMAGE_TYPES = {
    'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
    'image/png': ['png'],
    'image/webp': ['webp'],
    'image/tiff': ['tiff', 'tif'],
    'image/gif': ['gif'],
}

MIN_IMAGE_DIMENSION = 50
MAX_IMAGE_DIMENSION = 8192


def validate_image_file(file_obj, max_size_mb=MAX_FILE_SIZE_MB):
    """
    Validate an image file for upload.
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
    
    all_allowed_exts = [ext for exts in ALLOWED_IMAGE_TYPES.values() for ext in exts]
    if file_ext not in all_allowed_exts:
        allowed = ', '.join(all_allowed_exts)
        raise ValidationError(
            f"Invalid file type '.{file_ext}'. Allowed types: {allowed}"
        )
    
    # Validate image integrity and dimensions using PIL
    try:
        file_obj.seek(0)
        img = Image.open(file_obj)
        img.verify()
        
        file_obj.seek(0)
        img = Image.open(file_obj)
        width, height = img.size

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

        # Reset position so callers can read the raw bytes after validation.
        file_obj.seek(0)

    except ValidationError:
        # Re-raise dimension/format errors unchanged so the user-facing
        # message is not double-wrapped as "Invalid image file: [...]".
        raise
    except Exception as e:
        logger.error(f"Image validation error: {e}")
        raise ValidationError(f"Invalid image file: {str(e)}")


def validate_image_files(files, max_size_mb=MAX_FILE_SIZE_MB):
    """Validate a list of image files."""
    for f in files:
        validate_image_file(f, max_size_mb)
