"""
Annual ops task (PRD §11.9): pull a locale/year's public holidays from
Nager.Date and merge them into the stored holiday data, keeping custom
entries (Holi, Diwali, Eid, ops additions).

    docker-compose exec backend python manage.py refresh_holidays             # en-IN, next year
    docker-compose exec backend python manage.py refresh_holidays --year 2031
    docker-compose exec backend python manage.py refresh_holidays --locale en-US --dry-run

Writes through the configured storage backend — S3 on prod — the same way
`PUT /api/ops/holidays/<locale>/<year>` does. See services/holiday_refresh.py.
"""
from datetime import date

from django.core.cache import cache
from django.core.management.base import BaseCommand, CommandError

from services.holiday_refresh import refresh


class Command(BaseCommand):
    help = "Refresh a locale/year's holidays from Nager.Date, merged with the stored data."

    def add_arguments(self, parser):
        parser.add_argument("--locale", default="en-IN",
                            help="Our internal locale code (default: en-IN).")
        parser.add_argument("--country", default=None,
                            help="Nager.Date country code (e.g. IN). Auto-resolved from --locale by default.")
        parser.add_argument("--year", type=int, default=None,
                            help="Year to refresh. Defaults to next calendar year.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Show what would change without writing.")

    def handle(self, *args, **opts):
        locale = opts["locale"]
        year = opts["year"] or date.today().year + 1
        code = refresh(locale, year, opts["country"], opts["dry_run"],
                       out=self.stdout.write, err=self.stderr.write)
        if code:
            raise CommandError(f"refresh_holidays {locale}/{year} did not write (exit {code}).",
                               returncode=code)
        if not opts["dry_run"]:
            # The preview's Redis entry, as HolidaysView PUT clears it.
            from api.views import _HOLIDAYS_CACHE_KEY
            cache.delete(f"{_HOLIDAYS_CACHE_KEY}{locale}:{year}")
