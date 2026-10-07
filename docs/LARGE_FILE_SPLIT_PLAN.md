# Plan: split `api/views.py` and the editor `page.tsx`

**Status:** 🟡 In progress — Part 1 PR 2 of 3. Started 2026-10-06. Update the
progress table at the bottom as each PR merges.

## Why

| | `frontend/nextjs/src/app/editor/layout/[name]/page.tsx` | `backend/django/api/views.py` |
|---|---|---|
| Size (2026-10-06) | 5,558 lines; one component (`LayoutEditorPage`) is ~5,100 of them, with 68 `useState`, 37 effects, 42 refs | 4,500 lines, 27 view classes |
| Commits, last 30 / 90 days | 22 / 63 | 17 / 47 |

Several sessions edit these two files at once, so they conflict; neither fits
in one read, so changes are made from partial views; and distant parts of
`page.tsx` interact in ways that are hard to see (the autosave-overwrite bug
fixed in PR #166 was one).

## Rules

1. **Move, don't change.** A split PR only relocates code. Bugs or duplicates
   found along the way get their own PR.
2. **Small PRs, merged quickly**, one at a time. Before starting one, check no
   open PR touches the same file (`gh pr list --state open --json files`).
3. **Proof every time** (below). Nothing is pushed until it passes locally.
4. **Docs move with the code** — CLAUDE.md and `docs/` references to a moved
   name are updated in the same PR.

## Part 1 — `api/views.py` → `api/views/` package (3 PRs)

`api/views/__init__.py` re-exports every view, so `urls.py`, management
commands and tests keep importing from `api.views` unchanged.

| Module | Contents | ~Lines | PR |
|---|---|---|---|
| `system.py` | `HealthView`, `ConfigView`, `CSPReportView` | 110 | 1 |
| `ops.py` | `CeleryMonitoringView` (+ `_jobs_per_day_status`, `_disk_status`), `OrderDataPurgeView` | 280 | 1 |
| `media.py` | `OrientationDetectView`, `HeicConvertView` | 235 | 1 |
| `layouts.py` | `ListLayoutsView`, `GetLayoutView`, `ExternalLayoutDetailView`, `MaskDownloadView`, `_read_layout_def`, `_summarize_layout` | 425 | 2 |
| `layout_admin.py` | `LayoutManagementView`, `invalidate_layout_caches` | 445 | 2 |
| `calendar_assets.py` | `FontsView`, `CalendarStylesView`, `HolidaysView` and their read/write helpers and cache keys | 640 | 2 |
| `render.py` | `GenerateLayoutView`, `EditorRenderView`, `RenderStatusView` | 700 | 3 |
| `downloads.py` | `RenderJobDownloadView`, `SecureExportDownloadView` | 425 | 3 |
| `embed.py` | `EmbedSessionView`, `EmbedSessionValidateView`, `EditorInitView`, `CanvasStateView` | 630 | 3 |
| `uploads.py` | `ChunkedUploadInitView`, `ChunkedUploadChunkView`, `ChunkedUploadCompleteView`, `_AnyContentTypeParser` | 425 | 3 |

Module-level constants shared across modules (`LAYOUT_ID_NOTE`,
`OPS_WRITE_AUTH`, `UUID_GUARD`, …) go to `views/_common.py`, which imports
nothing from the package — a submodule importing from `api.views` itself would
be circular.

**Traps:**
- **Patch where the view looks the name up.** `patch('api.views._write_holidays')`
  stops intercepting once the view lives in `api.views.calendar_assets` — the
  re-export is a second reference. Tests that patch moved names
  (`test_ops_write_routes.py`, `test_csp_report.py`) must target the submodule.
- **Log lines name the module.** The `verbose` formatter prints `{module}`, so
  lines read `system`/`ops`/`render` instead of `views` (and `__init__` for
  code not yet moved). The `api` logger config still covers them.
- **Found, not fixed (follow-up PR):** `_is_safe_layout_name` exists as a
  method on three classes and `_is_path_safe` on two.

**Proof for each backend PR** (from a worktree, with the PR's own image tags —
see "How to test" below):
1. OpenAPI schema generated from `main` and from the branch: **byte-identical**.
2. Every name importable from `api.views` on `main` still is, and the source
   of every view class/function is identical except for intended import lines.
3. URL patterns resolve to the same view classes.
4. All `services/tests/test_*.py` modules and `manage.py test api.tests`.
5. Before/after HTTP comparison of the moved endpoints against two live
   servers (one per image) on the same local database.
6. Smoke tests through nginx once render/embed/upload code moves (PR 3).

## Part 2 — `page.tsx` (~11 PRs, riskiest last)

| Phase | Moves out | ~Lines | Risk |
|---|---|---|---|
| 0 (optional) | Small local Playwright script for the core embed flow (open → add photos → edit → refresh restores → submit), run before/after each PR | — | — |
| A | Helpers above the component (`shouldAutoRotate90`, `resolveRotation`, `formatWait`, `formatLayoutDisplayName`, card-count hints) → `editor-utils.ts` with Jest tests; the 5 warning/overlay components | 435 | Low |
| B1 | Modals: download options, embed disclaimer, auto-fill picker, 5 confirm dialogs | 375 | Low |
| B2 | Imposition as a unit: its state, 2 effects, `executeImposition`, modal | 570 | Low–med |
| B3 | Banners, processing/HEIC overlays, toolbar | 365 | Low |
| B4 | Canvas grid + empty state, book spread preview + page count, calendar section | 590 | Medium |
| C1 | Layout loading, low-DPI check, fit/blur effects | 200 | Medium |
| C2 | Calendar editor state (keep `printedHolidayLocale` and `resolveDefaultYear` rules) | 250 | Medium |
| C3 | Book pages state | 200 | Medium |
| C4 | File intake: append-not-replace, qty over/under, HEIC, drop, replace | 400 | High |
| C5 | Server render + submit, polling, `postMessage` (real `surface_key`, never `'*'`) | 450 | High |
| C6 | Persistence: restore, `scheduleAutosave`, IndexedDB photos | 450 | Highest |

End state: `page.tsx` ~600–900 lines wiring hooks to components. C6 goes last
and alone; its acceptance test is the PR #166 reproduction — delay the restore
GET and confirm no `canvas-state` PUT is issued before it lands.

**Proof for each frontend PR:** `pnpm typecheck`, `pnpm lint`, Jest (plus new
tests for extracted logic), `pnpm build`, then a browser walk-through (embed
token and dashboard): add photos twice (appends), edit a frame, swap/delete,
qty over and under, refresh restores the design, Save & Continue, ZIP download,
the `test_verification_calendar` layout, imposition, an iPhone HEIC photo.

## How to test a backend split PR locally

Work in a worktree (`git worktree add <scratch>/wt <branch>`); other sessions
switch the shared checkout's branch. Build images with your own tags rather
than through `docker-compose`, which would rebuild the shared stack:

```bash
docker build -f backend/django/Dockerfile -t pe-split:before .   # in a worktree at main
docker build -f backend/django/Dockerfile -t pe-split:after .    # in the branch worktree
```

Run them on the stack's network (`--network product-editor_web`) with a copy of
`storage/` mounted writable at `/app/storage`. `docker run --env-file` does not
strip `.env`'s inline `# comments`, so pass a cleaned copy, and set
`SECURE_SSL_REDIRECT=False` for direct HTTP calls. Two servers (one per image,
different host ports) give the before/after HTTP comparison. Delete the images,
storage copies and cleaned env file afterwards.

## Progress

| PR | Scope | Status |
|---|---|---|
| Part 1 · PR 1 | Package conversion; `system`, `ops`, `media` | ✅ Merged (#189), deployed 2026-10-06 |
| Part 1 · PR 2 | `layouts`, `layout_admin`, `calendar_assets` | 🟡 In review |
| Part 1 · PR 3 | `render`, `downloads`, `embed`, `uploads` | Not started |
| Part 2 | Phases 0, A, B1–B4, C1–C6 | Not started |
