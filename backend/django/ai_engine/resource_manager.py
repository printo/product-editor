"""
Resource Management and Optimization for AI Processing
Handles concurrent request limiting, result caching, and memory optimization
"""
import os
import hashlib
import logging
import threading
import time
import psutil
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from django.core.cache import cache
from django.conf import settings
from PIL import Image
import io

logger = logging.getLogger(__name__)


@dataclass
class ResourceMetrics:
    """System resource usage metrics"""
    cpu_percent: float
    memory_percent: float
    memory_available_mb: int
    active_requests: int
    queue_size: int
    cache_hit_rate: float
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class ProcessingRequest:
    """Represents an AI processing request"""
    id: str
    service_name: str
    function_name: str
    user_id: Optional[str]
    priority: int
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    estimated_duration: float = 30.0  # seconds


class ConcurrentRequestLimiter:
    """Limits concurrent AI processing requests to prevent system overload"""
    
    def __init__(self, max_concurrent: int = None, max_per_user: int = None):
        # Auto-detect system resources for optimal configuration
        self._detect_system_resources()
        
        # Calculate optimal limits based on system resources
        if max_concurrent is None:
            max_concurrent = self._calculate_max_concurrent()
        if max_per_user is None:
            max_per_user = self._calculate_max_per_user()
        
        self.max_concurrent = max_concurrent
        self.max_per_user = max_per_user
        self.active_requests: Dict[str, ProcessingRequest] = {}
        self.user_request_counts: Dict[str, int] = {}
        self._lock = threading.Lock()
        
        logger.info(f"Request limiter auto-configured: CPU cores={self.cpu_cores}, "
                   f"Memory={self.memory_gb:.1f}GB, max_concurrent={self.max_concurrent}, "
                   f"max_per_user={self.max_per_user}")
    
    def _detect_system_resources(self):
        """Auto-detect system resources"""
        try:
            import psutil
            self.cpu_cores = psutil.cpu_count(logical=True)
            memory = psutil.virtual_memory()
            self.memory_gb = memory.total / (1024**3)
        except ImportError:
            # Fallback values
            self.cpu_cores = 2
            self.memory_gb = 6.0
    
    def _calculate_max_concurrent(self) -> int:
        """Calculate max concurrent requests based on CPU cores and memory"""
        # Use system recommendations if available
        if hasattr(self, 'recommendations'):
            return self.recommendations['max_concurrent_requests']
        
        # Fallback calculation
        cpu_based = max(1, self.cpu_cores - 1)  # Leave 1 core for system
        memory_based = max(1, int(self.memory_gb / 2))  # ~2GB per request
        return min(cpu_based, memory_based, 5)  # Cap at 5 for safety
    
    def _calculate_max_per_user(self) -> int:
        """Calculate max requests per user based on system resources"""
        # Use system recommendations if available
        if hasattr(self, 'recommendations'):
            return self.recommendations['max_requests_per_user']
        
        # Fallback calculation
        max_concurrent = self._calculate_max_concurrent()
        if max_concurrent <= 2:
            return 1  # Very limited resources
        elif max_concurrent <= 4:
            return 2  # Moderate resources
        else:
            return 3  # Higher resources
    
    def can_process_request(self, user_id: Optional[str] = None) -> Tuple[bool, str]:
        """Check if a new request can be processed"""
        with self._lock:
            # Check global concurrent limit
            if len(self.active_requests) >= self.max_concurrent:
                return False, f"System at capacity ({self.max_concurrent} concurrent requests)"
            
            # Check per-user limit
            if user_id:
                user_count = self.user_request_counts.get(user_id, 0)
                if user_count >= self.max_per_user:
                    return False, f"User limit reached ({self.max_per_user} requests per user)"
            
            return True, "Request can be processed"
    
    def acquire_slot(self, request: ProcessingRequest) -> bool:
        """Acquire a processing slot for a request"""
        with self._lock:
            can_process, reason = self.can_process_request(request.user_id)
            if not can_process:
                logger.warning(f"Request {request.id} rejected: {reason}")
                return False
            
            # Acquire slot
            self.active_requests[request.id] = request
            if request.user_id:
                self.user_request_counts[request.user_id] = self.user_request_counts.get(request.user_id, 0) + 1
            
            request.started_at = datetime.now()
            logger.info(f"Acquired slot for request {request.id} (user: {request.user_id})")
            return True
    
    def release_slot(self, request_id: str) -> None:
        """Release a processing slot"""
        with self._lock:
            if request_id in self.active_requests:
                request = self.active_requests[request_id]
                del self.active_requests[request_id]
                
                if request.user_id:
                    self.user_request_counts[request.user_id] = max(0, self.user_request_counts.get(request.user_id, 0) - 1)
                    if self.user_request_counts[request.user_id] == 0:
                        del self.user_request_counts[request.user_id]
                
                duration = (datetime.now() - request.started_at).total_seconds() if request.started_at else 0
                logger.info(f"Released slot for request {request_id} after {duration:.1f}s")
    
    def get_active_requests(self) -> List[ProcessingRequest]:
        """Get list of currently active requests"""
        with self._lock:
            return list(self.active_requests.values())
    
    def get_stats(self) -> Dict[str, Any]:
        """Get request limiter statistics"""
        with self._lock:
            return {
                'active_requests': len(self.active_requests),
                'max_concurrent': self.max_concurrent,
                'max_per_user': self.max_per_user,
                'user_counts': dict(self.user_request_counts),
                'utilization': len(self.active_requests) / self.max_concurrent
            }


