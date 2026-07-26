"""
Backfill ExportedResult rows for renders that completed before the render task
started writing them, and report export directories the GC can never see.

Why this exists
---------------
garbage_collector_task's primary sweep iterates ExportedResult rows. Only
GenerateLayoutView's synchronous path ever created them, and that path is
unreachable, so the table stayed empty and the sweep deleted nothing. Render
outputs accumulated indefinitely — 380 directories / 17 GB in production when
this was found, the oldest ~82 days old.

render_canvas_task now writes a row per output file, which fixes it going
forward. This command covers the backlog:

  1. For every completed RenderJob whose output_paths still exist on disk but
     have no ExportedResult row, create one. The GC then collects them on its
     normal schedule (settings.EXPORT_RETENTION_DAYS).
  2. Report export directories with no RenderJob row at all. Those are
     unreachable by any DB-driven sweep — deleting them requires --delete-orphans,
     which is deliberately opt-in because it removes files with no database
     record to cross-check against.

Dry by default. Nothing is written or deleted without --apply.

    # see what would happen
    docker-compose exec backend python manage.py backfill_exported_results
    # write the rows
    docker-compose exec backend python manage.py backfill_exported_results --apply
    # also remove directories with no RenderJob row
    docker-compose exec backend python manage.py backfill_exported_results --apply --delete-orphans
"""
from __future__ import annotations

import os
import shutil
import time

from django.conf import settings
from django.core.management.base import BaseCommand

