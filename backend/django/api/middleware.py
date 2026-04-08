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
            # _api_auth_source is written onto the Django request by
            # BearerTokenAuthentication / PIAAuthentication so the resolved
            # auth source is available here even though DRF's user wrapper is
            # already discarded by the time this middleware phase runs.
            user_label = getattr(request, '_api_auth_source', 'anonymous')
            logger.info(f"API Response: {response.status_code} in {duration:.3f}s [Source: {user_label}]")
        
        return response


class RateLimitMiddleware(MiddlewareMixin):
    """Rate limiting using Django cache backend.

    Works correctly across multiple Gunicorn workers because all workers
    share the same cache. Swap the cache backend in settings.py to Redis
    (django-redis) for production-grade enforcement; LocMemCache is
    per-process so limits are still per-worker with that backend.

    Limits: RATE_LIMIT requests per WINDOW_SECONDS per IP.
    """

    RATE_LIMIT = 100        # requests allowed per window
    WINDOW_SECONDS = 60     # rolling window length in seconds

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith('/api/'):
            client_ip = self._get_client_ip(request)
            cache_key = f'ratelimit:{client_ip}'

            try:
                from django.core.cache import cache
                # cache.add is atomic: sets key=1 with TTL only if absent.
                # If key already exists, add() returns False and we increment.
                if not cache.add(cache_key, 1, self.WINDOW_SECONDS):
                    count = cache.incr(cache_key)
                else:
                    count = 1

                if count > self.RATE_LIMIT:
                    logger.warning(
                        f"Rate limit exceeded for IP {client_ip} "
                        f"(count={count}, limit={self.RATE_LIMIT})"
                    )
                    return JsonResponse({
                        'error': 'Rate limit exceeded',
                        'detail': 'Too many requests. Please try again later.',
                        'retry_after': self.WINDOW_SECONDS,
                    }, status=429)
            except Exception as exc:
                # If the cache backend is unavailable, fail open to avoid
                # blocking legitimate traffic.
                logger.error(f"Rate limit cache error: {exc}")

        return self.get_response(request)

    def _get_client_ip(self, request):
        x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
        if x_forwarded_for:
            return x_forwarded_for.split(',')[0].strip()
        return request.META.get('REMOTE_ADDR', '0.0.0.0')
