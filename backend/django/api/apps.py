from django.apps import AppConfig

class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self):
        # Register the drf-spectacular authentication extensions. They only take
        # effect once their module is imported, and nothing else imports it —
        # without this the OpenAPI document references a BearerAuth scheme it
        # never defines. See api/schema.py.
        try:
            from . import schema  # noqa: F401
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "drf-spectacular schema extensions failed to register", exc_info=True,
            )

        # Tolerate truncated images process-wide. Consumer uploads — iOS/iCloud
        # exports, WhatsApp-forwarded photos, interrupted transfers — are
        # frequently truncated (the last few scanlines are missing). Browsers
        # decode these leniently, so the customer composes and approves the
        # photo in the editor preview; Pillow is strict by default and would
        # raise "image file is truncated (N bytes not processed)" at 300-DPI
        # render time, failing the whole batch AFTER the upload already
        # succeeded. Matching the browser's leniency keeps the render WYSIWYG
        # and stops one bad photo from killing a 100-file job. Set here (rather
        # than in one module) so it applies in both the gunicorn web process
        # and the Celery render workers.
        try:
            from PIL import ImageFile
            ImageFile.LOAD_TRUNCATED_IMAGES = True
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Could not enable PIL LOAD_TRUNCATED_IMAGES", exc_info=True,
            )

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
