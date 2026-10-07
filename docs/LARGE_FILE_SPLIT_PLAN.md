# Plan: split `api/views.py` and the editor `page.tsx`

**Status:** 🟡 In progress — Part 1 done (2026-10-07); Part 2 Phase 0a in review. Started 2026-10-06.
Update the progress table at the bottom as each PR merges.

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
- **Found, not fixed (follow-up PRs):** `_is_safe_layout_name` exists as a
  method on three classes and `_is_path_safe` on two. And the web process's
  500 MP Pillow pixel cap depends on `api/views/__init__.py` importing
  `layout_engine.engine` purely for its import-time side effect (kept, with a
  comment); setting `Image.MAX_IMAGE_PIXELS` explicitly where uploads are
  validated would remove that hidden coupling.

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

## Part 2 — `page.tsx` (13 split PRs after a safety net, riskiest last)

**What is being split (2026-10-07, `main` @ `ed88707`):** 5,558 lines. The one
component, `LayoutEditorPage`, is lines 437–5558: 68 `useState`, 42 `useRef`,
37 effects (36 `useEffect` + 1 `useLayoutEffect`), 14 `useMemo`, 14
`useCallback`, 34 plain handler functions, and a 1,741-line JSX return. Above it
are ~435 lines of helpers and five small components.

### Safety net first (Phase 0)

- **0a — Jest characterization suite** (`editor/layout/[name]/__tests__/page.characterization.test.tsx`
  + `editor-page-harness.tsx`). Renders the whole page under Jest/happy-dom with
  the canvas library, image decoding, orientation, HEIC/PDF, auth and routing
  stubbed, against a `FakeBackend` that records every request in order and can
  hold a response back. 17 scenarios: embed load + order-id adoption,
  Add-Files-appends, autosave (after the restore GET, no `data:` previews), slow
  restore never overwritten (plain photos, and the calendar layout-defaults path),
  over-quantity hold + "Keep first N", under-quantity warning, remove photo,
  quick rotate, tap-to-swap, embed Save & Continue (uploads → render with real
  upload ids and the real surface key → `pe:render_job` to the parent origin,
  never `'*'`), dashboard proxy + login redirect + Download (render → poll → ZIP
  link click), calendar holidays only when printed, book page count.
  **Every key test was proven able to fail** by breaking the rule it guards in
  `page.tsx` and re-running it (8 deliberate breaks, all caught). One finding
  from that: the photo path has two independent restore guards, but the
  calendar/book autosave triggers rely on `scheduleAutosave`'s guard alone.
- **0b — Playwright smoke suite** (local, real browser, against the local
  stack): the same journeys end to end through the real UI, plus what Jest
  can't run — imposition (canvas), the editor modal, real image decoding, a
  phone viewport. Local only; GitHub Actions is billing-locked.
- **Download-link fix** (separate small PR, after 0b): the two download helpers
  (`handleQuickDownload`, and the dashboard ZIP hand-off in
  `executeServerRender`) attach a temporary `<a>` to `document.body`; switch both
  to a detached `<a>`, which every current browser can download from. Decided
  2026-10-07.

### The split PRs

| # | Moves out | New files | ~Lines | Risk | Extra check |
|---|---|---|---|---|---|
| A | Helpers above the component (`shouldAutoRotate90`, `resolveRotation`, `formatWait`, `formatLayoutDisplayName`, card-count hints, constants) and the 5 small components | `editor-utils.ts` (+ unit tests), `EditorNotices.tsx`, `EmbedSubmittedOverlay.tsx` | 435 | Low | New tests pin the auto-rotate rule |
| B1 | Dialogs: delete, re-pick, over-quantity, truncated, book-overflow, auto-fill picker, download options, embed disclaimer | `dialogs/*.tsx` | 440 | Low | Render test per dialog |
| B2 | Imposition as a unit: 9 state/refs, 5 memos, effects 33–37, `executeImposition`, the modal | `useImposition.ts`, `ImpositionModal.tsx` | 570 | Low–med | Imposition sheet in Playwright |
| B3 | Chrome: banners, processing/HEIC overlays, toolbar, sticky-toolbar + header effects (6–8), beforeunload (26), Escape (25) | `EditorToolbar.tsx`, `EditorBanners.tsx`, `ProcessingOverlay.tsx`, `useStickyToolbar.ts` | 420 | Low | Header on phone and desktop |
| B4 | Main content: card grid + cards + empty state, book spread preview + page count, calendar section | `CanvasGrid.tsx`, `CanvasCard.tsx`, `EmptyState.tsx`, `BookSpreadPreview.tsx`, `CalendarSection.tsx` | 600 | Medium | Swap/drag/pan on cards |
| C1 | Environment (token, parent origin, qty, order id + URL sync (1), login redirect (9)); layout loading (11, 15) + fonts (10); low-DPI (27) and submit-guard memos | `useEditorEnvironment.ts`, `useLayoutLoader.ts`, `useSubmitGuards.ts` | 300 | Medium | Order id adopted before the layout is set (embed) |
| C2 | Calendar state, defaults/holidays (28), cell edit + image upload | `useCalendarEditor.ts` | 250 | Medium | `printedHolidayLocale` / `resolveDefaultYear` rules; calendar test layout |
| C3 | Book page count, hidden pages, spreads, overflow decision | `useBookPages.ts` | 180 | Medium | Book page-count scenario |
| C4 | Card actions: quick rotate/fit/blur/background/delete/download, pan gesture, tap-to-swap, drag/drop | `useCardActions.ts`, `usePanGesture.ts` | 450 | Med–high | Touch/pan in a phone viewport |
| C5 | Canvas generation: `generateCanvases*`, `renderCanvas`, object-URL cache (12), fit/blur recompute (29–31) | `useCanvasGeneration.ts` | 420 | High | Crops and rotations identical |
| C6 | File intake: file change/drop/replace/re-pick/auto-fill/over-/under-qty/HEIC/PDF | `useFileIntake.ts` | 400 | High | Append-not-replace; over-qty hard cap; "Choose again" reopens the picker |
| C7 | Render & submit: `executeServerRender`, `executeBatchDownload`, `handleSubmitDesign`, download/disclaimer/submitted state | `useServerRender.ts` | 450 | High | Render payload and parent-origin rule (characterization) |
| C8 | Persistence: `serializeCanvasState`, `scheduleAutosave`/`cancelAutosave` + all three triggers (19, 20, canvases), restore (21), IndexedDB photo store (24), `reclaimUnusedFiles`, preview regeneration, card-count hint (22) | `useDesignPersistence.ts` | 600 | **Highest** | Both slow-restore scenarios, plus a fake-timer hook test that autosave waits for the restore |

Effect numbers refer to the order the effects appear in today's component.
End state: `page.tsx` ~500–800 lines wiring these together.

### Rules specific to splitting a component

- **Move, don't change** — same code, same dependency arrays; no new
  `eslint-disable`s. Bugs found along the way get their own PR.
- **Keep effect order.** Effects run in declaration order and some depend on it
  (e.g. the "latest value" ref mirrors). A hook is called where its first effect
  used to be.
- **One owner per ref.** A ref belongs to the hook that writes it; anything
  else receives it explicitly.
- **Tests come with logic.** Each hook PR adds focused `renderHook` tests where
  the logic allows; each component PR adds a render test.

### Proof for each frontend PR

1. `pnpm typecheck`, `pnpm lint`, all Jest tests — **the characterization suite
   must pass unchanged** — and `pnpm build`.
2. The Playwright smoke suite against the local stack.
3. The PR's extra check from the table.
Nothing is pushed until all three pass.

### Deploys

Each PR is deployed soon after it merges (decided 2026-10-07), so a regression
points at one PR; C4–C8 outside Indian business hours. Rollback is `git revert`
+ `./deploy.sh`.

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
| Part 1 · PR 2 | `layouts`, `layout_admin`, `calendar_assets` | ✅ Merged (#190) |
| Part 1 · PR 3 | `render`, `downloads`, `embed`, `uploads`; `__init__.py` reduced to re-exports | ✅ Merged (#191), deployed 2026-10-07 |
| Part 2 · 0a | Jest characterization suite; detailed Part 2 plan | 🟡 In review |
| Part 2 · 0b | Playwright smoke suite | Not started |
| Part 2 · fix | Detached download links | Not started |
| Part 2 · A–C8 | The 13 split PRs above | Not started |
