"""Layout templates: customer reads, ops management, sticker upload and serving.

A template is ops-authored decoration for a layout (see
services/template_decoration.py), offered as well on every other layout with
the same window box that ops tick (`extra_layouts`; the size rule is
services/print_sheet.py::template_size). Customers read published templates;
the embed proxy allows `templates` for GET only. Ops create, edit, publish and
hide them under `ops/templates`, which the internal proxy gates to the Ops
tier by path. Stickers are ops-owned PNGs stored like masks and served by
`GET /api/templates/assets/<file>` (local file, or a 302 to the CDN on S3).
"""
import io
import json
import logging
import os

from django.db.models import Count, Q
from django.http import FileResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from services.storage import S3Storage, get_storage
from services.print_sheet import template_size
from services.template_decoration import (
    InvalidTemplate,
    MAX_STICKER_BYTES,
    MAX_STICKER_SIDE_PX,
    STATUSES,
    STATUS_PUBLISHED,
    is_template_id,
    png_filename,
    sticker_url,
    validate_decoration,
    with_authored_on,
)

from ..models import LayoutCatalogue, LayoutTemplate
from ..permissions import CanListLayouts, IsAuthenticatedWithAPIKey, IsOpsTeam
from ._common import is_safe_layout_name
from .calendar_assets import OPS_WRITE_AUTH, _OPS_GATE_RESPONSES

logger = logging.getLogger(__name__)

# Templates are for generic layouts only; calendars and books have their own
# customer state and no hooks for decoration.
_NO_TEMPLATES = ('calendar', 'book')


def _product_type(layout: LayoutCatalogue) -> str:
    definition = layout.definition if isinstance(layout.definition, dict) else {}
    return str(definition.get('productType') or layout.product_type or 'single_canvas')


def _on_layouts(qs, layout_name: str):
    """Templates offered on this layout: authored on it, or ticked for it."""
    return qs.filter(Q(layout_id=layout_name) | Q(extra_layouts__name=layout_name)).distinct()


def _with_layouts(qs):
    return qs.select_related('layout').prefetch_related('extra_layouts')


def _same_shape(a: dict, b: dict) -> bool:
    """Two layouts can share a template when their first-surface box is the
    same size and they have the same sides (the decoration is stored per side)."""
    return a['windowKey'] is not None and a['windowKey'] == b['windowKey'] and a['surfaceKeys'] == b['surfaceKeys']


def serialize_template(t: LayoutTemplate, *, layout_version: int | None = None) -> dict:
    size = template_size(t.layout.definition)
    extra = list(t.extra_layouts.all())
    data = {
        'id': t.template_id,
        'layoutName': t.layout_id,
        # The other layouts ops ticked; the customer picker on any of them
        # lists this template too. Sorted so a response is stable.
        'alsoOn': sorted(l.name for l in extra),
        'displayName': t.display_name,
        'status': t.status,
        # The home layout's geometry as it is now rides with the decoration,
        # so the editor can place the artwork on another layout's canvas.
        'decoration': with_authored_on(t.decoration, t.layout.definition, t.layout_id),
        'thumbnailUrl': t.thumbnail_url or None,
        'layoutVersion': t.layout_version,
        'updatedAt': t.updated_at.isoformat() if t.updated_at else None,
    }
    if layout_version is not None:
        # Ops reads only. A ticked layout that was retired since, or whose
        # print areas were moved so its box is another size, stays ticked
        # (ops decide) but is named so the pages can flag it; the next save
        # that sends `also_on` is refused until it is unticked.
        data['windowBox'] = size['windowBox']
        data['layoutChanged'] = layout_version != t.layout_version
        data['homeRetired'] = bool(t.layout.is_deprecated)
        data['alsoOnMismatch'] = sorted(
            l.name for l in extra if l.is_deprecated or not _same_shape(size, template_size(l.definition))
        )
    return data


def published_templates(layout_name: str):
    """What the customer picker on `layout_name` lists: published templates
    authored on it or ticked for it, whose home layout is still live (a
    retired home hides the template everywhere, as its detail read does)."""
    qs = LayoutTemplate.objects.filter(status=STATUS_PUBLISHED, is_deleted=False, layout__is_deprecated=False)
    return _with_layouts(_on_layouts(qs, layout_name)).order_by('display_name', 'template_id')


