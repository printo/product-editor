#!/usr/bin/env bash
#
# Rotate DIRECT_API_KEY and drop the leaked NEXT_PUBLIC copy.
#
# WHY THIS EXISTS
#
# NEXT_PUBLIC_DEVELOPMENT_API_KEY in the production .env holds the DIRECT key —
# confirmed by matching it against APIKey.objects. NEXT_PUBLIC_ values are
# INLINED INTO THE BROWSER BUNDLE by Next.js at build time, and that variable
# was referenced in the frontend from the initial commit until 7bc98f9
# ("data-loss & exposure hardening", the same commit that removed
# NEXT_PUBLIC_DIRECT_API_KEY). So every frontend build produced before that
# commit shipped an ops-flagged credential inside public JavaScript.
#
# 7bc98f9 removed the REFERENCE. Nobody rotated the CREDENTIAL, which is the
# step that actually closes the exposure.
#
# WHAT THE KEY UNLOCKS
#
# Presented as `Authorization: Bearer`, it reaches Django directly and bypasses
# the Next.js proxies entirely — so src/lib/ops-guard.ts does not apply. That
# means create/edit/DELETE layouts, edit theme presets and holiday data, mint
# embed sessions, and download any order's rendered exports and uploads.
#
# DIRECT_API_KEY AND INTERNAL_API_KEY ARE INDEPENDENT NOW
#
# They used to have to be equal (CLAUDE.md required it). Since
# feat/independent-internal-api-key, INTERNAL_API_KEY seeds its own
# is_ops_team=True "INTERNAL" row in entrypoint.sh, so this script only
# rotates DIRECT_API_KEY — it does not touch INTERNAL_API_KEY at all, and
# rotating one no longer requires anything of the other. To rotate
# INTERNAL_API_KEY, generate a new value yourself the same way (openssl
# rand, or the same editor_<unix>_<token> shape below) and redeploy the
# backend — it seeds automatically, no dedicated script needed.
#
# BLAST RADIUS — READ BEFORE RUNNING
#
#   * Any direct-API partner using the old key breaks the moment the backend
#     restarts. Confirm who is using it first:
#         docker-compose logs backend | grep -c "Source: DIRECT"
#     and, once PR #44 is deployed, the durable version:
#         APIRequest.objects.filter(auth_source="DIRECT")
#   * The dashboard/editor keep working throughout — they authenticate via
#     INTERNAL_API_KEY, which this script does not touch.
#
# Usage:
#   ./scripts/rotate-api-key.sh                    # dry run against ./.env
#   ./scripts/rotate-api-key.sh --apply
#   ./scripts/rotate-api-key.sh --apply /path/.env
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

