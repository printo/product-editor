# Product Requirements Specification (PRS)
## Product Editor — Printo Internal Platform

---

| Field | Value |
|---|---|
| **Document Title** | Product Editor — Product Requirements Specification |
| **Version** | 1.1 |
| **Status** | Active / Living Document |
| **Date** | March 2026 |
| **Owner** | Engineering Lead |
| **Systems Affected** | Product Editor (Frontend · Backend · Storage · Auth) |
| **Classification** | Internal |

---

## 1. Background

### Company
**Printo** is India's leading print-on-demand platform offering personalised photo products, business printing, and custom merchandise. Orders flow through an internal OMS (Order Management System) which coordinates product production, fulfilment, and delivery.

### Product / Platform
**Product Editor** is a full-stack photo layout generation and interactive canvas editing platform built for Printo's internal and external workflows. It enables:

- **API-based batch layout generation** — internal systems automatically compose product images into predefined print-ready templates via REST API.
- **Interactive web canvas editor** — ops/design teams visually edit layouts, add text and design overlays, and export high-resolution print files.
- **Safe iframe embedding** — external partners embed the full editor in their own interfaces via a short-lived token system.

### Business Trigger
The ops/design team was manually compositing product images in external tools (Photoshop, Canva) for each order and SKU variant. This was slow, inconsistent, and could not scale with order volume. Internal engineering also needed a programmatic way to auto-generate layout images as part of the OMS order flow.

This PRS captures: what has been built, known gaps, and the roadmap for extending scope — to help the team evaluate the current state and plan the next phases.

---

## 2. Stakeholders

| Name / Team | Role | Responsibility in this Project |
|---|---|---|
| Ops / Design Team | Primary Users | Create and manage layout templates; edit product canvases; validate print output quality |
| Internal Engineering | API Consumer | Integrate layout generation into OMS; batch image generation for order flows |
| External Partners | Embed Consumer | Embed the canvas editor in third-party e-commerce interfaces |
| DevOps | Infrastructure Owner | Container deployment, monitoring, scaling, secret management |
| Engineering Lead | Product Owner | Feature prioritisation, architecture decisions, sign-off |
| Security / Compliance | Reviewer | Auth model review, rate limiting, path traversal protection, token lifecycle |

---

## 3. Confirmed Assumptions

These are agreed upon and **not up for debate** in the current phase.

| # | Assumption | Implication |
|---|---|---|
| A1 | Django + Fabric.js technology stack is locked in | No platform migration; all features must be built within this stack |
| A2 | All print exports must be 300 DPI | Layout engine always outputs with correct `pHYs` PNG metadata; no lower-DPI shortcut |
| A3 | Staff authentication is handled by PIA (Printo Internal Auth) | No separate auth system to build; all staff use PIA tokens; external consumers use static API keys |
| A4 | Local file storage is acceptable for MVP | Phase 1 roadmap includes migration to S3/GCS; current single-machine deployment is accepted for now |
| A5 | All exports are RGB PNG | CMYK/PDF export is explicitly out of scope for v1; downstream teams handle conversion if needed |
| A6 | The editor is single-user | Collaborative real-time editing (multi-user presence) is out of scope for v1 |
| A7 | Image generation happens synchronously in v1 | Celery/Redis async queue is a Phase 1 roadmap item; synchronous generation is the current accepted model |

---

## 4. Scope

### In Scope (Current)
- Layout generation REST API (single surface, multi-surface, batch-friendly)
- Interactive web canvas editor (Fabric.js — text, shapes, images, alignment, undo/redo)
- Layout template management — CRUD via ops API, JSON file storage
- Iframe embed mode with short-lived token authentication
- API key management (DB-stored, per-key permissions, daily caps)
- Full audit logging of every API request
- Multi-surface product layout support (front, back, flap etc.)
- Font management (ops-controlled list, client-side rendering)
- Bleed-aware print export + clean mockup export
- Rate limiting (100 req/min per IP, cross-process via Django cache)
- Path traversal protection on all file download endpoints

### Out of Scope (Explicitly Excluded)
- CMYK / PDF export
- Collaborative real-time editing (multi-user canvas presence)
- Background removal AI (removed; planned for Phase 4 as separate microservice)
- Mobile app
- Public-facing storefront or end-customer UI
- Cloud storage / S3 / GCS (Phase 1 backlog)
- Celery / Redis async task queue (Phase 1 backlog)
- Canvas state persistence / save-and-resume (Phase 2 backlog)
- Admin UI for API key management (Phase 3 backlog)

