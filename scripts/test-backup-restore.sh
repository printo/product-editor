#!/usr/bin/env bash
# Non-destructive backup+restore verification (Phase 4). Proves a backup can
# actually be restored — a backup you've never restored is a hope, not a
# backup. Restores into a THROWAWAY database, row-count-asserts against the
# manifest, then drops it. Never touches the live DB. Exit non-zero on
# mismatch so CI/cron can alert.
set -euo pipefail

cd "$(dirname "$0")/.."

DC="docker-compose"
command -v docker-compose >/dev/null 2>&1 || DC="docker compose"

PG_USER="${POSTGRES_USER:-postgres}"
PG_DB="${POSTGRES_DB:-product_editor}"
TEST_DB="pe_restore_test"

echo "[verify] creating a fresh backup…"
WEEKLY_TMP="backups/verify-weekly"
rm -rf "$WEEKLY_TMP"
FORCE_WEEKLY=1 WEEKLY_DIR="$WEEKLY_TMP" ./scripts/backup.sh >/dev/null
DUMP="$(ls -1 backups/daily/pe-db-*.dump | sort | tail -1)"
TS="$(basename "$DUMP" | sed 's/^pe-db-//; s/\.dump$//')"
MANIFEST="backups/daily/pe-manifest-$TS.json"
echo "[verify] restoring $DUMP into throwaway db $TEST_DB…"

$DC exec -T db psql -U "$PG_USER" -c "DROP DATABASE IF EXISTS $TEST_DB;" >/dev/null
$DC exec -T db psql -U "$PG_USER" -c "CREATE DATABASE $TEST_DB;" >/dev/null
$DC exec -T db pg_restore --no-owner -U "$PG_USER" -d "$TEST_DB" < "$DUMP" >/dev/null 2>&1 || true

FAIL=0
check_table() {
  local table="$1"
  local expected actual
  expected="$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('$table', 0))" 2>/dev/null || echo 0)"
  actual="$($DC exec -T db psql -U "$PG_USER" -d "$TEST_DB" -tAc "SELECT count(*) FROM $table;" 2>/dev/null | tr -d '[:space:]' || echo '?')"
  if [[ "$actual" == "$expected" ]]; then
    echo "  OK  $table: $actual rows"
  else
    echo "  FAIL $table: restored $actual, manifest says $expected"
    FAIL=1
  fi
}
# The core money-path tables — real db_table names (Django Meta.db_table).
for t in api_keys canvas_data render_jobs uploaded_files embed_sessions; do
  check_table "$t"
done

echo "[verify] verifying storage tarball is readable…"
TARBALL="backups/daily/pe-storage-$TS.tgz"
if tar -tzf "$TARBALL" >/dev/null 2>&1; then
  echo "  OK  storage archive intact ($(tar -tzf "$TARBALL" | wc -l | tr -d ' ') entries)"
else
  echo "  FAIL storage archive is unreadable"
  FAIL=1
fi

OPSCONFIG="backups/daily/pe-opsconfig-$TS.tgz"
if [[ -f "$OPSCONFIG" ]]; then
  if tar -tzf "$OPSCONFIG" >/dev/null 2>&1; then
    echo "  OK  ops-config archive intact ($(tar -tzf "$OPSCONFIG" | wc -l | tr -d ' ') entries)"
  else
    echo "  FAIL ops-config archive is unreadable"
    FAIL=1
  fi
else
  echo "  --  no ops-config archive (storage backend is not S3)"
fi

echo "[verify] weekly set must carry no customer data…"
NOPII_DUMP="$(ls -1 "$WEEKLY_TMP"/pe-db-nopii-*.dump 2>/dev/null | sort | tail -1 || true)"
if [[ -z "$NOPII_DUMP" ]]; then
  echo "  FAIL no pe-db-nopii dump was produced"
  FAIL=1
else
  NOPII_DB="pe_restore_nopii_test"
  $DC exec -T db psql -U "$PG_USER" -c "DROP DATABASE IF EXISTS $NOPII_DB;" >/dev/null
  $DC exec -T db psql -U "$PG_USER" -c "CREATE DATABASE $NOPII_DB;" >/dev/null
  $DC exec -T db pg_restore --no-owner -U "$PG_USER" -d "$NOPII_DB" < "$NOPII_DUMP" >/dev/null 2>&1 || true
  for t in canvas_data embed_sessions uploaded_files render_jobs exported_results api_requests; do
    n="$($DC exec -T db psql -U "$PG_USER" -d "$NOPII_DB" -tAc "SELECT count(*) FROM $t;" 2>/dev/null | tr -d '[:space:]' || echo '?')"
    if [[ "$n" == "0" ]]; then echo "  OK  weekly $t: 0 rows (table present)"; else echo "  FAIL weekly $t: '$n' rows"; FAIL=1; fi
  done
  keys_expected="$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('api_keys', 0))" 2>/dev/null || echo 0)"
  keys="$($DC exec -T db psql -U "$PG_USER" -d "$NOPII_DB" -tAc "SELECT count(*) FROM api_keys;" 2>/dev/null | tr -d '[:space:]' || echo '?')"
  if [[ "$keys" == "$keys_expected" ]]; then echo "  OK  weekly api_keys kept: $keys"; else echo "  FAIL weekly api_keys: $keys, expected $keys_expected"; FAIL=1; fi
  if tar -tzf "$WEEKLY_TMP"/pe-storage-*.tgz | grep -q '^uploads'; then echo "  FAIL weekly storage archive contains uploads/"; FAIL=1; else echo "  OK  weekly storage archive has no uploads/"; fi
  $DC exec -T db psql -U "$PG_USER" -c "DROP DATABASE IF EXISTS $NOPII_DB;" >/dev/null
fi
rm -rf "$WEEKLY_TMP"

echo "[verify] dropping throwaway db…"
$DC exec -T db psql -U "$PG_USER" -c "DROP DATABASE IF EXISTS $TEST_DB;" >/dev/null

if [[ $FAIL == 0 ]]; then
  echo "[verify] PASS — backup restores cleanly and row counts match."
else
  echo "[verify] FAIL — backup could not be verified." >&2
  exit 1
fi