class ResultCache:
    """Caches AI processing results to avoid redundant operations"""
    
    def __init__(self, default_ttl: int = 3600):  # 1 hour default
        self.default_ttl = default_ttl
        self.cache_hits = 0
        self.cache_misses = 0
        self._lock = threading.Lock()
        
        logger.info(f"Result cache initialized with {default_ttl}s TTL")
    
    def _generate_cache_key(self, service_name: str, function_name: str, 
                          image_path: str, params: Dict[str, Any]) -> str:
        """Generate a cache key for the operation"""
        # Include file modification time and size for cache invalidation
        try:
            stat = os.stat(image_path)
            file_info = f"{stat.st_mtime}_{stat.st_size}"
        except OSError:
            file_info = "unknown"
        
        # Create hash of parameters
        param_str = str(sorted(params.items())) if params else ""
        content = f"{service_name}_{function_name}_{image_path}_{file_info}_{param_str}"
        
        return f"ai_result_{hashlib.md5(content.encode()).hexdigest()}"
    
    def get(self, service_name: str, function_name: str, image_path: str, 
            params: Dict[str, Any] = None) -> Optional[Any]:
        """Get cached result if available"""
        cache_key = self._generate_cache_key(service_name, function_name, image_path, params or {})
        
        try:
            result = cache.get(cache_key)
            with self._lock:
                if result is not None:
                    self.cache_hits += 1
                    logger.debug(f"Cache hit for {service_name}.{function_name}")
                else:
                    self.cache_misses += 1
                    logger.debug(f"Cache miss for {service_name}.{function_name}")
            
            return result
        except Exception as e:
            logger.warning(f"Cache get error: {e}")
            return None
    
    def set(self, service_name: str, function_name: str, image_path: str, 
            result: Any, params: Dict[str, Any] = None, ttl: Optional[int] = None) -> None:
        """Cache a processing result"""
        cache_key = self._generate_cache_key(service_name, function_name, image_path, params or {})
        cache_ttl = ttl or self.default_ttl
        
        try:
            cache.set(cache_key, result, timeout=cache_ttl)
            logger.debug(f"Cached result for {service_name}.{function_name} (TTL: {cache_ttl}s)")
        except Exception as e:
            logger.warning(f"Cache set error: {e}")
    
    def invalidate(self, service_name: str, function_name: str, image_path: str, 
                   params: Dict[str, Any] = None) -> None:
        """Invalidate a cached result"""
        cache_key = self._generate_cache_key(service_name, function_name, image_path, params or {})
        
        try:
            cache.delete(cache_key)
            logger.debug(f"Invalidated cache for {service_name}.{function_name}")
        except Exception as e:
            logger.warning(f"Cache invalidation error: {e}")
    
    def get_hit_rate(self) -> float:
        """Get cache hit rate"""
        with self._lock:
            total = self.cache_hits + self.cache_misses
            return self.cache_hits / total if total > 0 else 0.0
    
    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        with self._lock:
            return {
                'hits': self.cache_hits,
                'misses': self.cache_misses,
                'hit_rate': self.get_hit_rate(),
                'total_requests': self.cache_hits + self.cache_misses
            }


