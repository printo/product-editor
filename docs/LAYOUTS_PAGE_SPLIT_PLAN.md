# Plan: splitting the ops layouts page

Status: **step 0 built** (2026-11-21): `editor/layouts/__tests__/page.characterization.test.tsx` + `layouts-page-harness.tsx`, 40 cases, about 7 s. Step 1 built (2026-11-21): `layout-form-utils.ts` + `__tests__/layout-form-utils.test.ts` (11 cases); `page.tsx` 2,193 → 1,951 lines. Steps 2 to 7 not started. Target: `frontend/nextjs/src/app/editor/layouts/page.tsx`, the ops layout list and layout editor at `/editor/layouts`.

## Why, and the rule for every step

The page is **2,193 lines** (CLAUDE.md still says ~1,930), one component `LayoutCreatorPage` with **45 `useState`s** and 11 effects, plus a small `MaskSlotRow` component and module helpers above it. It holds five jobs at once: the layout list, the create/edit/duplicate editor, the fonts picker, the delete and remove-mask prompts, and the JSON Specification viewer. It has **no test of its own** today (`editor/layouts/__tests__/` only tests `frame-align.ts`).

The model is the customer editor split (`src/app/editor/layout/[name]/`): a characterization suite first (`__tests__/page.characterization.test.tsx` + `editor-page-harness.tsx` with `FakeBackend`), then pieces moved out one at a time while that suite passes **unchanged**. Same rule here:

- **Step 0 lands first and alone.** Every later PR must pass it with no edit to the test file. If a step seems to need a test edit, the step changed behaviour: stop and look.
- **Moves, not fixes.** Quirks found while reading (listed under "Behaviour to pin, not fix") are pinned as they are. Fixing them is a separate PR after the split, each with its own test change.
- Each step also runs `pnpm typecheck`, `pnpm lint` (0 warnings) and the whole Jest suite.

## Step 0 — characterization test (first PR)

### Harness: `editor/layouts/__tests__/layouts-page-harness.tsx`

Copy the shape of `editor-page-harness.tsx`:

