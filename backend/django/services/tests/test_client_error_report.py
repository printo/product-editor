"""
Tests for ClientErrorReportView (POST /api/client-errors): frontend errors
passed to the team's Google Chat space. DB-free: send_alert is patched, and
the frontend-server case patches the bearer authentication.

Run stand-alone:
    cd backend/django && python -m services.tests.test_client_error_report
"""
from __future__ import annotations

import json
import os
from types import SimpleNamespace
from unittest.mock import patch

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.test import RequestFactory, override_settings  # noqa: E402
from api.views import ClientErrorReportView  # noqa: E402

factory = RequestFactory()
view = ClientErrorReportView.as_view()
HOST = "product-editor.printo.in"


def _post(body, origin=f"https://{HOST}", raw=None):
    data = raw if raw is not None else json.dumps(body).encode()
    extra = {"HTTP_HOST": HOST}
    if origin:
        extra["HTTP_ORIGIN"] = origin
    request = factory.post("/api/client-errors", data=data, content_type="application/json", **extra)
    with override_settings(ALLOWED_HOSTS=[HOST, "backend"]), \
            patch("services.error_alerts.send_alert") as send, \
            patch("api.views.system.logger") as log:
        response = view(request)
    return response, send, log


def test_a_browser_error_from_our_page_is_sent():
    response, send, log = _post({
        "kind": "error", "message": "TypeError: x is undefined",
        "stack": "at f (https://product-editor.printo.in/_next/static/chunks/a.js:1:2)",
        "source": "https://product-editor.printo.in/_next/static/chunks/a.js?v=1", "line": 1,
        "page": "/editor/layout/circle_48mm", "embed": True, "userAgent": "Mozilla/5.0 iPhone",
    })
    assert response.status_code == 204
    kwargs = send.call_args.kwargs
    assert kwargs["source"] == "Browser (embed)"
    assert kwargs["title"] == "TypeError: x is undefined"
    assert kwargs["where"] == "/editor/layout/circle_48mm · a.js:1"
    assert "iPhone" in kwargs["details"]
    assert log.warning.called


def test_a_report_without_our_origin_is_ignored():
    for origin in ("", "https://evil.example.com"):
        response, send, _ = _post({"message": "spam"}, origin=origin)
        assert response.status_code == 204
        assert not send.called


def test_noise_and_bad_bodies_are_ignored():
    for body in (
        {"message": "Script error."},
        {"message": "ResizeObserver loop completed with undelivered notifications."},
        {"message": "boom", "stack": "at chrome-extension://abc/content.js:1"},
        {"message": ""},
        ["not", "a", "dict"],
    ):
        response, send, _ = _post(body)
        assert response.status_code == 204 and not send.called, body
    response, send, _ = _post(None, raw=b"not json")
    assert response.status_code == 204 and not send.called
    response, send, _ = _post(None, raw=json.dumps({"message": "x" * 20000}).encode())
    assert response.status_code == 204 and not send.called


def test_the_page_query_never_travels():
    _, send, _ = _post({"message": "boom", "page": "/editor/layout/x?token=secret-token"})
    assert "secret-token" not in send.call_args.kwargs["where"]


def test_heic_warning_keeps_its_level():
    _, send, _ = _post({"kind": "heic", "level": "warning", "message": "HEIC decode failed"})
    assert send.call_args.kwargs["level"] == "warning"


def test_the_frontend_server_reports_with_the_ops_key_and_no_origin():
    ops_user = SimpleNamespace(is_authenticated=True, is_ops_team=True)
    with patch("api.authentication.BearerTokenAuthentication.authenticate",
               return_value=(ops_user, "key")):
        response, send, _ = _post({"kind": "server-render", "message": "Error: render failed",
                                   "page": "GET /dashboard"}, origin="")
    assert response.status_code == 204
    assert send.call_args.kwargs["source"] == "Frontend server"


def test_a_partner_key_is_not_the_frontend_server():
    partner = SimpleNamespace(is_authenticated=True, is_ops_team=False)
    with patch("api.authentication.BearerTokenAuthentication.authenticate",
               return_value=(partner, "key")):
        response, send, _ = _post({"message": "x"}, origin="")
    assert response.status_code == 204 and not send.called


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} client error report tests passed.")
