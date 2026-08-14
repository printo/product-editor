"""
Trace storage/uploads/_no_order/ files back to their real owning order, and
(with --apply) move the recoverable ones there.

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
     image_paths for the upload's upload_session_id or exact file_path, and
     remembers exactly WHICH CanvasData row(s) matched (not just the order_id
     string) — --apply needs to repoint those specific rows, not every row
     that happens to share the same order_id text across tenants.
  4. Classifies each file:
       RECOVERABLE    — exactly one order matched. Reports old path -> the
                        path it would move to under that order's directory.
       AMBIGUOUS      — more than one distinct order matched. Should be rare
                        to never (UUIDs don't collide) — needs a human, not
                        an automatic move. --apply never touches these.
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

Dry by default — the report above always prints, nothing is written or moved
without --apply. Only the RECOVERABLE set is ever touched:

  1. Copy the file to its real order directory (services/storage.py::
     order_upload_dir) and verify the copy's size matches before touching
     anything else — the original is never removed until this succeeds.
  2. In one transaction per file: repoint every CanvasData row that actually
     referenced the old path/upload_session_id (image_paths, render_state,
     and — for pre-migration-0008 rows — editor_state, via an EXACT leaf-value
     replace that can never corrupt a string merely containing the old path),
     and update the UploadedFile row's file_path + order_id.
  3. Only after that transaction commits, delete the original. Any failure
     before this point leaves the original untouched and cleans up its own
     half-made copy, so a re-run starts clean — never a state where a
     reference could point at a file that's gone.
  4. Re-verify on disk afterwards ("moving is not the same as having moved",
     mirroring purge_order_data's own verification sweep) before reporting
     a file as done.

    docker-compose exec backend python manage.py reconcile_no_order_uploads
    docker-compose exec backend python manage.py reconcile_no_order_uploads --show-all
    docker-compose exec backend python manage.py reconcile_no_order_uploads --apply
"""
from __future__ import annotations

import json
import os
import shutil

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction

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


def _replace_exact(value, old: str, new: str):
    """
    Recursively replace any string LEAF that exactly equals `old` with `new`,
    inside an arbitrary JSON-shaped structure (dict / list / scalar).

    Exact equality only — never a substring-within-a-larger-string replace —
    so a field that merely mentions the old path as part of unrelated text
    can never be corrupted. Returns (new_value, changed); the input is never
    mutated in place.
    """
    if isinstance(value, str):
        return (new, True) if value == old else (value, False)
    if isinstance(value, list):
        changed = False
        out = []
        for item in value:
            new_item, item_changed = _replace_exact(item, old, new)
            out.append(new_item)
            changed = changed or item_changed
        return (out, True) if changed else (value, False)
    if isinstance(value, dict):
        changed = False
        out = {}
        for k, v in value.items():
            new_v, v_changed = _replace_exact(v, old, new)
            out[k] = new_v
            changed = changed or v_changed
        return (out, True) if changed else (value, False)
    return value, False


