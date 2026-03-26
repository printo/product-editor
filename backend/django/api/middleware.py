"""
API Middleware
Contains logging and rate limiting for API requests.
"""
import time
import logging
from django.http import JsonResponse
from django.utils.deprecation import MiddlewareMixin

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
