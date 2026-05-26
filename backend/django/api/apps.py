from django.apps import AppConfig

class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
        # Boot-time visibility for the server-side overlay renderer's bundled
        # font (CALENDAR_FEATURE_PRD §11.7). Logs a single line on startup if
        # Inter-Variable.ttf is present, or a loud error if missing — beats
        # discovering "your overlays render in PIL default" on first customer
        # complaint. Lazy import so a partial install (no Pillow) doesn't
        # crash Django boot for unrelated workloads.
        try:
            from services.fonts import startup_check
            startup_check()
        except Exception:
            # Importing services.fonts shouldn't break Django startup even
            # if PIL is missing or the module hits some other surprise.
            import logging
            logging.getLogger(__name__).warning(
                "services.fonts startup_check failed to run", exc_info=True,
            )
