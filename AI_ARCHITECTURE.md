# System Architecture - Product Editor

## High-Level Design
The system follows a decoupled **Client-Server architecture** using Next.js for the frontend and Django (DRF) for the backend. Communication is handled via a Traefik reverse proxy.

## Project Folder Structure

### Root
- `/frontend`: Next.js application.
- `/backend`: Django application.
- `/storage`: Centralized persistent storage for files.
- `/proxy`: Reverse proxy configuration (Traefik).

### Backend Details (`/backend/django`)
- `api/`: Primary DRF app containing views, models, and business logic.
- `ai_engine/`: AI processing logic, caching, and resource management.
- `layout_engine/`: Python/PIL logic for rendering high-resolution canvases.
- `services/`: Low-level utilities (e.g., storage abstraction).
- `product_editor/`: Project configuration and settings.

### Frontend Details (`/frontend/nextjs/src`)
- `app/`: Next.js App Router (pages and layouts).
- `components/`: Reusable UI components.
- `lib/`: Utility functions, API clients, and **zip processing**.
- `context/`: React context providers.

## Data Flow
1. **Request**: Frontend sends `multipart/form-data` with images and layout parameters to the backend.
2. **Analysis**: `ai_engine` detects products and removes backgrounds if needed.
3. **Generation**: `layout_engine` arranges results into a canvas grid and applies masks.
4. **Interactive Edit**: Frontend maintains a structured state (`CanvasItem`) allowing users to zoom, move, and trigger manual AI processing (e.g., Background Removal).
5. **Persistence**: The final PNG (re-rendered on change) is saved or downloaded.
6. **Batch Export**: Client-side zipping via `JSZip` handles multi-canvas downloads.

## Key Architectural Decisions
- **Multipart Standard**: All data-heavy API requests use `multipart/form-data` for stability.
- **Structured Editor State**: Canvases are managed as `CanvasItem` objects with `FrameState` metadata to persist interactive edits.
- **File-Based Layouts**: Layout templates are stored as JSON files for easy portability.
- **Resource Management**: AI operations are throttled and cached in `ai_engine/resource_manager.py`.
- **Stateless API**: Authentication is handled via Bearer tokens; sessions are managed in Next.js (NextAuth).

## Boundaries & Interfacing
- **AI Engine**: Encapsulated. Does not interact with the DB directly; takes paths and returns metadata/processed paths.
- **Layout Management**: Reads/Writes to `/storage/layouts` and `/storage/masks`.
