# proxy/nginx

The edge proxy: TLS termination, routing of `/api/*` to Django and everything else to Next.js, and the edge rate limits. `docker-compose.yml` mounts `nginx.conf` and `certs/` into the `proxy` service. `CLAUDE.md` (Deployment) is the reference for the rules below.

## Certificates (`certs/`)

`origin.crt` and `origin.key` are **gitignored** and bind-mounted as a directory.

- **First run on a fresh clone / bootstrap:** `./deploy.sh` generates a self-signed pair when none exists. Cloudflare's SSL mode must then be **Full** (not strict), because the certificate is not trusted.
- **Production:** replace them with a **Cloudflare Origin Certificate** and set Cloudflare SSL mode to **Full (strict)**. Keep the key at `chmod 600`. Replacing files in `certs/` needs only a proxy restart, since it is a directory mount.
- Manual bootstrap:
  ```bash
  mkdir -p proxy/nginx/certs
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout proxy/nginx/certs/origin.key -out proxy/nginx/certs/origin.crt \
    -subj "/CN=localhost/O=product-editor self-signed"
  chmod 600 proxy/nginx/certs/origin.key
  ```

## Changing `nginx.conf`

It is a **single-file** bind mount, which binds the inode, and `git pull` replaces the file. A running proxy keeps the config it booted with, and `nginx -s reload` re-reads the same stale file. So the proxy must be **recreated**, not reloaded. `deploy.sh` does this (`sync_proxy_config`); by hand:

```bash
docker-compose up -d --force-recreate proxy
docker-compose exec proxy nginx -T | grep -c "<a string from your change>"
```

Recreating the proxy empties its log, which is what the rate-limit evidence below is read from.

## Edge rate limits

`limit_req` zones on `/api/auth/` (5 r/s), `/api/embed/proxy/` and `/api/internal/proxy/` (30 r/s each), keyed on the real client IP. `limit_req_dry_run on` is set at the server level: breaches are logged, nothing is rejected. To judge whether to switch it off, on the server:

```bash
docker inspect -f '{{.State.StartedAt}}' $(docker-compose ps -q proxy)    # how far back the log goes
docker-compose logs --since 168h proxy | grep -c "dry run"                # would-be rejections
```

Zero hits across a full week that includes busy weekdays means it is safe to set `limit_req_dry_run off` (breaches then answer 429). Any hits: look at who first.

## Troubleshooting

- **`nginx: [emerg] cannot load certificate`:** `certs/origin.crt` or `origin.key` is missing; run `./deploy.sh` once or use the manual bootstrap above.
- **A config change has no effect:** the proxy was not recreated (see above).
- **Health:** `GET /nginx-health` answers 200 from inside the container; the container healthcheck uses it.
