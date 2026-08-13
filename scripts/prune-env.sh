#!/usr/bin/env bash
#
# Prune dead environment variables from a .env file.
#
# The production .env drifted from .env.example over several stack migrations
# and accumulated ~16 variables from a previous Node/Express + Traefik setup
# that nothing in this codebase reads. They are harmless at runtime but make
# the file untrustworthy: it is hard to tell which knobs are real, and a stale
# JWT_SECRET sitting in a production env file is the kind of thing that gets
# copied forward forever.
#
# ONLY removes names verified unreferenced by every form the code uses to read
# an env var: os.getenv(), os.environ[], process.env.X, ${VAR} in compose /
# shell / nginx, and bare $VAR. Re-verify with:
#
#   grep -rnE "getenv\(['\"]NAME['\"]|process\.env\.NAME\b|\\\$\{?NAME\}?\b" \
#     --include=*.py --include=*.ts --include=*.mjs --include=*.yml \
#     --include=*.sh --include=*.conf . | grep -v node_modules
#
# Deliberately NOT touched — see the report this prints at the end:
#   PORT                             LIVE. entrypoint.sh binds gunicorn to
#                                    ${PORT:-8000} and both frontend and
#                                    backend receive .env, so its value
#                                    matters to two containers. Decide by hand.
#   MAX_FILE_SIZE_MB                 Inert TODAY (the code reads
#                                    MAX_UPLOAD_FILE_SIZE_MB), so renaming it
#                                    would ACTIVATE a limit that has never been
#                                    in force. That is a behaviour change, not
#                                    a cleanup.
#   NEXT_PUBLIC_DEVELOPMENT_API_KEY  Holds the DIRECT key and was inlined into
#                                    public browser bundles until 7bc98f9.
#                                    Needs rotation, not just deletion.
#
# Usage:
#   ./scripts/prune-env.sh                 # dry run against ./.env
#   ./scripts/prune-env.sh --apply         # write, after backing up
#   ./scripts/prune-env.sh --apply /path/to/.env
#
set -euo pipefail

APPLY=0
ENV_FILE=".env"
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) ENV_FILE="$arg" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || { echo "No such file: $ENV_FILE" >&2; exit 1; }

# Verified unreferenced anywhere in the codebase.
DEAD=(
  # Previous Node/Express auth stack — this app uses NextAuth + PIA.
  JWT_SECRET JWT_EXPIRY REFRESH_TOKEN_EXPIRY
  # Previous rate limiter — now api/middleware.py RateLimitMiddleware,
  # whose limits are class constants, not env-driven.
  RATE_LIMIT_MAX_REQUESTS RATE_LIMIT_WINDOW_MS UPLOAD_RATE_LIMIT_MAX
  # Previous worker/queue implementation — now Celery.
  WORKER_POLLING_INTERVAL WORKER_TIMEOUT_MINUTES MAX_RETRIES
  # Previous DB pool — Django uses CONN_MAX_AGE (DB_CONN_MAX_AGE).
  DB_POOL_MAX DB_POOL_MIN DB_POOL_IDLE_TIMEOUT_MS DB_POOL_CONNECTION_TIMEOUT_MS
  # Traefik era — nginx now terminates TLS with a Cloudflare origin cert.
  DOMAIN_NAME LETSENCRYPT_EMAIL
  # Renamed or superseded.
  ALLOWED_FILE_TYPES STORAGE_DIR BACKEND_PORT
)

echo "Scanning ${ENV_FILE}"
echo

found=(); missing=()
for v in "${DEAD[@]}"; do
  if grep -qE "^[[:space:]]*${v}=" "$ENV_FILE"; then found+=("$v"); else missing+=("$v"); fi
done

if [[ ${#found[@]} -eq 0 ]]; then
  echo "  Nothing to remove — none of the ${#DEAD[@]} dead names are present."
else
  echo "  Will remove ${#found[@]} dead variable(s):"
  printf '    %s\n' "${found[@]}"
fi
[[ ${#missing[@]} -gt 0 ]] && echo "  (${#missing[@]} already absent)"
echo

# Report-only checks — never auto-changed.
echo "  Needs a human decision (NOT changed by this script):"
for v in PORT MAX_FILE_SIZE_MB NEXT_PUBLIC_DEVELOPMENT_API_KEY; do
  if grep -qE "^[[:space:]]*${v}=" "$ENV_FILE"; then
    case "$v" in
      PORT)
        echo "    PORT is set. entrypoint.sh binds gunicorn to \${PORT:-8000} and BOTH"
        echo "      frontend and backend read .env — confirm its value suits both, or"
        echo "      remove it and let each fall back to its own default (8000 / 3000)." ;;
      MAX_FILE_SIZE_MB)
        cur=$(grep -E "^[[:space:]]*MAX_FILE_SIZE_MB=" "$ENV_FILE" | head -1 | cut -d= -f2-)
        echo "    MAX_FILE_SIZE_MB=${cur} is INERT — the code reads MAX_UPLOAD_FILE_SIZE_MB,"
        echo "      so the 50 MB default is what is actually enforced. Renaming it would"
        echo "      ACTIVATE ${cur} MB for the first time. Rename only if you want that." ;;
      NEXT_PUBLIC_DEVELOPMENT_API_KEY)
        echo "    NEXT_PUBLIC_DEVELOPMENT_API_KEY holds the DIRECT key. NEXT_PUBLIC_ values are"
        echo "      inlined into the browser bundle, and this one was referenced until 7bc98f9."
        echo "      Rotate DIRECT_API_KEY + INTERNAL_API_KEY together, then delete this line." ;;
    esac
  fi
done
echo

if [[ ${#found[@]} -eq 0 ]]; then exit 0; fi

if [[ $APPLY -eq 0 ]]; then
  echo "Dry run. Re-run with --apply to write the change."
  exit 0
fi

BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"

TMP="$(mktemp)"
cp "$ENV_FILE" "$TMP"
for v in "${found[@]}"; do
  grep -vE "^[[:space:]]*${v}=" "$TMP" > "${TMP}.next" && mv "${TMP}.next" "$TMP"
done

before=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" || true)
after=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$TMP" || true)
mv "$TMP" "$ENV_FILE"

echo "Backed up to ${BACKUP}"
echo "Variables: ${before} -> ${after} (removed $((before - after)))"
echo
echo "Nothing has restarted. Apply with:"
echo "  docker-compose up -d --force-recreate backend frontend celery-worker-standard celery-beat"
