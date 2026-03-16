"""
Unified Image Processing Gateway Middleware
Acts as a central gateway for all incoming and outgoing image processing activities
"""
import os
import time
import logging
import json
from typing import Dict, Any, Optional, List
from django.http import JsonResponse, HttpResponse
from django.utils.deprecation import MiddlewareMixin
from django.conf import settings
from django.core.files.uploadedfile import UploadedFile
from django.urls import resolve
from django.utils.crypto import get_random_string

from ai_engine.resource_manager import get_resource_manager
from ai_engine.failure_handler import get_failure_handler
from ai_engine.image_format_handler import get_format_handler
from ai_engine.background_removal import get_background_remover
from ai_engine.product_detection import get_product_detector
from ai_engine.design_placement import get_design_placer
from ai_engine.blend_engine import get_blend_engine
from ai_engine.smart_layout import get_smart_engine
from services.storage import get_storage
from .models import AIProcessingJob, UploadedFile as UploadedFileModel
from .authentication import APIKeyUser

logger = logging.getLogger(__name__)


class APIRequestLoggingMiddleware(MiddlewareMixin):
    """Middleware for logging API requests"""
    
    def __init__(self, get_response):
        self.get_response = get_response
    
    def __call__(self, request):
        start_time = time.time()
        
        # Log request
        if request.path.startswith('/api/'):
            logger.info(f"API Request: {request.method} {request.path}")
        
        response = self.get_response(request)
        
        # Log response
        if request.path.startswith('/api/'):
            duration = time.time() - start_time
            user_label = getattr(request.user, 'auth_source', 'anonymous')
            logger.info(f"API Response: {response.status_code} in {duration:.3f}s [Source: {user_label}]")
        
        return response


class RateLimitMiddleware(MiddlewareMixin):
    """Basic in-process rate limiting middleware.
    NOTE: With multiple Gunicorn workers, each worker has its own counter.
    For strict enforcement, replace with Redis-backed rate limiting.
    """

    def __init__(self, get_response):
        import threading
        self.get_response = get_response
        self.request_counts: dict[str, int] = {}
        self.last_reset = time.time()
        self._lock = threading.Lock()

    def __call__(self, request):
        current_time = time.time()

        if request.path.startswith('/api/'):
            client_ip = self._get_client_ip(request)

            with self._lock:
                # Reset counts every minute
                if current_time - self.last_reset > 60:
                    self.request_counts = {}
                    self.last_reset = current_time

                count = self.request_counts.get(client_ip, 0)
                if count > 100:  # 100 requests per minute
                    return JsonResponse({
                        'error': 'Rate limit exceeded',
                        'detail': 'Too many requests. Please try again later.'
                    }, status=429)
                self.request_counts[client_ip] = count + 1

        return self.get_response(request)
    
    def _get_client_ip(self, request):
        """Get client IP address"""
        x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
        if x_forwarded_for:
            ip = x_forwarded_for.split(',')[0]
        else:
            ip = request.META.get('REMOTE_ADDR')
        return ip


