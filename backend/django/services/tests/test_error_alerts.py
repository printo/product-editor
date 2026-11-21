"""
Tests for services/error_alerts.py — error alerts to the team's Google Chat
space (the replacement for Sentry). DB-free and Django-free: with settings
unconfigured the module counts repeats in-process, which is what is tested.

Run stand-alone:
    cd backend/django && python -m services.tests.test_error_alerts
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import datetime, timezone
from unittest.mock import patch

from services import error_alerts as ea

CHAT_URL = "https://chat.googleapis.com/v1/spaces/TEST/messages?key=k&token=t"


def _reset():
    ea._local_windows.clear()
    ea._local_counts.clear()
    ea._local_minute[:] = [0, 0]
    while not ea._queue.empty():
        ea._queue.get_nowait()


def _all_text(body: dict) -> str:
    import json
    return json.dumps(body, ensure_ascii=False)


def test_off_without_a_webhook_address():
    _reset()
    with patch.dict(os.environ, {"ERROR_ALERT_WEBHOOK_URL": ""}):
        assert ea.send_alert(level="error", source="Backend", title="x", signature="a") is False
    assert ea._queue.empty()


def test_only_a_google_chat_address_is_used():
    with patch.dict(os.environ, {"ERROR_ALERT_WEBHOOK_URL": "https://evil.example.com/hook"}):
        assert ea.webhook_url() == ""
    with patch.dict(os.environ, {"ERROR_ALERT_WEBHOOK_URL": " " + CHAT_URL + " "}):
        assert ea.webhook_url() == CHAT_URL


def test_card_is_branded_and_coloured_by_level():
    body = ea.build_message(level="error", source="Render worker", title="ValueError: boom",
                            where="tasks.render_canvas_task:42", details="Traceback ...",
                            now=datetime(2026, 11, 21, 6, 30, tzinfo=timezone.utc))
    text = _all_text(body)
    assert body["text"].startswith("🔴 Product Editor · Render worker error")
    card = body["cardsV2"][0]["card"]
    assert card["header"]["title"] == "Product Editor"
    assert "#64318E" in text  # Printo purple brand line
    assert "#D93025" in text  # red for an error
    assert "12:00:00 PM IST" in text  # 06:30 UTC shown in IST
    assert card["sections"][1]["collapsible"] is True  # details folded away

    warning = _all_text(ea.build_message(level="warning", source="Browser", title="HEIC decode failed"))
    assert "#F17A26" in warning and "🟠" in warning


def test_repeats_are_counted_and_reported_with_the_next_alert():
    body = ea.build_message(level="error", source="Backend", title="x", held_back=37)
    assert "37 more" in _all_text(body)


def test_card_text_is_escaped_and_secrets_are_removed():
    body = ea.build_message(
        level="error", source="Backend",
        title='<a href="https://x">click</a> <users/all> token=abc123 for a@b.com',
        details="GET https://files.example.com/p.jpg?X-Amz-Signature=deadbeef&size=2\nAuthorization: Bearer sk_live_123",
    )
    text = _all_text(body)
    assert "<a href" not in text and "&lt;a href" in text
    assert "abc123" not in text and "a@b.com" not in text
    assert "deadbeef" not in text and "sk_live_123" not in text
    assert "token=…" in text
    # The notification line is Chat's own markup: no link, no @all mention.
    assert "<" not in body["text"] and ">" not in body["text"]


def test_same_error_is_sent_once_per_window_then_with_the_count():
    _reset()
    assert ea.decide("Boom|x") == (True, 0)
    assert ea.decide("Boom|x") == (False, 0)
    assert ea.decide("Boom|x") == (False, 0)
    assert ea.decide("Other|y") == (True, 0)
    # The window passes: the next one goes out and carries the two held back.
    sig = __import__("hashlib").sha1(b"Boom|x").hexdigest()[:16]
    ea._local_windows[sig] -= ea.REPEAT_WINDOW_SECONDS + 1
    assert ea.decide("Boom|x") == (True, 2)


def test_ceiling_per_minute():
    _reset()
    results = [ea.decide(f"distinct-{i}")[0] for i in range(ea.MAX_PER_MINUTE + 5)]
    assert results.count(True) == ea.MAX_PER_MINUTE


def _record(name="api.tasks", exc=None, msg="Render failed for job %s", args=("1234",)):
    exc_info = None
    if exc is not None:
        try:
            raise exc
        except Exception:
            exc_info = sys.exc_info()
    return logging.LogRecord(name, logging.ERROR, __file__, 10, msg, args, exc_info, func="render")


def test_signature_ignores_ids_so_one_bug_is_one_alert():
    a = ea.signature_for(_record(exc=ValueError("job 1111 failed at 0x7f00")))
    b = ea.signature_for(_record(exc=ValueError("job 2222 failed at 0x7f99")))
    assert a == b
    c = ea.signature_for(_record(exc=RuntimeError("Render failed for job 7f3c (disk full)")))
    d = ea.signature_for(_record(exc=RuntimeError("Render failed for job 9a11 (disk full)")))
    assert c == d
    assert c != ea.signature_for(_record(exc=RuntimeError("Render failed for job 9a11 (font missing)")))
    assert ea.signature_for(_record(args=("1",))) == ea.signature_for(_record(args=("2",)))


def test_handler_queues_an_alert_for_an_error_with_a_traceback():
    _reset()
    handler = ea.ChatAlertHandler()
    with patch.dict(os.environ, {"ERROR_ALERT_WEBHOOK_URL": CHAT_URL}), \
            patch.object(ea, "_ensure_sender"):
        handler.emit(_record(exc=RuntimeError("disk full")))
    item = ea._queue.get_nowait()
    assert item["title"] == "RuntimeError: disk full"
    assert "Traceback" in item["details"]
    # The request thread only queued values; grouping happens on the sender.
    assert ea._local_windows == {}
    text = _all_text(ea.build_message(**{k: v for k, v in item.items() if k != "signature"}))
    assert "RuntimeError: disk full" in text


def test_handler_ignores_scanner_host_errors_and_never_raises():
    _reset()
    handler = ea.ChatAlertHandler()
    with patch.dict(os.environ, {"ERROR_ALERT_WEBHOOK_URL": CHAT_URL}), \
            patch.object(ea, "_ensure_sender"):
        handler.emit(_record(name="django.security.DisallowedHost", msg="Invalid HTTP_HOST", args=()))
        assert ea._queue.empty()
        with patch.object(ea, "signature_for", side_effect=RuntimeError("bad")):
            handler.emit(_record(exc=ValueError("x")))  # must not raise
    assert ea._queue.empty()


def test_sender_thread_posts_to_the_webhook():
    _reset()
    posted = []
    with patch.dict(os.environ, {"ERROR_ALERT_WEBHOOK_URL": CHAT_URL}), \
            patch.object(ea, "_post", side_effect=lambda url, body: posted.append((url, body))):
        ea._sender = None
        assert ea.send_alert(level="error", source="Backend", title="hello", signature="send-test")
        deadline = __import__("time").time() + 3
        while not posted and __import__("time").time() < deadline:
            __import__("time").sleep(0.02)
    assert posted and posted[0][0] == CHAT_URL
    assert "hello" in _all_text(posted[0][1])


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} error alert tests passed.")