class Command(BaseCommand):
    help = "Trace storage/uploads/_no_order/ files back to their real order via CanvasData; --apply moves the recoverable ones."

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply", action="store_true",
            help="Move RECOVERABLE files to their real order directory and repoint every reference. Default is a dry run.",
        )
        parser.add_argument(
            "--show-all", action="store_true",
            help="Print every file in every category instead of a capped sample.",
        )
        parser.add_argument(
            "--sample-size", type=int, default=20, metavar="N",
            help="Example rows to print per category when --show-all is not set (default 20).",
        )

    def handle(self, *args, **opts):
        apply_changes = opts["apply"]
        sample_size = None if opts["show_all"] else opts["sample_size"]

        no_order_dir = os.path.join(settings.UPLOADS_DIR, NO_ORDER_BUCKET)
        mode = "APPLY" if apply_changes else "DRY RUN"
        self.stdout.write(self.style.MIGRATE_HEADING(f"[{mode}] {no_order_dir}"))

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
            (c.pk, c.order_id, _haystack(c))
            for c in CanvasData.objects.all()
            .only("order_id", "editor_state", "render_state", "image_paths")
            .iterator()
        ]

        recovered: list[tuple[UploadedFile, str, str, list[int]]] = []
        ambiguous: list[tuple[UploadedFile, list[str]]] = []
        unrecoverable: list[UploadedFile] = []
        for row in reconcilable:
            needles = [n for n in (row.upload_session_id, row.file_path) if n]
            matches = [
                (pk, order_id) for pk, order_id, hay in canvases
                if any(needle in hay for needle in needles)
            ]
            matched_orders = {order_id for _pk, order_id in matches}
            if len(matched_orders) == 1:
                order_id = next(iter(matched_orders))
                proposed = os.path.join(order_upload_dir(order_id), os.path.basename(row.file_path))
                matching_pks = [pk for pk, _oid in matches]
                recovered.append((row, order_id, proposed, matching_pks))
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

        recovered_bytes = sum(disk_files.get(r.file_path, 0) for r, _, _, _ in recovered)
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

        if not apply_changes:
            self.stdout.write(self.style.WARNING(
                "\nDry run — nothing was moved or written. Re-run with --apply to move the "
                "RECOVERABLE set above. AMBIGUOUS / UNRECOVERABLE / DISK-ONLY / ROW-ONLY are "
                "never touched by --apply."
            ))
            return

        # ── Apply: move only the RECOVERABLE set ────────────────────────────
        self.stdout.write(self.style.MIGRATE_HEADING(f"\n[APPLY] moving {len(recovered)} file(s)"))
        succeeded, failed = self._apply_moves(recovered)

        for row, order_id, new_path in succeeded:
            self.stdout.write(self.style.SUCCESS(f"      moved: {new_path}  (order={order_id!r})"))
        for row, order_id, new_path, detail in failed:
            self.stdout.write(self.style.ERROR(f"      FAILED: {row.file_path} -> {new_path}: {detail}"))

        freed = sum(disk_files.get(r.file_path, 0) for r, _oid, _np in succeeded)
        self.stdout.write(
            f"\n  moved   : {len(succeeded)}  ({_human(freed)})\n"
            f"  failed  : {len(failed)}"
        )
        if failed:
            self.stdout.write(self.style.WARNING(
                "  failures left their original file untouched — safe to re-run."
            ))

    def _apply_moves(self, recovered):
        """
        Move each RECOVERABLE file and repoint its references.

        Returns (succeeded, failed):
          succeeded: list of (UploadedFile, order_id, new_path) — re-verified
                     on disk after the fact.
          failed:    list of (UploadedFile, order_id, new_path, error_detail)
        """
        succeeded: list[tuple[UploadedFile, str, str]] = []
        failed: list[tuple[UploadedFile, str, str, str]] = []

        for row, order_id, new_path, matching_pks in recovered:
            old_path = row.file_path
            try:
                if os.path.exists(new_path):
                    raise RuntimeError(f"target already exists: {new_path}")

                os.makedirs(os.path.dirname(new_path), exist_ok=True)
                shutil.copy2(old_path, new_path)
                if os.path.getsize(new_path) != os.path.getsize(old_path):
                    raise RuntimeError("size mismatch after copy")

                with transaction.atomic():
                    canvases = CanvasData.objects.select_for_update().filter(pk__in=matching_pks)
                    for canvas in canvases:
                        update_fields = []
                        for field in ("editor_state", "render_state", "image_paths"):
                            current = getattr(canvas, field)
                            if current is None:
                                continue
                            new_value, changed = _replace_exact(current, old_path, new_path)
                            if changed:
                                setattr(canvas, field, new_value)
                                update_fields.append(field)
                        if update_fields:
                            canvas.save(update_fields=update_fields)

                    UploadedFile.objects.filter(pk=row.pk).update(
                        file_path=new_path, order_id=order_id,
                    )

                # Only remove the original after the DB commit above succeeds —
                # os.remove is the last step, so any exception raised earlier
                # leaves old_path fully intact.
                os.remove(old_path)

                # "Moving is not the same as having moved" — re-check before
                # reporting success, mirroring purge_order_data's own
                # post-transaction verification sweep.
                if not os.path.isfile(new_path) or os.path.exists(old_path):
                    raise RuntimeError("post-move verification failed — new path missing or old path still present")

                succeeded.append((row, order_id, new_path))

            except Exception as exc:
                # old_path is only ever removed on the success path above, so
                # it is guaranteed intact here. Clean up any partial/complete
                # copy so a re-run doesn't trip the "target already exists"
                # guard.
                if os.path.exists(new_path):
                    try:
                        os.remove(new_path)
                    except OSError:
                        pass
                failed.append((row, order_id, new_path, str(exc)))

        return succeeded, failed
