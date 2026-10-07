# Plan: split `api/views.py` and the editor `page.tsx`

**Status:** 🟡 In progress — Part 1 done (2026-10-07); Part 2 safety nets (0a, 0b), the download-link fix, Phase A and its follow-up, and Phase B1 and its accessibility follow-ups (roles, focus, Escape, card keys) merged; Part 1's follow-ups merged (including the order-purge fix); Phase B2, its accessibility follow-up (the print-sheet window), the top-bar layering fix and the toolbar-pinning fix merged; Phases B3, B4, C1 and C2 merged; Phase C3 in review. Started 2026-10-06.
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
- **Found during Part 1, fixed in its follow-up PR (2026-10-07):** the three
  identical `_is_safe_layout_name` methods are one `is_safe_layout_name` in
  `views/_common.py`. The two `_is_path_safe` methods were not duplicates: the
  one on `GetLayoutView` was dead and is gone, and the export download's
  backstop check (`_is_full_path_safe`) now compares paths properly instead of
  with `startswith` (which also accepted a sibling like `exports_old/`). The
  500 MP Pillow ceiling is set at startup in `api/apps.py` instead of arriving
  through `api/views/__init__.py` importing `layout_engine.engine` for its side
  effect.

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
- **0b — Playwright smoke suite** (`frontend/nextjs/e2e/`, `pnpm e2e`): 14
  tests in the installed Chrome against the local stack and a production build —
  the same journeys through the real UI, plus what Jest can't run: a fake
  storefront page receiving `pe:back` / `pe:render_job`, the enforced
  `frame-ancestors` policy, a real server render downloaded as a ZIP,
  imposition, the canvas editor, real image decoding (HEIC included) and a
  phone profile. Local only; GitHub Actions is billing-locked. See
  `frontend/nextjs/e2e/README.md`.
- **Download-link fix** (separate small PR, after 0b): three download helpers
  (`handleQuickDownload`, the dashboard ZIP hand-off in `executeServerRender`,
  and `downloadBlob` in `lib/zip-utils.ts`, which imposition uses) attached a
  temporary `<a>` to `document.body`; all three now click a detached `<a>`,
  which every current browser can download from. Decided 2026-10-07; the
  third was found while making the change and included.

### The split PRs

| # | Moves out | New files | ~Lines | Risk | Extra check |
|---|---|---|---|---|---|
| A | Helpers above the component (`shouldAutoRotate90`, `resolveRotation`, `formatWait`, `formatLayoutDisplayName`, card-count hints, constants) and the 5 small components | `editor-utils.ts` (+ unit tests), `EditorNotices.tsx`, `EmbedSubmittedOverlay.tsx` | 435 | Low | New tests pin the auto-rotate rule |
| B1 | Dialogs: delete, re-pick, over-quantity, truncated, book-overflow, auto-fill picker, download options, embed disclaimer | `dialogs/*.tsx` | 440 | Low | Render test per dialog |
| B2 | Imposition as a unit: 9 state/refs, 5 memos, effects 33–37, `executeImposition`, the modal | `useImposition.ts`, `ImpositionModal.tsx` | 570 | Low–med | Imposition sheet in Playwright |
| B3 | Chrome: banners, processing/HEIC overlays, toolbar, sticky-toolbar + header effects (6–8), beforeunload (26), Escape (25; since the B2 follow-up it sits after the `useImposition` call, whose state it reads) | `EditorToolbar.tsx`, `EditorBanners.tsx`, `ProcessingOverlay.tsx`, `useStickyToolbar.ts` | 420 | Low | Header on phone and desktop |
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
| Part 2 · 0a | Jest characterization suite; detailed Part 2 plan | ✅ Merged (#193) |
| Part 2 · 0b | Playwright smoke suite (`frontend/nextjs/e2e/`, 14 tests) | ✅ Merged (#194) |
| Part 2 · fix | Detached download links | ✅ Merged (#195), deployed 2026-10-07 |
| Part 2 · A | Helpers and constants → `editor-utils.ts`; pre-submit notices → `EditorNotices.tsx`; `EmbedSubmittedOverlay.tsx` | ✅ Merged (#196), deployed 2026-10-07 |
| Part 2 · A follow-up | Found in A: the missing space in the "side has no photo" notice; stale auto-rotate and display-name comments | ✅ Merged (#197), deployed 2026-10-07 |
| Part 2 · B1 | The eight dialogs → `dialogs/*.tsx` | ✅ Merged (#198), deployed 2026-10-07 |
| Part 2 · B1 follow-up | Accessibility: dialog roles, names and descriptions on five dialogs; labels on two Close buttons | ✅ Merged (#199), deployed 2026-10-07 |
| Part 2 · B1 follow-up 2 | Dialogs take keyboard focus (in on open, Tab kept inside, back on close); Escape closes all eight. Adds two Escape scenarios to the characterization suite (17 → 19) and two e2e tests (14 → 16) | ✅ Merged (#200), deployed 2026-10-07 |
| Part 2 · B1 follow-up 3 | A card's own buttons (Remove Photo, Rotate, …) work from the keyboard: Enter/Space on them no longer opens the editor. Adds two characterization scenarios (19 → 21) | ✅ Merged (#201), deployed 2026-10-07 |
| Part 1 · follow-up | One shared layout-name guard (`views/_common.py`); dead path check removed; export backstop compares paths properly; the 500 MP Pillow ceiling set at startup instead of by a side-effect import | ✅ Merged (#202), deployed 2026-10-07 |
| Part 1 · follow-up 2 | Found while testing #202: the order purge erases upload-only orders, a key-scoped purge no longer touches another key's uploads, and `matched` counts everything found | ✅ Merged (#203), deployed 2026-10-07 |
| Part 2 · B2 | Imposition → `useImposition.ts` (state, refs, memos, effects 33–37, `executeImposition`) + `ImpositionModal.tsx` | ✅ Merged (#204), deployed 2026-10-07 |
| Part 2 · B2 follow-up | Accessibility for the print-sheet (imposition) window: a dialog role and name, a labelled Close button, focus (opens on Close, Tab kept inside, back on close), and Escape closes it. Its number fields are named and its sheet-size and orientation buttons say which one is chosen. The page's Escape handler moves below the `useImposition` call, which it reads. Adds one characterization scenario (21 → 22) and one e2e test (16 → 17) | ✅ Merged (#205), deployed 2026-10-07 |
| Part 2 · B2 follow-up 2 | The download options, embed disclaimer and print-sheet window move from `z-[100]` to `z-[2001]`, above the fixed top bar (`z-[2000]`), so it is dimmed and unclickable while they are open. Adds one e2e test (17 → 18) | ✅ Merged (#206), deployed 2026-10-07 |
| Part 2 · B3 prerequisite | Found starting B3: the toolbar never pinned when scrolled — not in the embed iframe, and on the dashboard it slid under the top bar. The pinning observer was set up once, before the toolbar existed (it renders only after the layout loads), through a plain ref that nothing re-ran. The sentinel is now held in state through a callback ref. Adds one characterization scenario (22 → 23) and two e2e tests, desktop and phone (18 → 20) — the B3 extra check | ✅ Merged (#207), deployed 2026-10-07 |
| Part 2 · B3 | Chrome → `useStickyToolbar.ts` (effects 6–7), `EditorToolbar.tsx` (the toolbar, plus `useDashboardHeader`: effect 8), `EditorBanners.tsx` (floating warnings, under-quantity banner, error message), `ProcessingOverlay.tsx` (progress and HEIC cards). The beforeunload guard (26) and the Escape handler (25) stay in the page: they read state that C6–C8 move into their own hooks, so moving them now would only mean moving them again | ✅ Merged (#208), deployed 2026-10-07 |
| Part 2 · B4 | Main content → `CanvasGrid.tsx`, `CanvasCard.tsx` (`SurfaceCard`, `CanvasCard`), `EmptyState.tsx`, `BookSpreadPreview.tsx` (`BookPageCount`, `BookSpreadPreview`), `CalendarSection.tsx`. Markup only: the card handlers stay in the page until C4. Extra check: a new e2e test drags one card onto another and checks the photos swap in the autosave (20 → 21); tap-to-swap was already covered. Pan has no check: the reposition toggle is hidden, so pan can't be switched on | ✅ Merged (#209), deployed 2026-10-07 |
| Part 2 · C1 | Setup and loading → `useEditorEnvironment.ts` (+ `useLoginRedirect`), `useLayoutLoader.ts` (+ `useActiveSurfaceLayout`), `useSubmitGuards.ts`. The state stays in the page (the layout is read near the top of the component, before these effects run); the hooks hold the effects and get the setters. The login redirect and the active-side layout sync are their own small hooks, called where those effects sat, so effect order is unchanged. Two deviations: `duplicateFills` and `intentionalDupesRef` stay in the page (the memo reads the ref during render, which the React Compiler lint rejects outside `page.tsx`; they move with C6, which writes the ref), and the active-side sync lists `setLayout` as a dependency (a stable setter; required now that it is a parameter). Extra check: a unit test pins `setOrderId` before `setLayout`, and delaying the adoption by one render fails 6 characterization scenarios | ✅ Merged (#210), deployed 2026-10-07 |
| Part 2 · C2 | Calendar → `useCalendarEditor.ts`: `useCalendarEditor` (the calendar state, `printedHolidays`, the per-day helpers and the day-photo upload; called where the state was declared) and `useCalendarDefaults` (effect 28: layout defaults, Gen-Z palettes, holidays; called where it ran). The day-photo callback lists its three setters as dependencies (stable, now parameters). Extra check: the holiday-years rule (`resolveDefaultYear` for both calendar types, plus the next year) and the `holidayLocale` gate are pinned by unit tests; dropping the gate fails a characterization scenario; the calendar e2e test passes | ✅ Merged (#211), deployed 2026-10-07 |
| Part 2 · C3 | Book → `useBookPages.ts`: page count, held-back pages and their ref mirror (the only effect, still first in its place), the overflow prompt state and its decided-ref, `handleBookPageCountChange`, the spread and spine memos; called where the book state was declared. `handleBookOverflowDecision` stays in the page: it calls `processSelectedFiles`, which is declared later (moves with C6). Values that now come from the hook are listed as dependencies where the page uses them (`bookHiddenPagesRef` in `reclaimUnusedFiles` and `scheduleAutosave`, `setPendingBookOverflow` in the Escape handler) and in the hook (`surfaceStatesRef`, `setSurfaceStates`); all stable. Extra check: ignoring the requested count fails the characterization page-count scenario | 🟡 In review |
| Part 2 · C4–C8 | The other 5 split PRs | Not started |
