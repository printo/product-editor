"""
Single sign-on for the Django admin, off the PIA/Google session.

`/django-admin/` used to carry two independent locks: nginx's `auth_request`
against the frontend (is this session a PIA superuser?), and then Django's own
`auth_user` username + password. Passing the first granted nothing towards the
second, so the admin was unusable without a separately-created Django account —
and on 2026-09-04 production had **zero** rows in `auth_user`, making it
unreachable for everyone.

This collapses the second lock into the first: nginx already knows who the
caller is by the time the request is proxied, so Django provisions and logs in
a matching `auth_user` and the operator never sees a Django login form.

## Why the identity is signed, and not merely a header

The obvious implementation forwards `X-PE-Admin-Id` from the auth subrequest and
has Django trust it. `proxy_set_header` does replace any client-supplied value,
so it cannot be forged *through nginx* — but it can be forged by anything that
reaches `backend:8000` directly on the Docker network, and the payload of a
successful forgery is `is_superuser` over every table in the database.

So the frontend signs the identity with a key derived from the secret it already
shares with Django, and Django verifies it. A forged header without the secret
fails, whatever route it arrived by, which means this no longer rests on network
topology being what we think it is.

The signature covers a short expiry too, so a header captured off one request
cannot be replayed later.

## What it grants

`is_staff` and `is_superuser`, every time, because the nginx gate has already
established that PIA considers this person a superuser and PIA is the source of
truth. This is deliberately not "create once, then leave alone": if PIA revokes
the flag, the gate stops letting them in at all, and if PIA grants it, they
should not need a Django-side edit to match. The corollary is that an existing
`auth_user` row whose username collides with a PIA employee id will be raised to
superuser — acceptable here because the same gate vetted them, but worth knowing
before adding deliberately-limited Django accounts.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

#: Path prefix the SSO applies to. Django admin is mounted at `/django-admin/`
#: (see product_editor/urls.py), NOT `/admin/`.
ADMIN_PATH_PREFIX = "/django-admin/"

#: Purpose string mixed into the signing key. Keeps this key distinct from the
#: embed-token verification that uses the same env secret, so a signature from
#: one context can never be replayed into the other.
_KEY_PURPOSE = b"django-admin-sso/v1"

#: How long a signed identity stays valid. It is minted per request by the auth
#: subrequest and consumed immediately, so this only has to cover proxy hop
#: latency and modest clock skew.
MAX_AGE_SECONDS = 120


def signing_key(secret: Optional[str] = None) -> Optional[bytes]:
    """
    Derive the purpose-bound signing key, or None when no secret is configured.

    None means "SSO is not available" — callers must fall through to Django's
    normal login rather than granting anything.
    """
    raw = secret if secret is not None else os.getenv("EMBED_INTERNAL_SECRET", "")
    if not raw:
        return None
    return hmac.new(raw.encode("utf-8"), _KEY_PURPOSE, hashlib.sha256).digest()


def identity_payload(user_id: str, email: str, expires_at: int) -> bytes:
    """
    The exact bytes that get signed.

    Newline-joined with the fields in a fixed order. `user_id` and `email` are
    length-delimited by the separator rather than concatenated, so no pair of
    different identities can produce the same payload (a `\\n` in either field
    would break that, which is why both are rejected below).
    """
    return f"{user_id}\n{email}\n{expires_at}".encode("utf-8")


def sign_identity(user_id: str, email: str, expires_at: int, secret: Optional[str] = None) -> Optional[str]:
    """Hex HMAC-SHA256 over the identity payload, or None with no secret."""
    key = signing_key(secret)
    if key is None:
        return None
    return hmac.new(key, identity_payload(user_id, email, expires_at), hashlib.sha256).hexdigest()


def verify_identity(
    user_id: str,
    email: str,
    expires_at: str,
    signature: str,
    *,
    secret: Optional[str] = None,
    now: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Validate a signed identity, returning the trusted fields or None.

    None on every failure path — missing field, no secret, unparseable expiry,
    expired, bad signature — because the only safe response to an identity we
    cannot verify is to grant nothing and let Django's own login handle it.
    """
    if not user_id or not signature or not expires_at:
        return None
    # A newline in either field would let two identities share one payload.
    if "\n" in user_id or "\n" in email:
        return None
    key = signing_key(secret)
    if key is None:
        return None
    try:
        exp = int(expires_at)
    except (TypeError, ValueError):
        return None

    current = int(time.time()) if now is None else now
    if exp < current:
        return None
    # Reject an absurdly distant expiry too: a signed-but-eternal header would
    # be a permanent credential if one ever leaked.
    if exp - current > MAX_AGE_SECONDS:
        return None

    expected = hmac.new(key, identity_payload(user_id, email, exp), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None

    return {"user_id": user_id, "email": email, "expires_at": exp}


class DjangoAdminSSOMiddleware:
    """
    Log a verified PIA superuser into the Django admin.

    Runs only for `ADMIN_PATH_PREFIX`, and only when the request is not already
    authenticated — so an operator who logged in with a Django password (or is
    mid-session) is left alone.

    Must sit AFTER `SessionMiddleware` and `AuthenticationMiddleware`: it needs
    a session to log into and `request.user` to test.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith(ADMIN_PATH_PREFIX):
            try:
                self._maybe_login(request)
            except Exception:
                # Never let SSO break the admin: a failure here just means the
                # operator sees Django's own login form.
                logger.exception("DjangoAdminSSOMiddleware: sign-in attempt failed")
        return self.get_response(request)

    def _maybe_login(self, request) -> None:
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            return

        identity = verify_identity(
            request.META.get("HTTP_X_PE_ADMIN_ID", ""),
            request.META.get("HTTP_X_PE_ADMIN_EMAIL", ""),
            request.META.get("HTTP_X_PE_ADMIN_EXP", ""),
            request.META.get("HTTP_X_PE_ADMIN_SIG", ""),
        )
        if identity is None:
            return

        from django.contrib.auth import get_user_model, login

        UserModel = get_user_model()
        username = identity["user_id"][: UserModel._meta.get_field("username").max_length]
        account, created = UserModel.objects.get_or_create(
            username=username,
            defaults={"email": identity["email"] or ""},
        )

        # PIA is the source of truth for who may administer — see the module
        # docstring on why these are asserted on every request, not just on
        # creation.
        dirty = False
        if created:
            # No Django password is ever set: the only way in is through the
            # nginx gate, so there is no credential here to leak or rotate.
            account.set_unusable_password()
            dirty = True
        if identity["email"] and account.email != identity["email"]:
            account.email = identity["email"]
            dirty = True
        if not account.is_staff:
            account.is_staff = True
            dirty = True
        if not account.is_superuser:
            account.is_superuser = True
            dirty = True
        if dirty:
            account.save()

        login(request, account, backend="django.contrib.auth.backends.ModelBackend")
        logger.info(
            "DjangoAdminSSOMiddleware: signed in %s (%s)",
            username,
            "provisioned" if created else "existing",
        )
