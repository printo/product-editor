"""Layout reads for customers and partners: list, detail, external detail, mask download."""
import os
import logging
from typing import Optional, Dict, Any
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status
from drf_spectacular.utils import (
    extend_schema,
    OpenApiParameter,
    OpenApiResponse,
    inline_serializer,
)
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from services.storage import get_storage
from ..permissions import IsAuthenticatedWithAPIKey, CanListLayouts
from ._common import is_safe_layout_name, layout_policy_cache_key

logger = logging.getLogger(__name__)


def _summarize_layout(data):
    """Trim a full layout def down to the fields an external catalog/picker needs.

    Handles both layout shapes: root-`canvas` (single-surface) and `surfaces[]`
    (multi-surface). `displayName` (2026-09-16) is the one ops-curated field
    surfaced here; there is still no thumbnail, so we don't fabricate one.
    """
    canvas = data.get("canvas")
    surfaces = data.get("surfaces")

    dim_src = canvas if isinstance(canvas, dict) else None
    if dim_src is None and isinstance(surfaces, list) and surfaces and isinstance(surfaces[0], dict):
        dim_src = surfaces[0].get("canvas")
    dim_src = dim_src if isinstance(dim_src, dict) else {}

    if isinstance(surfaces, list):
        surface_count = len(surfaces)
        frame_count = sum(
            len(s.get("frames", [])) for s in surfaces if isinstance(s, dict)
        )
    else:
        surface_count = 1
        frame_count = len(data.get("frames", [])) if isinstance(data.get("frames"), list) else 0

    return {
        "name": data.get("name"),
        "displayName": data.get("displayName"),
        "productType": data.get("productType"),
        "hasCalendar": data.get("productType") == "calendar",
        "tags": data.get("tags", []),
        "surfaceCount": surface_count,
        "frameCount": frame_count,
        "dimensions": {
            "widthMm": dim_src.get("widthMm"),
            "heightMm": dim_src.get("heightMm"),
            "widthPx": dim_src.get("width"),
            "heightPx": dim_src.get("height"),
            "dpi": dim_src.get("dpi"),
        },
        "updatedAt": data.get("updatedAt"),
    }


