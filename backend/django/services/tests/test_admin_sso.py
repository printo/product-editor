"""
Signed-identity handoff for Django admin SSO.

The middleware itself needs a database, so these pin the part that carries the
security: whether a given set of headers is trusted. Every rejection below is a
path that, if it returned an identity instead of None, would hand out
`is_superuser` over every table in the database.

DB-free and Django-free, per the harness convention.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from product_editor.admin_sso import (  # noqa: E402
    MAX_AGE_SECONDS,
    identity_payload,
    sign_identity,
    signing_key,
    verify_identity,
)

SECRET = 'test-secret-not-a-real-one'
UID = 'EMP-1234'
EMAIL = 'someone@printo.in'


def _signed(uid=UID, email=EMAIL, ttl=60, secret=SECRET):
    exp = int(time.time()) + ttl
    return uid, email, str(exp), sign_identity(uid, email, exp, secret=secret)


def test_a_freshly_signed_identity_verifies():
    uid, email, exp, sig = _signed()
    got = verify_identity(uid, email, exp, sig, secret=SECRET)
    assert got is not None, 'a correctly signed identity must verify'
    assert got['user_id'] == UID
    assert got['email'] == EMAIL


def test_a_tampered_user_id_is_rejected():
    # The whole attack: keep a valid signature, swap in a different operator.
    uid, email, exp, sig = _signed()
    assert verify_identity('EMP-9999', email, exp, sig, secret=SECRET) is None


def test_a_tampered_email_is_rejected():
    uid, email, exp, sig = _signed()
    assert verify_identity(uid, 'attacker@example.com', exp, sig, secret=SECRET) is None


def test_a_tampered_expiry_is_rejected():
    uid, email, exp, sig = _signed()
    later = str(int(exp) + 30)
    assert verify_identity(uid, email, later, sig, secret=SECRET) is None


def test_an_unsigned_header_set_is_rejected():
    # Forging the headers without the secret is the Docker-network attack the
    # signature exists to stop.
    exp = str(int(time.time()) + 60)
    assert verify_identity(UID, EMAIL, exp, '', secret=SECRET) is None
    assert verify_identity(UID, EMAIL, exp, 'deadbeef', secret=SECRET) is None


def test_a_signature_from_a_different_secret_is_rejected():
    uid, email, exp, sig = _signed(secret='some-other-secret')
    assert verify_identity(uid, email, exp, sig, secret=SECRET) is None


def test_an_expired_identity_is_rejected():
    exp = int(time.time()) - 1
    sig = sign_identity(UID, EMAIL, exp, secret=SECRET)
    assert verify_identity(UID, EMAIL, str(exp), sig, secret=SECRET) is None


def test_an_eternal_identity_is_rejected():
    # Signed but far-future: a leaked header would otherwise be a permanent
    # credential, so the age ceiling is enforced on verify, not just on mint.
    exp = int(time.time()) + MAX_AGE_SECONDS + 60
    sig = sign_identity(UID, EMAIL, exp, secret=SECRET)
    assert verify_identity(UID, EMAIL, str(exp), sig, secret=SECRET) is None


def test_a_replay_just_inside_the_window_still_verifies():
    exp = int(time.time()) + 5
    sig = sign_identity(UID, EMAIL, exp, secret=SECRET)
    assert verify_identity(UID, EMAIL, str(exp), sig, secret=SECRET) is not None


def test_missing_fields_are_rejected():
    uid, email, exp, sig = _signed()
    assert verify_identity('', email, exp, sig, secret=SECRET) is None
    assert verify_identity(uid, email, '', sig, secret=SECRET) is None


def test_an_unparseable_expiry_is_rejected():
    uid, email, _exp, sig = _signed()
    assert verify_identity(uid, email, 'not-a-number', sig, secret=SECRET) is None


def test_no_secret_means_no_sso_rather_than_open_access():
    # An unset EMBED_INTERNAL_SECRET must disable the handoff, never bypass it.
    assert signing_key('') is None
    assert sign_identity(UID, EMAIL, int(time.time()) + 60, secret='') is None
    exp = str(int(time.time()) + 60)
    assert verify_identity(UID, EMAIL, exp, 'anything', secret='') is None


def test_a_newline_cannot_smuggle_a_second_identity():
    # The payload is newline-joined, so a newline inside a field could otherwise
    # let two different identities share one signature. Both mint and verify
    # refuse it.
    exp = int(time.time()) + 60
    sig = sign_identity(f'{UID}\nx', EMAIL, exp, secret=SECRET)
    assert verify_identity(f'{UID}\nx', EMAIL, str(exp), sig, secret=SECRET) is None
    assert verify_identity(UID, f'{EMAIL}\nx', str(exp), sig, secret=SECRET) is None


def test_the_signing_key_is_purpose_bound():
    # The key is derived from the shared secret, never the secret itself, so a
    # signature cannot be replayed into the embed-token path that uses the same
    # env var.
    assert signing_key(SECRET) != SECRET.encode()
    assert signing_key(SECRET) == signing_key(SECRET)
    assert signing_key(SECRET) != signing_key(SECRET + 'x')


def test_the_payload_is_stable_and_ordered():
    assert identity_payload('a', 'b', 7) == b'a\nb\n7'


def test_matches_the_typescript_signer():
    # The frontend mints these in verify-django-admin/route.ts with the same
    # derivation: HMAC(secret, "django-admin-sso/v1") as the key, then
    # HMAC(key, "id\nemail\nexp"). Recomputed here independently so a change to
    # either side without the other is caught.
    import hashlib
    import hmac
    key = hmac.new(SECRET.encode(), b'django-admin-sso/v1', hashlib.sha256).digest()
    exp = int(time.time()) + 60
    expected = hmac.new(key, f'{UID}\n{EMAIL}\n{exp}'.encode(), hashlib.sha256).hexdigest()
    assert sign_identity(UID, EMAIL, exp, secret=SECRET) == expected


if __name__ == '__main__':
    passed = 0
    for name, fn in sorted(list(globals().items())):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f'  ✓ {name}')
            passed += 1
    print(f'\n{passed} admin-SSO tests passed.')