---

## 5. Systems Involved

| System | Role in the Flow |
|---|---|
| **Django / DRF** (Python 3.12) | REST API server; image generation via Pillow; authentication; rate limiting; audit logging |
| **Gunicorn** (gthread, multi-worker) | WSGI application server; `workers = nproc × 2 + 1`; OS thread pool per worker |
| **Traefik v3** | Reverse proxy; SSL/TLS termination; routing between frontend and backend |
| **Next.js 16** (App Router, TypeScript) | Web frontend; canvas editor UI; dashboard; embed mode host |
| **Fabric.js 7.2** | Client-side canvas rendering; object manipulation; export |
| **PostgreSQL 16** | Persistence: API keys, audit log, upload/export tracking, embed sessions |
| **PIA** (Printo Internal Auth) | Staff identity provider; session token verification with 5-minute local cache |
| **Local file storage** | Layout JSON templates, uploaded images, exported PNGs, mask images |

### Storage Layout
```
/storage/
├── uploads/    # Uploaded source images
├── layouts/    # Layout JSON template definitions
├── exports/    # Generated PNG output files
└── masks/      # Mask images for shaped frame crops
```

### Infrastructure Topology
```
Internet
  └── Traefik (SSL/TLS termination, routing)
        ├── Frontend: Next.js  (Port 5004 → 3000)
        ├── Backend:  Gunicorn (Port 8001 → 8000)
        └── Database: PostgreSQL 16 (Port 5433 → 5432)
```

---

## 6. Functional Requirements

### FR-01 — Layout Generation API
- Accept `multipart/form-data` POST with images + layout name (or inline JSON)
- Support `contain` (letterbox) and `cover` (center-crop) fit modes per frame
- Return URL(s) to generated PNG file(s); include `generation_time_ms`
- Support multi-surface layouts (multiple canvases per product returned in one response)
- Cycle images when layout has more frames than provided images
- Generate at 300 DPI with correct `pHYs` PNG metadata chunk
- LANCZOS resampling for high-quality image downscaling

### FR-02 — Layout Template Management
- Store layout definitions as JSON files on disk
- Ops team can create, update, delete templates via `PUT /api/ops/layouts/{name}`
- Layout JSON schema: canvas size (mm + px), frames (normalized or mm coordinates), bleed, border radius, fit mode, mask URL, optional surfaces array
- Multi-surface layouts define a `surfaces` array, each surface with its own frame definitions

### FR-03 — Interactive Canvas Editor
- Fabric.js canvas with full object model and layer system:
  - Paper background (white border with frame hole — evenodd path)
  - Background colour / image layer
  - Guide lines (horizontal/vertical), grid lines
  - Bleed zone visualization (red outline), safe zone visualization
  - User-placed images, shapes, and text overlays
- Text tool: font selection, size, bold, italic, colour, opacity, rotation, shadow
- Shape tool: circle, ellipse, rectangle, triangle, polygon, custom SVG paths
- Image overlay: upload and place local images on canvas
- Object controls: alignment (left/centre/right/top/middle/bottom/distribute), layer order (front/back)
- Undo / redo via Fabric.js JSON snapshot history
- Zoom in/out, fit-to-window, pan / viewport management

### FR-04 — Export Modes
- **Print export** — includes bleed margin and drop shadow; full 300 DPI canvas
- **Mockup export** — clean output without shadow or bleed; for product preview
- **CMYK soft-proof export** (`soft_proof=true` on `POST /api/layout/generate`):
  - Runs the ICC-calibrated RGB → CMYK → RGB roundtrip (ISOcoated_v2 profile, ISO 12647-2)
  - Returns three files per canvas: original RGB PNG, press-ready CMYK TIFF, on-screen print simulation PNG
  - Returns a per-canvas colour-shift report: `avg_diff`, `significant` flag, human-readable message
  - Users see a warning when `significant=true` (avg pixel shift > 8/255): *"Colour shift detected — saturated blues, vivid greens, and bright oranges fall outside the CMYK gamut"*
  - CMYK TIFF embeds the ICC profile header so the press operator's RIP uses it correctly
  - Falls back to profile-less Pillow conversion if ISOcoated_v2_eci.icc is not installed (logged warning)

