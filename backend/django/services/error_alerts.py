"""Error alerts to a Google Chat space (replaces Sentry, 2026-11-21).

One place builds and sends every alert: backend and Celery errors through
``ChatAlertHandler`` (attached to the root, ``django`` and ``api`` loggers in
settings.LOGGING, and to the worker's root logger in celery.py), and browser /
Next.js server errors through ``ClientErrorReportView``, which calls
``send_alert`` directly.

Rules this module keeps:

- **Off unless configured.** ``ERROR_ALERT_WEBHOOK_URL`` blank (the default,
  and every local .env) sends nothing. Only a Google Chat incoming-webhook
  address is accepted; anything else is ignored, so a typo can never make the
  server POST somewhere else.
- **Never slows or breaks the request.** The caller only puts plain values on
  a queue. Grouping (which asks Redis), building and sending all happen on one
  background thread per process with a 5 s timeout; a full queue drops the
  alert. The
  handler never raises and never logs through the logging tree (that would
  alert about alerting), only to stderr.
- **Repeats are grouped.** The first occurrence of an error is sent; the same
  error again within ``ALERT_REPEAT_WINDOW_SECONDS`` is only counted, and the
  next alert after the window says how many were held back. Counted in the
  Django cache (Redis), so all web and worker processes share one count; when
  the cache cannot answer, each process counts on its own.
- **A ceiling on the space.** At most ``ALERT_MAX_PER_MINUTE`` alerts a minute
  from the whole server (Google Chat refuses a webhook above ~60 a minute).
- **No secrets, no customer content.** Query strings, tokens, keys, bearer
  credentials and e-mail addresses are blanked; request paths are sent without
  their query; every value is HTML-escaped because a card renders HTML.
"""
from __future__ import annotations

import hashlib
import html
import logging
import os
import queue
import re
import sys
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone

WEBHOOK_PREFIX = "https://chat.googleapis.com/v1/spaces/"

REPEAT_WINDOW_SECONDS = int(os.getenv("ALERT_REPEAT_WINDOW_SECONDS", "600"))
MAX_PER_MINUTE = int(os.getenv("ALERT_MAX_PER_MINUTE", "20"))
SEND_TIMEOUT_SECONDS = 5
QUEUE_SIZE = 50

# Printo purple for the brand line; red / orange / blue mark how bad it is.
BRAND_COLOUR = "#64318E"
LEVEL_STYLE = {
    "error": ("#D93025", "ERROR", "🔴"),
    "warning": ("#F17A26", "WARNING", "🟠"),
    "info": ("#1A73E8", "NOTICE", "🔵"),
}

# Loggers whose ERRORs are expected noise, never an alert.
#   django.security.DisallowedHost: scanners hitting the bare IP with a
#   garbage Host header; Django refusing them is the protection working
#   (Sentry was told to ignore it for the same reason).
IGNORED_LOGGERS = (
    "django.security.DisallowedHost",
    __name__,
)

IST = timezone(timedelta(hours=5, minutes=30))

