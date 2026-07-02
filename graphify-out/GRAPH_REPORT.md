# Graph Report - .  (2026-07-02)

## Corpus Check
- 210 files · ~229,994 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1263 nodes · 2432 edges · 108 communities (88 shown, 20 thin omitted)
- Extraction: 83% EXTRACTED · 17% INFERRED · 0% AMBIGUOUS · INFERRED: 424 edges (avg confidence: 0.51)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Canvas Data & Render Jobs|Canvas Data & Render Jobs]]
- [[_COMMUNITY_Calendar Layout Engine|Calendar Layout Engine]]
- [[_COMMUNITY_Calendar Cell Upload|Calendar Cell Upload]]
- [[_COMMUNITY_App Shell & Auth Wrapper|App Shell & Auth Wrapper]]
- [[_COMMUNITY_Calendar Validators & Tests|Calendar Validators & Tests]]
- [[_COMMUNITY_Django Admin & API Models|Django Admin & API Models]]
- [[_COMMUNITY_Auth & API Key Auth|Auth & API Key Auth]]
- [[_COMMUNITY_Pillow Layout Engine|Pillow Layout Engine]]
- [[_COMMUNITY_Canvas Editor UI|Canvas Editor UI]]
- [[_COMMUNITY_Storage & Chunked Upload|Storage & Chunked Upload]]
- [[_COMMUNITY_Calendar Layout Editor|Calendar Layout Editor]]
- [[_COMMUNITY_Editor Page & Image Utils|Editor Page & Image Utils]]
- [[_COMMUNITY_Calendar Fabric Preview|Calendar Fabric Preview]]
- [[_COMMUNITY_Login & Rate Limiting|Login & Rate Limiting]]
- [[_COMMUNITY_Orientation Detection & Holidays|Orientation Detection & Holidays]]
- [[_COMMUNITY_Calendar Product Preview|Calendar Product Preview]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Calendar Renderer & Parity Tests|Calendar Renderer & Parity Tests]]
- [[_COMMUNITY_Month Tile Thumbnails|Month Tile Thumbnails]]
- [[_COMMUNITY_Pillow Calendar Cell Renderer|Pillow Calendar Cell Renderer]]
- [[_COMMUNITY_Module Group 20|Module Group 20]]
- [[_COMMUNITY_Module Group 21|Module Group 21]]
- [[_COMMUNITY_Module Group 22|Module Group 22]]
- [[_COMMUNITY_Module Group 23|Module Group 23]]
- [[_COMMUNITY_Module Group 24|Module Group 24]]
- [[_COMMUNITY_Module Group 25|Module Group 25]]
- [[_COMMUNITY_Module Group 26|Module Group 26]]
- [[_COMMUNITY_Module Group 27|Module Group 27]]
- [[_COMMUNITY_Module Group 28|Module Group 28]]
- [[_COMMUNITY_Module Group 29|Module Group 29]]
- [[_COMMUNITY_Module Group 30|Module Group 30]]
- [[_COMMUNITY_Module Group 31|Module Group 31]]
- [[_COMMUNITY_Module Group 32|Module Group 32]]
- [[_COMMUNITY_Module Group 33|Module Group 33]]
- [[_COMMUNITY_Module Group 34|Module Group 34]]
- [[_COMMUNITY_Module Group 35|Module Group 35]]
- [[_COMMUNITY_Module Group 36|Module Group 36]]
- [[_COMMUNITY_Module Group 37|Module Group 37]]
- [[_COMMUNITY_Module Group 38|Module Group 38]]
- [[_COMMUNITY_Module Group 39|Module Group 39]]
- [[_COMMUNITY_Module Group 40|Module Group 40]]
- [[_COMMUNITY_Module Group 41|Module Group 41]]
- [[_COMMUNITY_Module Group 42|Module Group 42]]
- [[_COMMUNITY_Module Group 43|Module Group 43]]
- [[_COMMUNITY_Module Group 44|Module Group 44]]
- [[_COMMUNITY_Module Group 45|Module Group 45]]
- [[_COMMUNITY_Module Group 46|Module Group 46]]
- [[_COMMUNITY_Module Group 47|Module Group 47]]
- [[_COMMUNITY_Module Group 48|Module Group 48]]
- [[_COMMUNITY_Module Group 49|Module Group 49]]
- [[_COMMUNITY_Module Group 50|Module Group 50]]
- [[_COMMUNITY_Module Group 51|Module Group 51]]
- [[_COMMUNITY_Module Group 52|Module Group 52]]
- [[_COMMUNITY_Module Group 53|Module Group 53]]
- [[_COMMUNITY_Module Group 54|Module Group 54]]
- [[_COMMUNITY_Module Group 55|Module Group 55]]
- [[_COMMUNITY_Module Group 56|Module Group 56]]
- [[_COMMUNITY_Module Group 57|Module Group 57]]
- [[_COMMUNITY_Module Group 58|Module Group 58]]
- [[_COMMUNITY_Module Group 59|Module Group 59]]
- [[_COMMUNITY_Module Group 60|Module Group 60]]
- [[_COMMUNITY_Module Group 61|Module Group 61]]
- [[_COMMUNITY_Module Group 62|Module Group 62]]
- [[_COMMUNITY_Module Group 63|Module Group 63]]
- [[_COMMUNITY_Module Group 64|Module Group 64]]
- [[_COMMUNITY_Module Group 65|Module Group 65]]
- [[_COMMUNITY_Module Group 66|Module Group 66]]
- [[_COMMUNITY_Module Group 67|Module Group 67]]
- [[_COMMUNITY_Module Group 68|Module Group 68]]
- [[_COMMUNITY_Module Group 69|Module Group 69]]
- [[_COMMUNITY_Module Group 70|Module Group 70]]
- [[_COMMUNITY_Module Group 71|Module Group 71]]
- [[_COMMUNITY_Module Group 73|Module Group 73]]
- [[_COMMUNITY_Module Group 76|Module Group 76]]
- [[_COMMUNITY_Module Group 77|Module Group 77]]
- [[_COMMUNITY_Module Group 79|Module Group 79]]
- [[_COMMUNITY_Module Group 80|Module Group 80]]
- [[_COMMUNITY_Module Group 81|Module Group 81]]
- [[_COMMUNITY_Module Group 82|Module Group 82]]
- [[_COMMUNITY_Module Group 83|Module Group 83]]
- [[_COMMUNITY_Module Group 84|Module Group 84]]
- [[_COMMUNITY_Module Group 85|Module Group 85]]
- [[_COMMUNITY_Module Group 86|Module Group 86]]
- [[_COMMUNITY_Module Group 87|Module Group 87]]
- [[_COMMUNITY_Module Group 89|Module Group 89]]
- [[_COMMUNITY_Module Group 90|Module Group 90]]
- [[_COMMUNITY_Module Group 96|Module Group 96]]
- [[_COMMUNITY_Module Group 99|Module Group 99]]
- [[_COMMUNITY_Module Group 106|Module Group 106]]

