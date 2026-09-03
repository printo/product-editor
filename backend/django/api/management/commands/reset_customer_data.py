"""
Return the instance to a just-launched state: remove ALL customer data.

Deletes every order's uploads, exports, canvas state, render jobs and embed
sessions — rows and files — by driving api.purge.purge_order_data(), the same
audited path the DPDP right-to-erasure endpoint uses. Reusing it means shared
uploads, in-flight-render guards and cross-tenant scoping behave exactly as
they do for a single-order erasure.

DELETED
    storage/uploads/**        customer photos (+ .chunks staging)
    storage/exports/**        generated print files
    UploadedFile, ExportedResult, CanvasData, RenderJob, EmbedSession rows

KEPT — this is configuration, not customer data
    storage/layouts/**        ops-authored templates
    storage/masks/**          layout masks
    storage/fonts.json
    storage/holidays/**, storage/calendar_styles/**, storage/calendar_palettes/**
    APIKey rows

Dry by default. Requires BOTH --apply and --yes-delete-all-customer-data, so it
cannot fire from a mistyped flag or a copied command line.

    manage.py reset_customer_data
    manage.py reset_customer_data --apply --yes-delete-all-customer-data
"""
from __future__ import annotations

import os
import shutil

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from api.models import (
    CanvasData, EmbedSession, ExportedResult, RenderJob, UploadedFile,
)
from api.purge import purge_order_data


def _human(nbytes: int) -> str:
    val = float(nbytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if val < 1024 or unit == "TB":
            return f"{val:.1f} {unit}"
        val /= 1024
    return f"{val:.1f} TB"


def _tree_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


# Repo scaffolding that must survive an empty-out: without these the storage
# directories vanish from git. (.chunks is upload staging and IS cleared.)
_KEEP_ENTRIES = {".gitkeep", ".gitignore"}


def _empty_dir(path: str) -> int:
    """Remove everything inside `path`, keeping the directory and its scaffolding."""
    removed = 0
    if not os.path.isdir(path):
        return 0
    for entry in os.listdir(path):
        if entry in _KEEP_ENTRIES:
            continue
        full = os.path.join(path, entry)
        try:
            if os.path.isdir(full):
                shutil.rmtree(full)
            else:
                os.remove(full)
            removed += 1
        except OSError:
            pass
    return removed


class Command(BaseCommand):
    help = "Delete ALL customer data (uploads, exports, canvas state, jobs, sessions). Keeps layouts and config."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Actually delete. Default is a dry run.")
        parser.add_argument(
            "--yes-delete-all-customer-data", action="store_true",
            help="Required alongside --apply. Deliberately verbose so this cannot fire by accident.",
        )
        parser.add_argument(
            "--force", action="store_true",
            help="Purge even when a render is in flight for an order (passed through to purge_order_data).",
        )

    def handle(self, *args, **opts):
        apply_changes = opts["apply"]
        confirmed = opts["yes_delete_all_customer_data"]
        force = opts["force"]

        if apply_changes and not confirmed:
            raise CommandError(
                "--apply requires --yes-delete-all-customer-data. "
                "This removes every customer upload and generated file on this instance."
            )

        uploads_dir = settings.UPLOADS_DIR
        exports_dir = settings.EXPORTS_DIR

        before = {
            "CanvasData": CanvasData.objects.count(),
            "RenderJob": RenderJob.objects.count(),
            "UploadedFile": UploadedFile.objects.count(),
            "ExportedResult": ExportedResult.objects.count(),
            "EmbedSession": EmbedSession.objects.count(),
        }
        uploads_bytes = _tree_size(uploads_dir)
        exports_bytes = _tree_size(exports_dir)

        mode = "APPLY" if apply_changes else "DRY RUN"
        self.stdout.write(self.style.MIGRATE_HEADING(f"[{mode}] reset customer data"))
        for k, v in before.items():
            self.stdout.write(f"  {k:<16}: {v}")
        self.stdout.write(f"  uploads on disk : {_human(uploads_bytes)}")
        self.stdout.write(f"  exports on disk : {_human(exports_bytes)}")

        order_ids = sorted(
            set(CanvasData.objects.values_list("order_id", flat=True))
            | set(EmbedSession.objects.values_list("order_id", flat=True))
        )
        self.stdout.write(f"  distinct orders : {len(order_ids)}")

        self.stdout.write(self.style.WARNING(
            "\n  KEPT: layouts, masks, fonts.json, holidays, "
            "calendar styles/palettes, API keys"
        ))

        if not apply_changes:
            self.stdout.write(self.style.WARNING(
                "\nDry run — nothing deleted. Re-run with "
                "--apply --yes-delete-all-customer-data"
            ))
            return

        # 1. Per-order erasure through the audited DPDP path.
        purged, blocked = 0, []
        for oid in order_ids:
            try:
                result = purge_order_data(oid, api_key=None, force=force)
                # purge_order_data returns {'blocked': True, ...} when a render
                # is still queued/processing for the order.
                if result.get("blocked"):
                    blocked.append(oid)
                else:
                    purged += 1
            except Exception as exc:
                self.stderr.write(f"  purge failed for {oid}: {exc}")
        self.stdout.write(self.style.SUCCESS(f"  purged {purged}/{len(order_ids)} order(s)"))
        if blocked:
            self.stdout.write(self.style.WARNING(
                f"  {len(blocked)} order(s) skipped — render in flight. Re-run with --force: "
                + ", ".join(blocked[:5]) + ("…" if len(blocked) > 5 else "")
            ))

        # 2. Anything the per-order pass could not reach: files with no owning
        #    order, and rows orphaned the same way.
        files_removed = _empty_dir(exports_dir) + _empty_dir(uploads_dir)
        rows = 0
        for model in (ExportedResult, UploadedFile, RenderJob, CanvasData, EmbedSession):
            n, _ = model.objects.all().delete()
            rows += n
        self.stdout.write(self.style.SUCCESS(
            f"  swept {files_removed} leftover path(s) and {rows} leftover row(s)"
        ))

        after_uploads = _tree_size(uploads_dir)
        after_exports = _tree_size(exports_dir)
        self.stdout.write(self.style.SUCCESS(
            f"\n  freed {_human((uploads_bytes + exports_bytes) - (after_uploads + after_exports))}"
        ))
        for k, model in (
            ("CanvasData", CanvasData), ("RenderJob", RenderJob),
            ("UploadedFile", UploadedFile), ("ExportedResult", ExportedResult),
            ("EmbedSession", EmbedSession),
        ):
            self.stdout.write(f"  {k:<16}: {model.objects.count()}")
