"""
Erase again, after a database restore, every order purged since the dump.

    manage.py reapply_purges --since 20261013T031500Z [--dry-run]

`scripts/restore.sh` runs this right after pg_restore. The dump predates some
erasures, and restoring it would otherwise bring those customers back. Reads the
purge ledger (services/purge_ledger.py), matches it against the restored
tables, and runs the normal purge for each match. See docs/DATA_LIFECYCLE.md.
"""
from django.core.management.base import BaseCommand, CommandError

from services import purge_ledger


class Command(BaseCommand):
    help = "Re-erase orders purged after the restored dump was taken."

    def add_arguments(self, parser):
        parser.add_argument("--since", required=True,
                            help="Dump time (20261013T031500Z or ISO 8601). Entries before it are already absent.")
        parser.add_argument("--dry-run", action="store_true", help="List what would be purged.")

    def handle(self, *args, **opts):
        from api.models import APIKey, CanvasData, EmbedSession, UploadedFile
        from api.purge import purge_order_data

        try:
            since = purge_ledger.parse_stamp(opts["since"])
        except ValueError as exc:
            raise CommandError(f"Bad --since value: {exc}") from exc

        entries = purge_ledger.read_entries(since)
        if not entries:
            self.stdout.write("reapply_purges: no erasures recorded since the dump.")
            return

        rows = set()
        for model in (CanvasData, EmbedSession, UploadedFile):
            rows.update(model.objects.values_list("order_id", "api_key__name").distinct())
        plan = purge_ledger.plan_replay(entries, rows)

        self.stdout.write(f"reapply_purges: {len(entries)} ledger entries since {since:%Y-%m-%dT%H:%M:%SZ}, "
                          f"{len(plan)} order(s) present in the restored data.")
        failures = 0
        for order_id, key_name in sorted(plan, key=lambda p: (p[0], p[1] or "")):
            scope = key_name or "all keys"
            if opts["dry_run"]:
                self.stdout.write(f"  would purge {order_id} ({scope})")
                continue
            key = APIKey.objects.filter(name=key_name).first() if key_name else None
            result = purge_order_data(order_id, api_key=key, force=True, record_ledger=False)
            done = result.get("matched", 0) > 0 and result.get("erasure_complete", False)
            failures += 0 if done else 1
            self.stdout.write(f"  {'purged' if done else 'INCOMPLETE'} {order_id} ({scope})")
        if failures:
            raise CommandError(f"{failures} order(s) were not fully erased; see above.")
