"""
Report which storage/uploads/_no_order/ files can be traced back to their
real owning order, and which genuinely cannot.

Why this exists
----------------
Before the fix to frontend/nextjs/src/lib/upload-utils.ts, the dashboard/
editor upload flow never sent order_id on the chunked-upload /complete call,
so ChunkedUploadCompleteView fell back to NO_ORDER_BUCKET for every one of
those uploads (see api/views.py::ChunkedUploadCompleteView, services/
storage.py::order_upload_dir). That left a backlog of misfiled customer
photos that OrderDataPurgeView / purge_order_data cannot discover by order_id
— a real DPDP gap, not just clutter.

Most of these files ARE still traceable. The browser uploads a file, then
— usually within seconds — references its upload_id in an autosave or a
submitted render: inside CanvasData.editor_state, CanvasData.render_state, or
CanvasData.image_paths. Finding that reference is exact proof of ownership,
not a guess, so this command:

  1. Walks storage/uploads/_no_order/ on disk.
  2. Loads every UploadedFile row pointing there.
  3. For each, searches every CanvasData row's editor_state / render_state /
     image_paths for the upload's upload_session_id or exact file_path.
  4. Classifies each file:
       RECOVERABLE    — exactly one order matched. Reports old path -> the
                        path it would move to under that order's directory.
       AMBIGUOUS      — more than one distinct order matched. Should be rare
                        to never (UUIDs don't collide) — needs a human, not
                        an automatic move.
       UNRECOVERABLE  — no CanvasData anywhere references it. Either the
                        upload was abandoned before any autosave/submit, or
                        its order has since been legitimately erased — either
                        way there is nothing left to attribute it to. Leave
                        these for the normal age-based GC.
  Also flagged, orthogonally to the three buckets above (these files were
  never candidates for the CanvasData search in the first place):
       DISK-ONLY      — a file in _no_order/ with no UploadedFile row at all.
                        Can't be reconciled by this method; needs separate
                        manual review if it matters.
       ROW-ONLY       — an UploadedFile row pointing at _no_order/ whose file
                        is already gone from disk. Nothing to move; the row
                        is just stale bookkeeping.

REPORT ONLY. This command never moves a file or writes a row — there is no
--apply flag here at all. Once the numbers below have been reviewed, the
actual move/update should be a separate, explicitly reviewed command (mirror
the dry-run/--apply split in backfill_exported_results.py) run against a
fresh backup.

    docker-compose exec backend python manage.py reconcile_no_order_uploads
    docker-compose exec backend python manage.py reconcile_no_order_uploads --show-all
"""
from __future__ import annotations

import json
import os

from django.conf import settings
from django.core.management.base import BaseCommand

from api.models import CanvasData, UploadedFile
from services.storage import NO_ORDER_BUCKET, order_upload_dir


