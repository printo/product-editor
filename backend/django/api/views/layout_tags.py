"""Layout tags: the tag list anyone with a key can read, and ops management.

Reads are `GET /api/layout-tags`. Ops create, rename and switch tags off under
`ops/layout-tags`, which the internal proxy gates to the Ops tier by path.
There is no delete: a switched-off tag stays on its layouts. Layouts store tag
keys (`tagKeys`); `with_layout_tag_names` fills in the names on the way out.
See services/layout_tags.py.
"""
import logging
from collections import Counter

from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from services.layout_tags import InvalidTag, clean_tag_key, clean_tag_name, with_tag_names

from ..models import LayoutCatalogue, LayoutTag
from ..permissions import CanListLayouts, IsAuthenticatedWithAPIKey, IsOpsTeam
from .calendar_assets import OPS_WRITE_AUTH, _OPS_GATE_RESPONSES

logger = logging.getLogger(__name__)


def tag_lookup() -> dict:
    """`{name_by_key, known, key_by_name}` for the whole list, one query.

    `known` maps key -> is_active; `key_by_name` is keyed by lowercased name.
    Read per request, never cached, so a rename shows at once.
    """
    rows = list(LayoutTag.objects.values_list('key', 'name', 'is_active'))
    return {
        'name_by_key': {k: n for k, n, _ in rows},
        'known': {k: a for k, _, a in rows},
        'key_by_name': {n.lower(): k for k, n, _ in rows},
    }


def with_layout_tag_names(layouts, name_by_key=None):
    """Fill `tagKeys` + `tags` (names) on one layout dict or a list of them."""
    if name_by_key is None:
        name_by_key = tag_lookup()['name_by_key']
    if isinstance(layouts, dict):
        return with_tag_names(layouts, name_by_key)
    return [with_tag_names(d, name_by_key) for d in layouts]


def _layout_counts() -> Counter:
    counts: Counter = Counter()
    for keys in LayoutCatalogue.objects.filter(is_deprecated=False).values_list('definition__tagKeys', flat=True):
        if isinstance(keys, list):
            counts.update(k for k in set(keys) if isinstance(k, str))
    return counts


def serialize_tag(tag: LayoutTag, layout_count: int = 0) -> dict:
    return {
        'key': tag.key,
        'name': tag.name,
        'isActive': tag.is_active,
        'layoutCount': layout_count,
    }


def _tag_schema(name: str):
    return inline_serializer(name=name, fields={
        'key': drf_serializers.CharField(help_text="Fixed identifier, e.g. `photo_prints`. Never changes."),
        'name': drf_serializers.CharField(help_text="What people see, e.g. `Photo Prints`. Ops may rename it."),
        'isActive': drf_serializers.BooleanField(help_text="False once ops switch the tag off. It stays on layouts that carry it."),
        'layoutCount': drf_serializers.IntegerField(help_text="Live layouts carrying this tag."),
    })


class LayoutTagsView(APIView):
    """The tag list: every tag, switched-off ones included, with layout counts."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="List layout tags",
        description=(
            "Every tag ops have created, with its fixed `key`, its display `name`, "
            "whether it is still in use (`isActive`) and how many live layouts carry "
            "it. Filter the layout list by key with `GET /api/layouts?tag=<key>`. "
            "Keys never change; names can, so match on `key`."
        ),
        responses={
            200: inline_serializer(name="LayoutTagList", fields={
                'tags': drf_serializers.ListField(child=_tag_schema("LayoutTag")),
            }),
        },
    )
    def get(self, request):
        counts = _layout_counts()
        return Response({'tags': [serialize_tag(t, counts.get(t.key, 0)) for t in LayoutTag.objects.all()]})


class LayoutTagManagementView(APIView):
    """Ops: create a tag, rename it, switch it off or on. No delete."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]

    @extend_schema(
        tags=["ops"],
        summary="Create a layout tag",
        description=(
            "`key` is fixed once created: lowercase letters, digits and single "
            "underscores, at most 50 characters. `name` is at most 60 characters "
            "and can be changed later with PATCH. Keys and names are each unique "
            "(names ignoring case)."
        ),
        request=inline_serializer(name="LayoutTagCreate", fields={
            'key': drf_serializers.CharField(),
            'name': drf_serializers.CharField(),
        }),
        responses={
            201: _tag_schema("LayoutTagCreated"),
            400: OpenApiResponse(description="Invalid key or name, or a key or name already in use."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def post(self, request):
        try:
            new_key = clean_tag_key(request.data.get('key'))
            name = clean_tag_name(request.data.get('name'))
        except InvalidTag as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        if LayoutTag.objects.filter(key=new_key).exists():
            return Response({'detail': f"Tag key '{new_key}' already exists."}, status=status.HTTP_400_BAD_REQUEST)
        if LayoutTag.objects.filter(name__iexact=name).exists():
            return Response({'detail': f"A tag named '{name}' already exists."}, status=status.HTTP_400_BAD_REQUEST)
        tag = LayoutTag.objects.create(key=new_key, name=name)
        logger.info("Created layout tag %s (%s)", tag.key, tag.name)
        return Response(serialize_tag(tag), status=status.HTTP_201_CREATED)

    @extend_schema(
        tags=["ops"],
        summary="Rename a layout tag or switch it off/on",
        description=(
            "Send `name` to rename, `isActive` to switch the tag off (false) or back "
            "on (true). The key cannot change. Layouts store the key, so a rename "
            "shows on every layout at once, and a switched-off tag stays on the "
            "layouts that already carry it."
        ),
        request=inline_serializer(name="LayoutTagUpdate", fields={
            'name': drf_serializers.CharField(required=False),
            'isActive': drf_serializers.BooleanField(required=False),
        }),
        responses={
            200: _tag_schema("LayoutTagUpdated"),
            400: OpenApiResponse(description="Invalid name, a name already in use, or nothing to change."),
            404: OpenApiResponse(description="No tag with that key."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def patch(self, request, key):
        tag = LayoutTag.objects.filter(key=key).first()
        if tag is None:
            return Response({'detail': f"Tag '{key}' not found"}, status=status.HTTP_404_NOT_FOUND)
        changed = False
        if 'name' in request.data:
            try:
                name = clean_tag_name(request.data.get('name'))
            except InvalidTag as exc:
                return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            if LayoutTag.objects.filter(name__iexact=name).exclude(pk=tag.pk).exists():
                return Response({'detail': f"A tag named '{name}' already exists."}, status=status.HTTP_400_BAD_REQUEST)
            tag.name = name
            changed = True
        if 'isActive' in request.data:
            active = request.data.get('isActive')
            if not isinstance(active, bool):
                return Response({'detail': 'isActive must be true or false.'}, status=status.HTTP_400_BAD_REQUEST)
            tag.is_active = active
            changed = True
        if not changed:
            return Response({'detail': 'Send name and/or isActive.'}, status=status.HTTP_400_BAD_REQUEST)
        tag.save()
        logger.info("Updated layout tag %s (%s, active=%s)", tag.key, tag.name, tag.is_active)
        return Response(serialize_tag(tag, _layout_counts().get(tag.key, 0)))
