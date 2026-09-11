"""
Tests for CSPReportView — the sink browsers POST to per the CSP `report-uri`
directive (see settings.py's CSP_REPORT_URI and next.config.mjs's mirror).
Both django-csp's own policy and the Next.js frontend's parallel copy point
here, so it has to tolerate whatever shape either side's browsers send.

Run stand-alone:
    cd backend/django && python -m services.tests.test_csp_report
"""
from __future__ import annotations

import os
import json
from unittest.mock import patch

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.test import RequestFactory  # noqa: E402
from api.views import CSPReportView  # noqa: E402

factory = RequestFactory()
view = CSPReportView.as_view()


def test_legacy_csp_report_shape_returns_204_and_logs():
    body = json.dumps({
        "csp-report": {
            "document-uri": "https://product-editor.printo.in/login",
            "violated-directive": "script-src-elem",
            "blocked-uri": "https://evil.example.com/x.js",
        }
    }).encode()
    request = factory.post("/api/csp-report", data=body, content_type="application/csp-report")
    with patch("api.views.logger") as mock_logger, patch("api.views.sentry_sdk") as mock_sentry:
        response = view(request)
    assert response.status_code == 204
    assert mock_logger.warning.called
    call_args = mock_logger.warning.call_args[0]
    assert call_args[1] == "script-src-elem"  # directive
    assert call_args[2] == "https://evil.example.com/x.js"  # blocked-uri
    assert mock_sentry.capture_message.called


def test_malformed_body_does_not_crash():
    request = factory.post("/api/csp-report", data=b"not json", content_type="application/csp-report")
    with patch("api.views.logger"), patch("api.views.sentry_sdk"):
        response = view(request)
    assert response.status_code == 204


def test_empty_body_does_not_crash():
    request = factory.post("/api/csp-report", data=b"", content_type="application/csp-report")
    with patch("api.views.logger"), patch("api.views.sentry_sdk"):
        response = view(request)
    assert response.status_code == 204


def test_bare_report_without_csp_report_wrapper():
    # Tolerate a report body that isn't wrapped in "csp-report" — not the
    # spec'd shape for report-uri, but cheap to not crash on.
    body = json.dumps({
        "document-uri": "https://product-editor.printo.in/login",
        "violated-directive": "style-src-elem",
        "blocked-uri": "https://example.com/x.css",
    }).encode()
    request = factory.post("/api/csp-report", data=body, content_type="application/reports+json")
    with patch("api.views.logger") as mock_logger, patch("api.views.sentry_sdk"):
        response = view(request)
    assert response.status_code == 204
    call_args = mock_logger.warning.call_args[0]
    assert call_args[1] == "style-src-elem"


def test_no_auth_required():
    # AllowAny + no authentication_classes: a bare POST with no Authorization
    # header must not 401/403 — browsers never attach credentials to a
    # report-uri delivery.
    request = factory.post("/api/csp-report", data=b"{}", content_type="application/csp-report")
    with patch("api.views.logger"), patch("api.views.sentry_sdk"):
        response = view(request)
    assert response.status_code == 204


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} CSP report tests passed.")
