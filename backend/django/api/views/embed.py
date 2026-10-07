"""The editor and embed session surface: session create/validate, the editor's mount payload, and canvas-state autosave."""
import os
import re
import json
import logging
from django.conf import settings
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status
from django.core.exceptions import ValidationError
from drf_spectacular.utils import (
    extend_schema,
    OpenApiParameter,
    OpenApiExample,
    OpenApiResponse,
    inline_serializer,
)
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from services.order_qty import InvalidOrderQty, MAX_ORDER_QTY, parse_order_qty
from ..permissions import IsAuthenticatedWithAPIKey, CanListLayouts
from ..authentication import APIKeyUser
from ..models import EmbedSession
from .layouts import GetLayoutView
from .calendar_assets import _read_fonts

logger = logging.getLogger(__name__)


class EmbedSessionView(APIView):
    """
    Exchange a real API key for a short-lived embed token (2 hours).
    The token is safe to place in an iframe URL — the real key never reaches the browser.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    # order_id charset — caller-controlled identifier that flows into Django
    # logs, the X-Order-ID header, and CanvasData.order_id. Allow the
    # conservative set used by typical OMS systems: alphanumerics + _ . -
    # up to 64 chars. Anything else is rejected with 400.
    ORDER_ID_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,64}$')

    @extend_schema(
        tags=["embed"],
        summary="Create embed session token",
        description=(
            "Exchange your API key for a **short-lived UUID token** (TTL: 2 hours) "
            "that is safe to embed in an iframe URL.\n\n"
            "### How it works\n\n"
            "```\n"
            "Your server  →  POST /api/embed/session\n"
            "                (optionally include callback_url for the completion webhook)\n"
            "             ←  { token: '<uuid>' }\n\n"
            "Your page    →  <iframe src=\"https://product-editor.printo.in/editor/layout/<name>?token=<uuid>\" />\n\n"
            "Customer edits canvas and clicks Save & Continue\n\n"
            "Your page    ←  window.postMessage({ type: 'pe:render_job', jobId, orderID })\n"
            "                (UX ping only — the rendered ZIP is delivered out-of-band\n"
            "                 via a signed webhook to your callback_url; see\n"
            "                 docs/INTEGRATION.md for the full contract)\n\n"
            "Customer taps the editor's Back button (optional)\n\n"
            "Your page    ←  window.postMessage({ type: 'pe:back', orderID })\n"
            "                (deliberately not browser-history navigation — an iframe\n"
            "                 shares its tab's back/forward stack with the parent page,\n"
            "                 so calling history.back() from inside it could navigate\n"
            "                 YOUR page, or even carry the customer off your site\n"
            "                 entirely. This message hands you the signal instead; it's\n"
            "                 a no-op until you add a listener — see docs/INTEGRATION.md)\n"
            "```\n\n"
            "### Ordered quantity (`qty`)\n\n"
            "Send `qty` in this body and it is stored on the session, injected "
            "upstream as `X-Order-Qty`, and **enforced at render submission** — the "
            "customer's browser never sees a number it could edit. It caps how many "
            "photos the customer can submit:\n\n"
            "- **More than `qty`** — blocked. The editor offers *Keep first N* or "
            "*Choose again*, and `POST /api/editor/render` rejects an over-count "
            "submission with 400 even if the editor is bypassed.\n"
            "- **Fewer than `qty`** — allowed, with an auto-fill prompt and a "
            "pre-submit warning. Deliberate, and true on the server too: a wrong "
            "`qty` must not strand a real order at checkout. The completion webhook "
            "carries `qty_summary` — `{ordered_qty, placed_photos, shortfall, "
            "customer_acknowledged_shortfall, summary}`, counted by the server — so you can "
            "record when a customer knowingly submitted fewer photos than ordered. "
            "It is `null` when no `qty` was set or the product is multi-surface, "
            "calendar or book.\n"
            "- Applies to **single-surface products only**. Two-sided products, "
            "calendars and books have a surface count fixed by the layout.\n\n"
            "The legacy `?qty=N` URL parameter still works as a fallback for callers "
            "that have not moved the value into this body, but it is browser-editable "
            "and not enforced server-side. Prefer this field.\n\n"
            "### Security guarantees\n\n"
            "- Token is a disposable UUID — never the real API key\n"
            "- All subsequent calls from the embed page go through the Next.js server-side proxy "
            "which resolves the token to the real key without exposing it to the browser\n"
            "- Token expires after 2 hours; generate a fresh one per customer session\n\n"
            "**Auth:** `Authorization: Bearer <real-api-key>` (server-to-server only)"
        ),
        request=inline_serializer(
            name="EmbedSession",
            fields={
                "order_id": drf_serializers.CharField(
                    required=False,
                    help_text=(
                        "Your job/order identifier. 1-64 chars, `A-Z a-z 0-9 _ . -` only. "
                        "Stored server-side and injected as the `X-Order-ID` header on every "
                        "upstream call — it never appears in the iframe URL."
                    ),
                ),
                "callback_url": drf_serializers.CharField(
                    required=False,
                    help_text=(
                        "HTTPS URL to POST the signed completion webhook to (max 2000 chars). "
                        "Omit it and no webhook fires — poll `/api/render-status/<job_id>/` instead. "
                        "See docs/INTEGRATION.md for the payload and HMAC verification."
                    ),
                ),
                "include_uploads": drf_serializers.BooleanField(
                    required=False,
                    default=True,
                    help_text=(
                        "Include the customer's original photos (`1_customer_uploads/`) in the "
                        "delivered ZIP. Set false for a smaller, faster download of just the "
                        "mock + print files; `uploads_download_url` is then null."
                    ),
                ),
                "qty": drf_serializers.IntegerField(
                    required=False,
                    min_value=1,
                    max_value=MAX_ORDER_QTY,
                    help_text=(
                        "Number of items the customer ordered. Stored on the session and "
                        "injected as the `X-Order-Qty` header, so the editor's cap cannot be "
                        "raised from the browser. Omit it and no quantity is enforced."
                    ),
                ),
            },
        ),
        responses={
            201: inline_serializer(
                name="EmbedSessionResponse",
                fields={
                    "token": drf_serializers.UUIDField(help_text="Short-lived embed token — safe to put in iframe URL"),
                    "expires_at": drf_serializers.DateTimeField(help_text="ISO 8601 expiry timestamp (2 hours from now)"),
                    "embed_url_template": drf_serializers.CharField(
                        help_text="URL template — replace `{layout_name}` with your layout, e.g. `retro_polaroid_4.2x3.5`"
                    ),
                },
            ),
            400: OpenApiResponse(
                description=(
                    "`order_id` outside `^[A-Za-z0-9_.\\-]{1,64}$`, `callback_url` over "
                    "2000 chars, `callback_url` failing the https-only + "
                    "public-address SSRF check, or `qty` that is not a whole number "
                    "between 1 and 10000."
                ),
            ),
            401: OpenApiResponse(description="Invalid or missing API key"),
        },
        examples=[
            OpenApiExample(
                "Successful token creation",
                value={
                    "token": "a3f1c2d4-e5b6-7890-abcd-ef1234567890",
                    "expires_at": "2024-01-15T14:30:00+05:30",
                    "embed_url_template": "/embed/editor/{layout_name}?token=a3f1c2d4-e5b6-7890-abcd-ef1234567890",
                },
                response_only=True,
                status_codes=["201"],
            ),
        ],
    )
    def post(self, request):
        from datetime import timedelta
        api_key = request.user.api_key
        expires_at = timezone.now() + timedelta(hours=2)
        # Caller's job/order identifier — stored server-side so the proxy can
        # inject it as X-Order-ID without putting it in the iframe URL.
        order_id = str(request.data.get('order_id', '') or '').strip()
        if order_id and not self.ORDER_ID_RE.match(order_id):
            return Response(
                {'detail': 'order_id must be 1-64 chars; allowed: A-Z a-z 0-9 _ . -'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Optional webhook URL the caller wants notified when render completes.
        # No domain allowlist — auth is enforced by the api_key the caller
        # already holds, and the HMAC signature (sent on the callback) lets
        # them verify the request actually came from us. We do require https
        # to avoid leaking download_url + signature over plaintext.
        callback_url = str(request.data.get('callback_url', '') or '').strip()
        if callback_url:
            if len(callback_url) > 2000:
                return Response(
                    {'detail': 'callback_url exceeds 2000-char limit.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # SSRF guard (Phase 4): https-only + the host must resolve to a
            # publicly-routable address (no internal services, cloud metadata,
            # loopback, RFC1918). Re-checked at webhook send time too.
            from services.url_safety import validate_public_https_url
            try:
                validate_public_https_url(callback_url)
            except ValidationError as exc:
                return Response(
                    {'detail': exc.messages[0] if exc.messages else 'callback_url is not allowed.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Whether the completion webhook's ZIP should include the customer's
        # original uploads (1_customer_uploads/). Defaults True so existing
        # integrations are unchanged; pass include_uploads=false for a smaller,
        # faster download that ships only the mock + print files.
        include_uploads = str(
            request.data.get('include_uploads', True)
        ).strip().lower() not in ('0', 'false', 'no', 'off')

        # Ordered quantity. Absent means "the caller did not say" and nothing
        # is enforced — distinct from a zero, which is rejected. Stored here
        # rather than read off the iframe URL so the cap the editor applies
        # can't be raised by editing that URL; EditorRenderView re-checks it at
        # submit from the header the proxy injects.
        try:
            qty = parse_order_qty(request.data.get('qty'))
        except InvalidOrderQty as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        session = EmbedSession.objects.create(
            api_key=api_key,
            expires_at=expires_at,
            order_id=order_id,
            callback_url=callback_url,
            include_uploads=include_uploads,
            qty=qty,
        )
        return Response({
            'token': str(session.token),
            'expires_at': session.expires_at.isoformat(),
            # The real iframe entry route (next.config.mjs frame-ancestors +
            # editor/layout/[name]/page.tsx). The old /embed/editor/... path
            # never existed. Advisory field — the caller substitutes the
            # layout name.
            'embed_url_template': '/editor/layout/{layout_name}?token=' + str(session.token),
            'order_id': order_id or None,
            'callback_url': callback_url or None,
            'include_uploads': include_uploads,
            'qty': qty,
        }, status=status.HTTP_201_CREATED)


class EmbedSessionValidateView(APIView):
    """
    Internal endpoint called only by the Next.js server-side proxy to resolve a token → real API key.
    Not intended for direct use by external clients.
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["embed"],
        summary="Validate embed token (internal proxy use only)",
        description=(
            "**⚠️ Internal use only** — called exclusively by the Next.js server-side proxy "
            "(`/api/embed/proxy/[...path]`). Do not call this from browser JavaScript.\n\n"
            "Validates the embed token and returns the underlying API key so the proxy can "
            "forward the request to Django with a real `Authorization: Bearer` header — "
            "without ever exposing the key to the browser.\n\n"
            "### Protection\n\n"
            "Protected by a shared `X-Internal-Secret` header that is set only in the server "
            "environment and never accessible to browsers. If `EMBED_INTERNAL_SECRET` env var "
            "is set, requests missing or providing a wrong secret receive `403 Forbidden`."
        ),
        parameters=[
            OpenApiParameter(
                "token",
                OpenApiTypes.UUID,
                OpenApiParameter.QUERY,
                required=True,
                description="The embed session UUID from the iframe URL",
            ),
        ],
        responses={
            200: inline_serializer(
                name="EmbedValidateResponse",
                fields={"api_key": drf_serializers.CharField(help_text="The real API key backing this embed session")},
            ),
            400: OpenApiResponse(description="`token` query param is missing"),
            401: OpenApiResponse(description="Token not found or expired"),
            403: OpenApiResponse(description="Missing or invalid `X-Internal-Secret` header"),
            503: OpenApiResponse(
                description="`EMBED_INTERNAL_SECRET` is not configured. Fails closed in production rather than serving an api_key unprotected.",
            ),
        },
        # Uses none of the three normal schemes — the gate is the shared header
        # declared in SPECTACULAR_SETTINGS["APPEND_COMPONENTS"].
        auth=[{"InternalSecret": []}],
    )
    def get(self, request):
        import os
        import hmac as _hmac
        # This endpoint returns the partner's REAL api_key, so it must only be
        # reachable by the trusted embed proxy — never by an arbitrary embed
        # token holder (a token rides in the iframe URL and is not itself a
        # secret). Access is gated by a shared X-Internal-Secret that only the
        # proxy knows; frontend + backend both read EMBED_INTERNAL_SECRET from
        # .env via env_file.
        expected_secret = os.getenv('EMBED_INTERNAL_SECRET', '')
        provided = request.headers.get('X-Internal-Secret', '')
        if expected_secret:
            # Constant-time compare so a wrong guess can't be timing-probed.
            if not _hmac.compare_digest(provided, expected_secret):
                return Response({'detail': 'Forbidden'}, status=status.HTTP_403_FORBIDDEN)
        elif not settings.DEBUG:
            # Fail closed in production: an unset secret would hand the partner
            # api_key to any token holder. Refuse rather than leak. Dev (DEBUG)
            # keeps working on localhost without the secret for convenience.
            logger.error(
                "EMBED_INTERNAL_SECRET is not set — refusing to serve api_key "
                "for an embed token in production. Set it in .env (read by both "
                "the backend and frontend containers via env_file)."
            )
            return Response(
                {'detail': 'Embed validation is not configured.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        token = request.query_params.get('token', '').strip()
        if not token:
            return Response({'detail': 'token param required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            session = EmbedSession.objects.select_related('api_key').get(token=token)
        except (EmbedSession.DoesNotExist, Exception):
            return Response({'detail': 'Invalid token'}, status=status.HTTP_401_UNAUTHORIZED)

        if not session.is_valid():
            return Response({'detail': 'Token expired or revoked'}, status=status.HTTP_401_UNAUTHORIZED)

        # Sliding TTL — keep long-lived editing sessions alive without a hard
        # cutoff at the original 2-hour mark. Only extend when the session is
        # already in its second half so we don't write on every request when
        # the proxy cache (110-min TTL) is hammering us at the start.
        from datetime import timedelta
        now = timezone.now()
        # original lifetime is 2h; extend by 1h when remaining < 30 min
        if (session.expires_at - now) < timedelta(minutes=30):
            session.expires_at = now + timedelta(hours=1)
            session.save(update_fields=['expires_at'])

        return Response({
            'api_key': session.api_key.key,
            'order_id': session.order_id or None,
            'callback_url': session.callback_url or None,
            'include_uploads': session.include_uploads,
            'qty': session.qty,
            'expires_at': session.expires_at.isoformat(),
        })


# ─── Editor init (batched fetch of cacheable mount data) ─────────────────────

class EditorInitView(APIView):
    """
    GET /api/editor/init?layout=<name>[&surfaces=<csv>]

    Returns the static, cacheable bits the editor needs on mount in one round
    trip: `{ layout, fonts }`. Replaces two parallel fetches (`/layouts/<name>`
    + `/fonts`) with a single TLS-friendly request — meaningful on cold-start
    embed iframes where the connection isn't warm yet.

    Per-order live data (canvas-state) is intentionally NOT included so this
    response stays cacheable. Frontend keeps `/canvas-state/<order_id>/` as a
    separate request (no cache, tenant-scoped to the api_key+order_id pair).

    Permission and surface filtering match `GetLayoutView` exactly so the
    embed proxy and ops admin paths behave identically.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["editor"],
        summary="Batched editor mount payload",
        description=(
            "Returns the static, cacheable bits the editor needs on mount: "
            "`{ layout, fonts, order_id, qty }`. This is what an embed iframe's "
            "URL hits on load. `layout.name` is immutable once a layout is "
            "created (2026-09-16) — safe to hardcode in your iframe URL "
            "indefinitely. A handful of layouts renamed before that date still "
            "resolve under their pre-rename identifier; the response's "
            "`layout.name` then reflects the current one, which may differ from "
            "the `layout` query param you sent. `layout.displayName` is the "
            "ops-curated customer-facing name, independent of `layout.name`."
        ),
        parameters=[
            OpenApiParameter("layout", OpenApiTypes.STR, OpenApiParameter.QUERY, required=True),
            OpenApiParameter("surfaces", OpenApiTypes.STR, OpenApiParameter.QUERY, required=False),
        ],
        responses={
            200: inline_serializer(
                name="EditorInitResponse",
                fields={
                    "layout": drf_serializers.DictField(),
                    "fonts": drf_serializers.ListField(child=drf_serializers.CharField()),
                    "order_id": drf_serializers.CharField(
                        allow_null=True,
                        help_text="Echo of the embed session's order_id; null for dashboard requests.",
                    ),
                    "qty": drf_serializers.IntegerField(
                        allow_null=True,
                        help_text=(
                            "Echo of the embed session's ordered quantity; null when the "
                            "session carries none or the caller is the dashboard."
                        ),
                    ),
                },
            ),
            400: OpenApiResponse(description="Missing or invalid `layout` query param"),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request):
        from django.core.cache import cache as django_cache
        from api.models import LayoutCatalogue, default_display_name_for

        name = (request.query_params.get('layout') or '').strip()
        if not name:
            return Response({'detail': '`layout` query param required'}, status=status.HTTP_400_BAD_REQUEST)
        # 400 for a malformed name, 404 for one that simply isn't there — the
        # editor needs to tell "bad request" apart from "this layout is gone".
        if not GetLayoutView._is_safe_layout_name(name):
            return Response({'detail': 'Invalid layout name'}, status=status.HTTP_400_BAD_REQUEST)

        surfaces_param = request.query_params.get('surfaces', '')
        # Reuse the GetLayoutView cache key so a request to either endpoint
        # warms both. Cache TTL matches GetLayoutView (2 min).
        cache_key = f"layout_detail:{name}:{surfaces_param}"
        layout_data = django_cache.get(cache_key)

        if layout_data is None:
            # Query LayoutCatalogue from Postgres — resolve_active follows a
            # rename alias so a stale name (e.g. a partner's hardcoded embed
            # URL, or an iframe already open when a rename lands) still
            # resolves instead of 404ing the customer mid-order.
            try:
                layout = LayoutCatalogue.resolve_active(name, require_public=True)
            except LayoutCatalogue.DoesNotExist:
                return Response(
                    {'detail': f"Layout '{name}' not found"},
                    status=status.HTTP_404_NOT_FOUND
                )

            # Fetch definition from database
            layout_data = layout.definition.copy() if isinstance(layout.definition, dict) else {}
            layout_data['name'] = layout.name
            layout_data['displayName'] = layout.display_name or default_display_name_for(layout.name)

            if surfaces_param and 'surfaces' in layout_data and isinstance(layout_data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                layout_data['surfaces'] = [
                    s for s in layout_data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]
            django_cache.set(cache_key, layout_data, 120)

        # _read_fonts has its own Redis-backed 5 min cache (see _FONTS_CACHE_KEY).
        # order_id echoes the proxy-injected X-Order-ID (EmbedSession.order_id)
        # so the embed iframe can adopt the SESSION id for autosave/restore
        # keying instead of a throwaway client-generated one (Phase 3 — an
        # iframe reload used to orphan the autosave). Only the trusted proxies
        # can set this header (both build forward headers from scratch);
        # dashboard requests carry none → null.
        #
        # qty echoes X-Order-Qty the same way, so the editor caps against the
        # quantity the CALLER set rather than the browser-editable ?qty=N. Null
        # for a dashboard request or a session created without one, and the
        # editor then falls back to that URL param.
        try:
            init_qty = parse_order_qty(request.headers.get('X-Order-Qty'))
        except InvalidOrderQty:
            # A header only the trusted proxy can set, sourced from a validated
            # column — if it is somehow unusable, drop it rather than fail the
            # editor's mount request over it.
            init_qty = None
        response = Response({
            'layout': layout_data,
            'fonts': _read_fonts(),
            'order_id': (request.headers.get('X-Order-ID') or '').strip() or None,
            'qty': init_qty,
        })
        # Cacheable on the proxy edge for short-lived shared cache; private so a
        # tenant's surfaces= filter doesn't bleed across tenants.
        response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
        return response


# ═══════════════════════════════════════════════════════════════════════════════
#  Canvas State Persistence  (P0 — survives page refresh / checkout transition)
# ═══════════════════════════════════════════════════════════════════════════════

class CanvasStateView(APIView):
    """
    Save / load the full editor state for a given order_id.

    PUT  /api/canvas-state/<order_id>/  — upsert editor state (called by the
         frontend on every meaningful edit, debounced ~2 s).
    GET  /api/canvas-state/<order_id>/  — restore editor state on page open or
         refresh.

    The state JSON is opaque to the backend — it stores whatever the frontend
    sends (frames, overlays, colours, surface layouts).  The only thing the
    backend validates is that it's valid JSON and under 5 MB.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    MAX_STATE_SIZE = 5 * 1024 * 1024  # 5 MB

    @extend_schema(
        tags=["canvas-state"],
        summary="Load saved editor state",
        responses={
            200: OpenApiResponse(description="Editor state JSON"),
            404: OpenApiResponse(description="No saved state for this order_id"),
        },
    )
    def get(self, request, order_id: str):
        from api.models import CanvasData

        # NOTE: GET deliberately respects the PATH param (unlike put(), where
        # the session header wins). The embed proxy injects X-Order-ID on
        # every request, so header-precedence here would make pre-adoption
        # autosaves (keyed by the old client-generated id) unreachable — the
        # client's legacy-id restore fallback needs the path to be honoured.
        # Tenant scoping below keeps this safe: a key can only read its own rows.

        # Resolve the API key so we can scope the lookup to the requesting
        # tenant.  Two different keys can legitimately share the same order_id
        # (e.g. separate embed customers); scoping prevents cross-tenant reads.
        api_key = getattr(request.user, 'api_key', None)
        if not api_key:
            return Response({'detail': 'API key required'}, status=status.HTTP_403_FORBIDDEN)

        try:
            canvas = CanvasData.objects.get(order_id=order_id, api_key=api_key)
        except CanvasData.DoesNotExist:
            return Response(
                {'detail': 'No saved state for this order'},
                status=status.HTTP_404_NOT_FOUND,
            )

        return Response({
            'order_id': canvas.order_id,
            'layout_name': canvas.layout_name,
            'fit_mode': canvas.fit_mode,
            'editor_state': canvas.editor_state,
            'image_paths': canvas.image_paths,
            'updated_at': canvas.updated_at.isoformat() if canvas.updated_at else None,
        })

    @extend_schema(
        tags=["canvas-state"],
        summary="Save editor state (upsert)",
        description=(
            "Autosave for the editor, called on a short debounce while the customer "
            "works. Keyed by `(order_id, api_key)`.\n\n"
            "The `X-Order-ID` header wins over the path parameter, so autosave and "
            "submit can never key different rows for one session.\n\n"
            "**This writes `editor_state` only.** The submit-time render payload "
            "lives in a separate column owned by the render endpoint. The two were "
            "one field once, and autosave firing after a submit could strip a "
            "queued job's payload. Do not merge them again.\n\n"
            "`image_paths` is deliberately not overwritten on update: blanking it "
            "every couple of seconds once made a customer's uploads unfindable for "
            "erasure, since that column was how a purge located their files."
        ),
        request=inline_serializer(
            name="CanvasStateWrite",
            fields={
                "editor_state": drf_serializers.JSONField(
                    help_text="Opaque editor snapshot — surfaces, frames, transforms, overlays, calendar/book state.",
                ),
                "layout_name": drf_serializers.CharField(
                    help_text="Required — the handler rejects a blank value with 400.",
                ),
                "image_paths": drf_serializers.ListField(
                    required=False, child=drf_serializers.CharField(),
                    help_text="Set on create. Not overwritten on update — see description.",
                ),
                "fit_mode": drf_serializers.ChoiceField(choices=["cover", "contain"], required=False, default="cover"),
            },
        ),
        responses={
            200: OpenApiResponse(description="State updated."),
            201: OpenApiResponse(description="State created."),
            400: OpenApiResponse(description="No order_id resolved from header or path, or `layout_name` missing."),
            403: OpenApiResponse(description="Caller presented no API key — PIA sessions cannot own canvas state."),
        },
    )
    def put(self, request, order_id: str):
        from api.models import CanvasData
        from datetime import timedelta

        # See get(): the embed session's order id wins over the path param so
        # autosave and submit can never key different rows again.
        order_id = (request.headers.get('X-Order-ID') or '').strip() or order_id

        body = request.data
        editor_state = body.get('editor_state')
        layout_name = body.get('layout_name', '')
        image_paths = body.get('image_paths', [])
        fit_mode = body.get('fit_mode', 'cover')

        if not order_id:
            return Response({'detail': 'order_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        if not layout_name:
            return Response({'detail': 'layout_name is required'}, status=status.HTTP_400_BAD_REQUEST)

        # Size guard — editor_state is opaque JSON but we cap it at 5 MB.
        raw = json.dumps(editor_state) if editor_state is not None else '{}'
        if len(raw) > self.MAX_STATE_SIZE:
            return Response(
                {'detail': f'editor_state exceeds {self.MAX_STATE_SIZE // (1024*1024)} MB limit'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        api_key = None
        if isinstance(request.user, APIKeyUser):
            api_key = request.user.api_key

        if not api_key:
            return Response({'detail': 'API key required'}, status=status.HTTP_403_FORBIDDEN)

        # Look up by (order_id, api_key) so each tenant owns its own namespace.
        # api_key is in the lookup key, NOT in defaults, so it's never changed
        # on update and is always set correctly on create.
        # image_paths is deliberately NOT in the unconditional defaults.
        #
        # update_or_create writes every key in `defaults`, and the editor's
        # autosave payload is {layout_name, editor_state} — it never carries
        # server-side file paths, because the browser never sees them. So
        # passing `image_paths or []` here overwrote the recorded paths with an
        # empty list on every autosave, i.e. every 2 seconds.
        #
        # That is what broke DPDP erasure: purge_order_data() finds a customer's
        # uploads through image_paths, and by the time anyone requested erasure
        # the field had long been blanked. Only write it when the caller
        # actually supplied paths. See docs/DPDP_ERASURE_GAP_PRD.md.
        defaults = dict(
            layout_name=layout_name,
            fit_mode=fit_mode,
            editor_state=editor_state,
            expires_at=timezone.now() + timedelta(days=settings.EXPORT_RETENTION_DAYS),
        )
        if image_paths:
            defaults['image_paths'] = image_paths

        canvas, created = CanvasData.objects.update_or_create(
            order_id=order_id,
            api_key=api_key,
            defaults=defaults,
        )

        logger.info(
            "Canvas state %s: order_id=%s, layout=%s",
            "created" if created else "updated",
            order_id,
            layout_name,
        )

        return Response(
            {
                'order_id': canvas.order_id,
                'layout_name': canvas.layout_name,
                'saved': True,
            },
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )
