#!/usr/bin/env bash
# Restore the DB + storage config from a backup set (Phase 4).
#   ./scripts/restore.sh latest       — most recent daily backup
#   ./scripts/restore.sh 20260711T031500Z
#
# CAVEATS printed before the yes-gate:
#   - pg_restore --clean replaces APIKey/EmbedSession rows: embed sessions and
#     any keys rotated after the dump are invalidated.
#   - RenderJobs captured mid-render restore as 'processing' and never finish.
set -euo pipefail

cd "$(dirname "$0")/.."

DC="docker-compose"
command -v docker-compose >/dev/null 2>&1 || DC="docker compose"

DEST="backups/daily"
SEL="${1:-latest}"
if [[ "$SEL" == "latest" ]]; then
  DUMP="$(ls -1 "$DEST"/pe-db-*.dump 2>/dev/null | sort | tail -1 || true)"
else
  DUMP="$DEST/pe-db-$SEL.dump"
fi
[[ -f "${DUMP:-}" ]] || { echo "No backup dump found for '$SEL'." >&2; exit 1; }
TS="$(basename "$DUMP" | sed 's/^pe-db-//; s/\.dump$//')"
TARBALL="$DEST/pe-storage-$TS.tgz"
MANIFEST="$DEST/pe-manifest-$TS.json"

PG_USER="${POSTGRES_USER:-postgres}"
PG_DB="${POSTGRES_DB:-product_editor}"

echo "About to restore backup from: $TS"
echo "  DB dump:  $DUMP"
echo "  Storage:  ${TARBALL:-<none>}"
echo "  Manifest: $(cat "$MANIFEST" 2>/dev/null || echo '<none>')"
echo
echo "This REPLACES the current database and storage config. API keys/embed"
echo "sessions created after $TS will be invalidated; mid-render jobs won't finish."
read -r -p "Type 'restore' to proceed: " REPLY
[[ "$REPLY" == "restore" ]] || { echo "Aborted."; exit 1; }

echo "[restore] stopping app containers (db stays up)…"
$DC stop backend celery-worker-priority celery-worker-standard celery-beat frontend || true

echo "[restore] restoring database…"
$DC exec -T db pg_restore --clean --if-exists -U "$PG_USER" -d "$PG_DB" < "$DUMP"

if [[ -f "$TARBALL" ]]; then
  echo "[restore] restoring storage config…"
  tar -xzf "$TARBALL" -C storage
fi

echo "[restore] starting containers…"
$DC up -d

echo "[restore] done. Verify: docker-compose exec db psql -U $PG_USER -d $PG_DB -c \\"
echo "  \"SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;\""
