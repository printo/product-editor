"""Icons for the editor's Icons tab, served from our own cache (services/icon_store.py)."""
import logging

from django.http import HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from services import icon_store
from ..permissions import IsAuthenticatedWithAPIKey

logger = logging.getLogger(__name__)

# How long a browser should wait before asking again for an icon we could not
# fetch: long enough for our spending window to move on.
RETRY_AFTER_SECONDS = 60


def _try_later(detail: str) -> Response:
    response = Response({'detail': detail}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
    response['Retry-After'] = str(RETRY_AFTER_SECONDS)
    return response


class IconSvgView(APIView):
    """
    GET /api/icons/<prefix>/<name>.svg — one icon, from our cache.

    Public, like the masks and template stickers: an `<img>` and the canvas
    load it by address and cannot send an API key. It only ever returns an
    icon from a fixed public library, and what it may fetch is bounded by the
    store's spending cap.
    """
    permission_classes = [AllowAny]
    authentication_classes = []

    @extend_schema(
        tags=["icons"],
        summary="Get an icon",
        description=(
            "An icon's SVG from the public Iconify library, served from this "
            "server's permanent cache. The editor's Icons tab, its canvas and "
            "the print's icon raster all load icons here; no browser talks to "
            "Iconify, whose per-address rate limit used to turn the tiles into "
            "broken images.\n\n"
            "Cached for a year (an icon never changes). **503** with "
            "`Retry-After` when the icon is not cached yet and cannot be fetched "
            "just now (Iconify unreachable, or this server's fetch budget for "
            "the window is spent)."
        ),
        responses={
            (200, "image/svg+xml"): OpenApiTypes.BINARY,
            404: OpenApiResponse(description="No such icon."),
            503: OpenApiResponse(description="Not cached and not fetchable just now; retry later."),
        },
        auth=[],
    )
    def get(self, request, prefix, name):
        try:
            data = icon_store.icon_svg(prefix, name)
        except icon_store.IconNotFound:
            return Response({'detail': 'No such icon.'}, status=status.HTTP_404_NOT_FOUND)
        except icon_store.IconUnavailable as exc:
            logger.warning("Icon %s:%s unavailable: %s", prefix, name, exc)
            return _try_later('Icon unavailable, try again shortly.')
        response = HttpResponse(data, content_type='image/svg+xml')
        response['Cache-Control'] = 'public, max-age=31536000, immutable'
        response['X-Content-Type-Options'] = 'nosniff'
        # Opened as a page rather than as an image, an SVG is a document on our origin.
        response['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        return response


class IconSearchView(APIView):
    """GET /api/icon-search?q=<words> — icon names for the Icons tab's search box."""
    permission_classes = [IsAuthenticatedWithAPIKey]

    @extend_schema(
        tags=["icons"],
        summary="Search icons",
        description=(
            "Up to 60 icons from the Iconify library matching `q`. Answers are "
            "kept for a week, and a new search also stores the icons it found, "
            "so the tiles that follow load from this server's cache.\n\n"
            "Load each with `GET /api/icons/<prefix>/<name>.svg`."
        ),
        parameters=[OpenApiParameter("q", str, description="Two to fifty letters or numbers.", required=True)],
        responses={
            200: inline_serializer(
                name="IconSearchResponse",
                fields={"icons": drf_serializers.ListField(child=inline_serializer(
                    name="IconName",
                    fields={"prefix": drf_serializers.CharField(), "name": drf_serializers.CharField()},
                ))},
            ),
            400: OpenApiResponse(description="`q` missing, too short, too long, or not plain words."),
            503: OpenApiResponse(description="The icon library cannot be searched just now; retry later."),
        },
    )
    def get(self, request):
        try:
            names = icon_store.search(request.query_params.get('q', ''))
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except icon_store.IconUnavailable as exc:
            logger.warning("Icon search unavailable: %s", exc)
            return _try_later('Icon search unavailable, try again shortly.')
        icons = [{'prefix': p, 'name': n} for p, n in (full.split(':', 1) for full in names)]
        return Response({'icons': icons})
