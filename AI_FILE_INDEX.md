# AI File Index - Product Editor

This index provides a quick reference for AI assistants to locate key functional blocks.

## Backend Core (`backend/django/api/`)
- `views.py`: API endpoints for layouts and processing.
- `models.py`: Database schema for audit logs and API keys.
- `storage.py`: File storage abstraction helpers.

## AI & Layout Engines
- `backend/django/ai_engine/resource_manager.py`: Resource limits and caching.
- `backend/django/layout_engine/engine.py`: High-res image composition.

## Frontend Pages (`frontend/nextjs/src/app/`)
- `dashboard/page.tsx`: Main generation and preview UI.
- `editor/layouts/page.tsx`: Layout template creator/editor.
- `embed/layout/[name]/route.ts`: Headless integration route.

## Common Components (`frontend/nextjs/src/components/`)
- `LayoutSVG.tsx`: Cross-platform layout preview component.
- `Modal.tsx`: Standardized pop-up interface.

## Frontend Utilities (`frontend/nextjs/src/lib/`)
- `api-client.ts`: Standardized backend communication.
- `zip-utils.ts`: Client-side zipping and download helpers.

## Critical Config
- `docker-compose.yml`: Root infrastructure definition.
- `backend/django/product_editor/settings.py`: Backend configuration.
- `frontend/nextjs/next.config.mjs`: Frontend configuration.
- `.env.example`: Reference for all required environment variables.