## God Nodes (most connected - your core abstractions)
1. `LayoutEngine` - 46 edges
2. `APIKeyUser` - 39 edges
3. `BearerTokenAuthentication` - 35 edges
4. `PIAAuthentication` - 35 edges
5. `UploadedFile` - 35 edges
6. `ExportedResult` - 35 edges
7. `IsAuthenticatedWithAPIKey` - 33 edges
8. `CanGenerateLayouts` - 33 edges
9. `CanListLayouts` - 33 edges
10. `CanAccessExports` - 33 edges

## Surprising Connections (you probably didn't know these)
- `Retro Polaroid Mask (4.2x3.5)` --related_to--> `Application Logo`  [AMBIGUOUS]
  storage/masks/retro_polaroid_4.2x3.5-with_mask_mask.png → frontend/nextjs/public/logo.png
- `Django Backend` --uses--> `Pillow Renderer`  [EXTRACTED]
  README.md → CLAUDE.md
- `Django Backend` --depends_on--> `PostgreSQL`  [EXTRACTED]
  README.md → docker-compose.yml
- `Django Backend` --depends_on--> `Redis`  [EXTRACTED]
  README.md → docker-compose.yml
- `nginx Edge Proxy` --uses--> `Django Backend`  [EXTRACTED]
  docker-compose.yml → README.md

