"""
Re-fetch every cached text-overlay font from Google Fonts, so a family Google
has updated since it was first cached prints in the current version.

    docker-compose run --rm --entrypoint /opt/venv/bin/python backend manage.py refresh_fonts

deploy.sh runs this before swapping containers; a failure there is a warning,
never a failed deploy — a font that can't be re-fetched keeps its cached copy.
See services/google_fonts.py.
"""
from django.core.management.base import BaseCommand, CommandError

from services.google_fonts import FontUnavailable, refresh_cached_fonts
from services.storage import FontCacheUnavailable


class Command(BaseCommand):
    help = "Re-fetch cached text-overlay fonts from Google Fonts."

    def handle(self, *args, **opts):
        try:
            stats = refresh_cached_fonts(out=self.stdout.write)
        except (FontUnavailable, FontCacheUnavailable) as exc:
            raise CommandError(f"Font refresh skipped: {exc}") from exc
        self.stdout.write("refresh_fonts: " + ", ".join(f"{k}={v}" for k, v in stats.items()))
        if stats["failed"]:
            raise CommandError(f"{stats['failed']} font(s) could not be refreshed; cached copies kept.")
