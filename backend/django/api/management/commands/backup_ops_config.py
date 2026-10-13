"""
Archive the ops-edited config held in S3 (holidays, calendar styles, palettes,
fonts) into a .tar.gz — the half of the backup scripts/backup.sh could not take.

    manage.py backup_ops_config --output /tmp/pe-opsconfig.tgz

Exits 0 and writes nothing under a non-S3 backend (that config is on local disk
and already in the storage tarball). See services/ops_config_backup.py.
"""
from django.core.management.base import BaseCommand, CommandError

from services.ops_config_backup import export_ops_config
from services.storage import get_storage


class Command(BaseCommand):
    help = "Archive S3 ops-config/ to a .tar.gz."

    def add_arguments(self, parser):
        parser.add_argument("--output", required=True, help="Path of the .tar.gz to write.")

    def handle(self, *args, **opts):
        path = opts["output"]
        try:
            with open(path, "wb") as fh:
                stats = export_ops_config(get_storage(), fh)
        except Exception as exc:
            raise CommandError(f"ops-config backup failed: {exc}") from exc
        if stats is None:
            self.stdout.write("ops-config backup skipped: storage backend is not S3.")
            import os
            os.unlink(path)
            return
        self.stdout.write(
            f"ops-config backup: {stats['objects']} objects ({stats['tombstones']} tombstones) -> {path}"
        )
