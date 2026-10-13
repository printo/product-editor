"""
Put an archive made by `backup_ops_config` back into S3.

    manage.py restore_ops_config --file /tmp/pe-opsconfig.tgz [--dry-run]
    manage.py restore_ops_config --stdin < pe-opsconfig-<ts>.tgz

Overwrites the keys the archive holds; leaves every other key alone.
"""
import sys

from django.core.management.base import BaseCommand, CommandError

from services.ops_config_backup import restore_ops_config
from services.storage import get_storage


class Command(BaseCommand):
    help = "Restore S3 ops-config/ from a backup_ops_config archive."

    def add_arguments(self, parser):
        parser.add_argument("--file", help="Archive to read.")
        parser.add_argument("--stdin", action="store_true", help="Read the archive from stdin.")
        parser.add_argument("--dry-run", action="store_true", help="Count what would be written.")

    def handle(self, *args, **opts):
        if bool(opts["file"]) == bool(opts["stdin"]):
            raise CommandError("Give exactly one of --file or --stdin.")
        try:
            if opts["stdin"]:
                import io
                stats = restore_ops_config(get_storage(), io.BytesIO(sys.stdin.buffer.read()), opts["dry_run"])
            else:
                with open(opts["file"], "rb") as fh:
                    stats = restore_ops_config(get_storage(), fh, opts["dry_run"])
        except Exception as exc:
            raise CommandError(f"ops-config restore failed: {exc}") from exc
        self.stdout.write(
            f"ops-config restore{' (dry run)' if opts['dry_run'] else ''}: "
            f"{stats['restored']} objects ({stats['tombstones']} tombstones), {stats['skipped']} skipped"
        )
