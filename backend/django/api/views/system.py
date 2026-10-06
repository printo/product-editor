"""Service endpoints: health check, public runtime config, CSP violation reports."""
import json
import time
import logging
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status
import sentry_sdk
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers as drf_serializers

logger = logging.getLogger(__name__)


class HealthView(APIView):
    """Health check endpoint - public access."""
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["health"],
        summary="Service health check",
        description="Returns `ok` if the service and database are reachable. No authentication required.",
        responses={
            200: inline_serializer(
                name="HealthResponse",
                fields={
                    "status": drf_serializers.CharField(default="ok"),
                    "database": drf_serializers.CharField(default="connected"),
                    "timestamp": drf_serializers.IntegerField(),
                },
            )
        },
    )
    def get(self, request):
        return Response({
            "status": "ok",
            "database": "connected",
            "timestamp": int(time.time() * 1000)
        })


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
        logger.warning(
            "CSP violation: directive=%s blocked=%s document=%s",
            report.get("violated-directive") or report.get("effective-directive"),
            report.get("blocked-uri"),
            report.get("document-uri"),
            extra={"csp_report": report},
        )
        # No-ops safely if SENTRY_DSN isn't set (sentry_sdk.capture_message
        # returns None when no client is initialized) — see settings.py's
        # "Sentry Error Tracking Initialization" for the one-time init.
        sentry_sdk.capture_message(
            f"CSP violation: {report.get('violated-directive') or report.get('effective-directive') or 'unknown'}",
            level="warning",
        )
        # 204: browsers don't read the response body for report-uri deliveries.
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
