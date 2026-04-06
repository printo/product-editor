# AI Project Context — Product Editor

Business logic and operational context for AI agents working on this codebase.

---

## Purpose

The Product Editor is Printo's internal print-automation platform. Customers upload images via an embedded canvas editor. Post-checkout, the system renders high-resolution print files asynchronously and pushes them directly to the production estimator (OMS) — replacing the manual preflight team entirely.

**Target**: under 5 minutes from file upload to production-ready output, fully automated, zero human intervention. Current manual process takes 1–3 hours per order.

---

## Key Concepts

### Layouts

A layout is a JSON template in `storage/layouts/` defining one or more "frames" where customer photos are placed. It specifies canvas dimensions in mm and pixels at the target DPI (usually 300). Layouts are identified by a `name` slug (e.g., `CIRCLE_48MM`) used in the URL and API.

### Multi-Surface Products

Some products (e.g., folded cards) have multiple surfaces. The editor allows customers to switch between surfaces and place different photos on each.

### Embed Flow (EmbedSession)

The editor runs as an iframe embed inside printo.in and inkmonk.com product pages. The host page authenticates with a real API key and exchanges it for a short-lived `EmbedSession` token. The token is the only credential exposed to the browser — the real API key never touches the client. Session tokens are scoped to a single embed interaction.

### Quantity Enforcement

The `?qty=N` URL parameter drives the required image count for an order. The editor enforces this at upload time:

- **Under-upload**: empty frames are shown visually; the customer is prompted to auto-fill (cycle existing images to fill remaining slots) or pick-to-fill (select which image fills each empty frame).
- **Over-upload**: a confirmation modal appears; the customer can proceed with the extras or trim back to the required count.

No preflight operator is involved. The customer self-validates quantity before checkout.

### CMYK Colour-Space Detection

When a customer uploads an image, the editor checks the ICC profile. If the file is RGB (not CMYK), a warning is shown before checkout so the customer can re-export from their design tool. A server-side CMYK soft-proof pipeline (ISOcoated_v2 ICC profile) is available for colour-accurate press output — this outputs three files: PNG + TIFF CMYK + preview PNG.

### Async Render Queue

Post-checkout, canvas data (images + layout + overlays) is sent to `POST /api/layout/generate` with an `order_id`. The API immediately returns `202 Accepted` with a `job_id`. Rendering happens in a dedicated Celery worker pool in the background.

Two dedicated worker services prevent priority starvation:
- **`celery-worker-priority`**: serves express delivery and store pickup orders (soft-proof / `soft_proof=true` requests). Never touches the standard queue.
- **`celery-worker-standard`**: serves regular PNG/TIFF exports. Horizontally scalable via `--scale celery-worker-standard=N`.

Worker concurrency is fixed at 2 per container (512 MB limit → ~256 MB per task slot — safe for large-image Pillow renders).

The render task (`render_canvas_task`) retries up to 3× with exponential backoff (2 s, 4 s, 8 s). `MemoryError` and `SoftTimeLimitExceeded` skip retries and fail the job immediately.

After successful render, `push_to_production_estimator_task` fires as a separate Celery task (never blocks the render worker slot). It notifies the OMS and fires the per-request `callback_url` on success. It retries up to 5× independently; on final failure it sets `CanvasData.requires_manual_review = True`.

Status is polled via `GET /api/render-status/{job_id}/` with Redis caching (3 s TTL for `queued`, 10 s for `processing`, 300 s for terminal states). The response includes an estimated wait time corrected for worker concurrency.

### Export Flow (Full End-to-End)

1. Customer opens editor embed on printo.in or inkmonk.com.
2. Real API key exchanged for short-lived `EmbedSession` token.
3. Customer uploads images → qty enforcement and CMYK warning applied.
4. Canvas preview rendered client-side with Fabric.js; frame outlines visible in editor, absent in export.
5. Customer approves and checks out → `POST /api/layout/generate` with `order_id`.
6. Django upserts `CanvasData` (via `update_or_create`), creates `RenderJob`, enqueues task via `on_commit`.
7. Worker renders PNG or CMYK TIFF → writes to `EXPORTS_DIR`.
8. `push_to_production_estimator_task` fires → OMS notified → `callback_url` called.
9. Caller polls `GET /api/render-status/{job_id}/` or receives webhook.

### Sync Mode (Backward Compatible)

Requests without `order_id` run synchronously — the API blocks until rendering completes and returns the output file path directly. This exists for backward compatibility. Async mode (with `order_id`) is the recommended path for all production traffic.

---

## User Personas

- **External Customers**: Use the editor via iframe embed to design personalised products before checkout.
- **Internal Ops Team**: Monitor queue health, manage API keys, review manually-flagged orders in Django Admin. Use the `/api/celery/monitor/` endpoint (requires `is_ops_team` API key flag).
- **Catalog Manager**: Manages SKU-to-layout mappings (partially manual today; B3 gap in PRD).

---

## Design Aesthetic (Frontend)

- Glassmorphism (blur, transparency).
- Vibrant gradients (violet, fuchsia, cyan).
- Bold typography and uppercase labels.
- Rounded corners (2xl, 3xl).
- `lucide-react` for icons; `tailwind-merge` / `clsx` for conditional styling.

---

## Current Implementation Status (April 2026)

| Feature | Status |
|---|---|
| Customer-facing canvas editor (embed) | ✅ Live |
| Qty enforcement (under/over-upload) | ✅ Live |
| CMYK colour-space warning | ✅ Live |
| Async render queue (Celery + Redis) | ✅ Live |
| Priority / standard worker isolation | ✅ Live |
| OMS push + callback_url webhook | ✅ Live |
| Canvas state persistence (post-refresh) | ❌ B1 gap — P0, blocks direct-to-production for refreshed sessions |
| SKU-to-layout auto-mapping | ❌ B3 gap — P1, currently manual |