class ImageProcessingGatewayMiddleware(MiddlewareMixin):
    """
    Unified gateway middleware for all image processing activities.
    Handles both UI and API requests with comprehensive processing pipeline.
    """
    
    def __init__(self, get_response):
        self.get_response = get_response
        self.resource_manager = get_resource_manager()
        self.format_handler = get_format_handler()
        self.storage = get_storage()
        
        # Processing endpoints that should go through the gateway
        self.processing_endpoints = {
            '/api/layout/generate',
            '/api/ai/remove-background/',
            '/api/ai/detect-products/',
            '/api/ai/place-design/',
            '/api/ai/blend-preview/',
            '/api/ai/process-complete/',
        }
        
        # UI endpoints (for future UI integration)
        self.ui_endpoints = {
            '/dashboard/',
            '/editor/',
        }
        
        logger.info("Image Processing Gateway Middleware initialized")
    
    def __call__(self, request):
        """Main middleware entry point"""
        # Pre-process request
        request = self.process_request(request)
        
        # Get response from view
        response = self.get_response(request)
        
        # Post-process response
        response = self.process_response(request, response)
        
        return response
    
    def process_request(self, request):
        """Process incoming requests through the gateway"""
        try:
            # Check if this is an image processing request
            if not self._is_processing_request(request):
                return request
            
            # Add gateway metadata to request
            request.gateway_metadata = {
                'request_id': get_random_string(12),
                'start_time': time.time(),
                'source': self._determine_request_source(request),
                'processing_type': self._determine_processing_type(request),
                'user_id': self._get_user_id(request)
            }
            
            # Validate and prepare images
            if hasattr(request, 'FILES') and request.FILES:
                request.gateway_metadata['images'] = self._process_uploaded_images(request)
            
            # Check resource availability
            resource_check = self._check_resource_availability(request)
            if not resource_check['available']:
                return self._create_resource_unavailable_response(resource_check)
            
            # Log gateway activity
            logger.info(f"Gateway processing request {request.gateway_metadata['request_id']} "
                       f"from {request.gateway_metadata['source']} "
                       f"for {request.gateway_metadata['processing_type']}")
            
        except Exception as e:
            logger.error(f"Gateway request processing error: {e}")
            # Continue with request even if gateway processing fails
        
        return request
    
    def process_response(self, request, response):
        """Process outgoing responses through the gateway"""
        try:
            # Only process responses for gateway-handled requests
            if not hasattr(request, 'gateway_metadata'):
                return response
            
            metadata = request.gateway_metadata
            processing_time = time.time() - metadata['start_time']
            
            # Enhance response with gateway metadata
            if hasattr(response, 'data') or response.get('Content-Type', '').startswith('application/json'):
                enhanced_response = self._enhance_response_with_metadata(
                    request, response, processing_time
                )
                if enhanced_response:
                    response = enhanced_response
            
            # Log completion
            logger.info(f"Gateway completed request {metadata['request_id']} "
                       f"in {processing_time:.2f}s")
            
            # Update resource metrics
            self._update_resource_metrics(request, response, processing_time)
            
        except Exception as e:
            logger.error(f"Gateway response processing error: {e}")
        
        return response
    
    # Endpoints that handle file uploads but should NOT go through AI processing
    NON_PROCESSING_UPLOAD_ENDPOINTS = {
        '/api/ops/layouts',
    }

    def _is_processing_request(self, request) -> bool:
        """Check if request should be processed by gateway"""
        path = request.path_info

        # Skip endpoints that handle their own file uploads (e.g. mask uploads)
        if any(path.startswith(ep) for ep in self.NON_PROCESSING_UPLOAD_ENDPOINTS):
            return False

        # Check API endpoints
        if any(endpoint in path for endpoint in self.processing_endpoints):
            return True

        # Check UI endpoints
        if any(endpoint in path for endpoint in self.ui_endpoints):
            return True

        # Check for image uploads in any request
        if hasattr(request, 'FILES') and request.FILES:
            return True

        return False
    
    def _determine_request_source(self, request) -> str:
        """Determine the source of the request (UI, API, etc.)"""
        # Check for authenticated user source
        if hasattr(request, 'user') and hasattr(request.user, 'auth_source'):
            return request.user.auth_source
        
        # Check for UI-specific headers or paths
        if '/dashboard/' in request.path_info or '/editor/' in request.path_info:
            return 'ui'
        
        # Check for AJAX requests (likely from UI)
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return 'ui_ajax'
        
        # Check user agent for browser vs API client
        user_agent = request.headers.get('User-Agent', '').lower()
        if any(browser in user_agent for browser in ['mozilla', 'chrome', 'safari', 'firefox']):
            return 'ui_browser'
        
        return 'api_client'
    
    def _determine_processing_type(self, request) -> str:
        """Determine the type of processing requested"""
        path = request.path_info
        
        if 'layout/generate' in path:
            return 'layout_generation'
        elif 'remove-background' in path:
            return 'background_removal'
        elif 'detect-products' in path:
            return 'product_detection'
        elif 'place-design' in path:
            return 'design_placement'
        elif 'blend-preview' in path:
            return 'blend_preview'
        elif 'process-complete' in path:
            return 'complete_processing'
        else:
            return 'general_processing'
    
    def _get_user_id(self, request) -> Optional[str]:
        """Get user ID for tracking"""
        if isinstance(getattr(request, 'user', None), APIKeyUser):
            return request.user.api_key.name
        
        # For UI users, use session key or create anonymous ID
        if hasattr(request, 'session'):
            if 'gateway_user_id' not in request.session:
                request.session['gateway_user_id'] = f"ui_user_{get_random_string(8)}"
            return request.session['gateway_user_id']
        
        return None
    
    def _process_uploaded_images(self, request) -> List[Dict[str, Any]]:
        """Process and validate uploaded images"""
        processed_images = []
        
        for field_name, uploaded_file in request.FILES.items():
            if isinstance(uploaded_file, list):
                files = uploaded_file
            else:
                files = [uploaded_file]
            
            for file_obj in files:
                try:
                    # Validate image using format handler
                    temp_path = self._save_temp_file(file_obj)
                    is_valid, error_msg, image_info = self.format_handler.validate_image(temp_path)
                    
                    if is_valid:
                        processed_images.append({
                            'field_name': field_name,
                            'filename': file_obj.name,
                            'size_mb': image_info.file_size_mb,
                            'format': image_info.format,
                            'dimensions': image_info.size,
                            'has_transparency': image_info.has_transparency,
                            'temp_path': temp_path,
                            'valid': True
                        })
                    else:
                        processed_images.append({
                            'field_name': field_name,
                            'filename': file_obj.name,
                            'valid': False,
                            'error': error_msg
                        })
                        # Clean up invalid temp file
                        try:
                            os.unlink(temp_path)
                        except OSError:
                            pass
                
                except Exception as e:
                    logger.error(f"Error processing uploaded file {file_obj.name}: {e}")
                    processed_images.append({
                        'field_name': field_name,
                        'filename': file_obj.name,
                        'valid': False,
                        'error': str(e)
                    })
        
        return processed_images
    
    def _save_temp_file(self, uploaded_file: UploadedFile) -> str:
        """Save uploaded file to temporary location for processing"""
        import tempfile
        
        # Create temp file with appropriate extension
        file_ext = os.path.splitext(uploaded_file.name)[1]
        temp_fd, temp_path = tempfile.mkstemp(suffix=file_ext)
        
        try:
            with os.fdopen(temp_fd, 'wb') as temp_file:
                for chunk in uploaded_file.chunks():
                    temp_file.write(chunk)
        except Exception:
            os.close(temp_fd)
            raise
        
        return temp_path
    
    def _check_resource_availability(self, request) -> Dict[str, Any]:
        """Check if resources are available for processing"""
        try:
            user_id = request.gateway_metadata.get('user_id')
            
            # Check concurrent request limits
            can_process, reason = self.resource_manager.request_limiter.can_process_request(user_id)
            
            if not can_process:
                return {
                    'available': False,
                    'reason': reason,
                    'suggested_actions': [
                        'Wait for current requests to complete',
                        'Try again in a few minutes',
                        'Use background processing for large operations'
                    ]
                }
            
            # Check system resources with dynamic thresholds based on system capacity
            metrics = self.resource_manager.get_resource_metrics()
            
            # Use dynamic memory threshold based on system resources
            memory_threshold = self.resource_manager._memory_threshold
            if metrics.memory_percent > memory_threshold:
                return {
                    'available': False,
                    'reason': f'System memory usage too high (>{memory_threshold}%) for current system capacity',
                    'suggested_actions': [
                        'Wait for system resources to free up',
                        'Use smaller images',
                        'Enable background processing'
                    ]
                }
            
            # Use dynamic CPU threshold based on system resources
            cpu_threshold = self.resource_manager._cpu_threshold
            if metrics.cpu_percent > cpu_threshold:
                return {
                    'available': False,
                    'reason': f'System CPU usage too high (>{cpu_threshold}%) for current system capacity',
                    'suggested_actions': [
                        'Wait for system load to decrease',
                        'Try again later',
                        'Use background processing'
                    ]
                }
            
            return {'available': True}
            
        except Exception as e:
            logger.error(f"Resource availability check failed: {e}")
            return {'available': True}  # Allow processing if check fails
    
    def _create_resource_unavailable_response(self, resource_check: Dict[str, Any]) -> JsonResponse:
        """Create response for resource unavailability"""
        return JsonResponse({
            'success': False,
            'detail': resource_check['reason'],
            'error_type': 'resource_unavailable',
            'suggested_actions': resource_check.get('suggested_actions', []),
            'retry_after_seconds': 60,
            'gateway_metadata': {
                'processed_by_gateway': True,
                'resource_check_failed': True
            }
        }, status=503)  # Service Unavailable
    
    def _enhance_response_with_metadata(self, request, response, processing_time: float):
        """Enhance response with gateway metadata"""
        try:
            metadata = request.gateway_metadata
            
            # Parse existing response data
            if hasattr(response, 'data'):
                response_data = response.data
            else:
                try:
                    response_data = json.loads(response.content.decode('utf-8'))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return None
            
            # Add gateway metadata
            if isinstance(response_data, dict):
                response_data['gateway_metadata'] = {
                    'request_id': metadata['request_id'],
                    'processing_time_seconds': processing_time,
                    'source': metadata['source'],
                    'processing_type': metadata['processing_type'],
                    'processed_by_gateway': True,
                    'images_processed': len(metadata.get('images', [])),
                    'resource_usage': self._get_current_resource_usage()
                }
                
                # Create new response with enhanced data
                return JsonResponse(response_data, status=response.status_code)
            
        except Exception as e:
            logger.error(f"Response enhancement failed: {e}")
        
        return None
    
    def _get_current_resource_usage(self) -> Dict[str, Any]:
        """Get current resource usage for metadata"""
        try:
            metrics = self.resource_manager.get_resource_metrics()
            return {
                'cpu_percent': round(metrics.cpu_percent, 1),
                'memory_percent': round(metrics.memory_percent, 1),
                'active_requests': metrics.active_requests,
                'cache_hit_rate': round(metrics.cache_hit_rate, 3)
            }
        except Exception:
            return {}
    
    def _update_resource_metrics(self, request, response, processing_time: float):
        """Update resource metrics after processing"""
        try:
            metadata = request.gateway_metadata
            
            # Record processing metrics
            success = response.status_code < 400
            
            # This would integrate with the performance profiler
            # For now, just log the metrics
            logger.info(f"Gateway metrics - Request: {metadata['request_id']}, "
                       f"Type: {metadata['processing_type']}, "
                       f"Time: {processing_time:.2f}s, "
                       f"Success: {success}")
            
        except Exception as e:
            logger.error(f"Resource metrics update failed: {e}")