### FR-05 — Authentication & Authorisation
- Bearer token API key authentication (static keys stored in DB, format `editor_{timestamp}_{random}`)
- PIA session token authentication for internal staff
- Per-key permissions: `can_generate_layouts`, `can_list_layouts`, `can_access_exports`, `is_ops_team`
- Per-key daily request cap (`max_requests_per_day`)
- Health endpoint (`/api/health`) is public; all others require auth

### FR-06 — Rate Limiting
- 100 requests / 60-second window per client IP
- Atomic cross-process enforcement using Django cache `add` + `incr` (swap to Redis backend for production)
- Fail open: if cache is unavailable, rate limiting is bypassed (logs error; does not block traffic)
- Returns `HTTP 429` with `retry_after` field when limit is exceeded

### FR-07 — Embed Mode
- `POST /api/embed/session` → short-lived UUID token (2-hour TTL) — requires real API key server-side
- `iframe src: /layout/<name>?token=<uuid>` — real API key never reaches the browser
- Internal proxy validates token on each request
- Parent page receives canvas data via `window.postMessage({ type: 'PRODUCT_EDITOR_COMPLETE', canvases: [...] })`

### FR-08 — Audit Logging
- Every API call creates a row in `APIRequest` model
- Logged fields: endpoint, HTTP method, status code, response time, client IP, user agent, auth source

### FR-09 — Font Management
- `GET /api/fonts` — returns current font list (public / authenticated)
- `PUT /api/fonts` — ops team only; updates font list
- Fonts rendered client-side in canvas editor; no server-side font embedding

---

## 7. Technical / API Requirements

### TR-01 — Backend
- Python 3.12, Django 5.0.6, Django REST Framework 3.15.2
- Pillow 10.3.0 for image processing
- PostgreSQL 16 for persistence
- Gunicorn `gthread` worker class; `workers = nproc × 2 + 1` (no artificial cap); `threads = 4`
- 300-second timeout for image generation requests
- Worker recycling: `max_requests = 500 + jitter(50)` to prevent Pillow memory leaks

### TR-02 — Frontend
- Next.js 16 (App Router), TypeScript 5.7
- Fabric.js 7.2 for canvas
- Tailwind CSS 3.4
- NextAuth 5.0.0-beta.30 for session management (⚠ not production-stable — see T2)

### TR-03 — Infrastructure
- Docker + Docker Compose deployment
- Traefik v3 for SSL termination and routing
- Entrypoint computes workers at container start via `$(nproc)`; no static worker config file

### TR-04 — Security Requirements
- API keys must never appear in browser-side JavaScript (enforced by embed token system)
- Path traversal protection on all file endpoints (`os.path.basename` + safe-path check)
- CORS restricted to configured origins in production
- Security headers: CSP, X-Frame-Options (SAMEORIGIN except embed routes), HSTS in production

### TR-05 — REST API Design
- OpenAPI 3.0 documentation via `drf-spectacular` at `/api/schema/swagger-ui/`
- RESTful JSON responses; `multipart/form-data` for image upload
- Consistent error shape: `{ "detail": "..." }`

### TR-06 — Caching
- `GET /api/layouts`, `GET /api/layouts/{name}`: `Cache-Control: private, max-age=300, stale-while-revalidate=600`
- `GET /api/fonts`: `Cache-Control: public, max-age=300, stale-while-revalidate=600`
- Django cache backend: `LocMemCache` (per-process) in development; swap to `django-redis` for production cross-worker cache (rate limiter shares the same backend)

---

## 8. Non-Functional Requirements

### NFR-01 — Performance Targets

| Metric | Current Estimate | Target |
|---|---|---|
| Layout generation — single surface, 6 images | ~1–3 s | < 2 s (p95) |
| Layout generation — multi-surface, 10+ images | ~3–8 s | < 5 s (p95) |
| Canvas editor load time | < 3 s | < 2 s |
| Export file download (< 10 MB) | — | < 1 s |

> Note: Canvas export is client-side (Fabric.js → `toDataURL`). Performance depends on user device CPU. On slow machines, move export to the backend layout engine (server-side PIL rendering) for consistent speed.

