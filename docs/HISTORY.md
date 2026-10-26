# Product Editor — history behind the rules

**Status:** append-only record, split out of `CLAUDE.md` on 2026-10-13. Every rule in `CLAUDE.md` that reads as arbitrary has its story here, under the same heading. When something costs you time, add the rule there and the story here, dated. Nothing in this file is verified by CI; where it and the code disagree, the code wins.

Headings follow `CLAUDE.md`'s order.

## Docs — and which of them to trust

- `CLAUDE.md` said `docs/` held "ten" files while the real count was twelve, and later "twelve" while it was 13. Hence "count them with `ls`". The same drift happened to the backend test count (18 and 19 claimed in consecutive paragraphs, real count 24) and to the smoke-test totals (19 claimed, 18 run).
- `CLAUDE.md` and `docs/AI_GUARDRAILS.md` were out of sync on worker memory, migration numbers and retention windows until 2026-08-14.
- `CALENDAR_FEATURE_PRD.md` spent a month claiming "Proposal" for a shipped feature, which is why every doc now carries a status line.

## Knowledge Graph

Counts by build, newest first. The report in `graphify-out/GRAPH_REPORT.md` is the source of truth; this is the trail.

| Date | Source | Nodes / edges / communities | Note |
|---|---|---|---|
| 2026-10-13 | `a2ea33e`, full rebuild (PR #269) | 4,105 / 8,733 / 229 | six subagents; 176 community names carried by overlap, 29 named by hand; `graph.html` stopped being committed the same day — its 22 commits were 10.8 MB of the repository's 13.5 MB pack |
| (unrecorded) | `16b501b6` | 4,044 / 8,377 / 241 | a build nobody wrote down |
| 2026-10-08 | `79ba213`, refresh | 3,616 / 7,334 / 219 | docs re-extracted from diffs; `build_merge` kept only incoming hyperedges (dropped 14 of 19), re-added by hand; re-clustering after a 9-file change had reshuffled ~70 of 213 communities, so the partition was kept |
| 2026-10-07 | `5f6e06e`, refresh | 3,615 / 7,321 / 219 | first use of `scripts/graphify-refresh.py` |
| 2026-10-07 | `662b18e`, full | 3,564 / 7,115 / 213 | repointed doc edges from the retired `api_views_*` nodes to the split `views_*` modules; every community named |
| 2026-10-06 | `0a7cb5f`, refresh | 3,198 / 6,379 / 232 | |
| 2026-10-06 | `88f86eb`, full | 3,255 / 6,462 / 229 | cleared the stale Printo Architecture Audit nodes and 50 `Community N` placeholders |
| 2026-10-06 | `afec3a3`, refresh | 3,195 / 6,376 / 234 | after the dead-code PRs #183–#185 |
| 2026-10-06 | `1a6d41f`, AST-only | 3,972 / 7,289 / 340 | the drop that followed was stale per-heading doc nodes and the newly-ignored migrations, not lost code |
| 2026-09-29 | `f098f3f` | 3,952 / 7,249 / 333 | |
| 2026-09-04 | — | 2,974 / 5,345 / 213 | until this date `CLAUDE.md` claimed 5,282 / 17,271 / 321 files while the committed graph held 2,297 / 3,977 — figures from an older doc-inclusive build |

God-node history: `a2ea33e` — `LayoutEngine` 73, `S3Backend` 68, `S3Storage` 55, `LayoutCatalogue` 54, `CLAUDE.md` 52, `CanvasItem` 44. `79ba213` — `Product Editor PRD` 64, `Calendar Feature PRD` 63, `LayoutEngine` 58, `AI Guardrails` 50. `0a7cb5f` — `LayoutEngine` 76, `S3Storage` 58, `LocalStorage` 53, `APIKey` 52.

Lessons that became rules:
- 2026-10-06: `graphify update .` after a full rebuild re-added the per-heading doc nodes the rebuild had removed (+430 nodes) and dropped 41 communities back to `Community N`. `--update` aborts without an LLM key.
- A build from a scratchpad worktree baked `private_tmp_…_scratchpad_wt_…_deploy_sh__entry` into shell-script node IDs.
- Indexing the vendored Scalar `standalone.js` put 3,180 nodes and 13,039 edges into the graph (58% / 77%) and manufactured phantom cross-language edges by name collision (`mm()`, `getSize()`); hence `.graphifyignore`.
- The `_AnyContentTypeParser` name collision produced ~28 INFERRED edges to unrelated classes until it moved into `api/views/uploads.py`.
- 2026-10-08: five parallel subagents, each inheriting ~73k tokens of CLAUDE.md and memory, exhausted the 5-hour rate limit. The 2026-10-13 rebuild ran six because the window was at 26%.
- 2026-10-13: subagents wrote `_name__usefileintake_x` where the AST had `name_usefileintake_x`, and referenced inner hook functions that have no AST node; 57 ids were remapped before merging. The extractor also flagged `services/asset_store.read_asset` as ambiguous because two migration docs name it loosely; it has five production importers and is fine.

## Hard constraints — git and shipping

- 2026-08-08, twice: a `git pull` failed silently and work began against a base 7 commits behind, in the shared checkout. Hence "branch first from freshly-pulled main".
- 2026-08-08 (PRs #41–#53): implement → test → commit → push → PR → merge ran as one autonomous pass; each change was sound, but the user was left reviewing merges rather than deciding them. Hence "never push, PR or merge without checking in".
- 2026-08-08: a session found four modified and two untracked files belonging to another session; they were only safe to discard after verifying each was byte-identical to `origin/main`. Hence "stage explicit paths".
- By the end of 2026-08-08, 13 merged branches had accumulated and every `git pull` on the production server printed the whole list as `[new branch]`. Cleaning that up is still the user's call every time.
- 2026-08-08: a PR was referenced as "#47" before it existed; #47 turned out to be an unrelated PR from another session.
- 2026-09-17: a commit landed directly on `main`; the rule was reinforced with "NO EXCEPTIONS".
- 2026-10-13: the shared checkout switched from another session's branch to `main` *during* a graph rebuild (PR #268 merged mid-run). Hence "prefer a worktree".

## Commands and tests

- `api/tests/` had no `__init__.py` until 2026-09-15, so `manage.py test api.tests` crashed with `TypeError: expected str, bytes or os.PathLike object, not NoneType` and `manage.py test api` silently found 0 tests; only the fully-qualified dotted form worked. Once runnable, `test_invalidate_preserves_other_layouts` was asserting the opposite of its name (that a *different* layout's cache entry was cleared); fixed to assert it survives. Wired into CI as `backend-db` in PRs #145/#146.
- `docker-compose run backend <cmd>` after editing source tests whatever the image was last built with, and fails silently: a freshly-added test module reads as "not found" rather than "not rebuilt".
- The layout-card action buttons not responding to synthetic clicks was reproduced on unmodified `main` before being written off as an automation artifact.
- 2026-10-13: a helper named `template.ts` beside `page.tsx` was rendered by Next as a special file and 500'd the route; tests stayed green, only a browser load showed it.

## Architecture — editor page split

The editor `page.tsx` and `api/views.py` (4,500 lines) topped the older doc-inclusive graph as the files most likely to break something else when edited. Both were split in October 2026 under `docs/LARGE_FILE_SPLIT_PLAN.md`: `api/views.py` into the `api/views/` package (PRs #189–#191), `page.tsx` into hooks and components in 13 PRs between #196 and #218, guarded by the Jest characterization suite (Phase 0a) and the Playwright smoke suite (Phase 0b), both of which had to pass unchanged across every split PR. "Add Files" replacing instead of appending was a live bug until PR #24. Until 2026-10-13 `CLAUDE.md` still said the book ops editor and customer page-count work had not started, long after both shipped.

## Architecture — Pillow pixel ceiling

Until 2026-10-07 the web process got the 500 MP ceiling only because `api/views/__init__.py` imported `layout_engine.engine` for the side effect, so any process that set up Django without loading the views refused uploads above Pillow's default (~179 MP). Moved to `api/apps.py` `ready()`; pinned by `test_image_pixel_cap.py`.

## API reference (Scalar)

Until 2026-09-03: 15 handlers had no `@extend_schema` and were silently dropped from the document (drf-spectacular logs `unable to guess serializer … Ignoring view`); `SECURITY_DEFINITIONS` — a drf-yasg setting — sat in `SPECTACULAR_SETTINGS` being ignored, so every operation referenced a `BearerAuth` scheme that was never defined and Scalar's Authorize dropdown was empty; the three `AllowAny`-declared ops views advertised their destructive methods as needing no credentials. The 2026-10-13 CSP-beacon and template-flow doc fixes are in PR #268.

## Async Queue

- There were two Celery workers until August 2026; the second was bound to `priority` alone for the soft-proof/CMYK express path retired in v1.8. It had never executed a task while holding a full Django + Pillow + MediaPipe process resident. Removed; the surviving worker drains both queues so an opt-in `apply_async(queue='priority')` cannot sit in Redis forever. The service name `celery-worker-standard` was kept to avoid renaming the container on prod.
- `render_canvas_task`'s poison-pill guard counts only genuine broker redeliveries after an earlier version miscounted `self.retry()` re-runs.
- A stale worker container left running on an old build rendered every surface with the whole photo list; check the worker's code before debugging the payload.

## Garbage collection

- **Why every 6 hours:** the sweep ran nightly at 02:00 UTC, the trough immediately *before* the 03:00–12:00 UTC expiry wave (3-day retention, Indian business hours). Of 7,647 rows pending on 2026-08-14 it collected the 151 expiring 01:00–02:00 (2%); the rest waited up to 23 hours. Effective retention was ~4 days, disk sawtoothed 82% → 93% overnight *while the sweep itself was healthy* (0.19 s, every night). Diagnosing that as a broken GC produced two wrong root causes (a non-firing beat, then a stale DB connection) before anyone plotted expiries by hour:
  ```bash
  docker compose exec backend /opt/venv/bin/python manage.py shell -c "
  from api.models import ExportedResult
  from django.db.models import Count
  from django.db.models.functions import ExtractHour
  for r in (ExportedResult.objects.filter(is_deleted=False).annotate(h=ExtractHour('expires_at'))
            .values('h').annotate(n=Count('id')).order_by('h')):
      print('%02d:00 UTC %6d' % (r['h'], r['n']))
  "
  ```
- **Why `stale` AND `failing`:** the first version of `gc_status` recorded only successes. On 2026-08-14 that let a wrong diagnosis run for two days: "the sweep broke" and "the sweep was never dispatched" look identical from outside. The answer was in the worker log the whole time — and those logs die on container recreation.
- **Why not a DB signal:** reading `ExportedResult.objects.filter(is_deleted=True).count()` as "did it run?" cost real debugging time on 2026-08-13; it is 0 either way.
- **Why the live `disk` block:** production hit 89% disk unnoticed twice because the only disk figure was the last sweep's.
- **Orphaned export directories:** the async-render cleanup filtered on `status='completed'`, so a job killed mid-render never had its output swept; its `CanvasData` later expired, the cascade removed the `RenderJob`, and the only pointer to the files went with it. 62 directories (54 MB) stranded by 2026-08-13. The sweep defaulted to `dry_run`; armed `delete` on prod 2026-09-10 (244 dirs scanned, 0 orphans at the check).
- **Abandoned chunk staging:** 93 directories found 2026-08-25. The module briefly duplicated an inline block that had been in `garbage_collector_task` since 2026-04-08 under the counter `stale_chunk_sessions_cleaned` (not `chunk_staging`), which is why `chunk_staging.scanned` read 0 the first day. The inline block was removed 2026-08-26.
- **Expired `EmbedSession` rows** were never deleted until commit `56a2136` (2026-09-10) added the 30-day sweep.

## Celery and stale database connections

A plausible story about the nightly sweep dying on a stale connection turned out to be wrong when the worker logs were read (2026-08-14). The hooks are hardening, not a fix for an observed incident; verified both directions by killing `connection.connection` and seeing the next query fail without the hook and succeed with it.

## Layout Loading

2026-09-04 audit after PR #111 moved layouts into Postgres found four paths still reading disk: `render_canvas_task` and `GenerateLayoutView._handle_async()` not passing `layout_definition`, `_layout_exists()` querying disk, `LocalStorage.list_layouts()` enumerating `/app/storage/layouts/`. All fixed.

Before the migration, production had diverged badly from git: 20 tracked layouts deleted in the ops UI, 11 renamed under new names (`classic_A4.json` → `classic_prints_-_4x6_in.json`), a new mask, a modified `fonts.json`, none committed. Every `git pull` on prod failed when a commit touched a layout file (removing `sku_layouts.json` did exactly that on 2026-09-04). `git reset --hard` would have resurrected the 20 obsolete layouts beside the live ones. The 14 live layouts were exported, committed as `backend/migrations/prod_layouts.json`, imported by migration 0017, and the disk files deleted. A `classic_A4.json` carrying `"name": "classic_a4"` had worked on the case-insensitive dev Mac and 404'd on prod's Linux.

## Layout identity

2026-09-16, two fixes the same day: `LayoutCatalogue.name` had been both the ops-editable display text and the identifier printo.in hardcodes into its iframe URL and SKU mapping, so an ops rename silently 404'd their embed. First an alias (`renamed_to`, migration 0019); then renaming was retired and `display_name` (0020, PR #154) took over. A rename made before 2026-09-16 is not retroactively fixed — its `renamed_to` is NULL until pointed by hand.

## Server-side render and embed

- v1.8 removed the client-side "≤ 20 canvases render in browser" shortcut; small jobs pay ~10–20 s extra, in exchange for one contract for webhooks, large batches and resumable uploads.
- The old `soft_proof` / `tiff_cmyk` / `callback_url` body params on `/api/layout/generate` were removed in v1.8. The legacy `/embed/layout/*` SVG-preview route was removed because it read `?apiKey=` from the URL.
- `docs/INTEGRATION.md` claimed numeric-string `qty` values were rejected until 2026-09-04; they are accepted on purpose.
- **Qty header-trust gap (2026-09-15, PR #144):** the submission cap read `X-Order-Qty` from the proxy. A caller holding the real api_key could POST to `/api/editor/render` with no proxy in the path. Verified: a qty=5 session, 7 files, direct POST — 202, no cap. `EditorRenderView` now looks `EmbedSession.qty` up itself.
- A literal `'canvas'` surface key matched no surface and printed a blank side; the frontend must send the real key.
- SKU→layout resolution (`storage/sku_layouts.json` + `SKULayoutView`) shipped April 2026 and was removed 2026-09-04: printo.in owns it. It never carried real data.
- `pe:back` exists because `history.back()` inside the iframe was verified, in a real nested `<iframe>`, to walk the parent page's history and potentially carry the customer off printo.in mid-checkout.
- The embed proxy allowlist was prefix-only until 2026-09-03, with "GET only" in a comment. `fonts`, `holidays` and `calendar-styles` accept ops writes upstream and the proxy injects the real api_key, so an embed token behind an ops-flagged key could `PUT` holiday data. `DIRECT` is ops-flagged and is what the local embed recipe uses.
- Webhook consumption by printo.in was confirmed 2026-09-11 (43 sessions with a live `callback_url`, 45 ZIP fetches all `200`, cross-checked against order 576430) and confirmed as production on 2026-10-13. `CLAUDE.md` said the opposite until the first date.
- The Next.js proxies used to read `await upstream.arrayBuffer()`, pinning a whole ZIP (up to ~500 MB for a 200-photo job) in memory; both now stream `upstream.body`. `CLAUDE.md` listed the buffering as a known limitation until 2026-10-13.
- `_resolve_render_inputs` fell back to `editor_state` for jobs enqueued before migration 0008 until 2026-10-13. CanvasData expires in 3 days, so the branch had been unreachable for months and let the pipeline read the autosave's field.

## API key daily request cap

`APIKey.max_requests_per_day` existed from the initial commit with `default=1000`, shown in the admin and set by `create_api_key` and the entrypoint seeds (10000 / 1000 / 5000), and nothing ever checked it. Enforced 2026-10-13 (migration 0022). Enforcing the stored numbers as-is would have capped production on deploy — the storefront key alone sends hundreds of autosave PUTs per customer — so every existing value was blanked and the default became "no cap".

## HEIC

Verified against a real 24 MP iOS 18 gain-map photo: the server decode matched macOS's own decode to RMSE 0.26. `heic2any` was last published in 2021 and cannot decode `tmap` gain-map HEICs; Chrome and Firefox have no HEIC codec.

## Auth, roles and admin

- **PR #24 (2026-07)** removed the internal proxy's `ops/*` gate by product decision, opening template management to any authenticated user. **2026-09-05** reversed it with the three-tier model after PIA's team confirmed the flags; a designer who edited templates before that loses it unless flagged into the ops team — intended.
- `is_super_user` never existed in PIA. `is_superuser` (their spelling) was described by PIA as a courier service account denied app access, then sent `true` for a human with full access (2026-09-07); removed from the payload 2026-09-11. `is_staff` was confirmed present on the Google login path 2026-09-05; full parity between the password and Google payloads is still not confirmed in writing. A day of guessing about `is_super_user` ended when `[pia-login]` started printing every flag with its type.
- Who held `is_staff` on 2026-09-05: two people (Merving and Kanna, employee 12180).
- **Dual-mounted write views (2026-09-29, PR #163):** `CalendarStylesView` and `HolidaysView` serve both the public read paths and their `ops/` twins, and their write handlers never check the route. The proxy gated only `ops/*` and `fonts`, so an Editor-tier session could `PUT calendar-styles/<name>` or `PUT|DELETE holidays/<locale>/<year>` with the ops-flagged key. Closed on both sides.
- **Django admin:** gated by nginx basic auth (`proxy/nginx/.htpasswd`, rotated off the default 2026-08-13) plus Django's own login until September 2026. On 2026-09-04 production had **zero** `auth_user` rows, so the admin was unreachable for everyone. Replaced by the SSO described in `CLAUDE.md`; `.htpasswd` is gone from the repo. `ProxyAuthenticationMiddleware` guarded `/admin/` until 2026-09-04 while the admin had been mounted at `/django-admin/` since the initial commit, so the check had never once run.
- Deleting an `APIKey` cascades to its orders; rotate with the admin's "Regenerate key" (PR #161) instead. The "Printo.in Storefront" key (minted 2026-08-13) is separate from the generic `EXTERNAL` key.

## Three frame renderers

- The blur once appeared in the thumbnail and print but not the live editor; `frame-fill.ts` exists because of it.
- **Overlay drift fix (2026-10-13, PR #258):** `fontSize: 72` on an 1800 px layout printed a capital H 118 px tall against 53 px in the editor, because `_draw_text` multiplied `fontSize` by `canvas height ÷ 800` while the editor canvas already *is* the layout's print size. The editor wrapped with `splitByGrapheme: true` (breaking words at any character), the thumbnail had no width (every word on its own line), the print had no wrapping model at all; an absent `textAlign` was left in the print and centre in the previews. Shapes: a circle filled its box in the print and was `min(w,h)/2` in the preview; `handleModified` moved a circle by half its size on every move and shrank a star 6% per move; `strokeWidth` was drawn full-size on the thumbnail; an absent `fill` printed black. PRD §11.7's "one font, no picker" was reversed the same day (PR #243): until then `fontFamily` was ignored and a script font previewed as script and printed as Inter. Prod's font list was empty (Inter only) at deploy.
- **Inter weights (2026-09-29):** `set_variation_by_axes([weight])` wrote the weight into `opsz` (Inter's fvar order is `[opsz, wght]`), so every server-rendered weight printed as 400.
- Fabric 7 anchors shapes by centre; a shape missing explicit `originX/originY` shifts up-left by half its size (the dotted-lines-in-top-left guide bug).

## UI conventions

- PR #24 overrode Tailwind's `indigo` scale with Printo purple to re-skin every call site at once instead of touching hundreds of them.
- The JSON Specification modal rendered behind the fixed header at `z-[60]` and went to `z-[200000]`. The editor's download options, embed disclaimer and print-sheet window sat at `z-[100]` until 2026-10-07, so the top bar stayed bright and Back to Templates stayed clickable while they were open.
- Until 2026-10-07 none of the editor dialogs had `dialog`/`alertdialog` roles or focus management, and a key pressed on a button inside a canvas card was caught by the card, which cancelled the button's click and opened the canvas editor — keyboard users couldn't use the card's buttons at all.
- Until 2026-10-13 selecting an icon or sticker in the canvas editor's sidebar hid the Add New Icon / Add Photo controls, so a second one could only be added after selecting another layer. The Django Admin button in the Templates toolbar overlapped the Fonts button on narrower screens; it became the header badge (PR #260).
- The grid thumbnail "blink" came from `LazyImg` destroying and re-creating each `<img>`; the "modal fixes it" theory was tested and is false.

## Export Flag

- **Print sheet and the two mask slots (2026-10-26).** Catalog Ops reported that a physical photo-frame product (prod `cPhoto Frame 12x18 Brown Goldline`; local equivalents `photo_frame_4x6_walnut`, `zz_photoframe_12x12`: one window at a 10% margin, bleed 0) could not be set up with the one mask and its "Mask on Export" switch: printed, the picture of the wooden frame was baked into the sheet; not printed, the sheet was the whole canvas with white around the window. The print they need is the bleed area only (the visible window grown by the strip hidden under the frame or trimmed after printing), with the customer preview and the storefront mock still showing the frame. Decisions that day: the print is everything within the bleed area, ONE file per surface (never one per window: a frame with two holes gets one sheet with both photos placed), each surface with its own bleed area; nothing is ticked as printable, placement decides (a mask outside the bleed area never prints, even where its pixels overlap the bleed ring; one inside prints, cropped); exactly two slots, no draggable layer stack; the mock is exactly the customer preview with every layer; existing layouts print byte-identically unless ops change the choice, which is why `bleed` can never be a default (`retro_polaroid_-_4.2x3.5_in` has its mask off and prints its white border and caption). Prior art checked: Customer's Canvas, Customily and teeinblue keep masks preview-only and print a separately defined print area. Deferred to a later task: multi-print areas / split canvas (several files per surface, one photo shared across windows, blur wrap), tilted frames, more than two slots, calendar and book sheets. Until then the mock had been derived from the print file inside `_write_output_atomic`; the caller supplies it now, since the print may be cropped. The unused `printableArea` on the ops page's `LayoutConfig` went the same day. The first build also offered a **typed** bleed-area rectangle (for printed artwork extending past the windows) and drew the windows' visible area as a second, green dashed rectangle; Kannan dropped both on the same day after testing locally: artwork outside the windows is never shown to the customer, so printing it could only produce a file that differs from what was ordered, and the second rectangle only repeated what the windows already show. The print area is therefore always read from the windows, so it moves with them.

## Storage

- **Prod runs S3 (verified 2026-09-29 from the running containers).** Until that date calendar-asset reads never actually hit S3 (key mismatch; `docs/CALENDAR_S3_READINESS.md` amendment), so an ops edit to holidays, styles or fonts would have been written and never read back — none had been attempted (zero writes in the audit trail; `ops-config/` held only the empty marker). A removed S3 key read as "never written" and resurrected the seed; hence tombstones. Style lists came from local seed files only, so a style created under a new name never appeared in the dropdown. PR #111 had moved `fonts.json` to `storage/fonts/fonts.json`, which neither `backup.sh` nor `.gitignore` covered; it was moved back.
- **Masks printed from local disk only** until 2026-10-12: on prod, which holds no local masks, a layout with Mask on Export on would preview its frame and then fail every render on `None.size`. The S3 key was `masks/<file>` at the bucket root, outside the `product-editor/` prefix the IAM user is scoped to; nothing had ever been stored there. Prod's only masked layout (`laptop_sleeve`) had Mask on Export off, so nothing live was affected.
- **Mask CDN:** `S3_CDN_DOMAIN=cdn-product-editor.printo.in` had no DNS record at all until 2026-10-12, so every mask preview on prod was broken while prints were fine. Set up that day: CloudFront `product-editor-masks` (`E3C4UVH2TRZVQ` → `dzbmx4blhpg8b.cloudfront.net`, Free plan), origin `pia-oms-uploads.s3.ap-southeast-1.amazonaws.com` with OAC `product-editor-masks-oac` (`E1RJHHTJJ4KVHP`), `CachingOptimized`, `CORS-With-Preflight`, the shared ACM `*.printo.in` cert (us-east-1, valid to Apr 2027), Cloudflare CNAME DNS-only. Bucket policy statement `AllowCloudFrontOACReadProductEditorMasks`; a second statement for `product-editor/ops-config/stickers/*` added and verified 2026-10-13 (302 → CDN `200`, `image/png`, CORS `*`). The bucket also serves RiderPro / POPS / Wiki through distribution `E1E3K1H0JIB2SL`. Content-fingerprint mask names arrived in PR #236.
- **IAM:** `pia-oms-user` lacked `s3:PutObject` on `product-editor/*` until 2026-10-12; every ops-config write and mask upload on prod had failed with `AccessDenied`.
- **Backups:** scheduled on prod at 03:15 UTC since 2026-08-28 (`CLAUDE.md` said "not scheduled" until 2026-09-04). The cron comment justifies 03:15 as "after the 02:00 GC", which is stale but still falls between sweeps. Until 2026-10-13 only local seeds were archived, not S3 `ops-config/`; the weekly tier carried customer data for ~28 days until the PII-free weekly dump landed the same day. The first run after that deploy deletes the legacy full weekly dumps.
- **The git-tracked-and-runtime-written storage files** (`storage/layouts/`, `masks/`, `fonts.json`, `holidays/`, `calendar_styles/`) were the source of the prod divergence above. As of 2026-09-29 `git status storage/` on prod is clean, `storage/layouts/` is empty, and `storage/fonts.json` does not exist (already absent from the oldest backup, 2026-09-06).
- **Holiday seeds:** the en-IN refresh had never fetched anything because Nager.Date does not cover India (HTTP 204). Switched to the offline `holidays` package; the en-IN seeds for 2026–2030 were regenerated 2026-10-13 and the 2026 Diwali moved from Nov 4 to Nov 8 (the wrong hand date had to be removed first, since the refresh keeps a stored date that disagrees).

## Layout templates

Shipped in PR #259 on 2026-10-13 (prerequisite PR #258), deployed to prod at `7996d8c`; prod held no templates at deploy. The picker opened on the empty page via a "Start with a template" button until 2026-10-13, when it became the first step on a fresh design and the button was removed; until that day a template picked before the first photo was forgotten on reload and the post-restore autosave wrote `template: null` over it. Both ops template pages scrolled into the fixed header on arrival from a scrolled Layouts page (fixed 2026-10-13). The "this card only / all cards" per-edit prompt was decided against the same day (Kanna).

## Layout tags

Until 2026-10-25 the nine tags were a hard-coded list in `lib/product-tags.ts`, a layout stored the tag *names*, and only the generic editor had a field (one "Primary Tag"). The calendar editor rebuilt the whole definition on save and silently dropped any tag; the book editor had no field. The CMS team asked to create their own tags; keys were introduced so a rename never disconnects a layout, and `tags` kept returning names because printo.in's API key can read the layout list and nobody could confirm whether their storefront uses it.

## Calendar

- Phase 9 bench (May 24 2026): 12-surface render ~1.8 s on the dev container, per-surface ~150 ms, RSS delta < 1 MB; target was ≤ 90 s. The bench script was a `/tmp` artifact and is gone.
- Previously N photos produced 12·N files in the ZIP; the 12-month cap and `(i mod N)` mapping replaced that.
- The Gen-Z palette loader read under `default_storage`, which never resolved at render time; it reads under `STORAGE_ROOT` now. Until 2026-10-12 the editor ignored the ops default palette and previewed the first one.
- **Customer preview showed holidays the print didn't carry (2026-09-29, PR #173):** the page loaded holidays for every calendar layout while the print included them only when `holidaySource.enabled`. PR #171 gave the ops preview the same gate (it had fetched `en-IN/<browser year>` once on mount, so a Financial or pinned-year layout previewed with no holiday dots). PR #175 made existing layouts open with the settings their print uses (`holidaySourceAsPrinted`) — an old block-less layout had previewed holidays in the ops editor and *gained* them in the print on its first ops save. PR #177 retired `holidaySource.showInCells`, which nothing read. No real layout was affected by any of these: the only one, locally and on prod, carries a complete enabled block.
- `resolveBaseYear` / `todayInIST` / `startMonthFor` were made module-private in PR #171 so nothing can show a calendar year without `resolveDefaultYear`.
- Until 2026-10-12 the customer could only edit the 1st of each month (`CalendarDayPicker` added). The calendar editor's mask picker copied only the file *name* into `maskUrl` and sent JSON, so the PNG never reached the server; the generic editor had always sent `mask_<surface key>`, silently dropped.
- Calendar frames gained mm fields on 2026-10-13; the fraction "Precise values" fields for frames were removed.
- **Printed calendars carried no month name (fixed 2026-10-17):** `render_calendar` drew only the weekday row and dates, on the theory that ops would place month labels as overlays — but no UI ever set `calendar.monthTitle`, so every printed page and mock was unlabelled while the customer's tiles said "JAN 2026" around the grid. Each block now prints "January 2026" above its weekday row by default, and the tiles draw it inside the grid as the print does. The grid area shrank by 12% of the block height on every existing calendar layout.
- **Calendars never asked for 12 photos (2026-10-17).** The "X of Y photos" banner, repeat picker and pre-submit notice ran only off the order `qty`, which calendars were exempt from (it counts calendars bought), so a 4-photo calendar silently repeated photos across the 12 months, and the poster kept up to 12 cards while printing only the first. Calendars now measure against their own photo pages (`calendarPhotoSlots`) on both sides, and the webhook carries a calendar `qty_summary`.

## Book

Backend 2026-08-14 (D1/D2/D2a/D4/D5/D6/D7 answered); the PRD's §4 D4 spine sketch (`pageCount × paperThicknessMm`) double-counts and the code uses leaves. On 2026-10-17 Catalog Ops agreed to follow that definition (thickness of one sheet), so the "unconfirmed" caveats were replaced by a per-sheet field label and a worked line on the ops editor. Ops editor and customer page count shipped later; `CLAUDE.md` said the opposite until 2026-10-12/13. Book Editor masks per role and merge-on-save (instead of rebuilding the layout and deleting `pageOverrides`, overlays, frame ids and hand-added masks) landed 2026-10-12.

## Auto-orientation

The "sideways photos" report (2026-05) was rotate-to-fill laying wide photos 90° in the near-square retro-polaroid window, not the pose model (which is conservative by design); hence the 0.8–1.25 near-square exclusion and Blur Effect on by default. `CLAUDE.md` listed the pose model as primary and the aspect rule as fallback until 2026-10-07; the code has worked the other way round since the 2026-05-19 ops decision.

**Calendar month photos printed people sideways (2026-10-17).** Desk calendars have a landscape photo window (~1.5:1), so every upright portrait (most customer photos) was turned 90° to fill it, before the pose model was consulted. The print matched the preview; the rule was the problem. Calendars now skip rotate-to-fill, as the retro polaroid's near-square window already did, and keep the pose model. Every other product keeps the 2026-05-19 fill-first rule.

**Upside-down previews from photos stored sideways (2026-10-25).** A customer's mirror selfie came out upside down in the Gold Sash frame. The file's pixels were sideways with EXIF orientation 1 and the EXIF pixel dimensions describing a portrait — the rotation had been dropped before upload — so rotate-to-fill turned it, and with no pose reading it turned it the default way, which was wrong. Of 14 real customer photos CX had collected, 11 were stored sideways like that; in 400 recent prod uploads the pattern is rare (1 by metadata, while 57 iPhone files still carried their flag), so these are the complaint cases, not typical traffic. The lite pose model read 5 of the 14, declining every close-up selfie (shoulders cropped → "not perpendicular") and every small subject ("keypoints too close"); the production rule therefore stood 5 of the 11 on their heads and left one sideways. Measured and rejected on the same photos: the `full` pose model (no better), the pose model at each quarter turn (wrong answers), a crop-and-redetect pass (the first-pass landmarks are noise), the full-range face model (found nothing), and letting the face detector vote across all four turns (wrong-turn keypoints outvote the right turn). What held: the bundled short-range face detector's eye/mouth keypoints are coherent only on an upright face, so the quarter turn in which the best face stands upright is the answer — the detector's score is not, it rates a sideways face at 0.86–0.92. With that second opinion and the pose dead zone widened 15° → 20°, the model read 11 of the 14 and declined 3 — the mirror selfie, a lone figure far from the camera, and an upright panorama of four small figures — with none wrong; in the editor 12 of the 14 come out upright where 7 did before, the mirror selfie is still upside down and the panorama still sideways by the fill rule. The face detector loads once per process (~0.8 s on the first declined photo) and then costs ~10 ms per photo. The face step runs only when the pose declines, so photos the pose already read are unchanged. The pure rules are pinned by `services/tests/test_orientation_rules.py` with the measured per-turn tables; the photos themselves are customer data and are not in the repo.

## Hardening — fixed issues

- **P1 autosave payload bloat (fixed 2026-09-10, PR #134):** `editor_state` embedded base64 canvas previews, 16 MB average and 93 MB peak. Measured 2026-09-04 over ~27 days: 1,326 `201`s (3 kB), 1,333 `200`s (2.4 MB avg) and **1,569 `400`s averaging 16 MB** — 28 GB of autosave traffic, ~25 GB discarded on the 10 MB body limit; `canvas_data` was 422 MB of TOAST for 166 rows. Invisible because renders use `render_state`, a same-browser refresh recovers from IndexedDB, and Django rejected the body before the view ran; only a customer resuming on another device lost work. Fixed by stripping previews from what is persisted and regenerating them on restore — **not** by raising the limit, which would trade silent failures for gunicorn OOM on a 2-core box. The diagnosis was only possible via `request_size_bytes` grouped by status, which is why `error_message` now carries framework rejections too.
- **Autosave overwrote saved designs on a slow restore (2026-09-29, PR #166):** a restore GET slower than the 2 s debounce let autosave PUT pre-restore state over the saved design; the calendar/book writers had no guard and the main writer's `restorePending` guard was off in the embed. Reproduced locally to a permanent wipe. Chrome holds a same-URL PUT behind an in-flight GET, which masks it; reproduce with the GET delayed and read `PerformanceResourceTiming.startTime`.
- **Photos stored repeatedly (2026-09-29):** the fileId patch effect wrote into `surfaceStates` only and the `canvases → surfaceStates` sync copied id-less canvases back, so every edit stored every photo again (3 photos + 3 rotates = 12 records).
- **Key-scoped purge deleted another key's photos** for the same order id until 2026-10-07 (order ids are unique only per key).
- **DPDP erasure found files only via `CanvasData.image_paths`**, which autosave blanked every 2 s, so `purge_order_data` reported `files_deleted: 0` and left 6.4 GB of photos on disk; migration 0011 added `UploadedFile.order_id`. Migration 0013's `default=list` fixed the first autosave for any new order 500ing (NULL into a NOT NULL column with no default — no row created, every retry the same).
- **Retroactive retention (migration 0012):** the GC swept uploads on `created_at + retention` recomputed at sweep time, so lowering `EXPORT_RETENTION_DAYS` deleted files whose expiry had already been sent to a partner as webhook `expires_at`; the ZIP then silently lacked `1_customer_uploads/`.
- **Audit trail wrote nothing** from the initial commit until migration 0014 (2026-09-04); `APIRequest.objects.count()` was 0 for every key forever — which, in a leaked-key investigation, reads as proof a credential was never used. 1,569 `400`s on `canvas-state` with no recorded reason cost real time that day.
- **v1.10 fixes:** cover-mode white space (`calculateSmartCropOffsets` now clamps to per-axis pan room); editor drag `clipPath` drift (`updateRelativeClipPath` on every `object:moving`); imposition modal Custom W×H inputs; smartcrop IDB cache keys at three call sites; `BATCH_SIZE` 5 → 8; `_smart_downscale` defensive copy removed (~50 MB memcpy per 12 MP frame); hot-path debug logs gated behind `_DEV`; Redis DB split; Docker log rotation; ops layouts list cache; Service Worker.
- Lint went from ~56 `no-unused-vars` warnings to 0 in PR #137 (2026-09-11); `as any` casts from 98 to 0 in non-test source by 2026-10-13; `LayoutDef` shape unified via `getCanvasSpec`/`getFrames` (commit `713bb5b`, 2026-08-14); API surface separation (`RenderSubmissionService`) in PR #133 (2026-09-04).

## Deployment

- **nginx inode (2026-09-04):** the admin-SSO identity headers were pulled onto prod, the deploy reported success, and the proxy was still serving an `nginx.conf` from 13 August — the feature simply did not work with nothing saying why. Single-file bind mounts bind the inode; `git pull` replaces the file. `sync_proxy_config` was added to `deploy.sh`.
- **Deploy hang:** `docker-compose run backend manage.py migrate` in the pre-swap step started a full gunicorn that never exited (the entrypoint ignores `$@`); fixed in `0c5a0b5`.
- **collectstatic at build time** aborted the clean build under `DEBUG=0` on the dev-default secret; the inline build-only key landed in `bc880b4`. A cached layer or stale running container hides the failure until `deploy.sh` does its clean build.
- **Local `.env` held the production `SENTRY_DSN`** until 2026-10-07, so the local stack and test containers reported into production Sentry as production, test CSP warnings included.
- **CSP:** report-only since 2026-04-27. Google Fonts was blocked on both halves until 2026-09-29 (PR #168), and the frontend's flag is build-time, so the September "ready to flip" note was wrong. 2026-10-13: one violation on prod, `script-src-elem` blocking `https://static.cloudflareinsights.com/beacon.min.js` on `/dashboard` — Cloudflare's own analytics beacon, injected at the edge; allowed the same day. The backend log only reaches back to the last container recreate, so Sentry is the history.

## Observability

Loki, Promtail, Grafana and Grafana Alloy (Faro RUM) lived here behind a `monitoring` compose profile from 2026-08-08 (`ac28d51`) until 2026-09-07, when they were removed along with `monitoring/`, the nginx `/grafana/` and `/faro/` locations, `scripts/setup-observability.sh`, the `GRAFANA_*` / `GF_AUTH_GOOGLE_*` / `NEXT_PUBLIC_FARO_URL` / `GOOGLE_CHAT_WEBHOOK` env vars and the `@grafana/faro-*` SDK: two half-owned stacks is worse than one owned one. The 12-part Printo architecture audit was removed the same day for the same reason (`git show 13430c7:docs/printo-architecture-audit/00-executive-summary.md`).