class ImageProcessingPipeline:
    """
    Unified image processing pipeline that can be used by both middleware and views
    """
    
    def __init__(self):
        self.background_remover = get_background_remover()
        self.product_detector = get_product_detector()
        self.design_placer = get_design_placer()
        self.blend_engine = get_blend_engine()
        self.smart_engine = get_smart_engine()
        self.format_handler = get_format_handler()
        self.storage = get_storage()
        
    def process_images_for_layout(self, image_paths: List[str], layout_name: str,
                                 processing_options: Dict[str, Any],
                                 user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Complete image processing pipeline for layout generation
        
        Args:
            image_paths: List of paths to input images
            layout_name: Name of the layout to generate
            processing_options: AI processing options
            user_id: User ID for tracking
            
        Returns:
            Dictionary with processing results and generated layouts
        """
        results = {
            'success': True,
            'processed_images': [],
            'ai_processing': {},
            'layouts': [],
            'processing_time': 0,
            'errors': []
        }
        
        start_time = time.time()
        
        try:
            # Process each image through the AI pipeline
            for i, image_path in enumerate(image_paths):
                image_result = self._process_single_image(
                    image_path, processing_options, f"image_{i}", user_id
                )
                results['processed_images'].append(image_result)
                
                if not image_result['success']:
                    results['errors'].append(f"Image {i}: {image_result.get('error', 'Unknown error')}")
            
            # Generate layouts using processed images
            processed_paths = [
                img['processed_path'] if img['success'] else img['original_path']
                for img in results['processed_images']
            ]
            
            layout_result = self._generate_layout(processed_paths, layout_name, processing_options)
            results['layouts'] = layout_result.get('outputs', [])
            
            # Compile AI processing metadata
            results['ai_processing'] = self._compile_ai_metadata(results['processed_images'])
            
            results['processing_time'] = time.time() - start_time
            
        except Exception as e:
            logger.error(f"Image processing pipeline failed: {e}")
            results['success'] = False
            results['errors'].append(str(e))
            results['processing_time'] = time.time() - start_time
        
        return results
    
    def _process_single_image(self, image_path: str, options: Dict[str, Any],
                             image_id: str, user_id: Optional[str]) -> Dict[str, Any]:
        """Process a single image through the AI pipeline"""
        result = {
            'image_id': image_id,
            'original_path': image_path,
            'processed_path': image_path,
            'success': True,
            'processing_steps': {},
            'error': None
        }
        
        current_path = image_path
        
        try:
            # Step 1: Background removal
            if options.get('remove_backgrounds', False):
                bg_result = self.background_remover.remove_background(
                    current_path, self.storage.uploads_dir(), user_id=user_id
                )
                
                result['processing_steps']['background_removal'] = {
                    'success': bg_result.success,
                    'processing_time': bg_result.processing_time,
                    'fallback_used': bg_result.fallback_used
                }
                
                if bg_result.success:
                    current_path = bg_result.processed_image_path
                    result['processed_path'] = current_path
            
            # Step 2: Product detection
            if options.get('detect_products', False):
                products = self.product_detector.detect_products(current_path)
                
                result['processing_steps']['product_detection'] = {
                    'success': True,
                    'products_found': len(products),
                    'products': [
                        {
                            'category': p.category,
                            'confidence': p.confidence,
                            'center_point': p.center_point
                        } for p in products
                    ]
                }
            
            # Step 3: Design placement (if applicable)
            if options.get('place_design', False) and 'design_path' in options:
                # This would be implemented for design placement
                pass
            
            # Step 4: Realistic blending (if applicable)
            if options.get('realistic_blending', False):
                # This would be implemented for blending
                pass
            
        except Exception as e:
            logger.error(f"Single image processing failed for {image_id}: {e}")
            result['success'] = False
            result['error'] = str(e)
        
        return result
    
    def _generate_layout(self, image_paths: List[str], layout_name: str,
                        options: Dict[str, Any]) -> Dict[str, Any]:
        """Generate layout using processed images"""
        try:
            from layout_engine.engine import LayoutEngine
            
            engine = LayoutEngine(self.storage.layouts_dir(), settings.EXPORTS_DIR)
            outputs = engine.generate(layout_name, image_paths)
            
            return {
                'success': True,
                'outputs': outputs,
                'layout_name': layout_name
            }
            
        except Exception as e:
            logger.error(f"Layout generation failed: {e}")
            return {
                'success': False,
                'error': str(e),
                'outputs': []
            }
    
    def _compile_ai_metadata(self, processed_images: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Compile AI processing metadata from all processed images"""
        metadata = {}
        
        for i, img_result in enumerate(processed_images):
            img_metadata = {}
            
            for step_name, step_result in img_result.get('processing_steps', {}).items():
                img_metadata[step_name] = step_result
            
            metadata[f'image_{i}'] = img_metadata
        
        return metadata


# Global pipeline instance
_processing_pipeline = None

def get_processing_pipeline() -> ImageProcessingPipeline:
    """Get the global image processing pipeline instance"""
    global _processing_pipeline
    if _processing_pipeline is None:
        _processing_pipeline = ImageProcessingPipeline()
    return _processing_pipeline