"""Ops layout management (create, update, soft-delete) and layout cache invalidation."""
import hashlib
import os
import re
import json
import logging
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from drf_spectacular.utils import extend_schema, OpenApiResponse, inline_serializer
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from services.storage import get_storage
from ..permissions import IsAuthenticatedWithAPIKey, IsOpsTeam
from ._common import is_safe_layout_name, layout_policy_cache_key

logger = logging.getLogger(__name__)


def invalidate_layout_caches(name: str | None = None) -> None:
    """
    Drop every cache entry that can serve a stale copy of a layout.

    Four families exist and they must be cleared together:
      * "layouts_list_all"      — public list  (ListLayoutsView)
      * "ops_layouts_list_all"  — ops list     (LayoutManagementView)
      * "layout_detail:<name>:<surfaces>" — per-layout JSON, written by BOTH
        GetLayoutView and EditorInitView, keyed by the optional ?surfaces=
        filter so ONE layout can hold several entries.
      * "layout_policy:<name>"  — the bare definition behind the quantity
        check (`_read_layout_def`); a separate key on purpose.

    The detail family was previously never invalidated at all. Because the
    renderer reads the layout fresh from disk at render time while the editor
    was served the cached copy, an ops edit opened a window where the customer
    composed against stale frame geometry and the print used the new one — a
    silent wrong print. A deleted layout also stayed openable until its TTL
    lapsed.

    `delete_pattern` is a django_redis extension (the configured backend); it
    is guarded so a non-Redis backend or an unreachable Redis degrades to
    "list caches cleared" rather than failing the write that triggered it.
    """
    from django.core.cache import cache as django_cache

    try:
        django_cache.delete_many(["layouts_list_all", "ops_layouts_list_all"])
    except Exception as exc:  # pragma: no cover — cache must never break a write
        logger.warning("Failed to invalidate list caches: %s", exc)

    if not name:
        return
    try:
        # Covers every ?surfaces= variant for this layout.
        django_cache.delete_pattern(f"layout_detail:{name}:*")
    except AttributeError:
        # Backend without delete_pattern — clear the unparameterised key, which
        # is the one the editor and partner API actually request.
        django_cache.delete(f"layout_detail:{name}:")
    except Exception as exc:  # pragma: no cover — cache must never break a write
        logger.warning("Failed to invalidate layout_detail cache for %s: %s", name, exc)
    try:
        django_cache.delete(layout_policy_cache_key(name))
    except Exception as exc:  # pragma: no cover — cache must never break a write
        logger.warning("Failed to invalidate layout_policy cache for %s: %s", name, exc)


# Shared by the layout read/write/delete schema descriptions below. Stated once
# because it is the single most expensive thing to get wrong about layouts.
LAYOUT_ID_NOTE = (
    "**A layout's identifier is its filename stem**, never the `name` field "
    "inside the JSON — both this endpoint and the public list overwrite the "
    "stored `name` with the filename for exactly that reason. When the two "
    "diverged in case, the layout became unopenable and undeletable on the "
    "case-sensitive production filesystem while working fine on a developer's "
    "case-insensitive Mac."
)