- **`FakeLayoutsBackend`**: a `fetch` stand-in that answers and records every request in order (method, path, parsed body; for `FormData` the field names, the parsed `layout` JSON, `name`, `display_name`, and each file's field name and file name). Routes the page calls, all under `/api/internal/proxy/`:
  - `GET ops/layouts` (list, `cache: 'no-store'`)
  - `GET ops/layouts/<name>` (detail, used by View, Edit, Duplicate)
  - `POST ops/layouts` (multipart save, create and update alike)
  - `DELETE ops/layouts/<name>`
  - `GET fonts`, `PUT/POST fonts` (whatever method `saveFontsToBackend` uses; pin it)
  - `GET layout-tags` (through `useLayoutTags`)
  - Can hold a response back and fail one with a status and `detail`.
- **Fixtures:** a plain 4x6 single-surface layout with two frames and bleed; a `product` layout with `front`/`back` surfaces, one with a frame mask and `printSheet: {mode:'bleed'}`; a calendar and a book row (for the card links); a retired one (`isDeprecated`, `renamedTo`); a layout with only a legacy `grid` block and no frames; three tags.
- **Mocks** (as the customer suite does): `next/navigation` (`useRouter` returning **the same object every render**, a `push` spy), `next-auth/react` (`useSession` with switchable `status` and flags), `next/dynamic`→ a stub `LayoutFabricPreview` that records its last props and exposes `onFramesChange`/`onFrameSelect` to the test (Fabric does not run under happy-dom), `GoogleFontLinks`/`useGoogleFonts`, `@/lib/image-utils.hasTransparentPixels`, `@/lib/import-session.readImportSession`, `URL.createObjectURL`/`revokeObjectURL` spies, `window.confirm`, `window.scrollTo`/`scrollY`, `history.replaceState`. Render inside `HeaderProvider`, and read what the page put in the header (title, centre and right actions) from a small probe component, since the search box, tag filter and Fonts button live there.

### Cases (each pins **what is sent and when**, not markup)

**Loading and access**
1. Signed in: one `GET ops/layouts` with `no-store`; a `GET fonts`; cards render each layout's display name; the retired one hidden until "show deleted" is on.
2. Signed out, and `session.error === 'RefreshAccessTokenError'`: `router.push('/login')`, and no `ops/layouts` request.
3. Ops-tier gating as the page has it: Holidays / Tags / Templates links in the header only when `canManageTemplates` (`is_ops_team` or `is_staff`) is true; an Editor-tier session gets none of them but still sees the list and the editor (writes are refused upstream by the internal proxy, not by this page; a refused save shows the server's `detail`). Also: a session that becomes ops *after* first render gets the links (the effect's dependency on `canManageHolidays`).
4. Search filters by name and by tag text; the tag filter filters by **key**; filters only narrow, nothing refetches.

**Create**
5. Create (generic) → editor opens with blank defaults (4x6 in, 300 DPI, no frames, Whole canvas, no mask); header title "Create Layout"; submit button "Create Layout", disabled until a display name is typed.
6. An identifier with a space or symbol: error shown, **no POST**.
7. Grid generator 2×2 with 2 mm padding → save → `POST ops/layouts` multipart with `name`, `display_name` (trimmed), and `layout` JSON whose `canvas` px/mm, `frames` (mm and the 0–1 fractions including bleed), `tagKeys`, `frameCaptionsEnabled`, `orientationRotatable`, `printSheet {mode:'canvas'}`, `frameMaskUrl: null` are exactly the fixture's expected values. Then a list refetch, the editor closes, a success toast.
8. Out-of-bounds print area: `window.confirm` asked; "Cancel" sends nothing; "OK" sends the POST.
9. Save fails (400 with `detail`): the toast shows that `detail`, editor stays open, `isSaving` released.

**Edit**
10. Edit on a single-surface card → `GET ops/layouts/<name>` → fields filled (display name, mm sizes, frames, tags, Can rotate, captions, Print file mode, existing frame mask URL); title "Edit Layout"; button "Update Layout"; save POSTs with the **same identifier**.
11. Edit a layout with no `displayName`: the name falls back to the tidied identifier.
12. Edit a legacy `grid`-only layout: frames are generated from the grid.
13. Edit a `product` layout: surface tabs; switching tabs swaps the preview's props; the save sends `type:'product'` with per-surface `canvas`, `frames`, `frameMaskUrl`, `printSheet`, and each new mask file as `frame_mask_<key>`.
14. Adding a surface, then saving, sends it; the surface key is derived from its label.

**Duplicate, delete, view**
15. Duplicate → detail fetch → editor in **create** mode, identifier reset to `untitled_layout`, name `copy <display name>`, frames/mask URL/Print file/tags/Can rotate copied; save POSTs the new identifier.
16. Duplicate is disabled on a book card (no request); calendar and book cards link to `/editor/layouts/calendar/<name>` and `/book/<name>`, not to the generic editor.
17. Delete asks first; Cancel sends nothing; Confirm sends `DELETE ops/layouts/<name>` then a list refetch; a failed delete shows the server `detail` (or the fallback text when the body is not JSON).
18. View Raw JSON → detail fetch → the JSON Specification modal shows it; Copy writes it to the clipboard (mock `navigator.clipboard`) and shows "copied".

**Masks and Print file**
19. Pick a frame mask: the file goes as `frame_mask` (single) on save, `frameMaskUrl` stays the old URL until the server replaces it; `hasTransparentPixels` false → the warning text; true → none. Switching surface clears the warning.
20. Remove mask: the `alertdialog` asks; confirm clears the slot and the save sends `frameMaskUrl: null` and no file.
21. Print file box: Whole canvas ↔ Bleed area changes the preview's `printSheet` prop at once and the saved `printSheet.mode`; per surface on a product layout.
22. Can rotate unticked → `orientationRotatable: false` in the save.
23. Tags: `TagPicker` choice → `tagKeys` in the save, in order; a switched-off tag already on the layout is kept.

**Address and import hand-off**
24. `?edit=<name>` opens that layout's editor once authenticated, then the address is cleared with `history.replaceState` (one call, pathname only); an invalid name does nothing; a second render does not reopen it.
25. `?edit=<name>&import=1` with `readImportSession(name)` returning a session with `guideSvg`: the preview gets a `guide` prop with an object URL and the import's mm size; saving **pushes `/editor/layouts/templates?import=continue`** instead of closing and toasting. Without a stored session, `?import=1` behaves as a plain `?edit=`. The object URL is revoked on unmount.
26. Saving a *different* identifier while an import is pending does not hand off (the `importFor === layoutId` check).

(`?import=continue` itself is read by the Templates page's `ImportDesignDialog`, not this page; this page only produces it. Its reading stays covered by `ImportDesignDialog.test.tsx`.)

**Modal and scroll**
27. Scroll position: with `scrollY = 640`, open the editor, close it (Close Editor in the header, Cancel, and a successful save): `window.scrollTo(0, 640)` once each time; never on first render.
28. While open the header shows Close Editor and no search box; after close the search box returns with the same query.

**Fonts and units**
29. Fonts modal: ticking a font sends the new list once; the header count updates.
30. Unit toggle mm ↔ in: values typed in inches are stored and sent in mm; the choice is written to `localStorage` (`pe:layout-editor:unit`), and a throwing `localStorage` starts in mm.

**Preview wiring** (through the stubbed `LayoutFabricPreview`)
31. The stub calling `onFramesChange` with moved frames → the table shows the new mm values and the save sends them; `onFrameSelect` highlights the row; zoom buttons change the `zoom` prop within 0.1–3.

Expect about 30 tests, real timers, under 30 s.

### What building step 0 found (2026-11-21)

- **Create after Edit could overwrite the layout just edited. Fixed (`fix/layouts-create-resets-form`):** the Create card now calls `openCreateModal`, which also resets Can rotate. Two cases pin the fix.
- **Duplicate on a two-sided product throws** (`Cannot read properties of undefined (reading 'dpi')`) and the editor never opens. Confirmed, so not pinned: an uncaught error cannot be a passing test. Fix separately.
- **The Create/Update button is outside its form** (`form="layout-form"`). happy-dom does not submit through such a button, so the suite checks the button's `type` and `form` and submits the form itself. The click needs the browser check after step 6.
- Not covered: zoom buttons (no accessible names), caption controls, surface duplicate/remove, Grid Gen with non-default rows. Add cases before the step that moves them.

### Behaviour to pin, not fix (found while reading; raise with Kannan after the split)

- ~~Create does not reset Can rotate~~: fixed with the Create card above.
- **Duplicate does not reset layout type or surfaces**, and reads `data.canvas.dpi` without `?.`, so Duplicate on a `product` layout probably throws. The test should prove what really happens before anything is decided.
- The comment at the top of the component says the ops gate was removed from the internal proxy; CLAUDE.md (Role model) says writes under `ops/` need Ops. The comment is stale; fix it in the first move PR (comment only).
- Two frame-loading routines exist (`_loadFramesFromData` and an inline copy in `openCopyModal`); merging them is a follow-up, not part of a move.

## Step 1+ — the split

Target files beside `page.tsx` (no `template.ts`, `layout.ts`, `loading.ts`, `error.ts` or `route.ts` names: Next.js treats them as special files in a route folder and the route 500s):

| File | Owns | From lines (today) |
|---|---|---|
| `layout-form-utils.ts` | `LayoutFrame`, `LayoutConfig`, `SurfaceEditorState`, `PrintSheetState` types; `round2`, `mmToPx`, `pxToMm`, `_mapFrames`, `frameSlotFromData`, `printSheetStateFrom`, `printSheetJson`, `EMPTY_SLOT`, `WHOLE_CANVAS`, unit pref read/write, plus new pure `framesFromData`, `gridFrames`, `framesOutOfBounds`, `buildLayoutFormData(state)` | 64–198, parts of 644–800, 826–951 |
| `MaskSlotRow.tsx` | the mask pick/thumbnail/remove row | 200–278 |
| `useLayoutList.ts` | list fetch, loading, search, tag filter, show-deleted, the filtered list, `deleteLayout` | 291, 325–333, 608–642, 802–824, filter at ~1250 |
| `useOpsFonts.ts` | selected fonts, fetch, save, font modal state | 421–424, 509–557 |
| `useLayoutForm.ts` | all editor fields (identity, canvas, frames, surfaces, active surface, masks, print sheet, Can rotate, captions), the `active*` derived values and setters, `loadForEdit`, `loadForCopy`, `resetForCreate`, `updateFrame`, `centerFrame`, grid generator, `submit` | 317–388, 558–606, 644–800, 826–1110 |
| `useModalScrollRestore.ts` | `isModalOpen` + the scroll save/restore layout effect | 392–407 |
| `useEditFromAddress.ts` | `?edit=` / `?import=1` once-only read, `replaceState`, import guide object URL and its revoke, `importing` | 409–410, 954–974 |
| `useLayoutsHeader.ts` | the `setTitle`/`setCenterActions`/`setRightActions` effect (both states) | 429–507 |
| `LayoutCard.tsx`, `LayoutGrid.tsx`, `CreateLayoutCards.tsx` | the list markup and the three "create" cards | ~1120–1515 |
| `LayoutEditorModal.tsx` (+ `LayoutBasicsSection.tsx`, `SurfaceTabs.tsx`, `PrintAreasTable.tsx`, `PrintFileBox.tsx`, `PreviewPane.tsx`) | the full-screen editor | 1519–2045 |
| `dialogs/RemoveMaskDialog.tsx`, `dialogs/DeleteLayoutDialog.tsx`, `dialogs/LayoutSpecModal.tsx`, `dialogs/FontPickerModal.tsx` | the four prompts | 2046–2190 |

`page.tsx` should end around 250–350 lines: session and redirect, the hook calls in their current order, and composition.

### Order and PRs

Each row is one PR, each passing Step 0 unchanged. Effort is rough, for Claude's working time including checks; review time is Kannan's.

| # | PR | Risk | Effort |
|---|---|---|---|
| 0 | Characterization harness + ~30 cases (no app change) | low; the hardest part is a faithful fake | 1–1.5 days |
| 1 | `layout-form-utils.ts` (pure helpers and types) + unit tests of `buildLayoutFormData`, `framesFromData`, `framesOutOfBounds` | low | 0.5 day |
| 2 | The four dialogs and `MaskSlotRow` as components (props in, callbacks out) | low | 0.5 day |
| 3 | `useOpsFonts`, `useModalScrollRestore`, `useEditFromAddress` | medium: the once-only `?edit=` ref and effect order | 0.5 day |
| 4 | `useLayoutList` + `LayoutCard`/`LayoutGrid`/`CreateLayoutCards` | medium: card buttons can't be clicked by automation in a browser (see Risks) | 0.5–1 day |
| 5 | `useLayoutForm` (the big one: state, load, save) | **high**: most behaviour lives here | 1–1.5 days |
| 6 | `LayoutEditorModal` and its sections; `useLayoutsHeader` | medium: header snapshot dependencies | 1 day |
| 7 | Tidy: update CLAUDE.md's Frontend Structure (and the "Big files" line in What to Do Next), refresh the graph with `scripts/graphify-refresh.py` | low | 0.25 day |

Total about **5–6.5 days** of work across 8 PRs. Steps 1–2 and 3 can be reviewed in parallel; 4 and 5 should not overlap (both touch the shared state block); 6 waits on 5.

## Risks and what the test cannot see

- **Fabric preview is stubbed in Jest.** `LayoutFabricPreview.tsx` (759 lines) is not part of the split and its internals (drag clamp with bleed inset, live print-file outline `syncSheet`, mask layer cancel-on-change, import guide under everything) are not exercised by Step 0. Its props must stay identical, and the props object should not become a new object every render where it was stable before (e.g. `activePrintSheetJson` is `useMemo`d today; keep it). After steps 5 and 6, a **browser check** on a local stack: open, drag and resize a print area, nudge with arrows, switch Whole canvas/Bleed area, add and remove a mask, switch surfaces on a product layout, and confirm the outline follows live.
- **Layout-card buttons ignore synthetic clicks** in the automated browser (CLAUDE.md, Known automation limits; reproduced on unmodified main). Jest drives them fine, so the test covers them; in the browser check, verify Edit/Duplicate/Delete/View Raw JSON by code and `curl`, and ask Kannan for **one manual click of each** after step 4.
- **Header actions are JSX snapshots** held in `HeaderContext`. The effect's dependency list (search, tag filter, font count, layout count, the ops flag) is what keeps them current; moving it into `useLayoutsHeader` must keep the same list, or the search box freezes. Case 3 and 28 guard this.
- **Effect order.** The `?edit=` effect must still run after `status` is authenticated and only once; the scroll restore is a `useLayoutEffect` and must stay one (a plain effect would paint the jump).
- **No direct DOM.** The page is clean today (only `inputRef.current?.click()` on a ref, `window.confirm`, `window.scrollTo`, `history.replaceState`, all allowed). New components must keep the file inputs as refs passed down, and must not "simplify" the scroll lock into a `document.body.style` write (that was removed on purpose; see UI Conventions).
- **The full-screen modal sizing** (`top: headerHeight`, page clipped to `100dvh - headerHeight` while open) needs a browser look at desktop and a phone-width window after step 6; a real phone is not needed for an ops page.
- **The import round trip** (Templates page → `?edit=…&import=1` → Update Layout → `?import=continue`) is covered end to end by `e2e/import-design.spec.ts`; run it after steps 3 and 5 (needs the local stack with a capped worker).
- **Shared checkout.** Do each PR in its own worktree from a freshly pulled `main`; other sessions move the shared checkout's branch.

## Not in scope

`components/CalendarLayoutEditor.tsx` (the other big file), the calendar/book/templates/holidays/tags sub-pages, any behaviour change, and `LayoutFabricPreview.tsx`'s internals.
