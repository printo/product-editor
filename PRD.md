# Product Editor — Product Requirements Document (PRD)
**Version:** 1.0
**Date:** March 2026
**Status:** Living Document

---

## 1. Executive Summary

**Product Editor** is a full-stack photo layout generation and interactive canvas editing platform built for Printo's internal and external workflows. It enables users to arrange product images into print-ready layouts, customize them with text and design overlays, and export high-resolution files suitable for print production.

The system serves two primary use cases:
- **API-based batch layout generation** — for internal systems to automatically compose product images into predefined templates
- **Interactive web editor** — for ops/design teams to visually edit layouts, add text, shapes, and export print-ready files

---

## 2. System Architecture

### 2.1 Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Backend Framework | Django + Django REST Framework | 5.0.6 / 3.15.2 |
| Backend Language | Python | 3.12 |
| Image Processing | Pillow (PIL) | 10.3.0 |
| Database | PostgreSQL | 16 |
| Frontend Framework | Next.js (App Router) | 16.2.0 |
| Frontend Language | TypeScript | 5.7 |
| Canvas Library | Fabric.js | 7.2.0 |
| UI Styling | Tailwind CSS | 3.4.17 |
| Authentication | NextAuth + PIA (Printo Internal Auth) | 5.0.0-beta.30 |
| Reverse Proxy | Traefik v3.0 with Let's Encrypt TLS | — |
| Container Runtime | Docker + Docker Compose | — |
| API Documentation | drf-spectacular (OpenAPI 3.0) | 0.27.2 |

### 2.2 Infrastructure Topology

```
Internet
  └── Traefik (SSL/TLS termination, routing)
        ├── Frontend: Next.js (Port 5004 → 3000)
        ├── Backend:  Django/Gunicorn (Port 8001 → 8000)
        └── Database: PostgreSQL 16 (Port 5433 → 5432)
```

### 2.3 Storage Layout

```
/storage/
├── uploads/    # Uploaded source images
├── layouts/    # Layout JSON template definitions
├── exports/    # Generated PNG output files
└── masks/      # Mask images for shaped frame crops
```

---

## 3. Features Implemented (Current State)

### 3.1 Layout Engine (Backend)

The core image composition engine (`layout_engine/engine.py`) provides:

- **20+ predefined layout templates** — 4x6, 5x7, 8x10, classic prints, polaroids, product-specific layouts
- **Frame-based positioning** — precise mm and normalized coordinate definitions
- **Two fit modes:**
  - `contain` — letterboxing (full image visible, padded)
  - `cover` — center-crop (fills frame without padding)
- **Mask application** — shaped crops (circular, custom) via overlay mask images
- **Multi-surface product layouts** — multiple surfaces per product (e.g., box front, back, side flap) composited as separate canvases
- **Image cycling** — automatically reuses images when layout has more frames than provided images
- **LANCZOS resampling** — high-quality image downscaling
- **300 DPI output** — with proper `pHYs` metadata chunk injection into PNG files

### 3.2 REST API (Backend)

**Public / Consumer APIs:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Service liveness check |
| `/api/layouts` | GET | List all available layout templates |
| `/api/layouts/{name}` | GET | Fetch specific layout JSON |
| `/api/layout/generate` | POST | Generate layout image from uploaded images |
| `/api/exports/{file_path}` | GET | Download exported PNG file |
| `/api/fonts` | GET | List available fonts |

**Ops / Admin APIs:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/ops/layouts` | GET / POST | List or create layout definitions |
| `/api/ops/layouts/{name}` | GET / PUT / DELETE | CRUD for layout definitions |
| `/api/layouts/masks/{filename}` | GET | Download mask images |
| `/api/fonts` | PUT | Update available fonts (ops only) |

**Embed / External APIs:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/embed/session` | POST | Create short-lived iframe embed token (2-hour TTL) |
| `/api/embed/session/validate` | GET | Internal token validation (proxy only) |
| `/api/external/layouts/{name}` | GET | External system layout access |

