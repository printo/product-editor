"""Service endpoints: health check, public runtime config, CSP violation reports, frontend error reports."""
import json
import re
import time
import logging
from urllib.parse import urlparse

from django.conf import settings
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status
from api.authentication import BearerTokenAuthentication
from django.db import connection
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers as drf_serializers

logger = logging.getLogger(__name__)


def _log_safe(value, limit: int = 300) -> str:
    """A value from an untrusted body, as one printable line of bounded length."""
    text = value if isinstance(value, str) else ('' if value is None else str(type(value).__name__))
    return ''.join(ch if ch.isprintable() else ' ' for ch in text)[:limit]


class HealthView(APIView):
    """Health check endpoint - public access."""
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["health"],
        summary="Service health check",
        description=(
            "Returns `ok` if the service and database are reachable. No authentication required. "
            "Answers **503** with `database: unavailable` when Postgres cannot be reached, so the "
            "deploy health gate and the load balancer see an unhealthy backend."
        ),
        responses={
            200: inline_serializer(
                name="HealthResponse",
                fields={
                    "status": drf_serializers.CharField(default="ok"),
                    "database": drf_serializers.CharField(default="connected"),
                    "timestamp": drf_serializers.IntegerField(),
                },
            ),
            503: inline_serializer(
                name="HealthUnavailable",
                fields={
                    "status": drf_serializers.CharField(default="unavailable"),
                    "database": drf_serializers.CharField(default="unavailable"),
                    "timestamp": drf_serializers.IntegerField(),
                },
            ),
        },
    )
    def get(self, request):
        timestamp = int(time.time() * 1000)
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
        except Exception:
            logger.error("Health check: database unreachable", exc_info=True)
            return Response(
                {"status": "unavailable", "database": "unavailable", "timestamp": timestamp},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response({"status": "ok", "database": "connected", "timestamp": timestamp})


class CSPReportView(APIView):
    """
    Public, unauthenticated sink for browser-generated CSP violation reports.

    Both django-csp's own policy (CSP_REPORT_URI below) and the Next.js
    frontend's parallel copy (next.config.mjs) point their `report-uri` here —
    nginx routes all of /api/* to this backend regardless of which app
    rendered the page that violated, so one endpoint covers both. Never
    called by anything but a browser; there is no legitimate manual use.
    """
    permission_classes = [AllowAny]
    authentication_classes = []

    @extend_schema(
        tags=["csp"],
        summary="CSP violation report sink",
        description="Browsers POST here automatically per the `report-uri` CSP directive. Not meant to be called directly.",
        auth=[],
        request=None,
        responses={204: None},
    )
    def post(self, request):
        try:
            payload = json.loads(request.body or b"{}")
        except (ValueError, UnicodeDecodeError):
            payload = {}
        # Legacy report-uri format wraps the report in a "csp-report" key;
        # tolerate a bare report body too in case a browser ever sends one.
        report = payload.get("csp-report", payload) if isinstance(payload, dict) else {}
        # A browser sends a dict, but anyone can POST here: a list or a string
        # under "csp-report" used to raise on .get() and answer 500, and values
        # went into the log line as sent, so a newline in one forged a log entry.
        if not isinstance(report, dict):
            report = {}
        directive = _log_safe(report.get("violated-directive") or report.get("effective-directive"))
        logger.warning(
            "CSP violation: directive=%s blocked=%s document=%s",
            directive,
            _log_safe(report.get("blocked-uri")),
            _log_safe(report.get("document-uri")),
        )
        # 204: browsers don't read the response body for report-uri deliveries.
        return Response(status=status.HTTP_204_NO_CONTENT)


# Browser messages that say nothing about our code: a script from another
# origin (the browser hides its details), a layout warning Chrome raises as an
# error, and anything thrown by a browser extension.
_CLIENT_NOISE = re.compile(
    r"^Script error\.?$|ResizeObserver loop|chrome-extension://|moz-extension://|"
    r"safari-(web-)?extension://|webkit-masked-url://",
    re.IGNORECASE,
)
_CLIENT_REPORT_MAX_BYTES = 16 * 1024


def _same_site_origin(request) -> bool:
    """True when the report came from a page served by this site.

    Anyone can POST here, so a report must carry the Origin header a browser
    adds to a fetch, naming this host. In DEBUG a localhost page counts too
    (the dev frontend runs on another port).
    """
    origin = request.META.get("HTTP_ORIGIN", "")
    origin_host = urlparse(origin).hostname or ""
    if not origin_host:
        return False
    try:
        own_host = request.get_host().split(":")[0]
    except Exception:
        return False
    if origin_host == own_host:
        return True
    return bool(settings.DEBUG) and origin_host in ("localhost", "127.0.0.1")


class ClientErrorReportView(APIView):
    """
    Errors from the frontend, passed on to the team's Google Chat space.

    The browser posts uncaught errors here (``lib/client-error-report.ts``),
    and the Next.js server posts its own request errors with the internal API
    key (``src/instrumentation.ts``). The webhook address stays on the
    server; the browser never sees it. Every report is also written to the
    backend log. Repeats are grouped and the space has a per-minute ceiling
    (``services/error_alerts.py``), on top of the per-IP rate limit.
    """
    permission_classes = [AllowAny]
    authentication_classes = [BearerTokenAuthentication]

    @extend_schema(
        tags=["health"],
        summary="Report a frontend error",
        description=(
            "Used by the editor's own pages. A browser report must come from a page of this site "
            "(its `Origin` header); the frontend server authenticates with its API key instead. "
            "Always answers 204, whether or not the report was passed on."
        ),
        auth=[],
        request=inline_serializer(
            name="ClientErrorReport",
            fields={
                "kind": drf_serializers.CharField(required=False),
                "level": drf_serializers.ChoiceField(choices=["error", "warning"], required=False),
                "message": drf_serializers.CharField(),
                "stack": drf_serializers.CharField(required=False),
                "source": drf_serializers.CharField(required=False),
                "line": drf_serializers.IntegerField(required=False),
                "column": drf_serializers.IntegerField(required=False),
                "page": drf_serializers.CharField(required=False),
                "embed": drf_serializers.BooleanField(required=False),
                "userAgent": drf_serializers.CharField(required=False),
            },
        ),
        responses={204: None},
    )
    def post(self, request):
        from services.error_alerts import send_alert

        # The Next.js server presents INTERNAL_API_KEY, an ops-flagged key; a
        # partner's key does not make a report "ours".
        from_frontend_server = request.auth is not None and bool(
            getattr(request.user, "is_ops_team", False)
        )
        if not from_frontend_server and not _same_site_origin(request):
            return Response(status=status.HTTP_204_NO_CONTENT)
        if len(request.body or b"") > _CLIENT_REPORT_MAX_BYTES:
            return Response(status=status.HTTP_204_NO_CONTENT)
        try:
            report = json.loads(request.body or b"{}")
        except (ValueError, UnicodeDecodeError):
            report = {}
        if not isinstance(report, dict):
            report = {}

        def text(key, limit):
            value = report.get(key)
            return _log_safe(value, limit) if isinstance(value, str) else ""

        message = text("message", 500)
        stack = report.get("stack") if isinstance(report.get("stack"), str) else ""
        source_file = text("source", 300)
        if not message or _CLIENT_NOISE.search(message) or _CLIENT_NOISE.search(source_file) \
                or _CLIENT_NOISE.search(stack[:2000]):
            return Response(status=status.HTTP_204_NO_CONTENT)

        kind = text("kind", 40) or "error"
        level = "warning" if report.get("level") == "warning" else "error"
        page = text("page", 300).split("?")[0]
        line = report.get("line") if isinstance(report.get("line"), int) else None
        where = page or ""
        if source_file:
            short = source_file.split("?")[0].rsplit("/", 1)[-1]
            where = f"{where} · {short}{f':{line}' if line else ''}" if where else short
        who = "Frontend server" if from_frontend_server else (
            "Browser (embed)" if report.get("embed") is True else "Browser"
        )

        logger.warning("Frontend %s from %s: %s (%s)", kind, who, message, _log_safe(where))

        details = stack[:3000]
        user_agent = text("userAgent", 200)
        if user_agent:
            details = f"{details}\n\nBrowser: {user_agent}" if details else f"Browser: {user_agent}"
        send_alert(
            level=level,
            source=who,
            title=message,
            where=where,
            details=details,
            signature=f"client|{kind}|{re.sub(r'[0-9]+', '#', message)[:160]}|{source_file.split('?')[0]}",
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ConfigView(APIView):
    """
    Public runtime-config endpoint — exposes a handful of settings the
    browser needs to know to decide which feature paths to activate.

    Kept deliberately tiny so it's safe to hit on every editor mount.
    Anything sensitive (API keys, secrets) MUST NOT be added here.
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["config"],
        summary="Public runtime configuration",
        description=(
            "Read-only config flags the frontend needs at boot. Currently "
            "exposes `autoOrientationMode` ('off' | 'mediapipe' | 'hybrid'); "
            "the frontend uses this to decide whether to load the MediaPipe "
            "BlazeFace model and whether to fall through to the server-side "
            "MoveNet pose endpoint when no face is detected client-side."
        ),
        responses={
            200: inline_serializer(
                name="ConfigResponse",
                fields={
                    "autoOrientationMode": drf_serializers.CharField(),
                },
            )
        },
    )
    def get(self, request):
        from django.conf import settings as _s
        response = Response({
            "autoOrientationMode": getattr(_s, "AUTO_ORIENTATION_MODE", "mediapipe"),
        })
        # Brief browser cache so the editor doesn't refetch every navigation;
        # operator restart of backend will still propagate within ~30 s.
        response['Cache-Control'] = 'public, max-age=30, stale-while-revalidate=60'
        return response