class MemoryOptimizer:
    """Optimizes memory usage for large image processing"""
    
    def __init__(self, max_image_size_mb: int = None, target_size_mb: int = None):
        # Auto-detect system memory and configure accordingly
        self._detect_system_memory()
        
        # Calculate optimal image size limits based on available memory
        if max_image_size_mb is None:
            max_image_size_mb = self._calculate_max_image_size()
        if target_size_mb is None:
            target_size_mb = self._calculate_target_size()
        
        self.max_image_size_mb = max_image_size_mb
        self.target_size_mb = target_size_mb  # Can be None
        self.processed_images = 0
        self.bytes_saved = 0
        
        target_str = f"{self.target_size_mb}MB" if self.target_size_mb else "no limit"
        logger.info(f"Memory optimizer auto-configured: {self.memory_gb:.1f}GB RAM, "
                   f"max_image={self.max_image_size_mb}MB, target={target_str}")
    
    def _detect_system_memory(self):
        """Auto-detect system memory"""
        from .system_info import get_system_info
        
        system_info = get_system_info()
        self.memory_gb = system_info['memory']['total_gb']
        self.recommendations = system_info['recommendations']
    
    def _calculate_max_image_size(self) -> int:
        """Calculate max image size based on available memory"""
        # Use system recommendations if available
        if hasattr(self, 'recommendations'):
            return self.recommendations['max_image_size_mb']
        
        # Fallback - always use 100MB as requested
        return 100
    
    def _calculate_target_size(self) -> Optional[int]:
        """Calculate target optimization size based on available memory"""
        # Use system recommendations if available
        if hasattr(self, 'recommendations'):
            return self.recommendations['target_image_size_mb']  # Will be None as requested
        
        # Fallback - no target size as requested
        return None
    
    def optimize_image_for_processing(self, image_path: str) -> Tuple[str, Dict[str, Any]]:
        """Optimize image size for AI processing while preserving quality"""
        try:
            # Check file size
            file_size_mb = os.path.getsize(image_path) / (1024 * 1024)
            
            if file_size_mb <= self.max_image_size_mb and self.target_size_mb is None:
                # No optimization needed when no target size is set
                return image_path, {'optimized': False, 'original_size_mb': file_size_mb}
            
            if self.target_size_mb and file_size_mb <= self.target_size_mb:
                # Already within target size
                return image_path, {'optimized': False, 'original_size_mb': file_size_mb}
            
            # Load and analyze image
            with Image.open(image_path) as img:
                original_size = img.size
                original_format = img.format
                
                # Calculate optimal dimensions based on available memory and file size
                # Only resize if image exceeds max_image_size_mb
                should_resize = file_size_mb > self.max_image_size_mb
                
                if should_resize:
                    if self.memory_gb <= 6:
                        max_dimension = 1024  # Conservative for low memory
                    elif self.memory_gb <= 8:
                        max_dimension = 1536  # Moderate for medium memory
                    else:
                        max_dimension = 2048  # Standard for high memory
                else:
                    # Don't resize if within limits
                    return image_path, {'optimized': False, 'original_size_mb': file_size_mb}
                
                # Resize if needed
                if max(original_size) > max_dimension:
                    ratio = max_dimension / max(original_size)
                    new_size = (int(original_size[0] * ratio), int(original_size[1] * ratio))
                    
                    # Create optimized version
                    optimized_img = img.resize(new_size, Image.Resampling.LANCZOS)
                    
                    # Save optimized version
                    base_name, ext = os.path.splitext(image_path)
                    optimized_path = f"{base_name}_optimized{ext}"
                    
                    # Use appropriate quality settings
                    save_kwargs = {}
                    if original_format == 'JPEG':
                        save_kwargs = {'quality': 85, 'optimize': True}
                    elif original_format == 'PNG':
                        save_kwargs = {'optimize': True}
                    
                    optimized_img.save(optimized_path, format=original_format, **save_kwargs)
                    
                    # Calculate savings
                    optimized_size_mb = os.path.getsize(optimized_path) / (1024 * 1024)
                    self.bytes_saved += (file_size_mb - optimized_size_mb) * 1024 * 1024
                    self.processed_images += 1
                    
                    logger.info(f"Optimized image: {file_size_mb:.1f}MB -> {optimized_size_mb:.1f}MB")
                    
                    return optimized_path, {
                        'optimized': True,
                        'original_size_mb': file_size_mb,
                        'optimized_size_mb': optimized_size_mb,
                        'original_dimensions': original_size,
                        'optimized_dimensions': new_size,
                        'compression_ratio': optimized_size_mb / file_size_mb
                    }
                else:
                    return image_path, {'optimized': False, 'original_size_mb': file_size_mb}
                    
        except Exception as e:
            logger.error(f"Image optimization failed: {e}")
            return image_path, {'optimized': False, 'error': str(e)}
    
    def cleanup_optimized_images(self, max_age_hours: int = 24) -> None:
        """Clean up old optimized images"""
        try:
            cutoff_time = time.time() - (max_age_hours * 3600)
            cleaned_count = 0
            
            # This is a simplified cleanup - in production you'd want a more robust system
            for root, dirs, files in os.walk(settings.MEDIA_ROOT):
                for file in files:
                    if '_optimized' in file:
                        file_path = os.path.join(root, file)
                        if os.path.getmtime(file_path) < cutoff_time:
                            try:
                                os.remove(file_path)
                                cleaned_count += 1
                            except OSError:
                                pass
            
            if cleaned_count > 0:
                logger.info(f"Cleaned up {cleaned_count} old optimized images")
                
        except Exception as e:
            logger.error(f"Cleanup failed: {e}")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get memory optimization statistics"""
        return {
            'processed_images': self.processed_images,
            'bytes_saved': self.bytes_saved,
            'mb_saved': self.bytes_saved / (1024 * 1024),
            'max_image_size_mb': self.max_image_size_mb,
            'target_size_mb': self.target_size_mb
        }


class ResourceManager:
    """Central resource management for AI processing"""
    
    def __init__(self):
        # Auto-detect system resources and configure accordingly
        self._detect_system_resources()
        
        # Initialize components with auto-detected configuration
        self.request_limiter = ConcurrentRequestLimiter()
        self.result_cache = ResultCache(
            default_ttl=getattr(settings, 'AI_CACHE_TTL', 3600)
        )
        self.memory_optimizer = MemoryOptimizer()
        
        # Resource monitoring with dynamic thresholds
        self._monitoring_enabled = True
        self._last_cleanup = datetime.now()
        self._memory_threshold = self._calculate_memory_threshold()
        self._cpu_threshold = self._calculate_cpu_threshold()
        
        logger.info(f"Resource Manager auto-configured: {self.cpu_cores} cores, "
                   f"{self.memory_gb:.1f}GB RAM, memory_threshold={self._memory_threshold}%, "
                   f"cpu_threshold={self._cpu_threshold}%")
    
    def _detect_system_resources(self):
        """Auto-detect system resources"""
        from .system_info import get_system_info
        
        system_info = get_system_info()
        self.cpu_cores = system_info['cpu']['cores']
        self.memory_gb = system_info['memory']['total_gb']
        self.recommendations = system_info['recommendations']
    
    def _calculate_memory_threshold(self) -> int:
        """Calculate memory usage threshold based on available memory"""
        # Use system recommendations if available
        if hasattr(self, 'recommendations'):
            return self.recommendations['memory_threshold']
        
        # Fallback calculation
        if self.memory_gb <= 6:
            return 75  # Conservative for low memory
        elif self.memory_gb <= 8:
            return 80  # Moderate for medium memory
        else:
            return 85  # Less conservative for high memory
    
    def _calculate_cpu_threshold(self) -> int:
        """Calculate CPU usage threshold based on available cores"""
        # Use system recommendations if available
        if hasattr(self, 'recommendations'):
            return self.recommendations['cpu_threshold']
        
        # Fallback calculation
        if self.cpu_cores <= 2:
            return 80  # Conservative for dual core
        elif self.cpu_cores <= 4:
            return 85  # Moderate for quad core
        else:
            return 90  # Less conservative for high core count
    
    def process_with_resource_management(self, service_name: str, function_name: str,
                                       image_path: str, user_id: Optional[str] = None,
                                       params: Dict[str, Any] = None,
                                       use_cache: bool = True,
                                       optimize_memory: bool = True) -> Tuple[Any, Dict[str, Any]]:
        """Process request with full resource management"""
        
        params = params or {}
        metadata = {
            'cache_used': False,
            'memory_optimized': False,
            'request_queued': False,
            'processing_time': 0.0
        }
        
        start_time = time.time()
        
        try:
            # 1. Check cache first
            if use_cache:
                cached_result = self.result_cache.get(service_name, function_name, image_path, params)
                if cached_result is not None:
                    metadata['cache_used'] = True
                    metadata['processing_time'] = time.time() - start_time
                    return cached_result, metadata
            
            # 2. Optimize image memory usage
            processed_image_path = image_path
            if optimize_memory:
                processed_image_path, opt_info = self.memory_optimizer.optimize_image_for_processing(image_path)
                metadata['memory_optimized'] = opt_info.get('optimized', False)
                metadata['optimization_info'] = opt_info
            
            # 3. Check if we can process the request
            request = ProcessingRequest(
                id=f"{service_name}_{function_name}_{int(time.time())}",
                service_name=service_name,
                function_name=function_name,
                user_id=user_id
            )
            
            if not self.request_limiter.acquire_slot(request):
                # Queue for background processing
                from .background_processor import queue_ai_operation
                job_id = queue_ai_operation(
                    service_name=service_name,
                    function_name=function_name,
                    image_path=processed_image_path,
                    user_id=user_id,
                    **params
                )
                metadata['request_queued'] = True
                metadata['background_job_id'] = job_id
                return None, metadata
            
            try:
                # 4. Execute the actual processing
                # This would be replaced with actual service calls
                result = self._execute_processing(service_name, function_name, processed_image_path, params)
                
                # 5. Cache the result
                if use_cache and result is not None:
                    self.result_cache.set(service_name, function_name, image_path, result, params)
                
                metadata['processing_time'] = time.time() - start_time
                return result, metadata
                
            finally:
                # Always release the slot
                self.request_limiter.release_slot(request.id)
                
                # Cleanup optimized image if created
                if optimize_memory and processed_image_path != image_path:
                    try:
                        os.remove(processed_image_path)
                    except OSError:
                        pass
        
        except Exception as e:
            metadata['error'] = str(e)
            metadata['processing_time'] = time.time() - start_time
            raise
    
    def _execute_processing(self, service_name: str, function_name: str, 
                          image_path: str, params: Dict[str, Any]) -> Any:
        """Execute the actual AI processing (placeholder)"""
        # This is a placeholder - actual implementation would call the appropriate service
        logger.info(f"Executing {service_name}.{function_name} on {image_path}")
        
        # Simulate processing time
        time.sleep(0.1)
        
        return {
            'success': True,
            'service': service_name,
            'function': function_name,
            'processed_at': datetime.now().isoformat()
        }
    
    def get_resource_metrics(self) -> ResourceMetrics:
        """Get current resource usage metrics"""
        try:
            # Get system metrics
            cpu_percent = psutil.cpu_percent(interval=0.1)
            memory = psutil.virtual_memory()
            
            # Get AI processing metrics
            limiter_stats = self.request_limiter.get_stats()
            cache_stats = self.result_cache.get_stats()
            
            return ResourceMetrics(
                cpu_percent=cpu_percent,
                memory_percent=memory.percent,
                memory_available_mb=memory.available / (1024 * 1024),
                active_requests=limiter_stats['active_requests'],
                queue_size=0,  # Would get from background processor
                cache_hit_rate=cache_stats['hit_rate']
            )
        except Exception as e:
            logger.error(f"Failed to get resource metrics: {e}")
            return ResourceMetrics(
                cpu_percent=0.0,
                memory_percent=0.0,
                memory_available_mb=0,
                active_requests=0,
                queue_size=0,
                cache_hit_rate=0.0
            )
    
    def perform_maintenance(self) -> None:
        """Perform periodic maintenance tasks"""
        try:
            # Clean up old optimized images
            self.memory_optimizer.cleanup_optimized_images()
            
            # Update last cleanup time
            self._last_cleanup = datetime.now()
            
            logger.info("Resource manager maintenance completed")
        except Exception as e:
            logger.error(f"Maintenance failed: {e}")
    
    def get_comprehensive_stats(self) -> Dict[str, Any]:
        """Get comprehensive resource management statistics"""
        return {
            'request_limiter': self.request_limiter.get_stats(),
            'result_cache': self.result_cache.get_stats(),
            'memory_optimizer': self.memory_optimizer.get_stats(),
            'resource_metrics': self.get_resource_metrics().__dict__,
            'last_maintenance': self._last_cleanup.isoformat()
        }


# Global instance
_resource_manager = None

def get_resource_manager() -> ResourceManager:
    """Get the global resource manager instance"""
    global _resource_manager
    if _resource_manager is None:
        _resource_manager = ResourceManager()
    return _resource_manager