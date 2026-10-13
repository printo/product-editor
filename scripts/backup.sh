#!/usr/bin/env bash
# Automated backup of the Postgres DB + ops-mutated storage config (Phase 4).
#
# What it captures:
#   - pe-db-<ts>.dump      : pg_dump custom format (pg_restore --clean ready)
#   - pe-storage-<ts>.tgz  : ONLY the config ops mutates at runtime and that is
#                            NOT recoverable from git (layouts, fonts,
#                            calendar palettes/styles, holidays, masks).
#   - pe-opsconfig-<ts>.tgz : S3 ops-config/ (holidays, calendar styles, palettes,
#                            fonts). On prod (STORAGE_BACKEND=s3) the ops UI writes
#                            there, NOT to storage/, so the tarball above holds
#                            only the git seeds. Skipped under the local backend.
#   - pe-manifest-<ts>.json : per-table row counts for restore verification.
#
# Deliberately EXCLUDED from the daily set:
#   - exports/  : pure derivatives (regenerable by re-render; GC'd every 6 hours)
#   - uploads/  : transient + potentially tens of GB (GC'd). Use --with-uploads
#                 for an ad-hoc set (daily tier only, never copied into the weekly tier) — CanvasData.editor_state references upload
#                 paths, so a DB restore without uploads can't re-render
#                 in-flight orders.
#
# Retention and personal data (docs/DATA_LIFECYCLE.md): customer rows and photos
# live 3 days in the app, so the long-lived tier must not outlive that. The DAILY
# set (7 days) is full. The WEEKLY set (4 weeks) is PII-free: pe-db-nopii-<ts>.dump
# is a pg_dump with the data of the customer tables left out (schema, API keys,
# layouts and the other config survive), and its storage archive never holds
# uploads/. Restore a weekly set only for disaster recovery of config; customer
# tables come back empty.
#
# Cron (document in deploy notes): run at 03:15 UTC. garbage_collector_task
# sweeps at 00:00, 06:00, 12:00 and 18:00 UTC, so 03:15 falls between sweeps and
# the tar doesn't race GC deletions:
#   15 3 * * * cd /path/to/product-editor && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."

WITH_UPLOADS=0
[[ "${1:-}" == "--with-uploads" ]] && WITH_UPLOADS=1

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="backups/daily"
WEEKLY="${WEEKLY_DIR:-backups/weekly}"
mkdir -p "$DEST" "$WEEKLY"

PG_USER="${POSTGRES_USER:-postgres}"
PG_DB="${POSTGRES_DB:-product_editor}"

DC="docker-compose"
command -v docker-compose >/dev/null 2>&1 || DC="docker compose"

echo "[backup] $TS — dumping database $PG_DB…"
$DC exec -T db pg_dump -U "$PG_USER" -Fc "$PG_DB" > "$DEST/pe-db-$TS.dump"

echo "[backup] archiving storage config…"
STORAGE_PATHS=(layouts masks fonts.json fonts_retired.json calendar_palettes calendar_styles holidays)
TAR_INCLUDE=()
for p in "${STORAGE_PATHS[@]}"; do
  [[ -e "storage/$p" ]] && TAR_INCLUDE+=("$p")
done
CONFIG_INCLUDE=("${TAR_INCLUDE[@]}")   # without uploads/, for the weekly tier
if [[ $WITH_UPLOADS == 1 && -d storage/uploads ]]; then
  TAR_INCLUDE+=(uploads)
  echo "[backup]   including uploads/ (weekly variant)"
fi
tar -czf "$DEST/pe-storage-$TS.tgz" -C storage "${TAR_INCLUDE[@]}"

echo "[backup] archiving S3 ops-config…"
OPS_TMP="/tmp/pe-opsconfig-$TS.tgz"
# A failure here must fail the backup: a set without the ops edits looks whole.
$DC exec -T backend /opt/venv/bin/python manage.py backup_ops_config --output "$OPS_TMP"
if $DC exec -T backend test -f "$OPS_TMP"; then
  $DC exec -T backend cat "$OPS_TMP" > "$DEST/pe-opsconfig-$TS.tgz"
  $DC exec -T backend rm -f "$OPS_TMP"