### 3.3 Authentication & Security

- **Bearer Token Authentication** — static API keys stored in DB (`editor_{timestamp}_{random}`)
- **PIA Integration** — Printo internal auth token verification with 5-minute verification cache
- **Per-key granular permissions:** `can_generate_layouts`, `can_list_layouts`, `can_access_exports`, `is_ops_team`
- **Rate limiting** — 100 requests/min per IP, per-key daily request cap
- **Embed Session System** — short-lived UUID tokens (2-hour TTL) for safe iframe embedding; real API key never exposed to browser
- **Path traversal protection** on file download endpoints
- **Full API request audit log** — every API call logged with endpoint, method, status code, response time, IP, user agent

### 3.4 Database Models

| Model | Purpose |
|---|---|
| `APIKey` | API consumer credentials and permission flags |
| `APIRequest` | Full audit trail of every API call |
| `UploadedFile` | File tracking for uploads (with soft delete + expiry) |
| `ExportedResult` | Tracks generated files with input list and performance metrics |
| `EmbedSession` | Short-lived tokens for iframe embedding |

### 3.5 Interactive Canvas Editor (Frontend)

The Fabric.js-based editor provides:

**Canvas Layer System:**
- Paper background layer (white or custom colour)
- Background image/colour layer
- Guide lines (horizontal and vertical)
- Grid lines for alignment
- Bleed zone visualization (red outline)
- Safe zone visualization
- User-placed images
- Shapes and text overlays

**Text Editing:**
- Font selection
- Size, bold, italic, colour, opacity
- Rotation
- Shadow control

**Shape Tools:**
- Circle, ellipse, rectangle, triangle, polygon
- Dynamic path-based shape catalog
- Rotation, scaling, colour fill

**Image Overlays:**
- Local image upload and canvas placement
- Resizable and repositionable

**Canvas Controls:**
- Zoom in/out and fit-to-window
- Pan/viewport management
- Object alignment (left, center, right, top, middle, bottom, distribute)
- Layer ordering (bring to front, send to back)
- Undo/redo (Fabric.js native JSON snapshot)

**Bleed-Aware Rendering:**
- Canvas renders with bleed margins shown during editing
- Print export includes bleed
- Mockup export excludes bleed/shadow

**Export Modes:**
- Print export (with shadow + bleed)
- Mockup export (clean, no shadow)

### 3.6 Dashboard

- Grid view of all available layout templates
- Search and filter by layout name
- Multi-surface layout visualization with surface count indicator
- Dynamic placeholder text
- Click-to-open editor

### 3.7 Embed Mode

- Safe iframe embedding for external/third-party integration
- Token-based authentication flow (API key never reaches browser)
- `window.postMessage` API for parent page communication
- Multi-surface surface rendering within iframe

### 3.8 Font Management

- Configurable font list via API (ops team can update)
- Font selection in the canvas text editor

---

## 4. Known Gaps and Shortcomings

### 4.1 Critical Gaps

| # | Gap | Impact |
|---|---|---|
| G1 | **No canvas state persistence** — editor state is lost on page refresh or navigation | High — users lose all editing work |
| G2 | **No layout save/versioning** — no way to save a partially edited layout and resume later | High — blocks collaborative or long-running design workflows |
| G3 | **Single Gunicorn worker (1 worker, 4 threads)** — rate limiter is in-process only, state is not shared across processes | High — rate limiting is not horizontally scalable |
| G4 | **No background task queue** — image generation happens synchronously in the request lifecycle; slow/large generations block the worker | High — will cause timeouts under load |
| G5 | **Local file storage only** — exports, uploads, and layouts stored on local disk; no cloud storage (S3, GCS) integration | High — not suitable for multi-instance deployment |

### 4.2 Functional Gaps

