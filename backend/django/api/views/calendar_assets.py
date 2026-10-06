"""Ops-editable calendar assets: the fonts list, calendar style presets and holidays."""
import json
import logging
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status
from drf_spectacular.utils import extend_schema, OpenApiResponse, inline_serializer
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from services.storage import get_storage

logger = logging.getLogger(__name__)


# ─── Fonts management ─────────────────────────────────────────────────────────

DEFAULT_FONTS = ['sans-serif', 'serif', 'monospace']


# Shared Redis cache for the on-disk JSON config files. Keys are namespaced so
# `cache.delete()` from the corresponding _write_* function invalidates exactly
# one entry without touching the rest of the cache. TTL is 5 min — matches the
# Cache-Control max-age served to clients, so callers and our cache stay in sync.
_FONTS_CACHE_KEY = 'storage:fonts'


_STORAGE_CACHE_TTL = 300


def _read_fonts():
    """Read the fonts config from asset store, with a 5-minute Redis cache."""
    from django.core.cache import cache
    from services.asset_store import read_asset_json, AssetNotFoundError, CalendarAssetUnavailable

    cached = cache.get(_FONTS_CACHE_KEY)
    if cached is not None:
        return cached

    try:
        # Fonts are stored as 'fonts' asset (no subdirectory)
        data = read_asset_json('fonts', 'fonts')
        value = data if isinstance(data, list) else DEFAULT_FONTS
    except CalendarAssetUnavailable as exc:
        # Editor init reads this on every mount, so serve the defaults rather
        # than fail the editor — but don't cache them as the answer.
        logger.warning("Fonts unavailable (%s), serving defaults uncached", exc)
        return DEFAULT_FONTS
    except (AssetNotFoundError, ValueError):
        logger.warning("Failed to read fonts from asset store, using defaults")
        value = DEFAULT_FONTS

    cache.set(_FONTS_CACHE_KEY, value, _STORAGE_CACHE_TTL)
    return value


def _write_fonts(fonts):
    """Write fonts config via storage abstraction and invalidate the cache."""
    from django.core.cache import cache
    from services.storage import get_storage

    try:
        storage = get_storage()
        content = json.dumps(fonts, indent=2).encode('utf-8')
        storage.write_calendar_asset('fonts', 'fonts', content)
        cache.delete(_FONTS_CACHE_KEY)
    except Exception as exc:
        logger.error(f"Failed to write fonts: {exc}")
        raise


# These three views are declared AllowAny because their GET is public, then gate
# their writes on the ops team *inside* the handler. drf-spectacular reads
# permission_classes, so without an explicit `auth=` it would advertise the
# destructive methods as requiring no credentials at all. State the truth
# per-operation instead: public reads carry `auth=[]`, ops writes carry this.
OPS_WRITE_AUTH = [{"BearerAuth": []}, {"PIAAuth": []}, {"PIASessionCookie": []}]