class LayoutManagementView(APIView):
    """View to manage layout JSON files - requires Ops Team permissions."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    from rest_framework.parsers import JSONParser, MultiPartParser, FormParser
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    
    @extend_schema(
        tags=["ops"],
        summary="List layouts, or fetch one layout's full JSON",
        description=(
            "Ops view of the layout library. Without `name`, returns every layout's "
            "full definition plus a `hasCalendar` convenience flag; with `name`, "
            "returns that one layout.\n\n"
            + LAYOUT_ID_NOTE +
            "\n\nThe list is cached server-side for 2 minutes and invalidated on "
            "write, so an edit shows up immediately rather than after the TTL.\n\n"
            "Both forms also carry `isDeprecated` and `renamedTo` (the alias target's "
            "`name`, or `null`) so a deprecated row's fate is visible without a DB "
            "query — a `renamedTo` value means it's a harmless alias left over from "
            "an ops rename (see `LayoutCatalogue.resolve_active()`); `null` while "
            "`isDeprecated` is true means a genuine dead end."
        ),
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "`{layouts: [...]}` for the list form, or the raw layout object "
                    "for the detail form. Layout JSON is free-form by design — the "
                    "schema differs per productType (photo / calendar / book)."
                ),
            ),
            400: OpenApiResponse(description="Layout name contains characters outside `A-Za-z0-9_.-`."),
            403: OpenApiResponse(description="Caller is not on the ops team, or the name resolved outside the layouts directory."),
            404: OpenApiResponse(description="No such layout."),
        },
    )
    def get(self, request, name=None):
        """List layouts or get a specific layout's JSON."""
        from django.core.cache import cache as django_cache
        from api.models import LayoutCatalogue, default_display_name_for

        if name:
            if not is_safe_layout_name(name):
                return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

            # Query LayoutCatalogue from Postgres (ops can see all, not just public)
            try:
                layout = LayoutCatalogue.objects.get(name=name)
            except LayoutCatalogue.DoesNotExist:
                return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)

            try:
                data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
                data['name'] = layout.name
                data['displayName'] = layout.display_name or default_display_name_for(layout.name)
                # Surface the alias pointer so ops can tell a renamed-away
                # layout (still reachable, harmless) from a genuinely deleted
                # one (dead end) at a glance — see LayoutCatalogue.resolve_active().
                data['isDeprecated'] = layout.is_deprecated
                data['renamedTo'] = layout.renamed_to_id
                # Real, DB-tracked provenance — set AFTER the definition copy so
                # these win over any same-named key a layout's JSON happens to
                # carry. Note there is no "last edited by" column: imported_by
                # is provenance for the original migration/import only, not
                # routine ops saves, so it is deliberately not surfaced here.
                data['createdAt'] = layout.created_at.isoformat()
                data['updatedAt'] = layout.updated_at.isoformat()
                data['version'] = layout.version
                response = Response(data)
                response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
                return response
            except Exception as e:
                return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        else:
            # Full list — server-side Django cache mirrors ListLayoutsView so
            # repeat hits skip the DB query; HTTP Cache-Control lets the
            # admin's browser cache it too.
            CACHE_KEY = "ops_layouts_list_all"
            CACHE_TTL = 120
            layouts_data = django_cache.get(CACHE_KEY)
            if layouts_data is None:
                # Query all layouts (not just public) for ops view
                rows = LayoutCatalogue.objects.all().values(
                    'name', 'display_name', 'definition', 'product_type', 'is_deprecated', 'renamed_to',
                    'created_at', 'updated_at', 'version'
                )
                layouts_data = []
                for row in rows:
                    data = row['definition'].copy() if isinstance(row['definition'], dict) else {}
                    data['name'] = row['name']
                    data['displayName'] = row['display_name'] or default_display_name_for(row['name'])
                    data['hasCalendar'] = data.get('productType') == 'calendar'
                    data['isDeprecated'] = row['is_deprecated']
                    # `renamed_to` is keyed on the target's `name` (to_field='name'),
                    # so the raw values() column is already the alias target's name.
                    data['renamedTo'] = row['renamed_to']
                    # Real, DB-tracked provenance — see the detail branch above
                    # for why there's no "last edited by" field here either.
                    data['createdAt'] = row['created_at'].isoformat()
                    data['updatedAt'] = row['updated_at'].isoformat()
                    data['version'] = row['version']
                    layouts_data.append(data)
                django_cache.set(CACHE_KEY, layouts_data, CACHE_TTL)
            # Drafts included: this is the ops list. Read per request, not
            # cached, so a new draft shows at once.
            from .templates import template_counts
            counts = template_counts(published_only=False)
            layouts_data = [{**d, 'templateCount': counts.get(d.get('name'), 0)} for d in layouts_data]
            response = Response({"layouts": layouts_data})
            response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
            return response

    @extend_schema(
        tags=["ops"],
        summary="Create or update a layout",
        description=(
            "Writes a layout to LayoutCatalogue. Ops team only.\n\n"
            + LAYOUT_ID_NOTE +
            "\n\n**`name` is immutable once created (2026-09-16).** A second POST "
            "to the same `name` updates that row in place. Sending `old_name` (or "
            "`originalName`) that differs from `name` — the old rename mechanism — "
            "is rejected with 400; edit `display_name` for anything customer-facing "
            "that needs to change, or create a new layout under a new name. Layouts "
            "renamed before 2026-09-16 still resolve under their old identifier via "
            "`LayoutCatalogue.resolve_active()` (a `renamed_to` pointer set at the "
            "time) — that mechanism stays as a historical safety net even though "
            "nothing can create a new one going forward.\n\n"
            "**Validation depends on `productType`.** A calendar or book layout is "
            "checked against its own validator; a multi-surface product must give "
            "every surface a canvas width and height; a plain layout must carry a "
            "root `canvas`. Book layouts carry neither a root canvas nor a surfaces "
            "list — their per-role canvases live under `book.cover` / "
            "`book.innerPage` / `book.backCover` — so they are exempt from the "
            "canvas check and validated separately."
        ),
        request=inline_serializer(
            name="LayoutWrite",
            fields={
                "name": drf_serializers.CharField(
                    required=False,
                    help_text=(
                        "Layout identifier. Optional when supplied in the URL path. "
                        "`A-Za-z0-9_.-` only. **Immutable once the row exists** — a "
                        "second POST to the same `name` updates it in place; it "
                        "cannot be changed to a different `name` (use `display_name` "
                        "for anything customer-facing that ops needs to edit)."
                    ),
                ),
                "display_name": drf_serializers.CharField(
                    required=False,
                    help_text=(
                        "Ops-editable customer-facing name, shown in the embed/dashboard "
                        "editor heading, the layout list APIs, and the ops Templates grid. "
                        "Freely editable at any time, unlike `name`. On create, if omitted "
                        "one is derived from `name`. On update, omitting it leaves the "
                        "existing value untouched — it is never silently blanked."
                    ),
                ),
                "layout_data": drf_serializers.JSONField(
                    help_text="The layout definition. Also accepted under the key `layout`. A JSON string is parsed.",
                ),
            },
        ),
        responses={
            200: OpenApiResponse(response=OpenApiTypes.OBJECT, description="The layout as stored."),
            400: OpenApiResponse(description="Missing name/layout_data, invalid name, malformed JSON, failed product validation, or an `old_name` that differs from `name` (renaming the identifier is retired — see docs above)."),
            403: OpenApiResponse(description="Caller is not on the ops team, or the path resolved outside the layouts directory."),
        },
    )
    def post(self, request, name=None):
        """Create or update a layout in LayoutCatalogue."""
        from api.models import LayoutCatalogue, default_display_name_for
        from django.db import transaction as db_transaction
        from django.core.exceptions import ValidationError as _DjangoValidationError

        layout_name = name or request.data.get("name")
        layout_data = request.data.get("layout_data") or request.data.get("layout")

        if not layout_name or not layout_data:
            return Response({"detail": "name and layout_data are required"}, status=status.HTTP_400_BAD_REQUEST)

        if not is_safe_layout_name(layout_name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

        # `name` is immutable once a row exists (2026-09-16) — a prior rename
        # (soft-delete + create-under-new-name, aliased via `renamed_to`) broke
        # printo.in's embed for real because their iframe URL hardcodes it and
        # they were never told it changed. old_name/originalName are still
        # accepted so a stale client gets a clear rejection instead of a
        # generic 400 or, worse, silently renaming again.
        old_name = request.data.get("old_name") or request.data.get("originalName")
        if old_name and old_name != layout_name:
            return Response(
                {
                    "detail": (
                        f"Renaming a layout's identifier is no longer supported "
                        f"(attempted '{old_name}' -> '{layout_name}'). `name` is "
                        f"immutable once created — edit `display_name` instead, or "
                        f"create a new layout under the new name."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        display_name_input = str(request.data.get("display_name") or "").strip()

        try:
            # Basic validation: ensure it's a valid JSON dict
            if isinstance(layout_data, str):
                layout_data = json.loads(layout_data)
            
            # Ensure required fields for LayoutEngine exist. Book layouts (D2a)
            # carry neither a root `canvas` nor a `surfaces[]` list — their
            # per-role canvases live under `book.cover` / `book.innerPage` /
            # `book.backCover` (D7) and are checked by validate_book_layout
            # below instead.
            is_book = layout_data.get('productType') == 'book'
            is_multi_surface = layout_data.get('type') == 'product' and isinstance(layout_data.get('surfaces'), list)
            if is_book:
                pass
            elif is_multi_surface:
                for idx, surface in enumerate(layout_data['surfaces']):
                    s_canvas = surface.get('canvas', {})
                    if 'width' not in s_canvas or 'height' not in s_canvas:
                        return Response(
                            {"detail": f"Surface '{surface.get('key', idx)}': missing canvas width/height"},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
            elif 'canvas' not in layout_data or 'width' not in layout_data['canvas'] or 'height' not in layout_data['canvas']:
                return Response({"detail": "Invalid layout structure: missing canvas width/height"}, status=status.HTTP_400_BAD_REQUEST)

            # Calendar product type — enforce monthRange × calendars constraint,
            # validate ops-default + customer-controllable fields, reject banned
            # fields inside surfaceOverrides. PRD §10.2, §11.1, §11.15.
            if layout_data.get('productType') == 'calendar':
                from api.validators import validate_calendar_layout
                from django.core.exceptions import ValidationError as _DjangoValidationError
                try:
                    validate_calendar_layout(layout_data)
                except _DjangoValidationError as exc:
                    # Surface the first failure message exactly as the validator
                    # built it — already specific and actionable.
                    msg = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                    return Response({"detail": msg}, status=status.HTTP_400_BAD_REQUEST)

            # Book product type — enforce the two-template contract (D2a),
            # per-role canvas presence (D7), and pageCount/gutter shape.
            # BOOK_LAYOUT_PRD.md §5.
            if is_book:
                from api.validators import validate_book_layout
                from django.core.exceptions import ValidationError as _DjangoValidationError
                try:
                    validate_book_layout(layout_data)
                except _DjangoValidationError as exc:
                    msg = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                    return Response({"detail": msg}, status=status.HTTP_400_BAD_REQUEST)

            # Mask uploads: `mask` is the layout-wide mask; `mask_<target>` is
            # one surface's (multi-surface products, by surface key) or one
            # book role's (cover / innerPage / backCover). The generic editor
            # has always sent `mask_<key>` for multi-surface products, but only
            # `mask` was ever read, so those uploads were silently dropped.
            try:
                _store_uploaded_masks(request.FILES, layout_name, layout_data)
            except ValueError as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            except Exception as exc:
                logger.error(f"Failed to upload mask: {exc}")
                return Response(
                    {"detail": f"Failed to upload mask: {str(exc)}"},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )

            # Infer product_type from definition
            product_type = layout_data.get('productType', 'single_canvas')

            with db_transaction.atomic():
                # Preserve an ops-curated display_name across an update that
                # doesn't send one (an old client build, or the calendar/book
                # editors, which don't yet have a dedicated display-name field —
                # see CLAUDE.md). Only a create with none supplied falls back to
                # an auto-derived one; an existing curated name is never
                # silently overwritten by that fallback.
                existing = LayoutCatalogue.objects.filter(name=layout_name).first()
                if display_name_input:
                    resolved_display_name = display_name_input
                elif existing is not None:
                    resolved_display_name = existing.display_name or default_display_name_for(layout_name)
                else:
                    resolved_display_name = default_display_name_for(layout_name)

                obj, created = LayoutCatalogue.objects.update_or_create(
                    name=layout_name,
                    defaults={
                        'definition': layout_data,
                        'product_type': product_type,
                        'category': '',
                        'is_public': True,
                        'is_deprecated': False,  # Un-deprecate if re-creating
                        'renamed_to': None,  # Clear any stale alias if this name was previously renamed away
                        'display_name': resolved_display_name,
                    },
                )
                if created:
                    obj.version = 1
                    obj.save()
                    logger.info(f"Created new layout '{layout_name}' (display_name='{resolved_display_name}')")
                else:
                    obj.version = obj.version + 1
                    obj.save()
                    logger.info(f"Updated layout '{layout_name}' (version {obj.version})")

            # Invalidate caches
            invalidate_layout_caches(layout_name)

            return Response({"status": "success", "name": layout_name, "display_name": resolved_display_name, "layout": layout_data})
        except json.JSONDecodeError:
            return Response({"detail": "Invalid JSON data"}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            logger.error(f"Error saving layout {layout_name}: {str(e)}")
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @extend_schema(
        tags=["ops"],
        summary="Delete a layout",
        description=(
            "Soft-deletes the layout (it stays listed under \"Show deleted\"; mask files are kept), then "
            "invalidates both the list cache and this layout's detail cache "
            "entries. Dropping only the list cache used to leave the deleted "
            "template visible on the Templates page — and still openable in the "
            "editor — for the remainder of the TTL.\n\n"
            "Renders already queued against this layout are unaffected; they read "
            "the definition snapshotted at submit time."
        ),
        request=None,
        responses={
            200: inline_serializer(
                name="LayoutDeleteResult",
                fields={
                    "status": drf_serializers.CharField(),
                    "detail": drf_serializers.CharField(),
                },
            ),
            400: OpenApiResponse(description="No layout name in the URL, or a name containing characters outside `A-Za-z0-9_.-`."),
            403: OpenApiResponse(description="Caller is not on the ops team, or the name resolved outside the layouts directory."),
            404: OpenApiResponse(description="No such layout."),
        },
    )
    def delete(self, request, name=None):
        """Soft-delete a layout from LayoutCatalogue."""
        from api.models import LayoutCatalogue

        # Both /api/ops/layouts and /api/ops/layouts/<name> route here, so the
        # collection form arrives with no name at all. Without this guard that
        # was a TypeError — a 500 on a route the API reference advertised as
        # valid. Deleting "every layout" is not a thing we want to offer, so the
        # collection form is simply a bad request.
        if not name:
            return Response(
                {"detail": "layout name is required in the URL: /api/ops/layouts/<name>"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not is_safe_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            # Soft-delete from LayoutCatalogue
            layout = LayoutCatalogue.objects.get(name=name)
            layout.is_deprecated = True
            layout.save()
            logger.info(f"Soft-deleted layout '{name}'")

            # Clear both list caches AND this layout's detail entries. Dropping
            # only "layouts_list_all" left the ops Templates page serving the
            # deleted row for its 2-minute TTL; leaving the detail entries meant
            # the deleted layout stayed openable in the editor for just as long.
            invalidate_layout_caches(name)
            return Response({"status": "success", "detail": f"Layout {name} deleted"})
        except LayoutCatalogue.DoesNotExist:
            return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            logger.error(f"Error deleting layout {name}: {str(e)}")
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


_MASK_TARGET_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
_BOOK_MASK_ROLES = ('cover', 'innerPage', 'backCover')


def _mask_target_block(layout_data: dict, target: str) -> dict:
    """The dict whose `maskUrl` a `mask_<target>` upload sets."""
    if layout_data.get('productType') == 'book':
        book = layout_data.get('book') or {}
        if target in _BOOK_MASK_ROLES and isinstance(book.get(target), dict):
            return book[target]
        raise ValueError(
            f"Mask for '{target}': a book layout takes masks for "
            f"{', '.join(r for r in _BOOK_MASK_ROLES if isinstance(book.get(r), dict))} only."
        )
    for surface in layout_data.get('surfaces') or []:
        if isinstance(surface, dict) and surface.get('key') == target:
            return surface
    raise ValueError(f"Mask for '{target}': this layout has no surface with that key.")


def _store_uploaded_masks(files, layout_name: str, layout_data: dict) -> None:
    """Save every mask in the upload and point the layout at it.

    Validates all targets before writing any file, so a bad request leaves
    storage untouched.
    """
    from services.storage import S3Storage

    pending = []
    for field, upload in files.items():
        if field == 'mask':
            target, block = None, layout_data
        elif field.startswith('mask_'):
            target = field[len('mask_'):]
            if not _MASK_TARGET_RE.match(target):
                raise ValueError(f"Invalid mask field '{field}'.")
            block = _mask_target_block(layout_data, target)
        else:
            continue
        ext = os.path.splitext(upload.name)[1].lower()
        if ext not in ('.png', '.svg'):
            raise ValueError("Masks must be PNG or SVG files, with a transparent window where the photo shows.")
        stem = f"{layout_name}_{target}_mask" if target else f"{layout_name}_mask"
        data = upload.read()
        if ext == '.svg':
            from services.svg_mask import validate_svg_mask
            validate_svg_mask(data)
        # A content fingerprint in the name gives every distinct mask its own
        # URL, so a CDN or browser can cache it for good: replacing a mask
        # changes its URL instead of serving the old image from cache while
        # the print uses the new one.
        digest = hashlib.sha256(data).hexdigest()[:10]
        pending.append((f"{stem}_{digest}{ext}", data, block))

    if not pending:
        return
    storage = get_storage()
    for mask_filename, data, block in pending:
        content_type = 'image/svg+xml' if mask_filename.endswith('.svg') else 'image/png'
        if isinstance(storage, S3Storage):
            # <prefix>/masks/ (NOT order-based uploads/) — the key
            # MaskDownloadView serves and the render reads.
            s3_key = storage.mask_key(mask_filename)
            storage.s3.put_object(Bucket=storage.bucket, Key=s3_key, Body=data, ContentType=content_type)
            logger.info(f"Uploaded mask to S3: {s3_key}")
        else:
            mask_path = os.path.join(storage.masks_dir(), mask_filename)
            with open(mask_path, 'wb') as destination:
                destination.write(data)
            logger.info(f"Uploaded mask to disk: {mask_path}")
        block['maskUrl'] = f"/api/layouts/masks/{mask_filename}"