## Import Cycles
- None detected.

## Communities (108 total, 20 thin omitted)

### Community 0 - "Canvas Data & Render Jobs"
Cohesion: 0.12
Nodes (53): CanvasData, Persisted canvas design for async rendering and editor state recovery., Async rendering job status and results., RenderJob, CanAccessExports, CanGenerateLayouts, CanListLayouts, IsAuthenticatedWithAPIKey (+45 more)

### Community 1 - "Calendar Layout Engine"
Cohesion: 0.08
Nodes (48): date, display_label_for(), materialize_surfaces(), Server-side helpers for the calendar product type (CALENDAR_FEATURE_PRD.md §10 +, 1 for English (Jan), 4 for Financial (Apr)., Resolve a (year, month) pair for a given (surface, primitive) position.      The, ZIP-filename-friendly month/year label (PRD §11.6)., Expand a calendar template into a list of concrete surfaces.      Args: (+40 more)

### Community 2 - "Calendar Cell Upload"
Cohesion: 0.07
Nodes (39): ALLOWED_MIMES, CalendarCellUploadError, uploadCalendarCellImage(), UploadCalendarCellImageOptions, UploadCalendarCellImageResult, validateCellImageFile(), cropMemo, CropResult (+31 more)

### Community 3 - "App Shell & Auth Wrapper"
Cohesion: 0.06
Nodes (32): AppWrapper(), AuthProvider(), AuthProviderProps, Header(), LayoutSVG(), LayoutSVGProps, ServiceWorkerRegistration(), HeaderContext (+24 more)

### Community 4 - "Calendar Validators & Tests"
Cohesion: 0.10
Nodes (43): File validators for upload validation. Validates file size, type, and content fo, Validate the calendar-specific fields on a layout JSON.      Invoked from Layout, validate_calendar_layout(), _assert_raises(), _good_layout(), _poster_layout(), Unit tests for api.validators.validate_calendar_layout (CALENDAR_FEATURE_PRD.md, x=0.8 + width=0.5 → 1.3 lands past the canvas's right edge. (+35 more)

### Community 5 - "Django Admin & API Models"
Cohesion: 0.08
Nodes (19): APIRequestAdmin, ExportedResultAdmin, Display generation time., Exports are tracked automatically., Requests are created automatically., Only superusers can delete., Display file size in human readable format., Files are tracked automatically. (+11 more)

### Community 6 - "Auth & API Key Auth"
Cohesion: 0.10
Nodes (28): BearerTokenAuthentication, PIAAuthentication, Custom authentication class for bearer token validation.     Validates API keys, Custom authentication class for PIA token validation.     Verifies tokens agains, CalendarStylesView, _holiday_path(), HolidaysView, Write fonts config to disk and invalidate the cache. (+20 more)

### Community 7 - "Pillow Layout Engine"
Cohesion: 0.07
Nodes (22): Load a mask image from its URL path, or return None., Convert normalized (0–1) frame coordinates to pixels.          JSON-defined layo, Extract a single-surface definition from a legacy (non-product) layout JSON., Replace filesystem-unsafe characters in a label; trim & collapse spaces., Yield (batch, n) for each image batch in this surface.         n is 1-indexed an, Delete partial output files left on disk by a multi-surface render         that, Write image data to disk atomically using .tmp → rename pattern., Generate export files for a single surface.         Returns a list of output fil (+14 more)

### Community 8 - "Canvas Editor UI"
Cohesion: 0.13
Nodes (24): ColorPicker(), ColorPickerProps, CanvasEditorModalProps, FabricEditor, ADD_TABS, CanvasEditorSidebar(), CanvasEditorSidebarProps, TabKey (+16 more)

### Community 9 - "Storage & Chunked Upload"
Cohesion: 0.07
Nodes (11): BinaryIO, LocalStorage, Storage abstraction layer.  Switch between local-disk and cloud (S3 / GCS) by se, Abstract base — every method must be implemented by concrete backends., Save an uploaded file and return its storage path / key., Return raw bytes for an uploaded file., Delete a single file.  Returns True on success., Return a staging location for chunk parts.  Local: a directory.         S3: a pr (+3 more)

### Community 10 - "Calendar Layout Editor"
Cohesion: 0.10
Nodes (19): CalendarFabricPreview, CalendarLayoutDraft, CalendarLayoutEditor(), CalendarMode, draftToLayoutJson(), modeToCounts(), MonthOverrideModalProps, STEP_LABELS (+11 more)

### Community 11 - "Editor Page & Image Utils"
Cohesion: 0.09
Nodes (23): LazyImg, LazyImgProps, detectJpegColorSpace(), getImageMetadata(), isImageComplete(), loadImageElement(), metadataCache, CanvasSpec (+15 more)

### Community 12 - "Calendar Fabric Preview"
Cohesion: 0.10
Nodes (20): CalBlock, CalendarFabricPreviewProps, CalFrame, MONTH_SHORT, LayoutFabricPreviewProps, LayoutFrame, AligningGuidelinesOptions, applySnapToGrid() (+12 more)

### Community 13 - "Login & Rate Limiting"
Cohesion: 0.11
Nodes (14): attempts, checkRateLimit(), clientIp(), googleLoginAction(), loginAction(), pruneRateLimit(), DecodedToken, GoogleDomainNotAllowedError (+6 more)

### Community 14 - "Orientation Detection & Holidays"
Cohesion: 0.11
Nodes (21): Path, fetch_nager(), _find_storage_root(), main(), merge_events(), normalize_nager_event(), Map a Nager.Date event into our schema., Merge fetched events into existing, keyed by (date, name).      Custom existing (+13 more)

### Community 15 - "Calendar Product Preview"
Cohesion: 0.11
Nodes (14): CAL_TYPE_OPTIONS, CalendarProductPreview(), CalendarProductPreviewProps, CalendarTypeToggleProps, countOrphanedEntries(), FlipWarningModalProps, GenZPaletteSwatchesProps, THEME_OPTIONS (+6 more)

### Community 16 - "TypeScript Config"
Cohesion: 0.09
Nodes (22): compilerOptions, allowJs, esModuleInterop, forceConsistentCasingInFileNames, incremental, isolatedModules, jsx, lib (+14 more)

### Community 17 - "Calendar Renderer & Parity Tests"
Cohesion: 0.17
Nodes (22): build_month_grid(), Build 35- or 42-cell month grid. Each cell: {iso, year, month, day,     dayOfWee, _case(), _load_parity_fixtures(), Unit tests for services.calendar_renderer + services.calendar_holidays (CALENDAR, Jan 1 2026 is a Thursday; check first row + Sunday leading-blanks., Pick a month known to span 6 rows: May 2026 (May 1 = Friday)., Dec 2025 + Sunday-start: trailing cells should land in January 2026. (+14 more)

### Community 18 - "Month Tile Thumbnails"
Cohesion: 0.15
Nodes (16): DotInfo, MonthTileThumb(), ThumbColors, buildMonthGrid(), isoFromDate(), mergeCellEntries(), weekdayHeaderLabels(), appendPill() (+8 more)

### Community 19 - "Pillow Calendar Cell Renderer"
Cohesion: 0.12
Nodes (20): ImageDraw, _draw_cell_image(), _draw_pill(), _hex_to_rgba(), Server-side calendar grid renderer (CALENDAR_FEATURE_PRD.md §5 Phase 4).  Draws, Merge layout style block + active Gen-Z palette + defaults.     Result has every, Draw a customer's image override into a cell (PRD §4.2.2 — replaces the     whol, Draw a single rounded-rect pill with a dot + auto-fit text. (+12 more)

### Community 20 - "Module Group 20"
Cohesion: 0.17
Nodes (16): Image, Pre-shrink source image to 2× the frame dimensions before compositing., Composite one canvas from a batch of image file paths.         Returns a flat RG, _draw_shape(), _draw_text(), _parse_color(), _paste_image(), Server-side overlay renderer (Phase 1 of CALENDAR_FEATURE_PRD.md §5).  Fixes a p (+8 more)

### Community 21 - "Module Group 21"
Cohesion: 0.11
Nodes (19): devDependencies, autoprefixer, class-variance-authority, eslint, eslint-config-next, @happy-dom/jest-environment, jest, jest-environment-jsdom (+11 more)

### Community 22 - "Module Group 22"
Cohesion: 0.12
Nodes (6): Trim a full layout def down to the fields an external catalog/picker needs., Read the SKU → layout mapping with a 5-minute Redis cache., Get render job status by job_id., Get Celery worker and queue statistics., _read_sku_layouts(), _summarize_layout()

### Community 23 - "Module Group 23"
Cohesion: 0.20
Nodes (13): HOLIDAYS_2026, SEED_CELLS, STUB_PALETTES, CalendarEditPanel(), CalendarEditPanelProps, formatLongDate(), CalendarLayoutEditorProps, MonthTileThumbProps (+5 more)

### Community 24 - "Module Group 24"
Cohesion: 0.14
Nodes (13): Button, ButtonProps, buttonVariants, Card, CardContent, CardDescription, CardFooter, CardHeader (+5 more)

### Community 25 - "Module Group 25"
Cohesion: 0.15
Nodes (14): ApiConfig, AppConfig, ImageFont, _autofit_text(), Binary-search for the largest font size that fits `text` inside `max_w`.     Ret, get_font(), _load_font(), Server-side font loader for the Pillow-based overlay + calendar renderer.  Per P (+6 more)

### Community 26 - "Module Group 26"
Cohesion: 0.15
Nodes (14): surfaceMonthList(), countLeapDayOrphans(), CellEntry, displayLabelFor(), GridCell, MINIMALIST_COLORS, resolveBaseYear(), resolveDefaultYear() (+6 more)

### Community 27 - "Module Group 27"
Cohesion: 0.18
Nodes (15): centerCanvasViewport(), changeDpiDataUrl(), createShapeFromOverlay(), updateRelativeClipPath(), getShapeDef(), getShapePath(), calculateSmartCropOffsets(), renderCanvas() (+7 more)

### Community 28 - "Module Group 28"
Cohesion: 0.14
Nodes (8): APIRequestLoggingMiddleware, RateLimitMiddleware, API Middleware Contains logging and rate limiting for API requests., Middleware for logging API requests, Rate limiting using Django cache backend.      Works correctly across multiple G, MiddlewareMixin, ProxyAuthenticationMiddleware, Ensure /admin/* is reached only via the edge proxy (nginx), never via a     dire

### Community 29 - "Module Group 29"
Cohesion: 0.16
Nodes (14): _build_uploaded_files_map(), _extract_calendar_state(), _extract_frame_transforms(), _extract_overlays_per_canvas(), garbage_collector_task(), notify_caller_webhook_task(), Celery tasks for asynchronous image generation., Build { upload_id → server file path } for image overlays referenced     by this (+6 more)

### Community 30 - "Module Group 30"
Cohesion: 0.23
Nodes (5): List layouts or get a specific layout's JSON., Create or update a layout JSON file., Delete a layout JSON file., Validate layout name to prevent path traversal.         Layout names should be a, get_storage()

### Community 31 - "Module Group 31"
Cohesion: 0.14
Nodes (14): Application Favicon, Application Logo, Arrow Right Icon, Check Icon, Circle Icon, Close / X Icon, Heart Icon, Square Icon (+6 more)

### Community 32 - "Module Group 32"
Cohesion: 0.21
Nodes (13): check_database(), check_dependencies(), check_python_version(), collect_static_files(), main(), Check Python version compatibility, Main startup function, Check required dependencies (+5 more)

### Community 33 - "Module Group 33"
Cohesion: 0.14
Nodes (14): dependencies, clsx, exifreader, fabric, jose, jszip, lucide-react, next (+6 more)

### Community 34 - "Module Group 34"
Cohesion: 0.16
Nodes (13): invalidate_cache(), load_holidays_for_year(), Disk-backed holiday loader for the server-side calendar renderer (CALENDAR_FEATU, Clear the holiday-file cache. Called after PUT/DELETE in HolidaysView., Return the on-disk path for (locale, year), or None if inputs are unsafe., LRU-cached disk read. Returns a tuple so the value is hashable / immutable., Public API: return the events list for (locale, year), or [] on miss.      Args:, _read_holiday_file() (+5 more)

### Community 35 - "Module Group 35"
Cohesion: 0.14
Nodes (14): _merge_cell_pills(), Apply §11.14 user-first + §11.10 hard cap.     Returns up to 3 pills: [{text, do, User entries fill first; holidays take any remaining slots (§11.14)., Anything past MAX_ENTRIES_PER_CELL is silently suppressed (§11.10)., If user has 3 entries on a holiday day, holiday is suppressed entirely., Holiday without `color` falls back to monthText / black., Whitespace-only / missing text user entries don't consume a slot., test_merge_pills_hard_cap_of_three() (+6 more)

### Community 36 - "Module Group 36"
Cohesion: 0.16
Nodes (12): FixtureCase, FixtureFile, FIXTURES_PATH, CalendarState, CalendarStylePresetFile, DotCycle, HolidayLocale, HolidaySource (+4 more)

### Community 37 - "Module Group 37"
Cohesion: 0.18
Nodes (13): Celery Worker, Chunked Upload API, Django Backend, Fabric.js Canvas, IndexedDB File Store, MediaPipe Auto-Orientation, Next.js Frontend, nginx Edge Proxy (+5 more)

### Community 38 - "Module Group 38"
Cohesion: 0.20
Nodes (12): ERP Status Webhook, Estimator (In-Store POS), Migration Roadmap, OpenTelemetry + Grafana Stack, PlatformUser, Printo.in Flask Monolith, printo_integration.py, RudderStack CDP (+4 more)

### Community 39 - "Module Group 39"
Cohesion: 0.17
Nodes (12): scripts, build, clean, dev, dev:clean, lint, lint:fix, start (+4 more)

### Community 40 - "Module Group 40"
Cohesion: 0.18
Nodes (7): EmbedSession, Short-lived session token for embedding the editor in external sites.      Exter, _AnyContentTypeParser, HealthView, DRF parser that matches any Content-Type without consuming the body.      Return, Health check endpoint - public access., BaseParser

### Community 41 - "Module Group 41"
Cohesion: 0.25
Nodes (10): _make_sample_canvas(), _make_sample_image_overlay_file(), Smoke test for services.overlay_renderer (CALENDAR_FEATURE_PRD.md §5, Phase 1)., Regression guard: confirm `_composite_canvas` skips the new overlay path     ent, Synthetic 5×7 @ 300 DPI canvas with a soft gradient background., Drop a tiny RGBA sticker to disk so the image overlay path exercises., test_engine_short_circuits_when_overlays_none(), test_no_overlays_is_a_noop() (+2 more)

### Community 42 - "Module Group 42"
Cohesion: 0.36
Nodes (9): COMPOSE_FILE, print_action(), print_error(), print_header(), print_info(), print_status(), print_warning(), usage() (+1 more)

### Community 43 - "Module Group 43"
Cohesion: 0.22
Nodes (4): Generate a secure random API key., Create a new API key., BaseCommand, Command

### Community 44 - "Module Group 44"
Cohesion: 0.31
Nodes (8): handler(), ALLOWED_PATH_PREFIXES, CacheEntry, evictExpired(), isPathAllowed(), resolveSession(), SessionInfo, tokenCache

### Community 45 - "Module Group 45"
Cohesion: 0.22
Nodes (8): name, brace-expansion@>=4.0.0, picomatch@>=4.0.0, yaml, pnpm, overrides, private, version

### Community 46 - "Module Group 46"
Cohesion: 0.25
Nodes (4): Read the fonts config from disk, with a 5-minute Redis cache., Validate layout name., Ensure path is within allowed directory (prevents path traversal)., _read_fonts()

### Community 47 - "Module Group 47"
Cohesion: 0.25
Nodes (4): Always async — order_id is mandatory.          Webhook callbacks are configured, Handle async generation request - enqueue job and return immediately., Enqueue render task to Celery and update the job record with the Celery task ID., Estimate seconds until a newly-enqueued job will start processing.          Take

### Community 48 - "Module Group 48"
Cohesion: 0.25
Nodes (8): Calendar Layout Service, Calendar Renderer, Fonts Service, Inter Variable Font, Layout Engine, smartcrop, Overlay Renderer, Smart Crop

### Community 49 - "Module Group 49"
Cohesion: 0.36
Nodes (6): SHAPE_CATALOG, ShapeDef, CATEGORIES, ShapesPicker(), ShapesPickerProps, ShapeOverlay

### Community 50 - "Module Group 50"
Cohesion: 0.46
Nodes (7): print_action(), print_error(), print_header(), print_info(), print_status(), print_warning(), reset-db.sh script

### Community 51 - "Module Group 51"
Cohesion: 0.29
Nodes (4): APIKeyAdmin, Show only the trailing 4 characters — avoids leaking significant         key mat, Only superusers can add keys., Only superusers can delete keys.

### Community 52 - "Module Group 52"
Cohesion: 0.33
Nodes (7): APIKey, Embed Proxy, Embed Session, HMAC-SHA256 Webhook, notify_caller_webhook_task, Printo.in Storefront, ZIP Download

### Community 53 - "Module Group 53"
Cohesion: 0.29
Nodes (5): Validate an image file for upload., Validate a list of image files., validate_image_file(), validate_image_files(), Handle synchronous generation request - backward compatible.

### Community 54 - "Module Group 54"
Cohesion: 0.52
Nodes (6): log_error(), log_header(), log_info(), log_success(), log_warning(), fresh-install.sh script

### Community 55 - "Module Group 55"
Cohesion: 0.29
Nodes (6): AlignmentToolbar(), AlignmentToolbarProps, H_ITEMS, HAlign, V_ITEMS, VAlign

### Community 56 - "Module Group 56"
Cohesion: 0.62
Nodes (6): bad(), check_proxy_path(), ok(), skip(), step(), smoke-test-calendar.sh script

### Community 57 - "Module Group 57"
Cohesion: 0.33
Nodes (4): ExportedResult, Model to track generated exports for analytics and user management., ConfigView, Public runtime-config endpoint — exposes a handful of settings the     browser n

### Community 58 - "Module Group 58"
Cohesion: 0.33
Nodes (4): LayoutManagementView, View to manage layout JSON files - requires Ops Team permissions., Validate layout name for security., Ensure path is within the intended directory.

### Community 59 - "Module Group 59"
Cohesion: 0.40
Nodes (6): Calendar Feature, CalendarState, CanvasData, EditorRenderView, render_canvas_task, RenderJob

### Community 60 - "Module Group 60"
Cohesion: 0.40
Nodes (5): API Gateway, Auth0 Identity (Mumbai), DPDP Act Compliance, AWS SNS+SQS Event Bus, Unified Customer Service

### Community 61 - "Module Group 61"
Cohesion: 0.40
Nodes (4): _list_calendar_styles(), Return [{name, label}] for every calendar style on disk., Read a single calendar style JSON. Returns None if missing/invalid., _read_calendar_style()

### Community 62 - "Module Group 62"
Cohesion: 0.40
Nodes (5): GiftRecipient, Hardcoded JWT Secret Key, PIA Delivery Dispatch, PIA Auth & Delivery System, Printose Corporate Gifting

### Community 63 - "Module Group 63"
Cohesion: 0.70
Nodes (4): bad(), ok(), step(), smoke-test-embed.sh script

### Community 64 - "Module Group 64"
Cohesion: 0.40
Nodes (5): Returns a 3-slot cycle for user-entry dot colours., _resolve_dot_cycle(), test_resolve_dot_cycle_default_when_nothing_set(), test_resolve_dot_cycle_palette_wins(), test_resolve_dot_cycle_style_fallback()

### Community 65 - "Module Group 65"
Cohesion: 0.40
Nodes (4): GoogleIdButtonOptions, GoogleIdConfiguration, GoogleIdCredentialResponse, Window

### Community 66 - "Module Group 66"
Cohesion: 0.50
Nodes (3): Check if file path is safe (no traversal attempts)., Secure file serving endpoint for exports.     Requires authentication and checks, SecureExportDownloadView

### Community 68 - "Module Group 68"
Cohesion: 0.50
Nodes (3): Canvas, FabricObject, StaticCanvas

### Community 69 - "Module Group 69"
Cohesion: 0.50
Nodes (3): JWT, Session, User

## Ambiguous Edges - Review These
- `Application Logo` → `Retro Polaroid Mask (4.2x3.5)`  [AMBIGUOUS]
  storage/masks/retro_polaroid_4.2x3.5-with_mask_mask.png · relation: related_to

## Knowledge Gaps
- **258 isolated node(s):** `Migration`, `Migration`, `Migration`, `Migration`, `Migration` (+253 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Application Logo` and `Retro Polaroid Mask (4.2x3.5)`?**
  _Edge tagged AMBIGUOUS (relation: related_to) - confidence is low._
- **Why does `LayoutEngine` connect `Canvas Data & Render Jobs` to `Module Group 66`, `Auth & API Key Auth`, `Pillow Layout Engine`, `Module Group 40`, `Module Group 20`, `Module Group 53`, `Module Group 57`, `Module Group 58`, `Module Group 29`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **Why does `render_calendar()` connect `Pillow Calendar Cell Renderer` to `Module Group 64`, `Module Group 35`, `Calendar Renderer & Parity Tests`, `Module Group 20`, `Module Group 25`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `materialize_surfaces()` connect `Calendar Layout Engine` to `Module Group 34`, `Pillow Layout Engine`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Are the 27 inferred relationships involving `LayoutEngine` (e.g. with `render_canvas_task()` and `_AnyContentTypeParser`) actually correct?**
  _`LayoutEngine` has 27 INFERRED edges - model-reasoned connections that need verification._
- **Are the 32 inferred relationships involving `APIKeyUser` (e.g. with `APIKey` and `CanAccessExports`) actually correct?**
  _`APIKeyUser` has 32 INFERRED edges - model-reasoned connections that need verification._
- **Are the 27 inferred relationships involving `BearerTokenAuthentication` (e.g. with `APIKey` and `_AnyContentTypeParser`) actually correct?**
  _`BearerTokenAuthentication` has 27 INFERRED edges - model-reasoned connections that need verification._