| # | Gap | Impact |
|---|---|---|
| F1 | **No admin UI** — API keys and permissions are managed manually in the DB or Django admin; no dedicated ops UI | Medium — slow and error-prone key management |
| F2 | **No image pre-processing pipeline** — no auto-orientation fix, no EXIF stripping, no colour profile normalisation | Medium — uploaded images with rotation metadata may render incorrectly |
| F3 | **No image upload directly from canvas editor** — users cannot upload new source images mid-edit | Medium — limits editor flexibility |
| F4 | **No export history / download history** — users cannot see previously generated exports from the UI | Medium — discoverability and reuse of exports |
| F5 | **No layout preview in editor for multi-surface** — editor only shows one surface at a time; no side-by-side view | Medium — hard to validate multi-surface products holistically |
| F6 | **Fonts are not embedded or validated** — fonts available in editor depend on browser; custom/brand fonts may not render correctly across environments | Medium — print output may differ from editor preview |
| F7 | **No CMYK export support** — all exports are RGB PNG; print workflows typically require CMYK or PDF | Medium — downstream print integration requires manual conversion |
| F8 | **No collaborative editing** — single user at a time; no multi-user presence or conflict resolution | Low–Medium — fine for current team size |
| F9 | **No crop/resize tool in canvas** — users cannot crop uploaded images within the editor | Medium — key missing editing primitive |

### 4.3 Operational Gaps

| # | Gap | Impact |
|---|---|---|
| O1 | **No structured logging** — `print()` / ad-hoc logs used in recent commits; no log aggregation | Medium — hard to debug production issues |
| O2 | **No metrics or monitoring** — no Prometheus, no Grafana, no error tracking (Sentry/Datadog) | Medium — blind to production health |
| O3 | **No automated test coverage** — test directory exists but coverage unknown; no CI test step visible | Medium — regressions are only caught manually |
| O4 | **No soft-delete cleanup job** — `UploadedFile.expires_at` exists but no cron/celery task to actually purge expired files | Low — storage will grow unbounded |
| O5 | **Embed token not revocable from UI** — `EmbedSession.is_revoked` field exists but no API endpoint to revoke a token | Low — security gap if a token needs to be invalidated early |

### 4.4 Technical Debt

| # | Item | Impact |
|---|---|---|
| T1 | `ai_models/` directory is empty — ghost directory from AI removal | Low |
| T2 | NextAuth beta version (5.0.0-beta.30) — not production stable | Medium |
| T3 | In-process rate limiting is reset on every deploy | Medium |
| T4 | No migration squashing — initial migration covers full schema | Low |

---

## 5. Future Scope & Roadmap

### Phase 1 — Stability & Production Readiness (0–2 months)

| Priority | Feature |
|---|---|
| P0 | Migrate file storage to S3 / GCS (replace `LocalStorage` with cloud backend) |
| P0 | Add Celery + Redis for async image generation queue |
| P0 | Canvas state auto-save (localStorage or backend-persisted JSON) |
| P1 | Replace in-process rate limiter with Redis-backed rate limiting |
| P1 | Add Sentry / Datadog error tracking |
| P1 | Add structured JSON logging (replace `print()` calls) |
| P1 | CI pipeline with automated tests |
| P1 | Upgrade NextAuth to stable release |

### Phase 2 — Editor Enhancements (1–3 months)

| Priority | Feature |
|---|---|
| P0 | **Save & Resume** — persist canvas JSON to backend; users can save draft layouts |
| P0 | **Layout versioning** — version history for saved layouts with diff view |
| P1 | **Image crop tool** — crop/resize uploaded images directly in canvas |
| P1 | **Image upload from within canvas editor** — allow mid-edit image replacement |
| P1 | **EXIF auto-rotation fix** — normalise image orientation on upload |
| P1 | **Font management improvements** — upload custom fonts, validate rendering |
| P2 | **Multi-surface side-by-side preview** — view all surfaces of a product simultaneously |
| P2 | **Export history** — list and re-download previous exports |
| P2 | **Keyboard shortcuts** — standard shortcuts (Cmd+Z, Cmd+S, arrow nudge) |

### Phase 3 — Platform Expansion (2–6 months)

