# AI Architecture - Product Editor

This document provides a high-level overview of the Product Editor architecture for AI agents.

## System Overview
The Product Editor is a full-stack application for generating photo layouts. It consists of a Django-based backend for layout management and rendering, and a Next.js-based frontend for interactive editing.

## Component Map

### 1. Frontend (Next.js)
- **Interactive Editor**: Located in `frontend/nextjs/src/app/layout/[name]`. Uses [fabric.js](https://fabricjs.com/) for canvas manipulation.
- **Renderer**: `fabric-renderer.ts` handles off-screen rendering for previews and exports.
- **Multi-surface Logic**: Supports products with multiple printable areas (e.g., front and back of a card).

### 2. Backend (Django)
- **API**: Django REST Framework endpoints in `backend/django/api`.
- **Layout Engine**: `backend/django/layout_engine/engine.py` uses Pillow to render high-resolution PNGs based on JSON templates.
- **Storage**: Centralized storage for uploads, layouts, and exports.

### 3. Data Flow
1. **Layout Retrieval**: Frontend fetches JSON layout definitions from `/api/layouts/{name}`.
2. **Interactive Editing**: Users upload images, adjust position/scale/rotation on the Fabric.js canvas.
3. **Rendering**:
   - **Client-side**: Fabric.js renders real-time previews.
   - **Server-side**: The `LayoutEngine` renders the final high-resolution output for production.

## Technology Stack
- **Backend**: Django, DRF, Pillow, PostgreSQL.
- **Frontend**: Next.js, React, Fabric.js, Tailwind CSS.
- **Infrastructure**: Docker, Traefik.

## Recent Changes
- All AI-related features (background removal, product detection) have been removed to simplify the core editing experience.
- The system now relies entirely on user-driven interactive editing.
