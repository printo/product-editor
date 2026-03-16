import os
import logging
import threading
from django.apps import AppConfig

logger = logging.getLogger(__name__)


class AiEngineConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'ai_engine'
    verbose_name = 'AI Processing Engine'

    def ready(self):
        # Preload in the server process — RUN_MAIN for runserver, or gunicorn worker
        is_server = os.environ.get('RUN_MAIN') == 'true' or 'gunicorn' in (os.environ.get('SERVER_SOFTWARE', '') + os.environ.get('GUNICORN_CMD_ARGS', ''))
        if is_server or os.path.basename(os.environ.get('_', '')).startswith('gunicorn'):
            # Warm up in a background thread so it doesn't block server startup
            thread = threading.Thread(target=self._preload_models, daemon=True)
            thread.start()

    @staticmethod
    def _preload_models():
        try:
            from .model_manager import get_model_manager
            manager = get_model_manager()
            logger.info("Preloading rmbg model for background removal...")
            manager.load_model("rmbg")
            logger.info("rmbg model preloaded successfully")
        except Exception as e:
            logger.warning(f"Model preload failed (will load on first request): {e}")