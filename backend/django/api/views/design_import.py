"""Ops: the server half of importing a design from the older online-canvas tool.

The reading and converting happen in the browser (the Templates page's Import
dialog). These are the two things the browser cannot do: fetch the design's
artwork from the old tool's file host, which sends no CORS header, and say
whether a font the design uses could be printed if it were put on the fonts
list. Under `ops/` and POST only, so the internal proxy keeps both to the Ops
tier, and never on the embed proxy's allowlist.
"""
import logging
from urllib.parse import urlparse

from django.http import HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.views import APIView

from services.design_import import CONTENT_TYPES, ArtworkFetchError, fetch_artwork
from services.google_fonts import font_available, is_listed
from services.photo_fetch import parse_photo_hosts

from ..authentication import APIKeyUser
from ..permissions import IsAuthenticatedWithAPIKey, IsOpsTeam
from .calendar_assets import OPS_WRITE_AUTH

logger = logging.getLogger(__name__)


class DesignImportArtworkView(APIView):
    """Fetch one artwork file of a design being imported and hand its bytes back."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    parser_classes = [JSONParser]

    @extend_schema(
        tags=["ops"],
        summary="Fetch an imported design's artwork",
        description=(
            "For the Templates page's Import dialog. `url` is the address of one artwork file "
            "named by a design exported from the older design tool. The server fetches it only "
            "from a host on the calling API key's `allowed_photo_hosts` (Django admin, exact "
            "names; blank, the default, keeps this off), over https on a public address with no "
            "redirects, up to 5 MB, and "
            "answers with the file's bytes when they are a PNG, a JPEG or an SVG. Nothing is "
            "stored: the dialog builds stickers from what it gets and uploads those through "
            "`POST /api/ops/templates/assets`, which checks them."
        ),
        request=inline_serializer(name="DesignImportArtworkRequest", fields={
            'url': drf_serializers.CharField(help_text="https address of the artwork file."),
        }),
        responses={
            200: OpenApiResponse(response=OpenApiTypes.BINARY, description="The file: `image/png`, `image/jpeg` or `image/svg+xml`."),
            400: OpenApiResponse(description="`url` missing, not https, or not a plain address."),
            401: OpenApiResponse(description="No API key or PIA session presented."),
            403: OpenApiResponse(description="Not on the ops team, the host is not on the key's list, or the list is blank."),
            413: OpenApiResponse(description="The file is larger than 5 MB."),
            415: OpenApiResponse(description="The address does not hold a PNG, JPEG or SVG."),
            502: OpenApiResponse(description="The host could not be reached, redirected, or answered with an error."),
            504: OpenApiResponse(description="The host took too long."),
        },
        auth=OPS_WRITE_AUTH,
    )
    def post(self, request):
        url = request.data.get('url') if isinstance(request.data, dict) else None
        api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
        hosts = parse_photo_hosts(api_key.allowed_photo_hosts) if api_key is not None else []
        try:
            data, kind = fetch_artwork(url, allowed_hosts=hosts)
        except ArtworkFetchError as exc:
            return Response({'detail': exc.detail}, status=exc.status)
        parsed = urlparse(str(url))
        logger.info("Design import fetched %s%s (%s, %d bytes)", parsed.hostname, parsed.path, kind, len(data))
        response = HttpResponse(data, content_type=CONTENT_TYPES[kind], status=status.HTTP_200_OK)
        response['Cache-Control'] = 'no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        # Bytes for the dialog's fetch(), never a page: an SVG must not run if opened.
        response['Content-Disposition'] = 'attachment'
        response['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        return response


class DesignImportFontView(APIView):
    """Say whether a font an imported design uses is on the fonts list, and if
    not, whether it could be printed once it is."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    parser_classes = [JSONParser]

    @extend_schema(
        tags=["ops"],
        summary="Check a font an imported design uses",
        description=(
            "For the Templates page's Import dialog. `listed` is whether `family` is on the fonts "
            "list (switched-off fonts included), which is what decides whether text prints in it "
            "or in the bundled Inter. `available` is whether the print could load it from Google "
            "Fonts if it were listed. The dialog offers to add a font only when it is available: "
            "a listed font that cannot be loaded fails every render that uses it. Nothing is "
            "changed here; the list is written with `PUT /api/fonts`."
        ),
        request=inline_serializer(name="DesignImportFontRequest", fields={
            'family': drf_serializers.CharField(help_text="The font family as the design names it."),
        }),
        responses={
            200: inline_serializer(name="DesignImportFont", fields={
                'family': drf_serializers.CharField(),
                'listed': drf_serializers.BooleanField(),
                'available': drf_serializers.BooleanField(),
            }),
            400: OpenApiResponse(description="`family` missing."),
            401: OpenApiResponse(description="No API key or PIA session presented."),
            403: OpenApiResponse(description="Authenticated, but not on the ops team."),
        },
        auth=OPS_WRITE_AUTH,
    )
    def post(self, request):
        raw = request.data.get('family') if isinstance(request.data, dict) else None
        family = " ".join(str(raw or '').split())
        if not family:
            return Response({'detail': 'family is required.'}, status=status.HTTP_400_BAD_REQUEST)
        listed = is_listed(family)
        return Response({'family': family, 'listed': listed, 'available': listed or font_available(family)})