read_var() { grep -E "^[[:space:]]*${1}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
tail4()    { local v="$1"; [[ -n "$v" ]] && printf '…%s' "${v: -4}" || printf '(unset)'; }

DIRECT_CUR="$(read_var DIRECT_API_KEY)"
PUBLIC_CUR="$(read_var NEXT_PUBLIC_DEVELOPMENT_API_KEY)"

echo "Rotating DIRECT_API_KEY in ${ENV_FILE}"
echo
echo "  Current state (last 4 chars only — full values are never printed):"
printf '    %-32s %s\n' "DIRECT_API_KEY"   "$(tail4 "$DIRECT_CUR")"
printf '    %-32s %s\n' "NEXT_PUBLIC_DEVELOPMENT_API_KEY" "$(tail4 "$PUBLIC_CUR")"
echo

# ── Pre-flight ────────────────────────────────────────────────────────────
[[ -n "$DIRECT_CUR" ]] || { echo "ABORT: DIRECT_API_KEY is not set in ${ENV_FILE}." >&2; exit 1; }

if [[ -z "$PUBLIC_CUR" ]]; then
  echo "  NEXT_PUBLIC_DEVELOPMENT_API_KEY is already absent — nothing to remove."
elif [[ "$PUBLIC_CUR" == "$DIRECT_CUR" ]]; then
  echo "  ⚠ NEXT_PUBLIC_DEVELOPMENT_API_KEY holds the SAME value as DIRECT_API_KEY."
  echo "    This is the exposure. It will be removed."
else
  echo "  NEXT_PUBLIC_DEVELOPMENT_API_KEY differs from DIRECT_API_KEY; removing it anyway"
  echo "    (nothing reads it, and no NEXT_PUBLIC_ variable should hold a credential)."
fi
echo

# ── Generate ──────────────────────────────────────────────────────────────
# Same shape as APIKey.generate_key(): editor_{unix}_{token_urlsafe(32)}.
command -v openssl >/dev/null || { echo "ABORT: openssl not found." >&2; exit 1; }
NEW_KEY="editor_$(date +%s)_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"

echo "  New key generated: $(tail4 "$NEW_KEY")  (length ${#NEW_KEY})"
echo

if [[ $APPLY -eq 0 ]]; then
  cat <<'DRY'
Dry run — nothing written. Re-run with --apply to rotate.

When you do, this will:
  1. back up .env to .env.bak.<timestamp>
  2. set DIRECT_API_KEY to the new value
  3. delete the NEXT_PUBLIC_DEVELOPMENT_API_KEY line
and restart nothing — the redeploy is yours to run.
DRY
  exit 0
fi

# ── Write ─────────────────────────────────────────────────────────────────
BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP" 2>/dev/null || true

TMP="$(mktemp)"
# awk, not sed: the replacement is injected as data, so no value can be
# reinterpreted as regex syntax or a delimiter.
awk -v k="$NEW_KEY" '
  /^[[:space:]]*DIRECT_API_KEY=/                  { print "DIRECT_API_KEY=" k;   next }
  /^[[:space:]]*NEXT_PUBLIC_DEVELOPMENT_API_KEY=/ { next }
  { print }
' "$ENV_FILE" > "$TMP"

# Verify before overwriting: DIRECT present once, public copy gone.
nd=$(grep -cE '^[[:space:]]*DIRECT_API_KEY='   "$TMP" || true)
np=$(grep -cE '^[[:space:]]*NEXT_PUBLIC_DEVELOPMENT_API_KEY=' "$TMP" || true)
if [[ "$nd" != "1" || "$np" != "0" ]]; then
  rm -f "$TMP"
  echo "ABORT: post-write check failed (direct=$nd public=$np). ${ENV_FILE} untouched." >&2
  exit 1
fi

mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

cat <<EOF
Rotated. Backup: ${BACKUP}

  DIRECT_API_KEY   -> $(tail4 "$NEW_KEY")
  NEXT_PUBLIC_DEVELOPMENT_API_KEY removed

Nothing has restarted yet. The old key still works until the backend reboots.
INTERNAL_API_KEY is untouched — the dashboard/editor keep working through
this whole rotation without interruption.

Next:
  1. Restart the backend. Frontend/celery don't reference DIRECT_API_KEY, so
     they don't need to move:

       docker-compose up -d --force-recreate backend

     (./deploy.sh backend also works, but rebuilds the image for no reason —
     no code changed here.)

  2. Confirm the API answers:
       curl -sf https://\${PUBLIC_HOST}/api/health && echo OK

  2b. Confirm the NEW key actually authenticates. The DB row matching only
      proves entrypoint.sh seeded it, not that the credential works:
       KEY=\$(grep '^DIRECT_API_KEY=' ${ENV_FILE} | cut -d= -f2-)
       curl -s -o /dev/null -w '%{http_code}\\n' -X POST \\
         http://localhost:8000/api/embed/session \\
         -H "Authorization: Bearer \$KEY" -H 'Content-Type: application/json' \\
         -d '{"order_id":"ROT-VERIFY"}'      # expect 201

  3. Confirm the DB row took the new key — prints only the last 4:
       docker-compose exec -T backend python manage.py shell -c \\
         "from api.models import APIKey; k=APIKey.objects.get(name='DIRECT'); print('DIRECT ends', k.key[-4:], 'ops:', k.is_ops_team)"

  4. Read the full new value out of .env when you need to hand it to a partner:
       grep '^DIRECT_API_KEY=' ${ENV_FILE}

  5. If the rebuilt frontend image predates 7bc98f9, rebuild it too so no bundle
     carries the old key:
       ./deploy.sh frontend

Roll back by restoring ${BACKUP} and redeploying.
EOF