_REDACTIONS = (
    # key=value pairs that carry credentials, in URLs, headers or messages
    (re.compile(r"(?i)\b(token|key|api_key|apikey|secret|password|passwd|signature|sig|"
                r"x-amz-[a-z-]+|authorization|auth|session|code)=([^&\s\"'<>]+)"), r"\1=…"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"), "Bearer …"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "…@…"),
    # any remaining query string on a URL
    (re.compile(r"(https?://[^\s?\"'<>]+)\?[^\s\"'<>]*"), r"\1?…"),
)


def redact(text: str) -> str:
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def clean(text, limit: int) -> str:
    """Untrusted text as safe card HTML: redacted, bounded, escaped, line breaks kept."""
    if text is None:
        return ""
    text = str(text)
    text = "".join(ch if ch.isprintable() or ch == "\n" else " " for ch in text)
    text = redact(text)
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return html.escape(text).replace("\n", "<br>")


def webhook_url() -> str:
    url = os.getenv("ERROR_ALERT_WEBHOOK_URL", "").strip()
    return url if url.startswith(WEBHOOK_PREFIX) else ""


def environment_label() -> str:
    explicit = os.getenv("ENVIRONMENT", "").strip()
    if explicit:
        return explicit
    return "local" if os.getenv("DEBUG", "0") in ("1", "true", "True") else "production"


def build_message(*, level: str, source: str, title: str, where: str = "",
                  details: str = "", held_back: int = 0, now: datetime | None = None) -> dict:
    """The webhook body: a plain-text line for notifications plus a coloured card.

    ``source`` is who raised it, e.g. "Backend", "Render worker", "Browser".
    """
    colour, word, dot = LEVEL_STYLE.get(level, LEVEL_STYLE["error"])
    env = environment_label()
    when = (now or datetime.now(timezone.utc)).astimezone(IST).strftime("%d %b %Y, %I:%M:%S %p IST")
    safe_title = clean(title, 300) or "(no message)"

    widgets = [
        {"textParagraph": {"text": (
            f'<font color="{BRAND_COLOUR}"><b>PRODUCT EDITOR</b></font> · '
            f'<font color="{colour}"><b>{dot} {word}</b></font> · {html.escape(env)}'
        )}},
        {"textParagraph": {"text": f'<font color="{colour}"><b>{safe_title}</b></font>'}},
        {"decoratedText": {
            "topLabel": "Source",
            "text": f"<b>{html.escape(source)}</b>" + (f" · {clean(where, 300)}" if where else ""),
            "startIcon": {"materialIcon": {"name": "dns"}},
        }},
        {"decoratedText": {
            "topLabel": "When",
            "text": when,
            "startIcon": {"materialIcon": {"name": "schedule"}},
        }},
    ]
    if held_back:
        widgets.append({"decoratedText": {
            "topLabel": "Repeats",
            "text": f'<font color="{colour}"><b>{held_back} more</b></font> of this since the last alert',
            "startIcon": {"materialIcon": {"name": "repeat"}},
        }})

    sections = [{"widgets": widgets}]
    if details:
        sections.append({
            "header": "Details",
            "collapsible": True,
            "uncollapsibleWidgetsCount": 0,
            "widgets": [{"textParagraph": {"text": f'<font color="#5F6368">{clean(details, 3000)}</font>'}}],
        })

    # Chat reads <...> in the plain text as a link or a mention (<users/all>),
    # so angle brackets from an error message are swapped for look-alikes.
    plain_title = redact(" ".join(str(title).split()))[:200].replace("<", "‹").replace(">", "›")
    return {
        "text": f"{dot} Product Editor · {source} {word.lower()} ({env}): {plain_title}",
        "cardsV2": [{
            "cardId": "product-editor-alert",
            "card": {
                "header": {
                    "title": "Product Editor",
                    "subtitle": f"{source} {word.lower()} · {env}",
                },
                "sections": sections,
            },
        }],
    }


# ── Grouping repeats and the per-minute ceiling ──────────────────────────────

_local_lock = threading.Lock()
_local_windows: dict[str, float] = {}
_local_counts: dict[str, int] = {}
_local_minute: list = [0, 0]  # [minute, count]


def _cache():
    try:
        from django.conf import settings
        if not settings.configured:
            return None
        from django.core.cache import cache
        return cache
    except Exception:
        return None


def _decide_local(sig: str) -> tuple[bool, int]:
    now = time.time()
    with _local_lock:
        opened = _local_windows.get(sig)
        if opened is not None and now - opened < REPEAT_WINDOW_SECONDS:
            _local_counts[sig] = _local_counts.get(sig, 0) + 1
            return False, 0
        _local_windows[sig] = now
        return True, _local_counts.pop(sig, 0)


def _under_ceiling_local() -> bool:
    minute = int(time.time() // 60)
    with _local_lock:
        if _local_minute[0] != minute:
            _local_minute[0], _local_minute[1] = minute, 0
        _local_minute[1] += 1
        return _local_minute[1] <= MAX_PER_MINUTE


def decide(signature: str) -> tuple[bool, int]:
    """(send it?, how many repeats were held back since the last alert)."""
    sig = hashlib.sha1(signature.encode("utf-8", "replace")).hexdigest()[:16]
    cache = _cache()
    if cache is None:
        send, held = _decide_local(sig)
        return (send and _under_ceiling_local()), held
    try:
        opened = cache.add(f"alert:win:{sig}", 1, REPEAT_WINDOW_SECONDS)
        if opened is None:  # the cache swallowed an error (Redis down)
            raise RuntimeError("cache unavailable")
        if not opened:
            if not cache.add(f"alert:cnt:{sig}", 1, 86400):
                cache.incr(f"alert:cnt:{sig}")
            return False, 0
        held = cache.get(f"alert:cnt:{sig}") or 0
        if held:
            cache.delete(f"alert:cnt:{sig}")
        minute_key = f"alert:minute:{int(time.time() // 60)}"
        if cache.add(minute_key, 1, 120):
            count = 1
        else:
            count = cache.incr(minute_key) or 1
        return count <= MAX_PER_MINUTE, int(held)
    except Exception:
        send, held = _decide_local(sig)
        return (send and _under_ceiling_local()), held


# ── Sending, off the request thread ──────────────────────────────────────────

_queue: "queue.Queue[dict]" = queue.Queue(maxsize=QUEUE_SIZE)
_sender: threading.Thread | None = None
_sender_pid: int | None = None
_sender_lock = threading.Lock()


def _stderr(message: str) -> None:
    try:
        sys.stderr.write(f"[error_alerts] {message}\n")
    except Exception:
        pass


def _post(url: str, body: dict) -> None:
    import requests
    response = requests.post(url, json=body, timeout=SEND_TIMEOUT_SECONDS)
    if response.status_code >= 300:
        _stderr(f"Google Chat answered {response.status_code}")


def _deliver(item: dict) -> None:
    """Group, build and post one alert. Runs on the sender thread only, so a
    slow Redis or a slow Google Chat never holds up the request that logged it."""
    url = webhook_url()
    if not url:
        return
    send, held = decide(item.pop("signature"))
    if not send:
        return
    _post(url, build_message(held_back=held, **item))


def _run_sender() -> None:
    while True:
        item = _queue.get()
        try:
            _deliver(item)
        except Exception as exc:  # never let the sender thread die
            _stderr(f"send failed: {type(exc).__name__}")


def _ensure_sender() -> None:
    global _sender, _sender_pid
    pid = os.getpid()
    # A forked Celery child inherits the parent's thread object but not the thread.
    if _sender is not None and _sender_pid == pid and _sender.is_alive():
        return
    with _sender_lock:
        if _sender is not None and _sender_pid == pid and _sender.is_alive():
            return
        _sender = threading.Thread(target=_run_sender, name="error-alerts", daemon=True)
        _sender_pid = pid
        _sender.start()


def send_alert(*, level: str, source: str, title: str, signature: str, where: str = "",
               details: str = "") -> bool:
    """Queue one alert for the sender thread, which drops it if it repeats a
    recent one or the per-minute ceiling is reached.

    Only plain values are queued here; nothing on the caller's thread touches
    the cache or the network. Returns True when queued. Never raises.
    """
    try:
        if not webhook_url():
            return False
        _ensure_sender()
        _queue.put_nowait({
            "level": level, "source": source, "title": str(title)[:2000], "where": where,
            "details": str(details)[:6000], "signature": signature,
        })
        return True
    except queue.Full:
        _stderr("queue full, alert dropped")
        return False
    except Exception as exc:
        _stderr(f"could not queue alert: {type(exc).__name__}")
        return False


# ── The logging handler ──────────────────────────────────────────────────────

# Anything with a digit in it (job ids, uuids, sizes, ports, addresses) is
# blanked, so one bug hitting many orders is one alert.
_NUMBERS = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}|[\w.]*\d[\w.]*")
_in_emit = threading.local()


def source_for(record: logging.LogRecord) -> str:
    process = os.getenv("ALERT_SOURCE", "").strip()
    if process:
        return process
    argv = " ".join(sys.argv[:3])
    if "celery" in argv and "beat" in argv:
        return "Scheduler"
    if "celery" in argv:
        return "Render worker"
    return "Backend"


def signature_for(record: logging.LogRecord) -> str:
    if record.exc_info and record.exc_info[0] is not None:
        exc_type, exc, tb = record.exc_info
        frames = traceback.extract_tb(tb) if tb else []
        last = frames[-1] if frames else None
        place = f"{os.path.basename(last.filename)}:{last.name}" if last else ""
        return f"{exc_type.__name__}|{_NUMBERS.sub('#', str(exc))[:160]}|{place}"
    return f"{record.name}|{_NUMBERS.sub('#', str(record.msg))[:160]}"


class ChatAlertHandler(logging.Handler):
    """Sends ERROR and CRITICAL log records to Google Chat. Never raises."""

    def __init__(self, level=logging.ERROR):
        super().__init__(level=level)

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(_in_emit, "active", False):
            return
        if record.name.startswith(IGNORED_LOGGERS):
            return
        if not webhook_url():
            return
        _in_emit.active = True
        try:
            message = record.getMessage()
            where_parts = [f"{record.module}.{record.funcName}:{record.lineno}"]
            request = getattr(record, "request", None)
            if request is not None:
                try:
                    where_parts.insert(0, f"{request.method} {request.path}")
                except Exception:
                    pass
            details = ""
            title = message
            if record.exc_info and record.exc_info[0] is not None:
                exc_type, exc, tb = record.exc_info
                title = f"{exc_type.__name__}: {exc}" if str(exc) else exc_type.__name__
                lines = traceback.format_exception(exc_type, exc, tb)
                details = f"{message}\n\n" + "".join(lines[-12:])
            send_alert(
                level="error",
                source=source_for(record),
                title=title,
                where=" · ".join(where_parts),
                details=details,
                signature=signature_for(record),
            )
        except Exception as exc:
            _stderr(f"handler failed: {type(exc).__name__}")
        finally:
            _in_emit.active = False
