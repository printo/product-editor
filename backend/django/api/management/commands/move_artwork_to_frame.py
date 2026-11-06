"""
Move what sits in a layout's artwork slot to its frame picture slot, once.

    manage.py move_artwork_to_frame            # lists what it would change
    manage.py move_artwork_to_frame --apply    # changes it

A generic layout no longer has an artwork of its own: artwork belongs to a
template (2026-11-06). On production the slot held twelve photo frames whose
wooden frame picture had been saved as "printed", plus one retired test layout.
Their previews and mocks stay as they were and the wood stops printing into the
bleed strip. Calendars and books keep their one mask. Running it again changes
nothing. Before changing anything `--apply` saves each layout's old mask values
to a JSON file under the storage folder.

No version bump: what a customer sees is unchanged, and a bump would tell every
restored order that the product changed.
"""
import json
import os
from datetime import datetime, timezone

from django.conf import settings
from django.core.management.base import BaseCommand

from services.print_sheet import move_artwork_to_frame


class Command(BaseCommand):
    help = "Move artwork-slot files on generic layouts to the frame picture slot."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Make the change. Without it, only list.")

    def handle(self, *args, **opts):
        from api.models import LayoutCatalogue
        from api.views.layout_admin import invalidate_layout_caches

        changes = []
        for row in LayoutCatalogue.objects.order_by("name").iterator():
            before = json.loads(json.dumps(row.definition))
            moved = move_artwork_to_frame(row.definition)
            if moved:
                changes.append((row, before, moved))

        if not changes:
            self.stdout.write("move_artwork_to_frame: nothing to move.")
            return

        verb = "Moving" if opts["apply"] else "Would move"
        self.stdout.write(f"{verb} {len(changes)} layout(s):")
        for row, _, moved in changes:
            retired = " (retired)" if row.is_deprecated else ""
            for m in moved:
                note = f"  dropped, keeps frame picture {m['frame']}" if m["kept_frame"] else ""
                self.stdout.write(f"  {row.name}{retired}: {m['artwork']}{note}")

        if not opts["apply"]:
            self.stdout.write("Nothing changed. Run again with --apply to make the change.")
            return

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = os.path.join(settings.STORAGE_ROOT, f"artwork_move_backup_{stamp}.json")
        with open(path, "w", encoding="utf-8") as out:
            json.dump({row.name: before for row, before, _ in changes}, out, indent=1)
        self.stdout.write(f"Old values saved to {path}")

        for row, _, _ in changes:
            # update(), not save(): no version bump and no change to updated_at.
            LayoutCatalogue.objects.filter(pk=row.pk).update(definition=row.definition)
            invalidate_layout_caches(row.name)
        self.stdout.write(f"Done: {len(changes)} layout(s) changed.")