def template_counts(*, published_only: bool) -> dict:
    """{layout name: template count}, a template counting once on its home
    layout and once on every layout it is also offered on. Two queries;
    computed per request rather than cached with the layout list, so a
    publish shows up without clearing any cache."""
    qs = LayoutTemplate.objects.filter(is_deleted=False, layout__is_deprecated=False)
    if published_only:
        qs = qs.filter(status=STATUS_PUBLISHED)
    counts: dict = {}
    for row in qs.values('layout_id').annotate(n=Count('id')):
        counts[row['layout_id']] = counts.get(row['layout_id'], 0) + row['n']
    for row in qs.filter(extra_layouts__isnull=False).values('extra_layouts__name').annotate(n=Count('id', distinct=True)):
        name = row['extra_layouts__name']
        counts[name] = counts.get(name, 0) + row['n']
    return counts


def _box_schema(name: str):
    return inline_serializer(name=name, fields={
        'xMm': drf_serializers.FloatField(), 'yMm': drf_serializers.FloatField(),
        'widthMm': drf_serializers.FloatField(), 'heightMm': drf_serializers.FloatField(),
    })


def _template_schema(name: str):
    return inline_serializer(
        name=name,
        fields={
            'id': drf_serializers.CharField(),
            'layoutName': drf_serializers.CharField(help_text='The home layout it was authored on.'),
            'alsoOn': drf_serializers.ListField(
                child=drf_serializers.CharField(),
                help_text='Other layouts whose print areas (bleed included) are the same size, on which it is also offered.',
            ),
            'displayName': drf_serializers.CharField(),
            'status': drf_serializers.CharField(help_text='draft | published'),
            'decoration': drf_serializers.DictField(
                help_text=(
                    'Percent of the home canvas. `authoredOn` carries the home layout\'s geometry as it is now '
                    '(canvas, print-area box per side), which the editor places the artwork by on another layout.'
                ),
            ),
            'thumbnailUrl': drf_serializers.CharField(allow_null=True),
            'layoutVersion': drf_serializers.IntegerField(),
            'updatedAt': drf_serializers.CharField(allow_null=True),
            'windowBox': _box_schema(f"{name}WindowBox"),
            'layoutChanged': drf_serializers.BooleanField(
                required=False, help_text='Ops reads only: the home layout was saved since the template was.',
            ),
            'homeRetired': drf_serializers.BooleanField(
                required=False, help_text='Ops reads only: the home layout was retired; customers no longer see the template anywhere.',
            ),
            'alsoOnMismatch': drf_serializers.ListField(
                required=False, child=drf_serializers.CharField(),
                help_text='Ops reads only: ticked layouts that were retired or no longer have the same size or sides.',
            ),
        },
    )


