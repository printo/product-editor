# nginx edge proxy

Replaces the previous Traefik setup. Sits behind Cloudflare and terminates TLS
at the origin (Cloudflare → Origin: HTTPS).

## Files

| Path | Purpose |
|---|---|
| `nginx.conf` | Main config — routing, TLS, upstreams. Single source of truth. |
| `certs/origin.crt` | TLS cert presented to Cloudflare (gitignored). |
| `certs/origin.key` | Matching private key (gitignored, mode 600). |
| `.htpasswd` | Basic-auth users for `/admin/django-admin/` (gitignored). |

## Cert workflow

**Production (recommended):** Cloudflare Origin Certificate

1. Cloudflare dashboard → SSL/TLS → Origin Server → **Create Certificate**
2. Defaults are fine (RSA 2048, 15-year). Hostnames: `printo.in, *.printo.in` or just `product-editor.printo.in`.
3. Paste the **certificate** into `proxy/nginx/certs/origin.crt`.
4. Paste the **private key** into `proxy/nginx/certs/origin.key`. `chmod 600`.
5. Cloudflare dashboard → SSL/TLS → Overview → set encryption mode to **Full (strict)**.

The cert is valid for 15 years and is trusted only by Cloudflare. Browsers see Cloudflare's edge cert (Universal SSL) — they never see this one.

**Bootstrap / dev:** `./deploy.sh` generates a self-signed cert with the same filenames if `certs/origin.crt` is missing. With self-signed, set Cloudflare to **Full** (not "Full (strict)") — strict mode validates the origin cert against a public CA, which a self-signed won't pass.

## Routing

Mirrors the Traefik priorities we replaced:

| Priority | Match | Upstream | Notes |
|---|---|---|---|
| 3 | `^~ /api/auth/` | `frontend:3000` | NextAuth |
| 3 | `^~ /api/internal/proxy/` | `frontend:3000` | Dashboard server-side proxy |
| 3 | `^~ /api/embed/proxy/` | `frontend:3000` | Embed-token proxy |
| 2 | `^~ /admin/django-admin/` | `backend:8000` | basic auth |
| 2 | `^~ /api/` | `backend:8000` | Everything else under /api/ |
| 1 | `/` | `frontend:3000` | Catch-all (Next.js pages) |

`^~` prefix matches stop further regex matching, so the order above is the effective evaluation order regardless of declaration order. Longest prefix wins.

## Key tunables (in `nginx.conf`)

- `client_max_body_size 100M` — fits chunked-upload chunks + a 50 MB max single-file payload.
- `proxy_read_timeout 600s` for `/api/*` — sync render can run up to 600 s.
- `proxy_buffering off` for `/api/*` and the two frontend proxy locations — lets `StreamingHttpResponse` (ZIP downloads) stream straight through without disk staging.
- `real_ip_header CF-Connecting-IP` — so the login per-IP rate limiter sees real client IPs, not Cloudflare edges.

## Updating the Cloudflare IP allowlist

The `set_real_ip_from` lines in `nginx.conf` are Cloudflare's published IP ranges. CF updates these annually. Refresh from <https://www.cloudflare.com/ips/> if real-IP detection ever drifts (rare).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Browser sees CF 526 ("invalid SSL cert") | `origin.crt` is self-signed and CF is in "Full (strict)" — drop CF to "Full" or paste a real CF Origin Cert. |
| Browser sees CF 521 ("web server is down") | `nginx` container isn't listening on 443. Check `docker compose ps proxy` and `docker compose logs proxy`. |
| 502 from nginx for `/api/*` | Backend isn't healthy. `docker compose ps backend`; `curl http://localhost:8000/api/health`. |
| Login rate-limited unexpectedly | `X-Forwarded-For` not propagated. Test: `curl -H 'X-Forwarded-For: 1.2.3.4' …` and check the rate limiter log. |
