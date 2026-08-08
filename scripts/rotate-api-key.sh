#!/usr/bin/env bash
#
# Rotate the DIRECT / INTERNAL API key pair and drop the leaked NEXT_PUBLIC copy.
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
# WHY BOTH KEYS MOVE TOGETHER
#
# CLAUDE.md requires INTERNAL_API_KEY == DIRECT_API_KEY: the internal proxy
# authenticates as this key, and the resolved APIKey row must be is_ops_team
# for /ops/* paths to work. Change one without the other and the dashboard
# starts 401-ing immediately. This script writes both in a single pass so they
# cannot drift.
#
# BLAST RADIUS — READ BEFORE RUNNING
#
#   * Any direct-API partner using the old key breaks the moment the backend
#     restarts. Confirm who is using it first:
#         docker-compose logs backend | grep -c "Source: DIRECT"
#     and, once PR #44 is deployed, the durable version:
#         APIRequest.objects.filter(auth_source="DIRECT")
#   * The dashboard is unavailable between writing .env and finishing the
#     redeploy. Pick a quiet window.
#
# Usage:
#   ./scripts/rotate-api-key.sh                    # dry run against ./.env
#   ./scripts/rotate-api-key.sh --apply            # rotate
#   ./scripts/rotate-api-key.sh --apply /path/.env
#   ./scripts/rotate-api-key.sh --apply --force    # proceed despite a mismatch
#
set -euo pipefail

APPLY=0
FORCE=0
ENV_FILE=".env"
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --force) FORCE=1 ;;
    *) ENV_FILE="$arg" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || { echo "No such file: $ENV_FILE" >&2; exit 1; }

read_var() { grep -E "^[[:space:]]*${1}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
tail4()    { local v="$1"; [[ -n "$v" ]] && printf '…%s' "${v: -4}" || printf '(unset)'; }

DIRECT_CUR="$(read_var DIRECT_API_KEY)"
INTERNAL_CUR="$(read_var INTERNAL_API_KEY)"
PUBLIC_CUR="$(read_var NEXT_PUBLIC_DEVELOPMENT_API_KEY)"

echo "Rotating API key pair in ${ENV_FILE}"
echo
echo "  Current state (last 4 chars only — full values are never printed):"
printf '    %-32s %s\n' "DIRECT_API_KEY"   "$(tail4 "$DIRECT_CUR")"
printf '    %-32s %s\n' "INTERNAL_API_KEY" "$(tail4 "$INTERNAL_CUR")"
printf '    %-32s %s\n' "NEXT_PUBLIC_DEVELOPMENT_API_KEY" "$(tail4 "$PUBLIC_CUR")"
echo

# ── Pre-flight ────────────────────────────────────────────────────────────
[[ -n "$DIRECT_CUR" ]] || { echo "ABORT: DIRECT_API_KEY is not set in ${ENV_FILE}." >&2; exit 1; }

if [[ -z "$INTERNAL_CUR" ]]; then
  echo "ABORT: INTERNAL_API_KEY is not set. It must exist and equal DIRECT_API_KEY," >&2
  echo "       or /ops/* paths through the internal proxy will break." >&2
  exit 1
fi

if [[ "$DIRECT_CUR" != "$INTERNAL_CUR" ]]; then
  echo "  ⚠ DIRECT_API_KEY and INTERNAL_API_KEY DO NOT MATCH."
  echo "    CLAUDE.md requires them equal — the internal proxy authenticates as this"
  echo "    key and the resolved APIKey row must be is_ops_team. A mismatch means"
  echo "    something is already wrong; rotating would paper over it."
  if [[ $FORCE -eq 0 ]]; then
    echo "    Investigate first, or re-run with --force to set BOTH to the new value." >&2
    exit 1
  fi
  echo "    --force given: both will be set to the new value."
  echo
fi

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
  2. set DIRECT_API_KEY and INTERNAL_API_KEY to the SAME new value
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
  /^[[:space:]]*INTERNAL_API_KEY=/                { print "INTERNAL_API_KEY=" k; next }
  /^[[:space:]]*NEXT_PUBLIC_DEVELOPMENT_API_KEY=/ { next }
  { print }
' "$ENV_FILE" > "$TMP"

# Verify before overwriting: both present, equal, and the public copy gone.
nd=$(grep -cE '^[[:space:]]*DIRECT_API_KEY='   "$TMP" || true)
ni=$(grep -cE '^[[:space:]]*INTERNAL_API_KEY=' "$TMP" || true)
np=$(grep -cE '^[[:space:]]*NEXT_PUBLIC_DEVELOPMENT_API_KEY=' "$TMP" || true)
if [[ "$nd" != "1" || "$ni" != "1" || "$np" != "0" ]]; then
  rm -f "$TMP"
  echo "ABORT: post-write check failed (direct=$nd internal=$ni public=$np). ${ENV_FILE} untouched." >&2
  exit 1
fi

mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

cat <<EOF
Rotated. Backup: ${BACKUP}

  DIRECT_API_KEY   -> $(tail4 "$NEW_KEY")
  INTERNAL_API_KEY -> $(tail4 "$NEW_KEY")   (same value, as required)
  NEXT_PUBLIC_DEVELOPMENT_API_KEY removed

Nothing has restarted yet. The old key still works until the backend reboots.

Next:
  1. Restart the backend AND the frontend TOGETHER.

     ./deploy.sh backend is NOT enough, and getting this wrong takes the
     dashboard down. It re-seeds the DIRECT row with the new key but leaves the
     frontend running with the OLD INTERNAL_API_KEY in its process
     environment, so every dashboard call then presents a key that matches no
     row - 403 on everything until the frontend restarts too. No code has
     changed here, so recreate rather than rebuild:

       docker-compose up -d --force-recreate \\
         backend frontend celery-worker-priority celery-worker-standard celery-beat

     (./deploy.sh both also works, but rebuilds images for no reason.)

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