| Priority | Feature |
|---|---|
| P0 | **PDF export** — CMYK PDF generation for print production pipelines |
| P0 | **Template library** — save custom designs as reusable templates |
| P1 | **Admin dashboard** — web UI for managing API keys, viewing audit logs, usage analytics |
| P1 | **User workspace** — per-user saved layouts, designs, and exports |
| P1 | **Bulk layout generation** — API or UI-based batch generation for multiple SKUs |
| P2 | **Webhook support** — notify external systems when an export completes |
| P2 | **Layout approval workflow** — draft → review → approved states for ops team |
| P2 | **Design variant generation** — one design, multiple colour/image variants auto-generated |

### Phase 4 — AI-Assisted Features (4–9 months)

| Priority | Feature |
|---|---|
| P1 | **Background removal (re-introduce)** — AI-based bg removal, this time as a dedicated microservice |
| P1 | **Auto-layout suggestion** — based on image count and aspect ratios, suggest best-fit layout |
| P2 | **Smart image cropping** — face/subject detection to auto-center crops |
| P2 | **Text style suggestions** — context-aware font/colour pairing |
| P3 | **One-click product mockup generation** — photo realistic product renders from flat artwork |

### Phase 5 — Integration & Ecosystem (6–12 months)

| Priority | Feature |
|---|---|
| P1 | **OMS / order management integration** — auto-trigger layout generation from order data |
| P1 | **SKU-to-layout mapping** — product catalogue integration (specific SKUs map to specific layouts) |
| P2 | **Public API v2** — documented, versioned, rate-limited API for external partners |
| P2 | **Multi-tenant workspace isolation** — separate namespaces per partner / external brand |
| P3 | **White-label embed** — customisable branding for embedded editor instances |

---

## 6. Non-Functional Requirements (NFRs)

### 6.1 Performance Targets (not yet measured)

| Metric | Current Estimate | Target |
|---|---|---|
| Layout generation (single surface, 6 images) | ~1–3 seconds | < 2 seconds (p95) |
| Layout generation (multi-surface, 10+ images) | ~3–8 seconds | < 5 seconds (p95) |
| Canvas editor load time | < 3 seconds | < 2 seconds |
| Export file download | Depends on file size | < 1 second for files < 10MB |

### 6.2 Scalability

- Current deployment: Single machine, 1 Gunicorn worker
- With async queue + S3 + Redis: horizontal scaling of backend workers is unblocked
- Frontend: Stateless Next.js — horizontally scalable today

### 6.3 Security

- All exports protected behind API key authentication
- Path traversal protection on download endpoints
- Embed tokens expire in 2 hours
- No raw API keys exposed to browser-side JavaScript

---

## 7. Stakeholder Map

| Stakeholder | Role | Interaction |
|---|---|---|
| Ops / Design Team | Create and manage layout templates, edit canvases | Web editor, ops API |
| Internal Engineering | API-based batch layout generation for OMS / order flows | REST API with API keys |
| External Partners | Embed editor in third-party interfaces | Embed session tokens + iframe |
| DevOps | Deployment, monitoring, scaling | Docker, Traefik, future: K8s |

---

## 8. Glossary

| Term | Definition |
|---|---|
| Layout | A JSON template defining a canvas size and set of named frames |
| Frame | A positioned region within a layout where an image is placed |
| Surface | A distinct face of a physical product (e.g., front, back, flap); a product layout can have multiple surfaces |
| Bleed | Extra margin beyond the safe print area to account for cutting tolerances |
| Fit Mode | How an image fills a frame — `contain` (letterbox) or `cover` (center crop) |
| Mask | A grayscale image applied over a frame to produce shaped crops (e.g., circle) |
| Embed Session | A short-lived UUID token used to safely embed the editor in an iframe without exposing the real API key |
| PIA | Printo Internal Auth — the internal identity provider used for staff authentication |
| DPI | Dots Per Inch — resolution metadata injected into exported PNGs via the `pHYs` chunk |

---

*This document is intended as a living reference. Update it as features ship or priorities change.*
