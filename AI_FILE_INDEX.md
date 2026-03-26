# AI File Index - Product Editor

Map of important files and directories for AI agents.

## Backend (Django)
- `backend/django/api/`: Main API application.
  - `views.py`: API endpoints for layouts, generation, and exports.
  - `models.py`: Database models for API keys, requests, and tracking.
  - `middleware.py`: Logging and rate-limiting logic.
  - `validators.py`: Image upload validation.
- `backend/django/layout_engine/`:
  - `engine.py`: Core rendering logic using Pillow.
- `backend/django/product_editor/settings.py`: Global Django configuration.
- `backend/django/requirements.txt`: Python dependencies.

## Frontend (Next.js)
- `frontend/nextjs/src/app/layout/[name]/`: Core editor page and components.
  - `page.tsx`: Main editor entry point and state management.
  - `CanvasEditorModal.tsx`: The full-screen interactive editor.
  - `FabricEditor.tsx`: Fabric.js canvas implementation.
  - `CanvasEditorSidebar.tsx`: Property controls and object insertion.
  - `LayersPanel.tsx`: Layer management and reordering.
  - `fabric-renderer.ts`: Logic for rendering Fabric objects to PNG.
  - `types.ts`: TypeScript interfaces for the editor state.
- `frontend/nextjs/package.json`: Frontend dependencies.

## Shared / Infrastructure
- `storage/`: Centralized storage for project data.
  - `layouts/`: JSON layout templates.
  - `masks/`: SVG/PNG mask files for layouts.
- `docker-compose.yml`: Container orchestration.
- `README.md`: Project documentation.