### NFR-02 — Scalability
- Current: Single machine, multi-worker Gunicorn (`nproc × 2 + 1` workers × 4 threads)
- Horizontal scaling unblocked once S3 + Redis + Celery are added (Phase 1)
- Next.js frontend: stateless, horizontally scalable today

### NFR-03 — Availability
- Target: 99.5% uptime
- Current single point of failure: local file storage (unblocked by S3 migration in Phase 1)

### NFR-04 — Concurrency
- Multiple users served by separate Gunicorn OS processes — sessions are fully independent
- Canvas editor is 100% client-side (Fabric.js in each user's browser); no server state per session

### NFR-05 — Observability (Current State)

| Area | Status | Gap |
|---|---|---|
| HTTP request/response logging | ✓ Implemented | — |
| Structured JSON logging | ✗ Not implemented | Gap O1 |
| Metrics / monitoring (Prometheus, Sentry) | ✗ Not implemented | Gap O2 |
| Automated test CI | ✗ Not implemented | Gap O3 |

---

## 9. Known Gaps & Shortcomings

### 9.1 Critical Gaps

| # | Gap | Impact |
|---|---|---|
| G1 | **No canvas state persistence** — editor state lost on page refresh or navigation | High — users lose all editing work |
| G2 | **No layout save/versioning** — no way to save a partial edit and resume later | High — blocks collaborative or long-running design workflows |
| G3 | **Multi-worker rate limiting** — implemented via Django cache; requires Redis backend for true cross-worker enforcement in production | High — `LocMemCache` is per-process; swap `settings.py` CACHES to `django-redis` |
| G4 | **No background task queue** — image generation is synchronous; large generations hold a worker thread | High — will cause timeouts under sustained load; Celery + Redis needed |
| G5 | **Local file storage only** — exports, uploads, layouts on disk; no cloud storage | High — not suitable for multi-instance deployment |

### 9.2 Functional Gaps

| # | Gap | Impact |
|---|---|---|
| F1 | No admin UI — API key and permission management is DB/Django-admin only | Medium |
| F2 | No image pre-processing — no EXIF auto-rotation, no colour profile normalisation | Medium — rotated images may render incorrectly |
| F3 | No image upload from within canvas editor | Medium — limits mid-edit flexibility |
| F4 | No export / download history in UI | Medium |
| F5 | No multi-surface side-by-side preview in editor | Medium |
| F6 | Fonts depend on browser — no embedding or cross-environment validation | Medium |
| F7 | No CMYK / PDF export — all outputs are RGB PNG | Medium — print workflows may require conversion |
| F8 | No collaborative editing | Low–Medium |
| F9 | No crop/resize tool in canvas | Medium |

### 9.3 Operational Gaps

| # | Gap | Impact |
|---|---|---|
| O1 | No structured logging — `print()` / ad-hoc logs in recent commits | Medium |
| O2 | No metrics or monitoring (Prometheus, Grafana, Sentry/Datadog) | Medium |
| O3 | No automated test coverage or CI test step | Medium |
| O4 | No soft-delete cleanup job — `UploadedFile.expires_at` exists but nothing purges expired files | Low — storage grows unbounded |
| O5 | Embed token revocation — `EmbedSession.is_revoked` field exists but no API endpoint to invoke it | Low — security gap if a token needs early invalidation |

### 9.4 Technical Debt

| # | Item | Impact |
|---|---|---|
| T1 | `ai_models/` directory is empty — ghost dir from AI removal | Low |
| T2 | NextAuth 5.0.0-beta.30 — not production-stable | Medium |
| T3 | `LocMemCache` for rate limiting — resets on every deploy; per-process only | Medium |
| T4 | No migration squashing — initial migration covers full schema | Low |

---

## 10. Impact Quantification (Pending Inputs)

These metrics must be filled in by stakeholders to validate production readiness.

| Metric Needed | Target | Actual | Owner |
|---|---|---|---|
| p95 layout generation latency — single surface | < 2 s | Not measured | Engineering |
| p95 layout generation latency — multi-surface | < 5 s | Not measured | Engineering |
| Concurrent users supported on current single machine | TBD | Not measured | DevOps |
| Peak API requests / minute expected from OMS integration | TBD | Not defined | Internal Engineering |
| Storage growth rate (exports per month, GB) | TBD | Not measured | DevOps |
| Embed sessions per day from external partners | TBD | Not defined | External Partners |
| Celery queue sizing required for async generation | TBD | Not defined | Engineering / DevOps |

---

## 11. Open Questions

| # | Question | Owner | Impact if Unresolved |
|---|---|---|---|
| OQ-01 | When will Redis be provisioned for production-grade rate limiting and async task queue? | DevOps | Blocks G3 enforcement and G4 async generation |
| OQ-02 | Should exports be stored in S3 from day 1, or migrate after MVP validation? | Engineering Lead | Blocks multi-instance deployment |
| OQ-03 | Do external partners require white-label embed customisation (branding, colour)? | External Partners | New scope item if yes — adds frontend work |
| OQ-04 | Is CMYK / PDF export required before commercial launch, or is RGB PNG temporarily acceptable? | Ops / Print Production | Determines print workflow readiness and Phase 3 timeline |
| OQ-05 | Should canvas state auto-save be local (localStorage) or server-persisted (backend JSON model)? | Engineering Lead | Determines whether backend model changes and new API endpoints are needed |
| OQ-06 | Is NextAuth beta version acceptable for production, or must stable release ship first? | Engineering Lead | Security and stability risk for staff auth sessions |
| OQ-07 | What is the expected peak OMS batch generation load (requests/minute)? | Internal Engineering | Determines Celery queue sizing and worker count |
| OQ-08 | Should embed tokens be revocable via UI/API before 2-hour TTL expires? | Security / External Partners | Backend endpoint needed; field `is_revoked` exists in DB, API not yet built |

---

## 12. Acceptance Criteria

| # | Area | Criterion |
|---|---|---|
| AC-01 | Layout Generation | `POST /api/layout/generate` returns a valid PNG URL within 5 seconds for a 6-image single-surface layout |
| AC-02 | Multi-Surface | Multi-surface layout returns one canvas object per surface with correct pixel dimensions |
| AC-03 | Canvas Editor — Load | Editor renders the correct layout within 3 seconds on a standard modern browser on a mid-range machine |
| AC-04 | Canvas Editor — Export | Print export PNG matches canvas visual at 300 DPI with correct bleed margin |
| AC-05 | Authentication | Requests without a valid API key or PIA token are rejected with `HTTP 401` |
| AC-06 | Rate Limiting | More than 100 requests in 60 seconds from the same IP returns `HTTP 429` with `retry_after` |
| AC-07 | Embed — Token Flow | iframe embed using a valid session token renders the canvas editor without exposing the real API key in the browser |
| AC-08 | Embed — Expiry | Requests with an expired embed token (> 2 hours old) return `HTTP 401` or `HTTP 403` |
| AC-09 | Path Traversal | `GET /api/exports/../../../etc/passwd` returns `HTTP 400` or `HTTP 403` |
| AC-10 | Audit Log | Every API call creates a corresponding `APIRequest` row in the database |
| AC-11 | Concurrency | Server handles 5 concurrent layout generation requests without timeout errors |
| AC-12 | Rate Limit — Cross-Worker | Rate limit is correctly enforced across all Gunicorn workers when using a shared cache backend |
| AC-13 | Bleed Accuracy | Polaroid layout (retro_polaroid_4.2x3.5) renders frame hole at 90% × 73.1% of canvas; white polaroid border visible at bottom |
| AC-14 | Caching | `GET /api/layouts` response includes `Cache-Control: private, max-age=300` header |

---

## 13. Future Roadmap

### Phase 1 — Stability & Production Readiness (0–2 months)

| Priority | Feature | Notes |
|---|---|---|
| P0 | Migrate file storage to S3 / GCS | Unblocks multi-instance deployment |
| P0 | Add Celery + Redis for async image generation queue | Fixes G4; workers no longer block on PIL |
| P0 | Canvas state auto-save (localStorage or backend JSON) | Fixes G1 |
| P1 | Swap `CACHES` to `django-redis` | Fixes G3 cross-worker rate limiting |
| P1 | Add Sentry / Datadog error tracking | Fixes O2 |
| P1 | Add structured JSON logging | Fixes O1 |
| P1 | CI pipeline with automated tests | Fixes O3 |
| P1 | Upgrade NextAuth to stable release | Fixes T2 |

### Phase 2 — Editor Enhancements (1–3 months)

| Priority | Feature |
|---|---|
| P0 | **Save & Resume** — persist canvas JSON to backend; users can save draft layouts |
| P0 | **Layout versioning** — version history for saved layouts |
| P1 | **Image crop tool** — crop/resize uploaded images directly in canvas |
| P1 | **Image upload from within canvas editor** — allow mid-edit image replacement |
| P1 | **EXIF auto-rotation fix** — normalise image orientation on upload |
| P1 | **Font management improvements** — upload custom fonts, validate rendering |
| P2 | **Multi-surface side-by-side preview** |
| P2 | **Export history** — list and re-download previous exports |
| P2 | **Keyboard shortcuts** — Cmd+Z, Cmd+S, arrow nudge |

### Phase 3 — Platform Expansion (2–6 months)

| Priority | Feature |
|---|---|
| P0 | **PDF export** — CMYK PDF generation for print pipelines |
| P0 | **Template library** — save custom designs as reusable templates |
| P1 | **Admin dashboard** — web UI for API key management, audit logs, usage analytics |
| P1 | **User workspace** — per-user saved layouts, designs, and exports |
| P1 | **Bulk layout generation** — batch generation for multiple SKUs |
| P2 | **Webhook support** — notify external systems when an export completes |
| P2 | **Layout approval workflow** — draft → review → approved states |

### Phase 4 — AI-Assisted Features (4–9 months)

| Priority | Feature |
|---|---|
| P1 | **Background removal** — AI-based, as a dedicated microservice |
| P1 | **Auto-layout suggestion** — best-fit layout based on image count and aspect ratios |
| P2 | **Smart image cropping** — face/subject detection for auto-centering |
| P2 | **Text style suggestions** — context-aware font/colour pairing |
| P3 | **One-click product mockup generation** — photorealistic renders from flat artwork |

### Phase 5 — Integration & Ecosystem (6–12 months)

| Priority | Feature |
|---|---|
| P1 | **OMS integration** — auto-trigger layout generation from order data |
| P1 | **SKU-to-layout mapping** — product catalogue maps specific SKUs to layouts |
| P2 | **Public API v2** — documented, versioned, rate-limited for external partners |
| P2 | **Multi-tenant workspace isolation** — separate namespaces per partner / brand |
| P3 | **White-label embed** — customisable branding for embedded editor instances |

---

## 14. Glossary

| Term | Definition |
|---|---|
| Layout | A JSON template defining a canvas size and set of named frames |
| Frame | A positioned region within a layout where an image is placed |
| Surface | A distinct face of a physical product (e.g., front, back, flap); a product can have multiple surfaces |
| Bleed | Extra margin beyond the safe print area to account for cutting tolerances |
| Fit Mode | How an image fills a frame — `contain` (letterbox) or `cover` (center crop) |
| Mask | A grayscale image applied over a frame to produce shaped crops (e.g., circular polaroid) |
| Embed Session | A short-lived UUID token for safely embedding the editor in an iframe without exposing the real API key |
| PIA | Printo Internal Auth — the internal identity provider used for staff authentication |
| DPI | Dots Per Inch — resolution metadata injected into exported PNGs via the `pHYs` chunk |
| OMS | Order Management System — Printo's internal order processing and fulfilment platform |
| gthread | Gunicorn worker class: synchronous worker with OS thread pool — suitable for mixed CPU/IO workloads |

---

## 15. Sign-Off

| Stakeholder | Role | Specific Sign-Off Responsibility | Status |
|---|---|---|---|
| Engineering Lead | Owner | Architecture, API design, technical requirements, scope decisions | Pending |
| Ops / Design Team Lead | User Representative | Functional requirements, editor UX, export quality, bleed accuracy | Pending |
| Internal Engineering Lead | Integration Owner | API contract, OMS integration requirements, batch generation load estimates | Pending |
| DevOps Lead | Infrastructure Owner | Deployment, scaling, storage, Redis / Celery provisioning | Pending |
| External Partner Representative | Embed Consumer | Embed flow, token TTL, postMessage API contract | Pending |
| Security Lead | Security Reviewer | Auth model, rate limiting, path traversal protection, token revocation | Pending |

---

*This is a living document. Update sections as features ship, decisions are made, or priorities change. Version the document when a new phase begins.*
