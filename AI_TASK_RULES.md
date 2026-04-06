# AI Task Rules — Product Editor

Guidelines for approaching common engineering tasks in this project.

---

## Adding a New Layout Property

1. Update `types.ts` in the frontend.
2. Update the `renderCanvas` logic in `fabric-renderer.ts`.
3. Update the server-side `LayoutEngine` in `engine.py` to support the new property during high-res export.
4. Ensure the layout management view in `views.py` persists the new property correctly.

---

## Modifying UI Components

1. Maintain the glassmorphism style (blur, transparency, vibrant gradients).
2. Use `lucide-react` for icons.
3. Use `clsx` or `tailwind-merge` for conditional styling.
4. Test interactions (drag-and-drop, zoom, rotation) to ensure they feel fluid.
5. When editing JSX template literals in `className`, verify every `` className={`...`} `` has a matching closing backtick — a missing `` ` `` triggers ~17 cascade TypeScript errors downstream.

---

## Debugging Rendering Issues

1. Check DPI settings in the layout JSON.
2. Verify coordinate systems — Fabric.js uses pixels; layouts specify mm. Confirm conversion is applied consistently.
3. Inspect `fabric-renderer.ts` for off-screen rendering bugs.
4. Verify Pillow's `Resampling.LANCZOS` is used for high-quality scaling on the server.
5. Check the `isExport` flag — frame outlines and preview overlays must be absent in download output. If they appear in the exported file, the flag is not being passed correctly to `FabricEditor.tsx` or `fabric-renderer.ts`.

---

## Debugging Async Task Issues

### Job stuck in `queued` (never transitions to `processing`)

1. Check that both worker services are running: `docker-compose ps celery-worker-priority celery-worker-standard`.
2. Check Redis is reachable from the worker: `docker-compose exec celery-worker-standard python -c "import redis; r=redis.Redis(host='redis', port=6379); print(r.ping())"`.
3. Verify the task was actually enqueued — if Redis was down at `on_commit` dispatch time, the job is set to `failed` immediately (not stuck in `queued`). Check `RenderJob.error_message`.
4. Check whether the job is on the `priority` or `standard` queue — a `priority` job will never be picked up by `celery-worker-standard` and vice versa.

### Job fails immediately (no retries)

1. Check `RenderJob.error_message` for the exception type.
2. If it is `MemoryError` or `SoftTimeLimitExceeded`, this is expected — these skip retries by design.
3. If it is a dispatch error (`"Failed to dispatch task to Celery: ..."`), Redis was unreachable at `on_commit` time.

### Retry counter out of sync

- If `RenderJob.retry_count` and Celery's retry counter diverge, someone may have added `autoretry_for` to a task that already uses `self.retry()`. Remove one. This codebase uses `self.retry()` exclusively.

### OMS push not firing

1. Confirm `render_canvas_task` completed successfully (status = `completed`).
2. Confirm `push_to_production_estimator_task` was dispatched — look for `apply_async` call at the end of the render task.
3. Check `CanvasData.requires_manual_review` — if `True`, the push failed 5 times and the order needs manual intervention.
4. Check whether `callback_url` is set on `CanvasData` — the push task reads it from the DB, not from task arguments.

### Worker exits immediately on startup

1. Check logs: `docker-compose logs celery-worker-standard --tail=50`.
2. Common causes: Redis unreachable, missing migrations (run `migrate` on the `backend` service, not on the worker), import error in `tasks.py`.
3. Verify `entrypoint.sh` is branching correctly — the worker branch must exit before the migration block.

---

## Adding a New Celery Task

1. Define the task in `backend/django/api/tasks.py` using `@shared_task(bind=True, ...)`.
2. Use `self.retry(exc=exc, countdown=delay)` for retries. Do not add `autoretry_for`.
3. Handle `MemoryError` and `SoftTimeLimitExceeded` explicitly — fail immediately, no retry.
4. Add an explicit route in `backend/django/product_editor/celery.py` under `task_routes`.
5. Never dispatch the task directly inside a DB transaction — always use `transaction.on_commit(lambda: task.apply_async(...))`.

---

## Adding a New API Endpoint

1. Add the view to `backend/django/api/views.py`.
2. Require `IsAuthenticatedWithAPIKey` permission. Add `is_ops_team` check for internal endpoints.
3. Register the URL in `urls.py`.
4. Document the endpoint in `README.md`.

---

## Running Migrations

Migrations run only via the `backend` (Gunicorn) container. Never trigger `migrate` from a worker or beat container.

```bash
# Apply migrations
docker-compose exec backend python manage.py migrate

# Verify
docker-compose exec backend python manage.py showmigrations
```

Current latest migration: `0007_canvasdata_callback_url`.

---

## Security Updates

1. Prioritize path traversal protection in any file-handling logic.
2. Ensure API keys are never exposed in the URL — use the `EmbedSession` token system.
3. Validate all user-provided data (dimensions, colors, text, file types, file sizes) before processing.
4. New file-serving endpoints must include path safety checks before opening any file path derived from request input.
