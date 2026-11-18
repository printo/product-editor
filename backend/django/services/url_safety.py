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
    # is_global is false for the shared address space 100.64.0.0/10 (carrier-grade
    # NAT), which the denylist below does not name and which holds Alibaba
    # Cloud's metadata address 100.100.100.200. Require both.
    return addr.is_global and not (
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


def _pinned_pool_class(allowed: list[str]):
    """
    An HTTPS connection pool class whose connections open their socket to one
    of `allowed` and to nothing else, whatever the name in the URL resolves to
    later. The hostname stays the connection's `host`, so SNI and certificate
    verification still run against it. The pin lives on the connection class,
    not on a process-wide patch of `socket.getaddrinfo`, so concurrent fetches
    never wait for one another and nothing outside this call is affected.
    """
    from urllib3.connection import HTTPSConnection
    from urllib3.connectionpool import HTTPSConnectionPool
    from urllib3.exceptions import ConnectTimeoutError, NewConnectionError

    ips = tuple(allowed)

    class _PinnedConnection(HTTPSConnection):
        def _new_conn(self):
            last_error: Exception | None = None
            for ip in ips:
                sock = None
                try:
                    sock = socket.create_connection(
                        (ip, self.port), self.timeout, source_address=self.source_address,
                    )
                    for level, option, value in (self.socket_options or ()):
                        sock.setsockopt(level, option, value)
                    return sock
                except socket.timeout as exc:
                    last_error = ConnectTimeoutError(self, f"Connection to {ip} timed out")
                    last_error.__cause__ = exc
                except OSError as exc:
                    last_error = NewConnectionError(self, f"Failed to connect to {ip}: {exc}")
                    last_error.__cause__ = exc
                if sock is not None:
                    sock.close()
            raise last_error or NewConnectionError(self, "No validated address to connect to")

    class _PinnedPool(HTTPSConnectionPool):
        ConnectionCls = _PinnedConnection

    return _PinnedPool


def _pinned_session(allowed: list[str]) -> requests.Session:
    """A requests Session whose https connections go only to `allowed`.
    Environment proxies are ignored: a proxy would be the one connecting."""
    from requests.adapters import HTTPAdapter

    class _PinnedAdapter(HTTPAdapter):
        def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
            super().init_poolmanager(connections, maxsize, block=block, **pool_kwargs)
            self.poolmanager.pool_classes_by_scheme = {
                **self.poolmanager.pool_classes_by_scheme,
                'https': _pinned_pool_class(allowed),
            }

    session = requests.Session()
    session.trust_env = False
    session.mount('https://', _PinnedAdapter())
    return session


def post_webhook_safely(url: str, *, data: bytes, headers: dict, timeout: float) -> requests.Response:
    """
    POST to a customer webhook with full SSRF protection. Resolve+validate the
    host to a public IP, then ACTUALLY PIN the connection to those IPs: the
    socket is opened to a validated address directly, so no name is resolved at
    connect time and DNS cannot rebind to an internal address (the TOCTOU a
    re-validate-then-delegate approach leaves open). TLS SNI/cert verification
    still runs against the original hostname (the URL is unchanged), and
    redirects are disabled so a public host can't 30x into an internal target.
    Raises ValidationError if the URL is unsafe.
    """
    allowed = validate_public_https_url(url)  # ordered list of validated public IPs
    session = _pinned_session(allowed)
    try:
        return session.post(
            url, data=data, headers=headers, timeout=timeout, allow_redirects=False,
        )
    finally:
        session.close()


def open_public_get(url: str, *, headers: dict | None = None, timeout) -> requests.Response:
    """
    Open a GET to a public https URL with the same protection as
    post_webhook_safely, and return the response with its body NOT yet read
    (`stream=True`). The caller reads it in pieces, under its own size cap, and
    must close it.

    The pin belongs to this response's own connection, so the body can be read
    at the caller's pace while other fetches in the same process carry on:
    nothing is shared between them. (It used to be a lock around a patch of
    socket.getaddrinfo, which made every other fetch in a threaded worker wait
    for the slowest connect.) Raises ValidationError if the URL is unsafe.
    """
    allowed = validate_public_https_url(url)
    # The session is not closed here: closing it would close the streamed
    # response's connection. The caller closes the response, which releases it.
    session = _pinned_session(allowed)
    return session.get(
        url, headers=headers or {}, timeout=timeout, allow_redirects=False, stream=True,
    )