def _asset_unavailable_response():
    """503 for a calendar-asset read the store couldn't answer (S3 outage).

    Not a 404: the asset may exist, and a 404 is what callers and caches
    treat as "there is no such data". No Cache-Control, so nothing keeps it.
    """
    return Response(
        {'detail': 'Calendar configuration is temporarily unavailable. Retry shortly.'},
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


_ASSET_UNAVAILABLE_503 = OpenApiResponse(
    description="Storage couldn't be read (e.g. an S3 outage). Retry; not cached.",
)


_OPS_GATE_RESPONSES = {
    401: OpenApiResponse(description="No API key or PIA session presented."),
    403: OpenApiResponse(description="Authenticated, but not on the ops team."),
}


class FontsView(APIView):
    """
    GET  /api/fonts  — returns the list of enabled fonts (open to any authenticated user).
    PUT  /api/fonts  — saves the list of enabled fonts (ops team only).
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["fonts"],
        summary="List enabled fonts",
        description=(
            "Font families offered in the editor's text-overlay picker. Public and "
            "cached (`max-age=300`, `stale-while-revalidate=600`) so the editor can "
            "fetch it on mount without an auth round-trip.\n\n"
            "This is the *editor* font list. It is unrelated to print rendering, "
            "which uses a single bundled Inter Variable face server-side — there is "
            "deliberately no font picker in the 300-DPI output path."
        ),
        responses={200: inline_serializer(
            name="FontList",
            fields={"fonts": drf_serializers.ListField(child=drf_serializers.CharField())},
        )},
        auth=[],
    )
    def get(self, request):
        response = Response({'fonts': _read_fonts()})
        response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
        return response

    @extend_schema(
        tags=["fonts"],
        summary="Replace the enabled font list (ops only)",
        description=(
            "Replaces the whole list — this is not a merge. Written atomically "
            "(temp file + rename) and the read cache is dropped immediately.\n\n"
            "Ops team only, enforced inside the handler rather than by "
            "`permission_classes`, because the GET on this same view is public."
        ),
        request=inline_serializer(
            name="FontListWrite",
            fields={"fonts": drf_serializers.ListField(
                child=drf_serializers.CharField(),
                help_text="Font family names. Must be a list of strings.",
            )},
        ),
        responses={
            200: inline_serializer(
                name="FontListWritten",
                fields={"fonts": drf_serializers.ListField(child=drf_serializers.CharField())},
            ),
            400: OpenApiResponse(description="`fonts` missing, or not a list of strings."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def put(self, request):
        # Only ops team can modify fonts
        from ..authentication import PIAAuthentication, BearerTokenAuthentication
        user = None
        for auth_cls in [PIAAuthentication(), BearerTokenAuthentication()]:
            try:
                result = auth_cls.authenticate(request)
                if result:
                    user = result[0]
                    break
            except Exception:
                continue

        if not user:
            return Response({'detail': 'Authentication required'}, status=status.HTTP_401_UNAUTHORIZED)

        # Check ops team permission
        is_ops = getattr(user, 'is_ops_team', False) or getattr(user, 'is_staff', False)
        if not is_ops:
            return Response({'detail': 'Only ops team can modify fonts'}, status=status.HTTP_403_FORBIDDEN)

        fonts = request.data.get('fonts')
        if not isinstance(fonts, list) or not all(isinstance(f, str) for f in fonts):
            return Response({'detail': 'fonts must be a list of strings'}, status=status.HTTP_400_BAD_REQUEST)

        _write_fonts(fonts)
        return Response({'fonts': fonts})


# ── Calendar style presets + Gen-Z palettes (PRD §10.3, §6.3) ───────────────

_CALENDAR_STYLES_CACHE_KEY = 'storage:calendar_styles:list'


_CALENDAR_STYLE_CACHE_KEY = 'storage:calendar_styles:'  # + name


def _list_calendar_styles():
    """Return [{name, label}] for every calendar style from asset store."""
    from django.core.cache import cache
    from services.asset_store import list_assets, CalendarAssetUnavailable

    cached = cache.get(_CALENDAR_STYLES_CACHE_KEY)
    if cached is not None:
        return cached

    out = []
    try:
        style_names = list_assets('calendar_styles')
        for name in style_names:
            try:
                style = _read_calendar_style(name)
                if style:
                    out.append({
                        'name': style.get('name') or name,
                        'label': style.get('label') or style.get('name') or name,
                        'description': style.get('description') or '',
                    })
            except CalendarAssetUnavailable:
                # Don't cache a list with the unreadable styles silently missing.
                raise
            except Exception as exc:
                logger.warning("Failed to read calendar style %s: %s", name, exc)
    except CalendarAssetUnavailable:
        raise
    except Exception as exc:
        logger.error("Error listing calendar styles: %s", exc)

    cache.set(_CALENDAR_STYLES_CACHE_KEY, out, _STORAGE_CACHE_TTL)
    return out


def _read_calendar_style(name):
    """Read a single calendar style JSON using asset_store. Returns None if missing/invalid.

    Raises CalendarAssetUnavailable when the store couldn't answer, so the
    view can 503 rather than cache a 404 for a style that exists.
    """
    from django.core.cache import cache
    from services.asset_store import read_asset_json, AssetNotFoundError

    # Path-traversal guard — name must be safe
    if not name or not name.replace('-', '').replace('_', '').isalnum():
        return None

    cache_key = _CALENDAR_STYLE_CACHE_KEY + name
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    # Same acceptance rule as the print's calendar_layout._read_calendar_asset:
    # undecodable or non-object JSON is "no style", not a 500.
    try:
        style = read_asset_json('calendar_styles', name)
    except (AssetNotFoundError, ValueError):
        return None
    if not isinstance(style, dict):
        return None

    # For Gen-Z, attach the available palettes inline so clients don't
    # have to make a second request to enumerate them.
    if style.get('name') == 'modern-genz':
        from services.asset_store import list_assets

        palettes = []
        for palette_name in list_assets('calendar_palettes/genz'):
            try:
                palette = read_asset_json('calendar_palettes/genz', palette_name)
            except (AssetNotFoundError, ValueError) as exc:
                logger.warning("Failed to read palette %s: %s", palette_name, exc)
                continue
            if isinstance(palette, dict):
                palettes.append(palette)

        style['palettes'] = palettes

    cache.set(cache_key, style, _STORAGE_CACHE_TTL)
    return style


def _write_calendar_style(name, payload):
    """Persist a calendar style via storage abstraction and invalidate cache."""
    from django.core.cache import cache
    from services.storage import get_storage

    if not name.replace('-', '').replace('_', '').isalnum():
        raise ValueError("invalid style name")

    try:
        storage = get_storage()
        content = json.dumps(payload, indent=2, sort_keys=True).encode('utf-8')
        storage.write_calendar_asset('calendar_styles', name, content)
        cache.delete(_CALENDAR_STYLES_CACHE_KEY)
        cache.delete(_CALENDAR_STYLE_CACHE_KEY + name)
    except Exception as exc:
        logger.error(f"Failed to write calendar style {name}: {exc}")
        raise


class CalendarStylesView(APIView):
    """
    GET  /api/calendar-styles/             → list summary [{name, label, description}]
    GET  /api/calendar-styles/<name>       → full style JSON (with palettes for genz)
    PUT  /api/ops/calendar-styles/<name>   → ops-team only; replaces a style preset

    The public routes are read-only at the URLconf (api/urls.py READ_ONLY);
    put() does not check the route itself.

    Public read so the customer preview page can fetch styles without an
    auth round-trip. Cached 5 min with stale-while-revalidate so the
    storefront can hammer it under load.
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["calendar"],
        summary="List calendar theme presets, or fetch one",
        description=(
            "Without `name`, a summary list of `{name, label, description}`. With "
            "`name`, the full preset — including its palette swatches for the "
            "Gen-Z theme, of which the customer picks exactly one per render.\n\n"
            "Public so the customer-facing preview can load themes straight through "
            "the embed proxy. Cached 5 minutes with a 10-minute "
            "stale-while-revalidate window.\n\n"
            "Theme colours are resolved server-side at render time from these same "
            "files, so the printed calendar matches the preview; ops colours set on "
            "the layout win over the preset."
        ),
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="`{styles: [{name, label, description}]}` for the list form, or the full preset object.",
            ),
            404: OpenApiResponse(description="No such style preset. Detail form only — the list never 404s."),
            503: _ASSET_UNAVAILABLE_503,
        },
        auth=[],
    )
    def get(self, request, name=None):
        from services.asset_store import CalendarAssetUnavailable

        try:
            if name is None:
                styles = _list_calendar_styles()
            else:
                style = _read_calendar_style(name)
        except CalendarAssetUnavailable as exc:
            logger.warning("Calendar styles unavailable: %s", exc)
            return _asset_unavailable_response()

        if name is None:
            response = Response({'styles': styles})
            response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
            return response

        if style is None:
            return Response(
                {'detail': f"Calendar style '{name}' not found"},
                status=status.HTTP_404_NOT_FOUND,
            )
        response = Response(style)
        response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
        return response

    @extend_schema(
        tags=["calendar"],
        summary="Replace a calendar theme preset (ops only)",
        description=(
            "Replaces one preset wholesale. Ops team only — mutations are routed "
            "through `/api/ops/calendar-styles/<name>` rather than the public read "
            "path, so the embed proxy (which allows `calendar-styles` for reads) "
            "can never forward a write.\n\n"
            "The stored `name` is forced to match the URL, so a client cannot "
            "smuggle a different identifier in the body and overwrite another "
            "preset."
        ),
        request=OpenApiTypes.OBJECT,
        responses={
            200: OpenApiResponse(response=OpenApiTypes.OBJECT, description="The preset as stored."),
            400: OpenApiResponse(description="Name missing from the URL, body not a JSON object, or preset rejected by validation."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def put(self, request, name=None):
        if name is None:
            return Response(
                {'detail': 'style name is required in the URL'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Ops-only mutation — mirror the FontsView gate.
        from ..authentication import PIAAuthentication, BearerTokenAuthentication
        user = None
        for auth_cls in [PIAAuthentication(), BearerTokenAuthentication()]:
            try:
                result = auth_cls.authenticate(request)
                if result:
                    user = result[0]
                    break
            except Exception:
                continue

        if not user:
            return Response(
                {'detail': 'Authentication required'},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        is_ops = getattr(user, 'is_ops_team', False) or getattr(user, 'is_staff', False)
        if not is_ops:
            return Response(
                {'detail': 'Only ops team can modify calendar styles'},
                status=status.HTTP_403_FORBIDDEN,
            )

        payload = request.data
        if not isinstance(payload, dict):
            return Response(
                {'detail': 'request body must be a JSON object'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Ensure the stored name field matches the URL path so clients
        # can't smuggle a different name into the payload.
        payload['name'] = name

        try:
            _write_calendar_style(name, payload)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(payload)


# ── Holiday data (PRD §11.9, §11.11) ────────────────────────────────────────

_HOLIDAYS_CACHE_KEY = 'storage:holidays:'  # + locale:year


def _safe_locale_year(locale: str, year_str: str) -> tuple[str, int]:
    """
    Validate path-traversal-safe locale + year before touching disk.

    Returns (locale, year_int) or raises ValueError.
    """
    if not locale or not all(c.isalnum() or c == '-' for c in locale):
        raise ValueError(f"invalid locale: {locale!r}")
    try:
        year = int(year_str)
    except (TypeError, ValueError):
        raise ValueError(f"invalid year: {year_str!r}")
    if not (1900 <= year <= 2100):
        raise ValueError(f"year {year} outside the supported range 1900..2100")
    return locale, year


def _read_holidays(locale: str, year: int) -> dict | None:
    """Read holidays from asset store with Redis cache.

    Raises CalendarAssetUnavailable (uncached) when the store couldn't answer.
    """
    from django.core.cache import cache
    from services.asset_store import read_asset_json, AssetNotFoundError

    cache_key = f"{_HOLIDAYS_CACHE_KEY}{locale}:{year}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        # Asset name format: {locale}/{year}
        asset_name = f"{locale}/{year}"
        data = read_asset_json('holidays', asset_name)
        if not isinstance(data, dict):
            raise ValueError("holiday file is not a JSON object")
    except (AssetNotFoundError, ValueError) as exc:
        logger.warning("Failed to read holidays for %s/%d: %s", locale, year, exc)
        cache.set(cache_key, None, _STORAGE_CACHE_TTL)
        return None

    cache.set(cache_key, data, _STORAGE_CACHE_TTL)
    return data


def _write_holidays(locale: str, year: int, payload: dict) -> None:
    """Persist a holiday file via storage abstraction and invalidate cache."""
    from django.core.cache import cache
    from services.storage import get_storage

    try:
        storage = get_storage()
        asset_name = f"{locale}/{year}"
        content = json.dumps(payload, indent=2, sort_keys=False).encode('utf-8')
        storage.write_calendar_asset('holidays', asset_name, content)
        cache.delete(f"{_HOLIDAYS_CACHE_KEY}{locale}:{year}")
    except Exception as exc:
        logger.error(f"Failed to write holidays {locale}/{year}: {exc}")
        raise


class HolidaysView(APIView):
    """
    GET    /api/holidays/<locale>/<year>           → public, cached 1 day / swr 7 days
    PUT    /api/ops/holidays/<locale>/<year>       → ops-team only; replaces year file
    DELETE /api/ops/holidays/<locale>/<year>       → ops-team only

    The public route is read-only at the URLconf (api/urls.py READ_ONLY);
    put()/delete() do not check the route themselves.

    Per PRD §11.9 + §11.11. Calendar layouts that opt into a locale auto-load
    the matching year's holiday file; years without a file render with no
    auto-injection (no error — customers can still add their own entries).
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["calendar"],
        summary="Fetch holiday data for a locale and year",
        description=(
            "Holidays auto-injected into calendar layouts that opt into a locale. "
            "Seeded locales are `en-IN` and `generic`; seeded years are 2026-2030.\n\n"
            "A year with no file is **404, not an error condition** — calendars for "
            "that year simply render with no auto-injected holidays, and customers "
            "can still add their own entries. Refreshing the data annually is an "
            "ops task (`manage.py refresh_holidays`).\n\n"
            "Cached hard (1 day, 7-day stale-while-revalidate); the data changes at "
            "most once a year."
        ),
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="`{events: [...]}` plus any locale metadata stored with it.",
            ),
            400: OpenApiResponse(description="Malformed locale or a year outside the supported range."),
            404: OpenApiResponse(description="No holiday file for this locale/year."),
            503: _ASSET_UNAVAILABLE_503,
        },
        auth=[],
    )
    def get(self, request, locale: str, year: str):
        try:
            locale, year_int = _safe_locale_year(locale, year)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        from services.asset_store import CalendarAssetUnavailable
        try:
            data = _read_holidays(locale, year_int)
        except CalendarAssetUnavailable as exc:
            logger.warning("Holidays %s/%d unavailable: %s", locale, year_int, exc)
            return _asset_unavailable_response()
        if data is None:
            return Response(
                {'detail': f"No holiday data for {locale}/{year_int}"},
                status=status.HTTP_404_NOT_FOUND,
            )
        response = Response(data)
        # 1-day cache + 7-day stale-while-revalidate. Holiday data changes
        # at most once a year, so aggressive caching is the right call.
        response['Cache-Control'] = 'public, max-age=86400, stale-while-revalidate=604800'
        return response

    def _gate_ops(self, request):
        """Returns (user, None) on success or (None, Response) on auth failure."""
        from ..authentication import PIAAuthentication, BearerTokenAuthentication
        user = None
        for auth_cls in [PIAAuthentication(), BearerTokenAuthentication()]:
            try:
                result = auth_cls.authenticate(request)
                if result:
                    user = result[0]
                    break
            except Exception:
                continue
        if not user:
            return None, Response(
                {'detail': 'Authentication required'},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        is_ops = getattr(user, 'is_ops_team', False) or getattr(user, 'is_staff', False)
        if not is_ops:
            return None, Response(
                {'detail': 'Only ops team can modify holidays'},
                status=status.HTTP_403_FORBIDDEN,
            )
        return user, None

    @extend_schema(
        tags=["calendar"],
        summary="Replace a locale-year holiday file (ops only)",
        description=(
            "Replaces one year's holidays for one locale. Ops team only, via "
            "`/api/ops/holidays/<locale>/<year>`.\n\n"
            "Takes effect on the next render — already-queued jobs read the data "
            "snapshotted when they were submitted."
        ),
        request=inline_serializer(
            name="HolidayFileWrite",
            fields={"events": drf_serializers.ListField(
                child=drf_serializers.DictField(),
                help_text="Holiday entries. Required, and must be an array.",
            )},
        ),
        responses={
            200: OpenApiResponse(response=OpenApiTypes.OBJECT, description="The holiday file as stored."),
            400: OpenApiResponse(description="Malformed locale/year, body not a JSON object, or no `events` array."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def put(self, request, locale: str, year: str):
        try:
            locale, year_int = _safe_locale_year(locale, year)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        user, err = self._gate_ops(request)
        if err:
            return err

        payload = request.data
        if not isinstance(payload, dict):
            return Response(
                {'detail': 'request body must be a JSON object'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        events = payload.get('events')
        if not isinstance(events, list):
            return Response(
                {'detail': 'payload must contain an "events" array'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Lightly validate each event so an ops typo doesn't corrupt the file.
        # Empty events: [] is intentionally allowed — it's the canonical way to
        # clear out a year's auto-injection without deleting the file (which
        # would also drop the _meta metadata).
        from datetime import date as _date
        for idx, ev in enumerate(events):
            if not isinstance(ev, dict):
                return Response(
                    {'detail': f'events[{idx}] must be an object'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            date_str = ev.get('date')
            if not isinstance(date_str, str):
                return Response(
                    {'detail': f"events[{idx}].date must be a string"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Full ISO YYYY-MM-DD parse — rejects "2026-13-32" and friends
            # that the old startswith check would have let through.
            try:
                parsed = _date.fromisoformat(date_str)
            except ValueError:
                return Response(
                    {'detail': f"events[{idx}].date is not a valid ISO date: {date_str!r}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if parsed.year != year_int:
                return Response(
                    {'detail': (
                        f"events[{idx}].date year ({parsed.year}) doesn't match the URL year ({year_int})"
                    )},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if not ev.get('name'):
                return Response(
                    {'detail': f'events[{idx}].name is required'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Stamp authoritative metadata
        from django.utils import timezone
        payload['year'] = year_int
        payload['locale'] = locale
        payload.setdefault('_meta', {})
        payload['_meta']['lastRefreshed'] = timezone.now().isoformat()

        _write_holidays(locale, year_int, payload)
        return Response(payload)

    @extend_schema(
        tags=["calendar"],
        summary="Delete a locale-year holiday file (ops only)",
        description=(
            "Removes the locale/year's holiday data and drops its cache entry. "
            "Idempotent — deleting a locale/year that has no data still returns 204.\n\n"
            "A seeded year stays deleted: the bundled default file does not come "
            "back. A later PUT (or `manage.py refresh_holidays`) re-creates it.\n\n"
            "Calendars for that year then render with no auto-injected holidays "
            "rather than failing."
        ),
        request=None,
        responses={
            204: OpenApiResponse(description="Deleted, or there was nothing to delete."),
            400: OpenApiResponse(description="Malformed locale or year."),
            500: OpenApiResponse(description="Storage refused the delete; nothing changed."),
            **_OPS_GATE_RESPONSES,
        },
        auth=OPS_WRITE_AUTH,
    )
    def delete(self, request, locale: str, year: str):
        try:
            locale, year_int = _safe_locale_year(locale, year)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        user, err = self._gate_ops(request)
        if err:
            return err

        from django.core.cache import cache
        from services.storage import get_storage

        try:
            storage = get_storage()
            asset_name = f"{locale}/{year_int}"
            storage.delete_calendar_asset('holidays', asset_name)
            cache.delete(f"{_HOLIDAYS_CACHE_KEY}{locale}:{year_int}")
        except Exception as exc:
            logger.error(f"Failed to delete holidays {locale}/{year_int}: {exc}")
            return Response(
                {'detail': f"Failed to delete holidays: {str(exc)}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

        return Response(status=status.HTTP_204_NO_CONTENT)