class ListLayoutsView(APIView):
    """List available layouts - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="List all available layouts",
        description=(
            "Returns all layout definitions the API key is permitted to use. Every "
            "entry carries `name` (the stable, immutable identifier — safe to embed "
            "in a URL indefinitely) and `displayName` (ops-editable, for showing a "
            "customer a friendly product name — use this instead of formatting "
            "`name` yourself, and re-pull periodically if you cache it since ops "
            "can change it any time).\n\n"
            "Pass `?fields=summary` to get a slim catalog (name, displayName, "
            "productType, hasCalendar, tags, surfaceCount, frameCount, dimensions, "
            "updatedAt) instead of the full layout defs — intended for external "
            "systems that auto-pull the catalog to render a picker."
        ),
        parameters=[
            OpenApiParameter(
                "fields", OpenApiTypes.STR, OpenApiParameter.QUERY,
                required=False,
                description="Set to `summary` for the slim catalog. Omit for full layout defs.",
            ),
        ],
        responses={
            200: inline_serializer(
                name="LayoutListResponse",
                fields={"layouts": drf_serializers.ListField(child=drf_serializers.DictField())},
            ),
            500: OpenApiResponse(description="The layout store could not be read."),
        },
    )
    def get(self, request):
        try:
            from django.core.cache import cache as django_cache
            from api.models import LayoutCatalogue, default_display_name_for

            CACHE_KEY = "layouts_list_all"
            CACHE_TTL = 120  # 2 minutes — invalidated on layout write

            layouts_data = django_cache.get(CACHE_KEY)
            if layouts_data is None:
                # Query LayoutCatalogue from Postgres — single source of truth
                rows = LayoutCatalogue.objects.filter(
                    is_deprecated=False,
                    is_public=True,
                ).values('name', 'display_name', 'definition', 'product_type', 'category', 'updated_at')

                layouts_data = []
                for row in rows:
                    # Merge definition with metadata for response
                    data = row['definition'].copy() if isinstance(row['definition'], dict) else {}
                    data['name'] = row['name']
                    data['displayName'] = row['display_name'] or default_display_name_for(row['name'])
                    data['category'] = row['category']
                    data['hasCalendar'] = data.get('productType') == 'calendar'
                    layouts_data.append(data)

                django_cache.set(CACHE_KEY, layouts_data, CACHE_TTL)
                logger.info(f"Layouts cache miss — loaded {len(layouts_data)} layouts from LayoutCatalogue")
            else:
                logger.info(f"Layouts cache hit — serving {len(layouts_data)} layouts")

            # ?fields=summary → slim catalog (name, productType, tags, dimensions,
            # surface/frame counts, updatedAt) instead of the full layout defs.
            # Derived from the same cached full list so one cache serves both.
            if request.query_params.get('fields') == 'summary':
                payload = [_summarize_layout(d) for d in layouts_data]
            else:
                payload = layouts_data

            response = Response({"layouts": payload})
            response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
            return response
        except Exception as e:
            logger.error(f"Error listing layouts: {str(e)}")
            return Response(
                {"detail": "Failed to list layouts"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class GetLayoutView(APIView):
    """Get layout JSON - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="Get layout by name",
        description=(
            "Retrieve the full JSON definition for a specific layout. `name` is "
            "immutable once a layout is created (2026-09-16) — safe to hardcode "
            "indefinitely. A handful of layouts renamed before that date still "
            "resolve under their pre-rename identifier; the response's `name` "
            "then reflects the current one, which may differ from what you "
            "requested. `displayName` is the ops-curated customer-facing name, "
            "independent of `name`."
        ),
        parameters=[
            OpenApiParameter("name", OpenApiTypes.STR, OpenApiParameter.PATH, description="Layout name, e.g. `retro_polaroid_4.2x3.5`"),
        ],
        responses={
            200: inline_serializer(
                name="LayoutDetailResponse",
                fields={
                    "name": drf_serializers.CharField(),
                    "canvases": drf_serializers.ListField(child=drf_serializers.DictField()),
                },
            ),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request, name: str):
        try:
            from django.core.cache import cache as django_cache
            from api.models import LayoutCatalogue, default_display_name_for

            # Malformed name is a client error; a well-formed name that simply
            # isn't there is a missing resource.
            if not is_safe_layout_name(name):
                return Response(
                    {"detail": "Invalid layout name"},
                    status=status.HTTP_400_BAD_REQUEST
                )

            # Cache individual layout JSON (same TTL as list endpoint)
            surfaces_param = request.query_params.get('surfaces', '')
            cache_key = f"layout_detail:{name}:{surfaces_param}"
            cached_data = django_cache.get(cache_key)

            if cached_data is not None:
                response = Response(cached_data)
                response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
                return response

            # Query LayoutCatalogue from Postgres — resolve_active follows a
            # rename alias so a stale name (e.g. a partner's pre-rename embed
            # URL) still resolves rather than 404ing.
            try:
                layout = LayoutCatalogue.resolve_active(name, require_public=True)
            except LayoutCatalogue.DoesNotExist:
                return Response(
                    {"detail": f"Layout '{name}' not found"},
                    status=status.HTTP_404_NOT_FOUND
                )

            # Fetch definition from database
            data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
            data['name'] = layout.name
            data['displayName'] = layout.display_name or default_display_name_for(layout.name)

            # Filter surfaces if ?surfaces= param is provided (for multi-surface layouts)
            if surfaces_param and 'surfaces' in data and isinstance(data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                data['surfaces'] = [
                    s for s in data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]

            django_cache.set(cache_key, data, 120)  # 2 min TTL

            response = Response(data)
            response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
            return response

        except Exception as e:
            logger.error(f"Error getting layout: {str(e)}")
            return Response(
                {"detail": "Failed to get layout"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class ExternalLayoutDetailView(APIView):
    """
    Secured view for external systems to fetch layout JSON.
    Requires a valid API Key or Bearer Token.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="Get layout for external systems",
        description=(
            "Fetch a layout JSON definition via API key auth. "
            "Intended for external server-to-server use (not browser clients). "
            "`name` is immutable once a layout is created (2026-09-16) — safe to "
            "hardcode indefinitely. A handful of layouts renamed before that date "
            "still resolve under their pre-rename identifier; the response's "
            "`name` then reflects the current one, which may differ from what "
            "you requested. `displayName` is the ops-curated customer-facing "
            "name, independent of `name`. See docs/INTEGRATION.md."
        ),
        parameters=[
            OpenApiParameter("name", OpenApiTypes.STR, OpenApiParameter.PATH, description="Layout name, e.g. `retro_polaroid_4.2x3.5`"),
        ],
        responses={
            200: inline_serializer(
                name="ExternalLayoutResponse",
                fields={
                    "name": drf_serializers.CharField(),
                    "canvases": drf_serializers.ListField(child=drf_serializers.DictField()),
                },
            ),
            400: OpenApiResponse(description="Invalid layout name"),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request, name):
        from api.models import LayoutCatalogue, default_display_name_for

        # 400 for a malformed name, 404 for one that simply isn't there.
        if not is_safe_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            # Query LayoutCatalogue from Postgres — resolve_active follows a
            # rename alias so a stale name (e.g. a partner's pre-rename embed
            # URL) still resolves rather than 404ing.
            layout = LayoutCatalogue.resolve_active(name, require_public=True)
        except LayoutCatalogue.DoesNotExist:
            return Response(
                {"detail": f"Layout '{name}' not found"},
                status=status.HTTP_404_NOT_FOUND
            )

        try:
            data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
            data['name'] = layout.name
            data['displayName'] = layout.display_name or default_display_name_for(layout.name)

            # Filter surfaces if ?surfaces= param is provided (for multi-surface layouts)
            surfaces_param = request.query_params.get('surfaces')
            if surfaces_param and 'surfaces' in data and isinstance(data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                data['surfaces'] = [
                    s for s in data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]

            return Response(data)
        except Exception as e:
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class MaskDownloadView(APIView):
    """View to serve layout mask images from S3 or local storage."""
    permission_classes = [AllowAny]  # Publicly accessible if URL is known

    @extend_schema(
        tags=["layouts"],
        summary="Fetch a layout mask image",
        description=(
            "Serves the mask bitmap a layout clips its frames against. Public if "
            "you know the filename — masks are shape stencils, not customer data.\n\n"
            "**Local storage (dev):** Streams the file directly.\n"
            "**S3 storage (prod):** Returns a 301 redirect to a presigned URL (1-hour expiry)."
        ),
        responses={
            200: OpenApiResponse(response=OpenApiTypes.BINARY, description="The mask image (usually image/png) — local storage only."),
            301: OpenApiResponse(description="Redirect to presigned S3 URL — S3 storage only."),
            400: OpenApiResponse(description="Malformed filename (path traversal attempt or invalid characters)."),
            404: OpenApiResponse(description="No such mask."),
            502: OpenApiResponse(description="S3 service error."),
        },
        auth=[],
    )
    def get(self, request, filename):
        from services.storage import LocalStorage, S3Storage

        storage = get_storage()

        # Guard against path traversal — filename must not contain / or .. or start with .
        # This is input validation (400), not an auth denial (403)
        if '/' in filename or '\\' in filename or '..' in filename or filename.startswith('.'):
            return Response(
                {"detail": "Invalid filename: path traversal not allowed"},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            if isinstance(storage, S3Storage):
                # S3 storage: generate presigned URL and redirect
                s3_key = f"masks/{filename}"
                try:
                    presigned_url = storage.generate_mask_presigned_url(s3_key, expiry=3600)
                    response = Response(status=status.HTTP_301_MOVED_PERMANENTLY)
                    response['Location'] = presigned_url
                    return response
                except Exception as exc:
                    logger.error(f"Failed to generate presigned URL for mask {filename}: {exc}")
                    return Response(
                        {"detail": "S3 service unavailable"},
                        status=status.HTTP_502_BAD_GATEWAY
                    )
            else:
                # LocalStorage: serve file directly
                import os
                from django.http import FileResponse
                import mimetypes

                path = os.path.join(storage.masks_dir(), filename)

                # Double-check path safety (belt and suspenders)
                if not os.path.abspath(path).startswith(os.path.abspath(storage.masks_dir())):
                    return Response(
                        {"detail": "Invalid path: access denied"},
                        status=status.HTTP_400_BAD_REQUEST
                    )

                if not os.path.exists(path):
                    return Response(
                        {"detail": "Mask not found"},
                        status=status.HTTP_404_NOT_FOUND
                    )

                content_type, _ = mimetypes.guess_type(path)
                return FileResponse(
                    open(path, 'rb'),
                    content_type=content_type or 'image/png'
                )
        except Exception as e:
            logger.error(f"Error serving mask {filename}: {e}")
            return Response(
                {"detail": str(e)},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


# ─── Editor Render (server-side high-res render from uploaded files) ──────────


def _read_layout_def(name: str) -> Optional[Dict[str, Any]]:
    """
    Read a layout definition for a *policy* decision, never for rendering.

    Returns None — meaning "unknown, do not decide anything on this" — for a
    name that fails the safety guard, a layout that is not in the catalogue, or
    a definition that is not a dict. Callers must fail open on None; the render
    task loads the layout again for real and reports a genuine failure properly.

    Sourced from **LayoutCatalogue, not disk**. Layouts moved to Postgres in
    PR #111 and `storage/layouts/` was deleted, so a disk read here would
    return None for every layout in production and the quantity cap would
    silently never fire. That is the same disk-vs-catalogue trap the #111
    audit fixed in four other places.

    Cached for two minutes under its own key, not GetLayoutView's: that key
    holds the shaped payload the editor is served verbatim, and writing the
    bare definition into it dropped `displayName` from the editor and put
    non-public layouts behind the public endpoints.
    `invalidate_layout_caches` clears this entry too, so an ops layout edit
    cannot leave a policy decision reading yesterday's surfaces.
    """
    from django.core.cache import cache as django_cache

    if not is_safe_layout_name(name):
        return None
    cache_key = layout_policy_cache_key(name)
    cached = django_cache.get(cache_key)
    if isinstance(cached, dict):
        return cached
    try:
        from api.models import LayoutCatalogue
        layout = LayoutCatalogue.resolve_active(name)
        data = layout.definition
    except Exception:
        # A DB hiccup, missing layout, or dead-end alias must not 400 a
        # legitimate order — fail open.
        return None
    if not isinstance(data, dict):
        return None
    django_cache.set(cache_key, data, 120)
    return data
