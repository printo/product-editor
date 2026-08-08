"""
API Middleware
Contains logging and rate limiting for API requests.
"""
import re
import time
import logging
from django.http import JsonResponse
from django.utils.deprecation import MiddlewareMixin

logger = logging.getLogger(__name__)


def _get_client_ip(request):
    """
    Resolve the real client IP.

    Trust ONLY headers nginx sets from its real_ip resolution of
    CF-Connecting-IP (proxy/nginx/nginx.conf), never the left-most
    X-Forwarded-For hop — that token is fully client-controlled, so reading it
    let an attacker mint unlimited rate-limit buckets by rotating a forged IP
    (and grief a victim by forging theirs). X-Real-IP is the resolved client IP;
    the RIGHT-most XFF hop is the value nginx appends ($remote_addr);
    REMOTE_ADDR is the last resort.

    Shared by the rate limiter and the audit trail so a spoofed address can
    never be believed by one and rejected by the other.
    """
    x_real_ip = request.META.get('HTTP_X_REAL_IP')
    if x_real_ip:
        return x_real_ip.strip()
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        return x_forwarded_for.split(',')[-1].strip()
    return request.META.get('REMOTE_ADDR', '0.0.0.0')


class APIRequestLoggingMiddleware(MiddlewareMixin):
    """
    Logs API activity to the container log AND to the APIRequest table.

    The table existed from the initial commit but nothing ever wrote to it, so
    `APIRequest.objects.count()` was 0 for every key forever. That is a trap: it
    reads like an audit trail, and a "0 requests" answer looks like proof a
    credential was never used when it is really proof nothing was ever recorded.
    Container logs were the only history, and they rotate at 50 MB x 3.

    Persisting here gives DPDP questions ("who downloaded this order's files,
    and when?") an answer that outlives log rotation.
    """

    # High-frequency paths that would swamp the table without adding anything an
    # investigation would want. Chunk PUTs fire hundreds of times per order and
    # the /complete call that finalises the file IS recorded; render-status is
    # polled every few seconds for the life of a job.
    AUDIT_EXEMPT_PREFIXES = (
        '/api/health',
        '/api/config',
        '/api/render-status/',
    )
    AUDIT_EXEMPT_RE = re.compile(r'^/api/upload/[^/]+/chunk')

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
            self._record_audit(request, response, duration, user_label)

        return response

    def _should_audit(self, path: str) -> bool:
        if not path.startswith('/api/'):
            return False
        if path.startswith(self.AUDIT_EXEMPT_PREFIXES):
            return False
        return not self.AUDIT_EXEMPT_RE.match(path)

    def _record_audit(self, request, response, duration, user_label):
        """
        Persist one audit row. Never allowed to affect the response: an audit
        trail that can 500 the API is worse than no audit trail.
        """
        if not self._should_audit(request.path):
            return
        try:
            from api.models import APIRequest

            APIRequest.objects.create(
                api_key=getattr(request, '_api_auth_key', None),
                auth_source=(user_label or 'anonymous')[:100],
                endpoint=request.path[:255],
                method=(request.method or '')[:10],
                status_code=response.status_code,
                response_time_ms=int(duration * 1000),
                request_size_bytes=int(request.META.get('CONTENT_LENGTH') or 0),
                response_size_bytes=int(response.get('Content-Length') or 0),
                # Trust nginx's X-Real-IP (else the RIGHT-most XFF hop); the
                # left-most hop is client-controlled and trivially spoofed.
                ip_address=_get_client_ip(request),
                user_agent=(request.META.get('HTTP_USER_AGENT') or '')[:500],
            )
        except Exception as exc:  # noqa: BLE001 — audit must never break traffic
            logger.warning("Audit write failed for %s: %s", request.path, exc)


class RateLimitMiddleware(MiddlewareMixin):
    """Rate limiting using Django cache backend.

    Works correctly across multiple Gunicorn workers because all workers
    share the same cache. Swap the cache backend in settings.py to Redis
    (django-redis) for production-grade enforcement; LocMemCache is
    per-process so limits are still per-worker with that backend.

    Limits: RATE_LIMIT requests per WINDOW_SECONDS per IP.

    Bursty paths (chunked upload init/chunk/complete, render-status
    polling) are exempt — they have their own safeguards (auth-gated,
    UUID-validated, per-file size limits) and a customer uploading a
    200-photo calendar legitimately fires ~600 API calls in <60 s.
    """

    RATE_LIMIT = 200        # requests allowed per window (general API)
    WINDOW_SECONDS = 60     # rolling window length in seconds

    # Path prefixes that bypass the rate limit. Order matters: longest /
    # most-specific first so the prefix check is unambiguous.
    EXEMPT_PREFIXES = (
        '/api/upload/',          # chunked-upload init/chunk/complete
        '/api/render-status/',   # polled every few seconds during render
        '/api/jobs/',            # ZIP download (single hit but large body)
        '/api/health',           # docker healthcheck (every 30 s)
    )

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith('/api/') and not any(
            request.path.startswith(p) for p in self.EXEMPT_PREFIXES
        ):
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
                    response = JsonResponse({
                        'error': 'Rate limit exceeded',
                        'detail': 'Too many requests. Please try again later.',
                        'retry_after': self.WINDOW_SECONDS,
                    }, status=429)
                    # RFC 6585 §4 — standard header; HTTP clients and proxies
                    # use this, not the JSON body field.
                    response['Retry-After'] = str(self.WINDOW_SECONDS)
                    return response
            except Exception as exc:
                # If the cache backend is unavailable, fail open to avoid
                # blocking legitimate traffic.
                logger.error(f"Rate limit cache error: {exc}")

        return self.get_response(request)

    def _get_client_ip(self, request):
        return _get_client_ip(request)