from api.models import ExportedResult, RenderJob


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _human(nbytes: int) -> str:
    val = float(nbytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if val < 1024 or unit == "TB":
            return f"{val:.1f} {unit}"
        val /= 1024
    return f"{val:.1f} TB"


class Command(BaseCommand):
    help = "Backfill ExportedResult rows for past renders; report/remove orphan export dirs."

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply", action="store_true",
            help="Actually write rows (and delete orphans if --delete-orphans). Default is a dry run.",
        )
        parser.add_argument(
            "--delete-orphans", action="store_true",
            help="Also delete export directories that have no RenderJob row. Requires --apply.",
        )
        parser.add_argument(
            "--purge-older-than-days", type=int, default=None, metavar="N",
            help=(
                "Delete every export directory last modified more than N days ago, "
                "regardless of DB state, and mark any matching ExportedResult rows "
                "deleted. Use to clear a backlog that predates GC registration. "
                "Requires --apply. Directories NEWER than N days are never touched, "
                "so in-flight downloads survive."
            ),
        )

    def handle(self, *args, **opts):
        apply_changes = opts["apply"]
        delete_orphans = opts["delete_orphans"]
        exports_dir = settings.EXPORTS_DIR

        if delete_orphans and not apply_changes:
            self.stdout.write(self.style.WARNING(
                "--delete-orphans has no effect without --apply; running as a dry run."
            ))

        mode = "APPLY" if apply_changes else "DRY RUN"
        self.stdout.write(self.style.MIGRATE_HEADING(f"[{mode}] EXPORTS_DIR = {exports_dir}"))

        # ── 1. Backfill rows for completed jobs whose files are still on disk ──
        known_paths = set(
            ExportedResult.objects.values_list("export_file_path", flat=True)
        )
        jobs = (
            RenderJob.objects
            .filter(status="completed")
            .exclude(output_paths=[])
            .select_related("canvas_data")
        )

        rows, missing_files, already = [], 0, 0
        for job in jobs.iterator():
            canvas = job.canvas_data
            if canvas is None:
                continue
            for path in (job.output_paths or []):
                if path in known_paths:
                    already += 1
                    continue
                if not os.path.exists(path):
                    missing_files += 1
                    continue
                try:
                    size = os.path.getsize(path)
                except OSError:
                    size = 0
                rows.append(ExportedResult(
                    api_key=canvas.api_key,
                    layout_name=canvas.layout_name,
                    export_file_path=path,
                    input_files=[],          # not recoverable after the fact
                    generation_time_ms=job.generation_time_ms or 0,
                    file_size_bytes=size,
                    # created_at is auto_now_add, so these rows look "new" and
                    # the GC gives them a full retention window from today
                    # rather than deleting them on its next pass.
                    expires_at=canvas.expires_at,
                ))

        self.stdout.write(
            f"  completed jobs scanned      : {jobs.count()}\n"
            f"  files already registered    : {already}\n"
            f"  files gone from disk        : {missing_files}\n"
            f"  rows to create              : {len(rows)}"
        )
        if rows and apply_changes:
            ExportedResult.objects.bulk_create(rows, batch_size=200)
            self.stdout.write(self.style.SUCCESS(f"  created {len(rows)} ExportedResult row(s)"))

        # ── 2. Export dirs with no RenderJob row — invisible to any DB sweep ──
        job_ids = {str(i) for i in RenderJob.objects.values_list("id", flat=True)}
        orphans = []
        if os.path.isdir(exports_dir):
            for entry in os.listdir(exports_dir):
                full = os.path.join(exports_dir, entry)
                if os.path.isdir(full) and entry not in job_ids:
                    orphans.append(full)

        orphan_bytes = sum(_dir_size(p) for p in orphans)
        self.stdout.write(
            f"  orphan dirs (no RenderJob)  : {len(orphans)}  ({_human(orphan_bytes)})"
        )
        for p in orphans[:10]:
            self.stdout.write(f"      {p}")
        if len(orphans) > 10:
            self.stdout.write(f"      … and {len(orphans) - 10} more")

        if orphans and delete_orphans and apply_changes:
            removed = 0
            for p in orphans:
                try:
                    shutil.rmtree(p)
                    removed += 1
                except OSError as exc:
                    self.stderr.write(f"  failed to remove {p}: {exc}")
            self.stdout.write(self.style.SUCCESS(
                f"  removed {removed} orphan dir(s), freeing {_human(orphan_bytes)}"
            ))
        elif orphans:
            self.stdout.write(
                "  (re-run with --apply --delete-orphans to remove them)"
            )

        # ── 3. Optional: purge everything older than N days ───────────────────
        purge_days = opts["purge_older_than_days"]
        if purge_days is not None:
            cutoff = time.time() - purge_days * 86400
            stale = []
            if os.path.isdir(exports_dir):
                for entry in os.listdir(exports_dir):
                    full = os.path.join(exports_dir, entry)
                    if not os.path.isdir(full):
                        continue
                    try:
                        if os.path.getmtime(full) < cutoff:
                            stale.append(full)
                    except OSError:
                        pass

            stale_bytes = sum(_dir_size(p) for p in stale)
            self.stdout.write(self.style.MIGRATE_HEADING(
                f"\n  purge: dirs older than {purge_days}d : {len(stale)}  ({_human(stale_bytes)})"
            ))
            self.stdout.write(
                "  (directories newer than the cutoff are NOT touched, so downloads "
                "still in flight survive)"
            )

            if stale and apply_changes:
                removed = 0
                for p in stale:
                    try:
                        shutil.rmtree(p)
                        removed += 1
                    except OSError as exc:
                        self.stderr.write(f"  failed to remove {p}: {exc}")
                # Flag rows whose file is now gone so the GC stops chasing them.
                gone_ids = [
                    row.id
                    for row in ExportedResult.objects
                    .filter(is_deleted=False)
                    .only("id", "export_file_path")
                    .iterator()
                    if not os.path.exists(row.export_file_path)
                ]
                marked = (
                    ExportedResult.objects.filter(id__in=gone_ids).update(is_deleted=True)
                    if gone_ids else 0
                )
                self.stdout.write(self.style.SUCCESS(
                    f"  removed {removed} dir(s), freeing {_human(stale_bytes)}; "
                    f"marked {marked} ExportedResult row(s) deleted"
                ))
            elif stale:
                self.stdout.write(
                    f"  (re-run with --apply --purge-older-than-days {purge_days} to remove them)"
                )

        if not apply_changes:
            self.stdout.write(self.style.WARNING("\nDry run — nothing was written or deleted."))
