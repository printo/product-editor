"""
Background Removal Service using Hugging Face RMBG-1.4
Enhanced with comprehensive failure handling, resource management, and multi-format support
"""
import os
import logging
from PIL import Image
from typing import Optional
from dataclasses import dataclass
from datetime import datetime
from .model_manager import get_model_manager
from .failure_handler import get_failure_handler
from .background_processor import get_background_processor, JobPriority
from .resource_manager import get_resource_manager
from .network_resilience import get_resilient_client
from .image_format_handler import get_format_handler

logger = logging.getLogger(__name__)


@dataclass
class ProcessingResult:
    """Result of AI processing operation"""
    success: bool
    processed_image_path: Optional[str]
    original_image_path: str
    processing_time: float
    error_message: Optional[str]
    metadata: dict
    fallback_used: bool = False
    manual_override_available: bool = True
    suggested_actions: list = None
    background_job_id: Optional[str] = None


class BackgroundRemovalService:
    """Service for removing backgrounds from images using RMBG model with comprehensive format support"""
    
    def __init__(self):
        self.model_manager = get_model_manager()
        self.failure_handler = get_failure_handler()
        self.background_processor = get_background_processor()
        self.resource_manager = get_resource_manager()
        self.resilient_client = get_resilient_client()
        self.format_handler = get_format_handler()
        
        # Register background processing function
        self.background_processor.register_service_function(
            'background_removal', 'remove_background_bg', self._remove_background_internal
        )
    
    @get_failure_handler().with_failure_handling('background_removal', timeout=30)
    def remove_background(self, image_path: str, output_dir: str = None, 
                         background_processing: bool = False, user_id: str = None) -> ProcessingResult:
        """
        Remove background from image using RMBG-1.4 model with resource management
        
        Args:
            image_path: Path to input image
            output_dir: Directory to save processed image (optional)
            background_processing: If True, queue for background processing on timeout
            user_id: User ID for background job tracking
            
        Returns:
            ProcessingResult with success status and processed image path
        """
        # Use resource manager for comprehensive processing
        try:
            result, metadata = self.resource_manager.process_with_resource_management(
                service_name='background_removal',
                function_name='remove_background',
                image_path=image_path,
                user_id=user_id,
                params={'output_dir': output_dir, 'background_processing': background_processing},
                use_cache=True,
                optimize_memory=True
            )
            
            # If request was queued, return appropriate result
            if metadata.get('request_queued'):
                return ProcessingResult(
                    success=False,
                    processed_image_path=None,
                    original_image_path=image_path,
                    processing_time=metadata.get('processing_time', 0.0),
                    error_message=None,
                    metadata={
                        'queued_for_background': True,
                        'memory_optimized': metadata.get('memory_optimized', False),
                        'optimization_info': metadata.get('optimization_info', {})
                    },
                    fallback_used=False,
                    manual_override_available=True,
                    suggested_actions=[
                        "Continue with other tasks",
                        "Check background job status",
                        "Use manual background removal if needed immediately"
                    ],
                    background_job_id=metadata.get('background_job_id')
                )
            
            # If cached result was used
            if metadata.get('cache_used'):
                return result
            
            # Process normally with optimized image
            optimized_path = image_path
            if metadata.get('memory_optimized'):
                # Use the optimized image path from resource manager
                optimized_path = metadata.get('optimization_info', {}).get('optimized_path', image_path)
            
            return self._remove_background_internal(optimized_path, output_dir)
            
        except Exception as e:
            logger.error(f"Resource-managed background removal failed: {e}")
            # Fallback to direct processing
            return self._remove_background_internal(image_path, output_dir)
    
    def _remove_background_internal(self, image_path: str, output_dir: str = None) -> ProcessingResult:
        """
        Internal background removal implementation with comprehensive format support
        
        Args:
            image_path: Path to input image
            output_dir: Directory to save processed image (optional)
            
        Returns:
            ProcessingResult with success status and processed image path
        """
        start_time = datetime.now()
        
        try:
            # Validate input image with format handler
            is_valid, error_msg, image_info = self.format_handler.validate_image(image_path)
            if not is_valid:
                raise ValueError(error_msg)
            
            # Log format information
            logger.info(f"Processing {image_info.format} image: {image_info.size}, "
                       f"transparency: {image_info.has_transparency}, size: {image_info.file_size_mb:.1f}MB")
            
            # Load the RMBG model
            model_session = self.model_manager.load_model("rmbg")
            
            # Process the image
            with open(image_path, 'rb') as input_file:
                input_data = input_file.read()
            
            # Remove background using rembg
            from rembg import remove
            output_data = remove(input_data, session=model_session)
            
            # Save processed image as PNG to preserve transparency
            output_path = self._generate_output_path(image_path, output_dir, 'PNG')
            with open(output_path, 'wb') as output_file:
                output_file.write(output_data)
            
            processing_time = (datetime.now() - start_time).total_seconds()
            
            # Verify output and get final info
            _, _, output_info = self.format_handler.validate_image(output_path)
            
            return ProcessingResult(
                success=True,
                processed_image_path=output_path,
                original_image_path=image_path,
                processing_time=processing_time,
                error_message=None,
                metadata={
                    'model_used': 'rmbg-1.4',
                    'input_format': image_info.format,
                    'output_format': 'PNG',
                    'input_size': image_info.size,
                    'output_size': output_info.size if output_info else None,
                    'input_file_size_mb': image_info.file_size_mb,
                    'output_file_size_mb': output_info.file_size_mb if output_info else None,
                    'transparency_preserved': True,
                    'device': self.model_manager.get_device()
                },
                fallback_used=False,
                manual_override_available=True,
                suggested_actions=["Review the processed image", "Manually adjust if needed"]
            )
            
        except Exception as e:
            processing_time = (datetime.now() - start_time).total_seconds()
            error_msg = f"Background removal failed: {str(e)}"
            logger.error(error_msg)
            
            return ProcessingResult(
                success=False,
                processed_image_path=None,
                original_image_path=image_path,
                processing_time=processing_time,
                error_message=error_msg,
                metadata={'model_used': 'rmbg-1.4', 'error': str(e)},
                fallback_used=False,
                manual_override_available=True,
                suggested_actions=[
                    "Use manual background removal tools",
                    "Try with a different image format",
                    "Check if image is corrupted",
                    "Try again later when AI service is restored"
                ]
            )
    
    def _generate_output_path(self, input_path: str, output_dir: str = None, output_format: str = 'PNG') -> str:
        """Generate output path for processed image with format support"""
        if output_dir is None:
            output_dir = os.path.dirname(input_path)
        
        base_name = os.path.splitext(os.path.basename(input_path))[0]
        
        # Use appropriate extension for output format
        if output_format == 'PNG':
            extension = '.png'
        elif output_format == 'WEBP':
            extension = '.webp'
        elif output_format == 'TIFF':
            extension = '.tiff'
        else:
            extension = '.png'  # Default to PNG for transparency
        
        output_filename = f"{base_name}_no_bg{extension}"
        return os.path.join(output_dir, output_filename)
    
    def is_available(self) -> bool:
        """Check if background removal service is available"""
        try:
            status = self.model_manager.get_model_status("rmbg")
            return status.is_healthy and not self.failure_handler._is_circuit_open('background_removal')
        except:
            return False
    
    def _queue_for_background_processing(self, image_path: str, output_dir: str = None, 
                                       user_id: str = None) -> ProcessingResult:
        """Queue background removal for background processing"""
        try:
            job_id = self.background_processor.queue_job(
                service_name='background_removal',
                function_name='remove_background_bg',
                image_path=image_path,
                output_dir=output_dir,
                priority=JobPriority.NORMAL,
                timeout_seconds=60,
                user_id=user_id
            )
            
            return ProcessingResult(
                success=False,  # Not completed yet
                processed_image_path=None,
                original_image_path=image_path,
                processing_time=0.0,
                error_message=None,
                metadata={'queued_for_background': True},
                fallback_used=False,
                manual_override_available=True,
                suggested_actions=[
                    "Continue with other tasks",
                    "Check background job status",
                    "Use manual background removal if needed immediately"
                ],
                background_job_id=job_id
            )
            
        except Exception as e:
            logger.error(f"Failed to queue background job: {e}")
            return ProcessingResult(
                success=False,
                processed_image_path=None,
                original_image_path=image_path,
                processing_time=0.0,
                error_message=f"Failed to queue background processing: {str(e)}",
                metadata={'queue_error': str(e)},
                fallback_used=False,
                manual_override_available=True,
                suggested_actions=[
                    "Use manual background removal tools",
                    "Try again later",
                    "Contact support if issues persist"
                ]
            )
    
    def get_manual_override_options(self) -> dict:
        """Get manual override options for background removal"""
        return {
            'available': True,
            'options': [
                {
                    'name': 'manual_selection',
                    'display_name': 'Manual Background Selection',
                    'description': 'Manually select background areas to remove using selection tools',
                    'tools_required': ['selection_tool', 'eraser_tool']
                },
                {
                    'name': 'magic_wand',
                    'display_name': 'Magic Wand Tool',
                    'description': 'Use magic wand tool to select similar colored background areas',
                    'tools_required': ['magic_wand_tool']
                },
                {
                    'name': 'color_range',
                    'display_name': 'Color Range Selection',
                    'description': 'Select background by color range and remove',
                    'tools_required': ['color_picker', 'range_selector']
                },
                {
                    'name': 'use_original',
                    'display_name': 'Use Original Image',
                    'description': 'Continue with original image without background removal',
                    'tools_required': []
                }
            ],
            'tutorials': [
                {
                    'title': 'Manual Background Removal Guide',
                    'url': '/help/manual-background-removal',
                    'duration': '5 minutes'
                }
            ]
        }
    
    def check_background_job_status(self, job_id: str) -> dict:
        """Check status of background processing job"""
        job = self.background_processor.get_job_status(job_id)
        
        if not job:
            return {
                'status': 'not_found',
                'message': 'Background job not found'
            }
        
        return {
            'status': job.status.value,
            'created_at': job.created_at.isoformat(),
            'started_at': job.started_at.isoformat() if job.started_at else None,
            'completed_at': job.completed_at.isoformat() if job.completed_at else None,
            'progress': self._calculate_job_progress(job),
            'result': job.result if job.status.value == 'completed' else None,
            'error_message': job.error_message if job.status.value == 'failed' else None,
            'retry_count': job.retry_count,
            'estimated_completion': self._estimate_completion_time(job)
        }
    
    def _calculate_job_progress(self, job) -> int:
        """Calculate job progress percentage"""
        if job.status.value == 'completed':
            return 100
        elif job.status.value == 'failed' or job.status.value == 'cancelled':
            return 0
        elif job.status.value == 'processing':
            # Estimate based on average processing time
            if job.started_at:
                elapsed = (datetime.now() - job.started_at).total_seconds()
                estimated_total = 30  # Average 30 seconds
                return min(90, int((elapsed / estimated_total) * 100))
            return 10
        else:  # queued
            return 0
    
    def _estimate_completion_time(self, job) -> Optional[str]:
        """Estimate job completion time"""
        if job.status.value in ['completed', 'failed', 'cancelled']:
            return None
        
        if job.status.value == 'processing' and job.started_at:
            elapsed = (datetime.now() - job.started_at).total_seconds()
            remaining = max(0, 30 - elapsed)  # Assume 30 second average
            return f"{int(remaining)} seconds"
        
        # For queued jobs, estimate based on queue position
        queue_stats = self.background_processor.get_queue_stats()
        estimated_wait = queue_stats['queue_size'] * 30  # 30 seconds per job
        return f"{int(estimated_wait / 60)} minutes"


# Global instance
_background_remover = None

def get_background_remover() -> BackgroundRemovalService:
    """Get the global background removal service instance"""
    global _background_remover
    if _background_remover is None:
        _background_remover = BackgroundRemovalService()
    return _background_remover