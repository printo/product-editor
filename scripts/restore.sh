#!/usr/bin/env bash
# Restore the DB + storage config from a backup set (Phase 4).
#   ./scripts/restore.sh latest       — most recent daily backup
#   ./scripts/restore.sh 20260711T031500Z
#   ./scripts/restore.sh weekly:20260705T031500Z — config only; customer tables come back EMPTY
#
# CAVEATS printed before the yes-gate:
#   - pg_restore --clean replaces APIKey/EmbedSession rows: embed sessions and
#     any keys rotated after the dump are invalidated.
#   - RenderJobs captured mid-render restore as 'processing' and never finish.
#   - Orders erased (DPDP purge) after the dump was taken are erased again from
#     the restored data via the purge ledger; see services/purge_ledger.py.
set -euo pipefail

cd "$(dirname "$0")/.."

DC="docker-compose"
command -v docker-compose >/dev/null 2>&1 || DC="docker compose"

DEST="backups/daily"
SEL="${1:-latest}"
NOPII=0
if [[ "$SEL" == weekly:* ]]; then
  # Weekly sets leave customer tables empty (see backup.sh). Config recovery only.
  DEST="backups/weekly"
  SEL="${SEL#weekly:}"
  NOPII=1
  DUMP="$DEST/pe-db-nopii-$SEL.dump"
elif [[ "$SEL" == "latest" ]]; then
  DUMP="$(ls -1 "$DEST"/pe-db-*.dump 2>/dev/null | sort | tail -1 || true)"
else
  DUMP="$DEST/pe-db-$SEL.dump"
fi
[[ -f "${DUMP:-}" ]] || { echo "No backup dump found for '$SEL'." >&2; exit 1; }
TS="$(basename "$DUMP" | sed 's/^pe-db-nopii-//; s/^pe-db-//; s/\.dump$//')"
TARBALL="$DEST/pe-storage-$TS.tgz"
MANIFEST="$DEST/pe-manifest-$TS.json"
OPSCONFIG="$DEST/pe-opsconfig-$TS.tgz"

PG_USER="${POSTGRES_USER:-postgres}"
PG_DB="${POSTGRES_DB:-product_editor}"

echo "About to restore backup from: $TS"
echo "  DB dump:  $DUMP"
echo "  Storage:  ${TARBALL:-<none>}"
echo "  S3 ops-config: $([[ -f "$OPSCONFIG" ]] && echo "$OPSCONFIG" || echo '<none in this set>')"
echo "  Manifest: $(cat "$MANIFEST" 2>/dev/null || echo '<none>')"
echo
echo "This REPLACES the current database and storage config. API keys/embed"
echo "sessions created after $TS will be invalidated; mid-render jobs won't finish."
if [[ $NOPII == 1 ]]; then
  echo "WEEKLY SET: customer tables (canvas data, uploads rows, embed sessions, render jobs,"
  echo "exports, audit trail) are EMPTY in this dump by design. Uploaded photos are not restored."
fi
read -r -p "Type 'restore' to proceed: " REPLY
[[ "$REPLY" == "restore" ]] || { echo "Aborted."; exit 1; }

echo "[restore] stopping app containers (db stays up)…"
$DC stop backend celery-worker-standard celery-beat frontend || true

echo "[restore] restoring database…"
$DC exec -T db pg_restore --clean --if-exists -U "$PG_USER" -d "$PG_DB" < "$DUMP"

if [[ -f "$TARBALL" ]]; then
  echo "[restore] restoring storage config…"
  tar -xzf "$TARBALL" -C storage
fi

if [[ -f "$OPSCONFIG" ]]; then
  echo "[restore] restoring S3 ops-config…"
  # One-off container: the app is stopped, and this needs only the S3 credentials.
  $DC run --rm -T --no-deps --entrypoint /opt/venv/bin/python backend \
    manage.py restore_ops_config --stdin < "$OPSCONFIG"
fi

if [[ $NOPII == 0 ]]; then
  # The dump predates some erasures; without this a restore brings those
  # customers back. The ledger (storage/purge_ledger.jsonl) is outside the
  # database, so the restore did not touch it.
  echo "[restore] re-erasing orders purged since $TS…"
  $DC run --rm -T --no-deps --entrypoint /opt/venv/bin/python backend \
    manage.py reapply_purges --since "$TS"
fi

echo "[restore] starting containers…"
$DC up -d

echo "[restore] done. Verify: docker-compose exec db psql -U $PG_USER -d $PG_DB -c \\"
echo "  \"SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;\""