class TemplatesListView(APIView):
    """Published templates for one layout — what the customer picker shows."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["templates"],
        summary="List published templates for a layout",
        description=(
            "Ops-authored decorations (background, text, stickers) a customer can "
            "start from on this layout: those authored on it and those ops ticked for "
            "it from another layout whose print areas (bleed included) are the same size "
            "(`alsoOn`). Only published templates are returned. Reachable from the embed "
            "iframe (GET only)."
        ),
        parameters=[
            OpenApiParameter("layout", OpenApiTypes.STR, OpenApiParameter.QUERY, required=True,
                             description="Layout name, e.g. `retro_polaroid_4.2x3.5`"),
        ],
        responses={
            200: inline_serializer(name="TemplateList", fields={
                'templates': drf_serializers.ListField(child=_template_schema("TemplateSummary")),
            }),
            400: OpenApiResponse(description="`layout` missing or not a valid layout name."),
            404: OpenApiResponse(description="No live layout under that name."),
        },
    )
    def get(self, request):
        name = (request.query_params.get('layout') or '').strip()
        if not name or not is_safe_layout_name(name):
            return Response({'detail': '`layout` query param required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            layout = LayoutCatalogue.resolve_active(name, require_public=True)
        except LayoutCatalogue.DoesNotExist:
            return Response({'detail': f"Layout '{name}' not found"}, status=status.HTTP_404_NOT_FOUND)
        items = [serialize_template(t) for t in published_templates(layout.name)]
        response = Response({'templates': items})
        response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
        return response


class TemplateDetailView(APIView):
    """One published template, with the layout it belongs to."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["templates"],
        summary="Get a published template",
        parameters=[
            OpenApiParameter("template_id", OpenApiTypes.STR, OpenApiParameter.PATH,
                             description="Template id, e.g. `retro-birthday`"),
        ],
        responses={
            200: _template_schema("TemplateDetail"),
            404: OpenApiResponse(description="No published template under that id."),
        },
    )
    def get(self, request, template_id):
        t = _with_layouts(LayoutTemplate.objects.filter(
            template_id=template_id, status=STATUS_PUBLISHED, is_deleted=False,
        )).first()
        if t is None or t.layout.is_deprecated:
            return Response({'detail': f"Template '{template_id}' not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(serialize_template(t))


def _read_png(upload, *, what: str) -> bytes:
    """The bytes of an uploaded PNG, or raise ValueError with a reason."""
    from PIL import Image, UnidentifiedImageError

    if upload is None:
        raise ValueError(f"{what} is required")
    if upload.size > MAX_STICKER_BYTES:
        raise ValueError(f"{what} is larger than {MAX_STICKER_BYTES // (1024 * 1024)} MB")
    data = upload.read()
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format != 'PNG':
                raise ValueError(f"{what} must be a PNG file")
            w, h = img.size
            if w > MAX_STICKER_SIDE_PX or h > MAX_STICKER_SIDE_PX:
                raise ValueError(f"{what} must be at most {MAX_STICKER_SIDE_PX} px on each side")
            img.verify()
    except UnidentifiedImageError:
        raise ValueError(f"{what} is not an image")
    except (OSError, SyntaxError) as exc:
        raise ValueError(f"{what} could not be read: {exc}")
    return data


def _store_png(data: bytes, stem: str) -> str:
    """Store an ops PNG under its content fingerprint; return its URL."""
    filename = png_filename(data, stem)
    get_storage().write_sticker(filename, data)
    return sticker_url(filename)


def _resolve_also_on(body: dict, home: LayoutCatalogue):
    """`(layouts, error)` for the body's `also_on`: the other layouts the
    template is offered on. `(None, None)` when the body does not set it
    (the stored list stays). Each named layout must exist, be live, be a
    generic layout, and have the same window box as the home layout."""
    raw = body.get('also_on')
    if raw is None:
        return None, None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = [s for s in raw.split(',')]
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        return None, 'also_on must be a list of layout names'
    names = []
    for n in raw:
        n = n.strip()
        if not n or n == home.name or n in names:
            continue
        if not is_safe_layout_name(n):
            return None, f"also_on holds an invalid layout name: {n!r}"
        names.append(n)
    if not names:
        return [], None
    home_size = template_size(home.definition)
    if home_size['windowKey'] is None:
        return None, f"Layout '{home.name}' has no print areas to key a shared template on"
    found = {l.name: l for l in LayoutCatalogue.objects.filter(name__in=names, is_deprecated=False)}
    out = []
    for n in names:
        layout = found.get(n)
        if layout is None:
            return None, f"Layout '{n}' not found (unknown or retired); untick it to save"
        if _product_type(layout) in _NO_TEMPLATES:
            return None, f"Templates are not available for calendars and books ('{n}')"
        size = template_size(layout.definition)
        if size['windowKey'] != home_size['windowKey']:
            return None, (
                f"Layout '{n}' has {size['windowKey'] or 'no'} mm print areas (bleed included); "
                f"'{home.name}' has {home_size['windowKey']} mm. "
                "Only layouts with the same size can share a template; untick it to save."
            )
        if size['surfaceKeys'] != home_size['surfaceKeys']:
            return None, (
                f"Layout '{n}' has sides {', '.join(size['surfaceKeys'])}; '{home.name}' has "
                f"{', '.join(home_size['surfaceKeys'])}. A template is drawn per side, so only layouts "
                "with the same sides can share it; untick it to save."
            )
        out.append(layout)
    return out, None


class TemplateCandidatesView(APIView):
    """Ops: every live generic layout with the size a template on it would be
    keyed on, so the Templates page can group layouts by size and the
    authoring page can offer the same-box layouts (and show near-misses)."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]

    @extend_schema(
        tags=["ops"],
        summary="Layouts a template can be offered on, with the size of their print areas",
        description=(
            "Every live generic layout (calendars and books excluded) with `windowKey`, "
            "the size of the box around its print areas (the photo windows, bleed included) "
            "rounded to the millimetre. Two layouts with the same `windowKey` and the same "
            "`surfaceKeys` (sides) can share a template. `printAreaKey` is the same box "
            "without the bleed: layouts that agree on it but not on `windowKey` differ only "
            "in bleed, which the ops page points out."
        ),
        responses={
            200: inline_serializer(name="TemplateCandidates", fields={
                'layouts': drf_serializers.ListField(child=inline_serializer(name="TemplateCandidate", fields={
                    'name': drf_serializers.CharField(),
                    'displayName': drf_serializers.CharField(),
                    'windowBox': _box_schema("CandidateWindowBox"),
                    'windowKey': drf_serializers.CharField(allow_null=True),
                    'printAreaBox': _box_schema("CandidatePrintAreaBox"),
                    'printAreaKey': drf_serializers.CharField(allow_null=True),
                    'bleedMm': drf_serializers.FloatField(),
                    'surfaceKeys': drf_serializers.ListField(child=drf_serializers.CharField()),
                    'templateCount': drf_serializers.IntegerField(help_text='Templates offered on it, drafts included.'),
                })),
            }),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def get(self, request):
        counts = template_counts(published_only=False)
        items = []
        for layout in LayoutCatalogue.objects.filter(is_deprecated=False).order_by('name'):
            if _product_type(layout) in _NO_TEMPLATES:
                continue
            definition = layout.definition if isinstance(layout.definition, dict) else {}
            items.append({
                'name': layout.name,
                'displayName': layout.display_name or layout.name,
                **template_size(definition),
                'templateCount': counts.get(layout.name, 0),
            })
        return Response({'layouts': items})


class TemplateManagementView(APIView):
    """Ops: list all templates (drafts included), create or update, hide."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    @extend_schema(
        tags=["ops"],
        summary="List templates (ops, drafts included)",
        parameters=[
            OpenApiParameter("layout", OpenApiTypes.STR, OpenApiParameter.QUERY, required=False,
                             description="Only the templates offered on this layout (authored on it, or ticked for it)"),
        ],
        responses={
            200: inline_serializer(name="OpsTemplateList", fields={
                'templates': drf_serializers.ListField(child=_template_schema("OpsTemplate")),
            }),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def get(self, request, template_id=None):
        if template_id is not None:
            t = _with_layouts(LayoutTemplate.objects.filter(template_id=template_id, is_deleted=False)).first()
            if t is None:
                return Response({'detail': f"Template '{template_id}' not found"}, status=status.HTTP_404_NOT_FOUND)
            return Response(serialize_template(t, layout_version=t.layout.version))
        qs = LayoutTemplate.objects.filter(is_deleted=False)
        layout_name = (request.query_params.get('layout') or '').strip()
        if layout_name:
            if not is_safe_layout_name(layout_name):
                return Response({'detail': 'Invalid layout name'}, status=status.HTTP_400_BAD_REQUEST)
            qs = _on_layouts(qs, layout_name)
        items = [serialize_template(t, layout_version=t.layout.version) for t in _with_layouts(qs)]
        return Response({'templates': items})

    @extend_schema(
        tags=["ops"],
        summary="Create or update a template",
        description=(
            "JSON body, or multipart with a `template_data` JSON string plus an "
            "optional `thumbnail` PNG. Creating needs `id`, `layout` (the home layout "
            "it is authored on), `display_name` and `decoration`; updating takes any "
            "of `display_name`, `status`, `decoration`, `also_on`, `thumbnail`. `id` "
            "and `layout` are immutable. `also_on` is the full list of other layouts "
            "the template is offered on: each must be a live generic layout with the "
            "same sides whose print areas (bleed included) make a box of the same size "
            "as the home layout's, else 400 naming the layout. Every read adds the home "
            "layout's current geometry to the decoration as `authoredOn`, which the "
            "editor uses to centre the artwork on another layout's print areas."
        ),
        request=inline_serializer(name="TemplateWrite", fields={
            'id': drf_serializers.CharField(required=False),
            'layout': drf_serializers.CharField(required=False, help_text='Home layout; immutable.'),
            'display_name': drf_serializers.CharField(required=False),
            'status': drf_serializers.CharField(required=False, help_text='draft | published'),
            'decoration': drf_serializers.DictField(required=False),
            'also_on': drf_serializers.ListField(
                required=False, child=drf_serializers.CharField(),
                help_text='Every other layout to offer it on; replaces the previous list.',
            ),
        }),
        responses={
            200: _template_schema("OpsTemplateUpdated"),
            201: _template_schema("OpsTemplateCreated"),
            400: OpenApiResponse(description=(
                "Invalid id, unknown layout, a decoration the editor could not apply, or an "
                "`also_on` layout that is missing, a calendar or book, or has a different window box."
            )),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def post(self, request, template_id=None):
        body = request.data.get('template_data')
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                return Response({'detail': 'template_data is not valid JSON'}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(body, dict):
            body = request.data
        tid = template_id or str(body.get('id') or '').strip()
        if not is_template_id(tid):
            return Response(
                {'detail': 'id must be 1-80 lowercase letters, digits and hyphens, e.g. retro-birthday'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        existing = LayoutTemplate.objects.filter(template_id=tid).select_related('layout').first()
        requested_layout = str(body.get('layout') or '').strip()
        if existing is not None and not existing.is_deleted:
            if requested_layout and requested_layout != existing.layout_id:
                return Response(
                    {'detail': "A template cannot move to another layout; create a new one there."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            layout = existing.layout
        else:
            if not requested_layout or not is_safe_layout_name(requested_layout):
                return Response({'detail': 'layout is required'}, status=status.HTTP_400_BAD_REQUEST)
            layout = LayoutCatalogue.objects.filter(name=requested_layout, is_deprecated=False).first()
            if layout is None:
                return Response({'detail': f"Layout '{requested_layout}' not found"}, status=status.HTTP_400_BAD_REQUEST)

        decoration = None
        if 'decoration' in body:
            try:
                decoration = validate_decoration(body.get('decoration'))
            except InvalidTemplate as exc:
                return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        also_on, also_on_error = _resolve_also_on(body, layout)
        if also_on_error:
            return Response({'detail': also_on_error}, status=status.HTTP_400_BAD_REQUEST)
        new_status = body.get('status')
        if new_status is not None and new_status not in STATUSES:
            return Response({'detail': f"status must be one of {', '.join(STATUSES)}"}, status=status.HTTP_400_BAD_REQUEST)
        display_name = str(body.get('display_name') or '').strip()

        thumbnail_url = None
        thumb = request.FILES.get('thumbnail')
        if thumb is not None:
            try:
                thumbnail_url = _store_png(_read_png(thumb, what='thumbnail'), 'thumb')
            except ValueError as exc:
                return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            except Exception as exc:
                logger.error("Storing template thumbnail failed: %s", exc)
                return Response({'detail': 'Could not store the thumbnail'}, status=status.HTTP_502_BAD_GATEWAY)

        if existing is None or existing.is_deleted:
            if not display_name or decoration is None:
                return Response(
                    {'detail': 'display_name and decoration are required to create a template'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if existing is not None:
                # A hidden template under this id comes back as the new one.
                t = existing
                t.is_deleted = False
                t.layout = layout
            else:
                t = LayoutTemplate(template_id=tid, layout=layout)
            t.display_name = display_name
            t.status = new_status or 'draft'
            t.decoration = decoration
            t.thumbnail_url = thumbnail_url or ''
            t.layout_version = layout.version
            t.save()
            t.extra_layouts.set(also_on or [])
            logger.info("Created template %s on %s (also on %s)", tid, layout.name, [l.name for l in also_on or []])
            return Response(serialize_template(t, layout_version=layout.version), status=status.HTTP_201_CREATED)

        t = existing
        if display_name:
            t.display_name = display_name
        if new_status is not None:
            t.status = new_status
        if decoration is not None:
            t.decoration = decoration
            # A re-saved decoration was made against the layout as it is now.
            t.layout_version = layout.version
        if thumbnail_url:
            t.thumbnail_url = thumbnail_url
        t.save()
        if also_on is not None:
            t.extra_layouts.set(also_on)
        logger.info("Updated template %s (%s)", tid, t.status)
        return Response(serialize_template(t, layout_version=layout.version))

    @extend_schema(
        tags=["ops"],
        summary="Hide a template",
        description="Soft delete: the row and its stickers stay, customers stop seeing it.",
        responses={
            204: OpenApiResponse(description="Hidden."),
            404: OpenApiResponse(description="No such template."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def delete(self, request, template_id=None):
        if not template_id:
            return Response({'detail': 'template id required'}, status=status.HTTP_400_BAD_REQUEST)
        t = LayoutTemplate.objects.filter(template_id=template_id, is_deleted=False).first()
        if t is None:
            return Response({'detail': f"Template '{template_id}' not found"}, status=status.HTTP_404_NOT_FOUND)
        t.is_deleted = True
        t.save(update_fields=['is_deleted', 'updated_at'])
        logger.info("Hid template %s", template_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TemplateAssetUploadView(APIView):
    """Ops: store a sticker PNG. Returns the address a template overlay uses as `src`."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(
        tags=["ops"],
        summary="Upload a template sticker",
        description=(
            "Multipart `file`: a PNG up to 5 MB and 4096 px a side. Stored under its "
            "content fingerprint, so the same image uploaded twice shares one file and "
            "a changed image gets a new address. Stickers are never deleted."
        ),
        request={'multipart/form-data': inline_serializer(name="StickerUpload", fields={
            'file': drf_serializers.FileField(),
        })},
        responses={
            201: inline_serializer(name="StickerStored", fields={
                'url': drf_serializers.CharField(),
                'filename': drf_serializers.CharField(),
            }),
            400: OpenApiResponse(description="Missing, not a PNG, or too large."),
            502: OpenApiResponse(description="The store could not take the file."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def post(self, request):
        try:
            data = _read_png(request.FILES.get('file'), what='file')
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        try:
            url = _store_png(data, 'sticker')
        except Exception as exc:
            logger.error("Storing sticker failed: %s", exc)
            return Response({'detail': 'Could not store the sticker'}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({'url': url, 'filename': os.path.basename(url)}, status=status.HTTP_201_CREATED)


class TemplateAssetDownloadView(APIView):
    """Serve a sticker or thumbnail: the local file, or a 302 to the CDN on S3."""
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["templates"],
        summary="Download a template sticker or thumbnail",
        parameters=[
            OpenApiParameter("filename", OpenApiTypes.STR, OpenApiParameter.PATH),
        ],
        responses={
            200: OpenApiResponse(description="The PNG (local storage)."),
            302: OpenApiResponse(description="Redirect to the CDN or a presigned S3 URL (S3 storage)."),
            400: OpenApiResponse(description="Not a sticker filename."),
            404: OpenApiResponse(description="No such file."),
        },
        auth=[],
    )
    def get(self, request, filename):
        if (
            '/' in filename or '\\' in filename or '..' in filename or filename.startswith('.')
            or not filename.endswith('.png')
        ):
            return Response({'detail': 'Invalid filename'}, status=status.HTTP_400_BAD_REQUEST)
        storage = get_storage()
        if isinstance(storage, S3Storage):
            try:
                location = storage.generate_mask_presigned_url(storage.sticker_key(filename), expiry=3600)
            except Exception as exc:
                logger.error("Sticker URL for %s failed: %s", filename, exc)
                return Response({'detail': 'S3 service unavailable'}, status=status.HTTP_502_BAD_GATEWAY)
            response = Response(status=status.HTTP_302_FOUND)
            response['Location'] = location
            # The address is fingerprinted, so a long cache is safe.
            response['Cache-Control'] = 'public, max-age=86400'
            return response
        path = storage.sticker_path(filename)
        if not os.path.abspath(path).startswith(os.path.abspath(storage.stickers_dir())) or not os.path.isfile(path):
            return Response({'detail': 'Not found'}, status=status.HTTP_404_NOT_FOUND)
        response = FileResponse(open(path, 'rb'), content_type='image/png')
        response['Cache-Control'] = 'public, max-age=86400'
        # The editor draws stickers to a canvas (crossOrigin anonymous) for the
        # print raster; without this a local dev server taints the canvas.
        response['Access-Control-Allow-Origin'] = '*'
        return response
