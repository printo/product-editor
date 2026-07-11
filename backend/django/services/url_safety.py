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


class _PinnedIPAdapter(requests.adapters.HTTPAdapter):
    """Force every connection to a pre-validated IP while keeping the Host
    header + TLS SNI/cert verification, closing the DNS-rebinding window."""

    def __init__(self, allowed_ips: set[str], *args, **kwargs):
        self._allowed_ips = allowed_ips
        super().__init__(*args, **kwargs)

    def send(self, request, **kwargs):
        parsed = urlparse(request.url)
        host = parsed.hostname or ""
        try:
            literal = ipaddress.ip_address(host)
            resolved = {str(literal)}
        except ValueError:
            resolved = set(resolve_public_ips(host))
        if not resolved & self._allowed_ips:
            raise ValidationError("callback_url resolved to a different address at send time.")
        return super().send(request, **kwargs)


def post_webhook_safely(url: str, *, data: bytes, headers: dict, timeout: float) -> requests.Response:
    """
    POST to a customer webhook with full SSRF protection: re-validate at send
    time (DNS-rebinding defence), pin the connection to the validated public
    IP, and never follow redirects (a public host can't 30x into an internal
    target). Raises ValidationError if the URL is unsafe.
    """
    allowed = set(validate_public_https_url(url))
    session = requests.Session()
    session.mount("https://", _PinnedIPAdapter(allowed))
    return session.post(
        url, data=data, headers=headers, timeout=timeout, allow_redirects=False,
    )