def _human(nbytes: int) -> str:
    val = float(nbytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if val < 1024 or unit == "TB":
            return f"{val:.1f} {unit}"
        val /= 1024
    return f"{val:.1f} TB"


def _haystack(canvas: CanvasData) -> str:
    """
    Serialize the three fields that can reference an upload, once per
    CanvasData row, so scanning every orphan against every canvas is a plain
    substring check rather than a query per orphan.
    """
    parts = []
    for value in (canvas.editor_state, canvas.render_state, canvas.image_paths):
        if value:
            try:
                parts.append(json.dumps(value))
            except TypeError:
                parts.append(str(value))
    return "\n".join(parts)


class Command(BaseCommand):
    help = "REPORT ONLY: trace storage/uploads/_no_order/ files back to their real order via CanvasData. No --apply."

    def add_arguments(self, parser):
        parser.add_argument(
            "--show-all", action="store_true",
            help="Print every file in every category instead of a capped sample.",
        )
        parser.add_argument(
            "--sample-size", type=int, default=20, metavar="N",
            help="Example rows to print per category when --show-all is not set (default 20).",
        )

    def handle(self, *args, **opts):
        sample_size = None if opts["show_all"] else opts["sample_size"]

        no_order_dir = os.path.join(settings.UPLOADS_DIR, NO_ORDER_BUCKET)
        self.stdout.write(self.style.MIGRATE_HEADING(
            f"[REPORT ONLY — no files moved, no rows written] {no_order_dir}"
        ))

        if not os.path.isdir(no_order_dir):
            self.stdout.write("  directory does not exist — nothing to reconcile.")
            return

        # ── 1. What's actually on disk ──────────────────────────────────────
        disk_files: dict[str, int] = {}
        for entry in os.listdir(no_order_dir):
            full = os.path.join(no_order_dir, entry)
            if os.path.isfile(full):
                try:
                    disk_files[full] = os.path.getsize(full)
                except OSError:
                    disk_files[full] = 0

        # ── 2. What the DB thinks lives there ───────────────────────────────
        # Prefix with os.sep so a hypothetical sibling like "_no_order_2"
        # can never be swept in by a bare startswith on the directory name.
        db_rows = list(UploadedFile.objects.filter(file_path__startswith=no_order_dir + os.sep))
        db_paths = {row.file_path: row for row in db_rows}

        disk_only = sorted(set(disk_files) - set(db_paths))
        row_only = [row for path, row in db_paths.items() if path not in disk_files]
        reconcilable = [row for path, row in db_paths.items() if path in disk_files]

        # ── 3. Build the search haystack once, not once per orphan ─────────
        canvases = [
            (c.order_id, _haystack(c))
            for c in CanvasData.objects.all()
            .only("order_id", "editor_state", "render_state", "image_paths")
            .iterator()
        ]

        recovered: list[tuple[UploadedFile, str, str]] = []
        ambiguous: list[tuple[UploadedFile, list[str]]] = []
        unrecoverable: list[UploadedFile] = []
        for row in reconcilable:
            needles = [n for n in (row.upload_session_id, row.file_path) if n]
            matched_orders = {
                order_id for order_id, hay in canvases
                if any(needle in hay for needle in needles)
            }
            if len(matched_orders) == 1:
                order_id = next(iter(matched_orders))
                proposed = os.path.join(order_upload_dir(order_id), os.path.basename(row.file_path))
                recovered.append((row, order_id, proposed))
            elif len(matched_orders) > 1:
                ambiguous.append((row, sorted(matched_orders)))
            else:
                unrecoverable.append(row)

        # ── Report ───────────────────────────────────────────────────────────
        total_bytes = sum(disk_files.values())
        self.stdout.write(
            f"\n  files on disk                  : {len(disk_files)}  ({_human(total_bytes)})\n"
            f"  UploadedFile rows pointing here : {len(db_rows)}\n"
            f"  CanvasData rows scanned         : {len(canvases)}"
        )

        def _dump(label, items, fmt, style=None):
            style = style or (lambda s: s)
            self.stdout.write(style(f"\n  {label}: {len(items)}"))
            shown = items if sample_size is None else items[:sample_size]
            for item in shown:
                self.stdout.write(f"      {fmt(item)}")
            if sample_size is not None and len(items) > sample_size:
                self.stdout.write(f"      … and {len(items) - sample_size} more (--show-all to list them)")

        recovered_bytes = sum(disk_files.get(r.file_path, 0) for r, _, _ in recovered)
        _dump(
            f"RECOVERABLE — exact single-order match ({_human(recovered_bytes)})",
            recovered,
            lambda t: f"{t[0].file_path} -> {t[2]}  (order={t[1]!r}, uploaded {t[0].created_at:%Y-%m-%d})",
            self.style.SUCCESS,
        )

        _dump(
            "AMBIGUOUS — matched more than one order, needs manual review",
            ambiguous,
            lambda t: f"{t[0].file_path}  candidates={t[1]}",
            self.style.WARNING,
        )

        unrecoverable_bytes = sum(disk_files.get(r.file_path, 0) for r in unrecoverable)
        _dump(
            f"UNRECOVERABLE — no CanvasData references this upload ({_human(unrecoverable_bytes)})",
            unrecoverable,
            lambda r: (
                f"{r.file_path}  ({_human(disk_files.get(r.file_path, 0))}, "
                f"uploaded {r.created_at:%Y-%m-%d}, upload_session_id={r.upload_session_id})"
            ),
        )

        disk_only_bytes = sum(disk_files.get(p, 0) for p in disk_only)
        _dump(
            f"DISK-ONLY — file exists but no UploadedFile row at all ({_human(disk_only_bytes)})",
            disk_only,
            lambda p: f"{p}  ({_human(disk_files.get(p, 0))})",
            self.style.WARNING,
        )

        _dump(
            "ROW-ONLY — UploadedFile row points here but the file is already gone from disk",
            row_only,
            lambda r: f"{r.file_path}  (upload_session_id={r.upload_session_id})",
            self.style.WARNING,
        )

        self.stdout.write(self.style.WARNING(
            "\nReport only — nothing was moved or written. Review the RECOVERABLE list, "
            "then implement a separate --apply command (dry-run/--apply split, per "
            "backfill_exported_results.py) once you're satisfied with what it proposes."
        ))