fi

echo "[backup] writing manifest…"
# Exact COUNT(*) on the money-path tables (n_live_tup is a stale estimate and
# useless for verification). Cheap — these tables are small.
$DC exec -T db psql -U "$PG_USER" -d "$PG_DB" -tAc "
  SELECT json_build_object(
    'api_keys',        (SELECT count(*) FROM api_keys),
    'canvas_data',     (SELECT count(*) FROM canvas_data),
    'render_jobs',     (SELECT count(*) FROM render_jobs),
    'uploaded_files',  (SELECT count(*) FROM uploaded_files),
    'embed_sessions',  (SELECT count(*) FROM embed_sessions),
    'exported_results',(SELECT count(*) FROM exported_results)
  );" > "$DEST/pe-manifest-$TS.json"

# ── Retention: keep newest 7 daily sets (by sorted name, not mtime, so a
#    stalled cron can't mass-delete). Sunday → also copy into weekly, keep 4.
prune() {
  # Keep the newest $keep by sorted name (portable — no bash-4 mapfile, no
  # GNU-only `head -n -N`). Delete all but the last $keep entries.
  local dir="$1" pattern="$2" keep="$3"
  local total
  # `|| true`: an empty glob makes `ls` fail, and under `set -e` + `pipefail`
  # that used to abort the whole backup (before the remaining prunes and the
  # weekly set) whenever no file of this kind existed yet, e.g. no ops-config
  # archive under the local storage backend.
  total="$(ls -1 "$dir"/$pattern 2>/dev/null | wc -l | tr -d '[:space:]' || true)"
  [ "$total" -le "$keep" ] && return 0
  ls -1 "$dir"/$pattern 2>/dev/null | sort | head -n "$(( total - keep ))" | while read -r f; do
    rm -f "$f"
  done
}
prune "$DEST" "pe-db-*.dump" 7
prune "$DEST" "pe-storage-*.tgz" 7
prune "$DEST" "pe-opsconfig-*.tgz" 7
prune "$DEST" "pe-manifest-*.json" 7

if [[ "$(date -u +%u)" == "7" || "${FORCE_WEEKLY:-0}" == "1" ]]; then
  echo "[backup] weekly set (no customer data)…"
  # Data of every table that holds customer content or IPs is left out; the
  # tables themselves are still created so a restore boots a working schema.
  PII_TABLES=(canvas_data embed_sessions uploaded_files render_jobs exported_results api_requests)
  EXCLUDES=()
  for t in "${PII_TABLES[@]}"; do EXCLUDES+=("--exclude-table-data=$t"); done
  $DC exec -T db pg_dump -U "$PG_USER" -Fc "${EXCLUDES[@]}" "$PG_DB" > "$WEEKLY/pe-db-nopii-$TS.dump"
  tar -czf "$WEEKLY/pe-storage-$TS.tgz" -C storage "${CONFIG_INCLUDE[@]}"
  [[ -f "$DEST/pe-opsconfig-$TS.tgz" ]] && cp "$DEST/pe-opsconfig-$TS.tgz" "$WEEKLY/"
  prune "$WEEKLY" "pe-db-nopii-*.dump" 4
  prune "$WEEKLY" "pe-storage-*.tgz" 4
  prune "$WEEKLY" "pe-opsconfig-*.tgz" 4
  # Before 2026-10-13 the weekly tier held full dumps (pe-db-<ts>.dump). They
  # carry customer data for up to four weeks, so remove them now that a
  # PII-free set exists. Only the legacy name matches; nopii sets are untouched.
  for old in "$WEEKLY"/pe-db-[0-9]*.dump; do
    [[ -e "$old" ]] || continue
    echo "[backup]   removing legacy full weekly dump $(basename "$old")"
    rm -f "$old"
  done
fi

# S3 upgrade path (uncomment + configure rclone remote):
# rclone copy backups/ s3:printo-pe-backups/ --include "pe-*"

echo "[backup] done → $DEST/pe-db-$TS.dump"
