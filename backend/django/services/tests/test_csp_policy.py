"""
The Content Security Policy django-csp 4 puts on the responses this Django process serves.

django-csp 4 reads `CONTENT_SECURITY_POLICY` (enforced) or
`CONTENT_SECURITY_POLICY_REPORT_ONLY` (reported only) and ignores every old `CSP_*`
setting without a word, so a policy left in the old names would silently stop being sent.
The `CSP_REPORT_ONLY` env flag (read into a private name: a setting NAMED that fails django-csp's own check) picks which of the two carries the policy.

Run stand-alone:
    cd backend/django && python -m services.tests.test_csp_policy
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

if not os.environ.get('DJANGO_SETTINGS_MODULE'):
    os.environ['DJANGO_SETTINGS_MODULE'] = 'product_editor.settings'

import django  # noqa: E402
django.setup()

from django.conf import settings  # noqa: E402
from django.http import HttpResponse  # noqa: E402
from django.test import RequestFactory  # noqa: E402
from csp.middleware import CSPMiddleware  # noqa: E402
from csp.utils import build_policy  # noqa: E402


def report_only_flag() -> bool:
    return os.environ.get('CSP_REPORT_ONLY', 'True').lower() not in ('false', '0', 'no')


def _directives(policy: str) -> dict[str, list[str]]:
    return {part.split()[0]: part.split()[1:] for part in policy.split(';') if part.strip()}


def test_no_legacy_csp_settings_are_left():
    left = [n for n in dir(settings) if re.match(r'CSP_', n)]
    assert not left, f"django-csp 4 ignores these: {left}"


def test_the_policy_carries_every_directive_the_frontend_mirrors():
    policy = _directives(build_policy(report_only=True) if hasattr(settings, 'CONTENT_SECURITY_POLICY_REPORT_ONLY') else build_policy())
    assert set(policy) == {
        'default-src', 'script-src', 'style-src', 'img-src', 'font-src',
        'connect-src', 'frame-src', 'frame-ancestors', 'report-uri',
    }
    assert policy['default-src'] == ["'self'"]
    assert "'unsafe-eval'" in policy['script-src']  # Fabric.js
    assert 'https://accounts.google.com' in policy['script-src']  # Google sign-in
    assert 'https://static.cloudflareinsights.com' in policy['script-src']
    assert policy['frame-ancestors'] == ["'self'", 'https://printo.in', 'https://*.printo.in']
    assert policy['report-uri'] == ['/api/csp-report']


def test_the_default_is_report_only_and_the_middleware_names_the_header_so():
    assert hasattr(settings, 'CONTENT_SECURITY_POLICY_REPORT_ONLY') == report_only_flag()
    response = CSPMiddleware(lambda request: HttpResponse('ok'))(RequestFactory().get('/'))
    if report_only_flag():
        assert 'Content-Security-Policy-Report-Only' in response and 'Content-Security-Policy' not in response
    else:
        assert 'Content-Security-Policy' in response and 'Content-Security-Policy-Report-Only' not in response


def _settings_carrying_the_policy(flag: str) -> tuple[bool, bool]:
    code = (
        "import os;os.environ['DJANGO_SETTINGS_MODULE']='product_editor.settings';"
        "from django.conf import settings;"
        "print(hasattr(settings,'CONTENT_SECURITY_POLICY'), hasattr(settings,'CONTENT_SECURITY_POLICY_REPORT_ONLY'))"
    )
    out = subprocess.run(
        [sys.executable, '-c', code], capture_output=True, text=True, check=True,
        env={**os.environ, 'CSP_REPORT_ONLY': flag, 'DEBUG': '1'},
    ).stdout.split()
    return out[0] == 'True', out[1] == 'True'


def test_the_flag_moves_the_policy_between_the_two_settings():
    assert _settings_carrying_the_policy('True') == (False, True)
    assert _settings_carrying_the_policy('False') == (True, False)
    assert _settings_carrying_the_policy('0') == (True, False)


def test_django_system_check_accepts_the_settings():
    from django.core.management import call_command
    call_command('check')


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} CSP policy tests passed.")
