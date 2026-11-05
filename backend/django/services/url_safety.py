"""
SSRF guard for customer-supplied webhook URLs (Phase 4).

EmbedSession.callback_url is customer-controlled (any holder of an api_key)
and the render worker POSTs to it from INSIDE the Docker network. Without a
guard an attacker can point it at internal services — http://backend:8000,
the cloud metadata endpoint 169.254.169.254, redis:6379 — or use DNS
rebinding / an HTTPS redirect to reach them.

Product decision (unchanged): no domain allowlist. This is a deny-list of
non-publicly-routable address ranges, enforced at BOTH session-create time
and — because DNS can rebind between then and the POST — again at send time,
with the connection pinned to the validated IP so the socket can't be
re-pointed after the check (TOCTOU close).
"""
from __future__ import annotations

import ipaddress
import socket
import threading
from urllib.parse import urlparse

import requests
from django.core.exceptions import ValidationError

MAX_CALLBACK_URL_LEN = 2000


def _is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # IPv4-mapped IPv6 (::ffff:10.0.0.1) must be judged on the mapped v4.
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return not (
        addr.is_private or addr.is_loopback or addr.is_link_local
        or addr.is_reserved or addr.is_multicast or addr.is_unspecified
    )


def resolve_public_ips(hostname: str) -> list[str]:
    """Resolve every A/AAAA record; raise ValidationError unless ALL are public."""
    try:
        infos = socket.getaddrinfo(hostname, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise ValidationError(f"callback_url host '{hostname}' could not be resolved.")
    ips = sorted({info[4][0] for info in infos})
    if not ips:
        raise ValidationError(f"callback_url host '{hostname}' resolved to no addresses.")
    for ip in ips:
        if not _is_public_ip(ip):
            raise ValidationError("callback_url host is not publicly routable.")
    return ips


def validate_public_https_url(url: str) -> list[str]:
    """
    Validate a customer webhook URL and return its resolved public IPs.
    Raises django ValidationError on anything unsafe.
    """
    if not url or len(url) > MAX_CALLBACK_URL_LEN:
        raise ValidationError("callback_url is missing or too long.")
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValidationError("callback_url must be an https:// URL.")
    host = parsed.hostname
    if not host:
        raise ValidationError("callback_url has no host.")
    # A raw private/reserved IP literal is rejected by resolve_public_ips too,
    # but check up front so the error is clear.
    try:
        literal = ipaddress.ip_address(host)
        if not _is_public_ip(str(literal)):
            raise ValidationError("callback_url host is not publicly routable.")
        return [str(literal)]
    except ValueError:
        pass  # not an IP literal — resolve the hostname
    return resolve_public_ips(host)


# Serialise the getaddrinfo pin (below). Celery prefork workers run one task
# per process so a collision is already unlikely, but the lock keeps it correct
# even under a future threaded worker.
_PIN_LOCK = threading.Lock()


def _pinned_resolver(host: str, allowed: list[str], real_getaddrinfo):
    """A getaddrinfo that answers for `host` with the validated public IPs only
    and passes every other name through."""
    def _pinned_getaddrinfo(h, port, *args, **kwargs):
        # Only redirect resolution of OUR target host; everything else resolves
        # normally. Return EVERY validated public IP (each with its own family)
        # so urllib3 keeps its multi-address fallback — e.g. a Cloudflare-fronted
        # host that publishes several A/AAAA records stays reachable if the first
        # is down — while guaranteeing every candidate is a vetted public address.
        if isinstance(h, str) and h.lower() == host:
            return [
                (
                    socket.AF_INET6 if ":" in ip else socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    "",
                    (ip, port),
                )
                for ip in allowed
            ]
        return real_getaddrinfo(h, port, *args, **kwargs)
    return _pinned_getaddrinfo


def post_webhook_safely(url: str, *, data: bytes, headers: dict, timeout: float) -> requests.Response:
    """
    POST to a customer webhook with full SSRF protection. Resolve+validate the
    host to a public IP, then ACTUALLY PIN the connection to that IP for the
    duration of the request by scoping socket.getaddrinfo — so urllib3's own
    resolution at connect time cannot rebind to an internal address (the
    TOCTOU a re-validate-then-delegate approach leaves open). TLS SNI/cert
    verification still runs against the original hostname (the URL is
    unchanged), and redirects are disabled so a public host can't 30x into an
    internal target. Raises ValidationError if the URL is unsafe.
    """
    allowed = validate_public_https_url(url)  # ordered list of validated public IPs
    host = (urlparse(url).hostname or "").lower()

    session = requests.Session()
    with _PIN_LOCK:
        # Capture the real resolver INSIDE the lock so a concurrent call (once
        # workers are threaded) can never capture another call's pinned shim as
        # its "real" and leave a stale host-pin installed process-wide.
        real_getaddrinfo = socket.getaddrinfo
        socket.getaddrinfo = _pinned_resolver(host, allowed, real_getaddrinfo)
        try:
            return session.post(
                url, data=data, headers=headers, timeout=timeout, allow_redirects=False,
            )
        finally:
            socket.getaddrinfo = real_getaddrinfo


def open_public_get(url: str, *, headers: dict | None = None, timeout) -> requests.Response:
    """
    Open a GET to a public https URL with the same protection as
    post_webhook_safely, and return the response with its body NOT yet read
    (`stream=True`). The caller reads it in pieces, under its own size cap, and
    must close it.

    The pin is held only until the response headers arrive. By then the socket
    is connected to a validated public IP, redirects are off, and nothing
    resolves a name again for this response, so the body can be read outside
    the lock. That matters here in a way it does not for a small webhook POST:
    the web workers are threaded, and holding a process-wide lock for a whole
    photo download would queue every other fetch in the process behind it.
    Raises ValidationError if the URL is unsafe.
    """
    allowed = validate_public_https_url(url)
    host = (urlparse(url).hostname or "").lower()

    session = requests.Session()
    with _PIN_LOCK:
        real_getaddrinfo = socket.getaddrinfo
        socket.getaddrinfo = _pinned_resolver(host, allowed, real_getaddrinfo)
        try:
            return session.get(
                url, headers=headers or {}, timeout=timeout, allow_redirects=False, stream=True,
            )
        finally:
            socket.getaddrinfo = real_getaddrinfo
