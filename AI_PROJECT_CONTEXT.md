# AI Project Context - Product Editor

This file serves as the primary context for AI assistants working on the Product Editor repository.

## Project Overview
The **Product Editor** is a production-ready system designed for generating photo layouts and collages. It leverages AI for advanced image processing (background removal, product detection, blending) and provides a professional layout management system for high-resolution print exports.

## Project Goals
- Provide a seamless UI for photo layout creation and **interactive canvas editing**.
- Automate canvas generation using AI-driven image analysis.
- Ensure professional print quality (LANCZOS resampling, "Cover" fit consistency).
- Support **batch downloading** of high-res canvases via client-side zipping.
- Maintain a secure, rate-limited, and audited API for third-party integrations.

## Tech Stack
- **Frontend**: Next.js 15 (React 19), TypeScript, Tailwind CSS, Lucide React, NextAuth.
- **Backend**: Django 5.0, Django REST Framework (DRF), PostgreSQL.
- **Image Processing**: Pillow (PIL), OpenCV, Torch/Ultralytics (AI models).
- **Communication**: Unified `multipart/form-data` for all non-login POST requests.
- **Infrastructure**: Docker Compose, Traefik (Reverse Proxy).

## Runtime Environment
- All services run within Docker containers.
- **Frontend**: Port 5004
- **Backend**: Port 8000 (proxied via `/api`)
- **Storage**: Persistent volumes for `/uploads`, `/layouts`, `/exports`, and `/masks`.

## Approved Dependencies
- **Backend**: `django`, `djangorestframework`, `Pillow`, `rembg`, `ultralytics`, `psycopg2-binary`, `whitenoise`.
- **Frontend**: `next`, `react`, `lucide-react`, `js-cookie`, `jszip`, `clsx`, `tailwind-merge`, `jose`, `next-auth`.

## Coding Standards
- **TypeScript**: Strict type checking. Use functional components with hooks.
- **CSS**: Vanilla CSS or Tailwind. Favor reusable utility classes.
- **Python**: PEP 8 compliance. Use DRF `APIView` for endpoints.
- **Security**: Robust path traversal checks and CORS restriction are mandatory.
- **Persistence**: Layouts are stored as JSON files with associated binary masks.

## Environment Configuration
- Configuration is strictly driven by `.env` files.
- Never hardcode API keys or database credentials.

## Testing Strategy
- **Backend**: Django unit tests and system checks.
- **Frontend**: Next.js linting and build validation.

## AI Assistant Instructions
- Read `AI_GUARDRAILS.md` before making any structural changes.
- Refer to `ARCHITECTURE.md` to understand component boundaries.
- Follow the workflow defined in `TASK_RULES.md`.
