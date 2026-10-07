'use client';

/**
 * /layout/[name]  —  Canvas editor page
 */

import React, {
  useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useHeader } from '@/context/HeaderContext';
import {
  Upload, Loader2, CheckCircle2, Check, X,
  Layout,
  SendHorizonal, RotateCw, Maximize, Download, Trash2,
  AlertTriangle, ImagePlus, ArrowLeftRight, Droplets, ArrowLeft, Plus,
  // Palette, Move, Lock: only used by the hidden Set-BG-Color and
  // reposition-lock buttons (commented-out JSX below); re-add them if those
  // come back.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  Palette, Move, Lock,
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  uploadFiles,
  unsupportedFilesMessage,
  isAllowedImageFile,
  IMAGE_AND_PDF_ACCEPT_ATTR,
} from '@/lib/upload-utils';
import { convertHeicFileIfNeeded, convertAndPartitionFiles, isHeicFile, createServerHeicConverter } from '@/lib/heic-convert';
import { pdfDerivedFiles } from '@/lib/pdf-import';
import { usePdfPageImport } from '@/components/use-pdf-page-import';
import {
  saveFile, deleteFile, getFilesForOrder, pruneStaleOrders, pruneUnreferencedFiles,
  FileStoreQuotaError, getPersistenceMode,
} from '@/lib/file-store';
import { collectFileIds, unreferencedFileIds } from './file-refs';
import { LazyImg } from '@/components/LazyImg';
import CanvasCardSkeleton from '@/components/CanvasCardSkeleton';
import { normalizeLayout, filterSurfaces, getCanvasSpec, getFrames, type NormalizedLayout } from '@/lib/layout-utils';
import { getImageMetadata, getImageSize, detectJpegColorSpace, isImageComplete } from '@/lib/image-utils';
import { collectLowDpiFrames, type LowDpiFrame } from '@/lib/dpi-utils';
import { planCanvasReuse, countCanvasesLosingEdits } from './canvas-merge';
import {
  allocateFilesToSurfaces, planFrameSlots, surfaceFrameCount, totalSurfaceCapacity,
} from './surface-allocation';
import {
  collectEmptySurfaces, collectDuplicateFills, duplicateFingerprint, checkOrderQty,
} from '@/lib/submit-guards';
import type { FitMode, FrameState, CanvasItem, SurfaceState, Overlay } from './types';
import { renderCanvas as renderCanvasCore, calculateSmartCropOffsets } from './fabric-renderer';
import { detectFileOrientation } from '@/lib/ml-orientation';
import { CanvasEditorModal } from './CanvasEditorModal';
import { CalendarProductPreview } from '@/components/CalendarProductPreview';
import { CalendarEditPanel } from '@/components/CalendarEditPanel';
import { GoogleFontLinks, useGoogleFonts } from '@/components/GoogleFontLinks';
import type { CalendarTheme, CalendarType, GenzPalette, HolidayEntry } from '@/types/calendar';
import { printedHolidayLocale, resolveDefaultYear } from '@/lib/calendar';
import {
  uploadCalendarCellImage,
  CalendarCellUploadError,
} from '@/lib/calendar-cell-upload';
import { reconcilePageCount, roleForSurfaceKey } from './book-pages';
import { pageCountBounds, resolvePageCount, pagesToSpreads, spineWidthMm, type BookLayoutLike } from '@/lib/book-layout';
import {
  resolveRotation, formatWait, formatLayoutDisplayName,
  MAX_SKELETON_CARDS, ORPHAN_FILE_MIN_AGE_MS, NO_HOLIDAYS, readCardCountHint, writeCardCountHint, activatesCard,
} from './editor-utils';
import { EmbedSubmittedOverlay } from './EmbedSubmittedOverlay';
import { ImpositionModal } from './ImpositionModal';
import { useImposition } from './useImposition';
import { AutoFillPickerDialog } from './dialogs/AutoFillPickerDialog';
import { BookOverflowDialog } from './dialogs/BookOverflowDialog';
import { DeleteConfirmDialog } from './dialogs/DeleteConfirmDialog';
import { DownloadOptionsDialog } from './dialogs/DownloadOptionsDialog';
import { EmbedDisclaimerDialog } from './dialogs/EmbedDisclaimerDialog';
import { OverQuantityDialog } from './dialogs/OverQuantityDialog';
import { RepickConfirmDialog } from './dialogs/RepickConfirmDialog';
import { TruncatedImagesDialog } from './dialogs/TruncatedImagesDialog';

export default function LayoutEditorPage() {
  const params = useParams();
  const layoutName = Array.isArray(params.name) ? params.name[0] : (params.name as string);
  const router = useRouter();
  const { data: session, status } = useSession();

  const embedToken = useMemo<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('token');
  }, []);

  // Resolve the parent window's origin for postMessage. Strict targetOrigin
  // prevents an unrelated outer page from eavesdropping on completion payloads
  // (which include order_id, job_id, and dataUrls for client-rendered jobs).
  // Resolution order: ancestorOrigins (Chromium/Safari) → document.referrer
  // → NEXT_PUBLIC_EMBED_PARENT_ORIGIN env. Falls back to a defaulted printo.in
  // host so production never silently leaks via '*'.
  const parentOrigin = useMemo<string>(() => {
    if (typeof window === 'undefined') return 'https://printo.in';
    const ancestors = (window.location as unknown as { ancestorOrigins?: { length: number; [i: number]: string } }).ancestorOrigins;
    if (ancestors && ancestors.length > 0 && ancestors[0]) return ancestors[0];
    if (document.referrer) {
      try { return new URL(document.referrer).origin; } catch { /* fall through */ }
    }
    return process.env.NEXT_PUBLIC_EMBED_PARENT_ORIGIN || 'https://printo.in';
  }, []);

  // Quantity enforcement (single-surface only). Two sources, in priority order:
  //
  //   1. EmbedSession.qty — set by the caller server-side, injected upstream as
  //      X-Order-Qty and echoed back by /editor/init below. This is the number
  //      POST /api/editor/render actually enforces, so it is the one the editor
  //      must cap against.
  //   2. the legacy ?qty=N URL param, kept as a fallback so callers that have
  //      not moved the value into the session body keep working during rollout.
  //      It lives in a URL the customer's browser owns, which is precisely why
  //      (1) exists — nothing server-side honours it.
  const urlQty = useMemo<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const v = new URLSearchParams(window.location.search).get('qty');
    const n = v ? parseInt(v, 10) : NaN;
    return isNaN(n) || n <= 0 ? null : n;
  }, []);
  const [sessionQty, setSessionQty] = useState<number | null>(null);
  const orderQty = sessionQty ?? urlQty;

  // Stable order ID — read from URL or generate a new friendly ID.
  // Written back to the URL immediately so a refresh / share keeps the same ID.
  const [orderId, setOrderId] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const sp = new URLSearchParams(window.location.search);
    let id = sp.get('order_id');
    if (!id) {
      // Generate PE-XXXXXXXX (8 uppercase hex chars)
      const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      id = `PE-${hex}`;
    }
    return id;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !orderId) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('order_id') !== orderId) {
      sp.set('order_id', orderId);
      window.history.replaceState(null, '', `?${sp.toString()}`);
    }
  }, [orderId]);

  // Two distinct request paths, deliberately kept separate:
  //
  //   1. EMBED iframe flow → /api/embed/proxy/* with X-Embed-Token header.
  //      The proxy exchanges the short-lived UUID token for the real API key
  //      server-side; the browser never holds a real key.
  //
  //   2. PIA-LOGGED-IN dashboard/editor flow → /api/internal/proxy/* with no
  //      auth header at all.  The proxy uses the NextAuth session cookie to
  //      gate access and injects the server-side INTERNAL_API_KEY.  The
  //      browser never holds a real key here either — replacing the previous
  //      NEXT_PUBLIC_DIRECT_API_KEY which leaked into the client bundle.
  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (embedToken) return { 'X-Embed-Token': embedToken };
    // Internal proxy reads the session cookie automatically; no header needed.
    return {};
  }, [embedToken]);

  const apiBase = embedToken ? '/api/embed/proxy' : '/api/internal/proxy';

  // Last-resort HEIC decoder, running current libheif on the server. Needed
  // because the in-browser decoders cannot read the gain-map HDR photos
  // current iPhones write, and Chrome/Firefox have no HEIC codec at all.
  // Routed through whichever proxy this flow already uses, so the embed
  // iframe never sees an API key. See lib/heic-convert.ts.
  const serverHeicConvert = useMemo(
    () => createServerHeicConverter(apiBase, getAuthHeaders),
    [apiBase, getAuthHeaders],
  );

  const [layout, setLayout] = useState<any | null>(null);
  const [layoutLoading, setLayoutLoading] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  // Separate from isProcessing (which is coupled to the renderProgress bar) —
  // true only while an iPhone HEIC photo is being decoded to JPEG client-side.
  const [heicConverting, setHeicConverting] = useState(false);
  const [renderProgress, setRenderProgress] = useState<{ current: number; total: number } | null>(null);
  const [canvases, setCanvases] = useState<CanvasItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  // ── Restore placeholders ────────────────────────────────────────────────
  // `order_id` is written into the URL on first mount, so its presence at
  // startup means this is a revisit and a restore may be inbound. Knowing that
  // synchronously — before any fetch — lets the grid show skeletons instead of
  // the "No images selected" empty state, which otherwise claims the customer's
  // design is gone for the ~2s the restore takes. Cleared on every exit path of
  // the restore effect, including the 404 "nothing saved" case.
  const [restorePending, setRestorePending] = useState<boolean>(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('order_id')
  );
  // The autosave gate — deliberately NOT restorePending. That one only starts
  // true when `order_id` is already in the URL, and the embed iframe URL never
  // carries it (the id is adopted from the session after mount), so in the
  // customer flow it started false and autosave could PUT pre-restore state
  // over a saved design. This starts false for everyone and flips once, in the
  // restore effect's `finally`. The ref mirrors it for the debounced writer.
  const [restoreSettled, setRestoreSettled] = useState(false);
  const restoreSettledRef = useRef(false);
  // Card count from the last visit, so the placeholder count is right on the
  // first paint rather than snapping when the payload lands. Purely cosmetic —
  // any failure just falls back to a default.
  const [restoreCount, setRestoreCount] = useState<number>(() => readCardCountHint());
  const [globalFitMode, setGlobalFitMode] = useState<FitMode>('contain');
  // Blur Effect defaults ON — fills the empty space around a photo with a
  // blurred copy so near-square products (e.g. polaroid) look filled without
  // laying the photo sideways.
  const [globalBlurFill, setGlobalBlurFill] = useState(true);
  const blurFillUserToggledRef = useRef(false);
  const globalBlurFillRef = useRef(true);
  // True only when the customer clicked the Fit/Cover toggle — gates the
  // smartcrop-recompute effect so programmatic fit-mode changes (restore,
  // surface switch) can't wipe manual pans (Phase 3).
  const fitModeUserToggledRef = useRef(false);
  const globalFitModeRef = useRef<FitMode>(globalFitMode);
  useEffect(() => {
    globalFitModeRef.current = globalFitMode;
    globalBlurFillRef.current = globalBlurFill;
  }, [globalFitMode, globalBlurFill]);

  // ── Reposition mode: drag-to-pan the photo inside a grid card ──────────────
  // Off by default so a stray drag can't shift a photo. Global (all canvases),
  // matching the Fit/Cover control it sits next to.
  // setRepositionMode: kept for the hidden reposition-lock toggle button
  // (see the commented-out JSX below) rather than deleted alongside it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [repositionMode, setRepositionMode] = useState(false);
  /** Live drag state, captured on pointerdown so pointermove stays synchronous. */
  const panRef = useRef<{
    pointerId: number; idx: number; surfaceKey: string | null; frameIdx: number;
    startX: number; startY: number; startOffset: { x: number; y: number };
    ratioX: number; ratioY: number; panRoomX: number; panRoomY: number; moved: boolean;
  } | null>(null);
  /** Serialises re-renders so out-of-order thumbnails can't land. */
  const panQueueRef = useRef<Promise<void>>(Promise.resolve());
  const panPendingRef = useRef<{ x: number; y: number } | null>(null);
  const panFlushScheduledRef = useRef(false);
  /** Set when a drag actually moved, so the card's onClick doesn't open the editor. */
  const panSuppressClickRef = useRef(false);

  const [activeCanvasIdx, setActiveCanvasIdx] = useState<number | null>(null);
  const [editingCanvas, setEditingCanvas] = useState<CanvasItem | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [serverRenderLabel, setServerRenderLabel] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [colorWarning, setColorWarning] = useState<string | null>(null);
  // Unsupported-file (e.g. .svg) notice. Its own channel — NOT `error` — so a
  // partial selection's "skipped" message survives generateCanvases()'s
  // setError(null). Self-clears on the next clean selection.
  const [unsupportedWarning, setUnsupportedWarning] = useState<string | null>(null);
  // Qty enforcement state
  const [qtyUnder, setQtyUnder] = useState<{ uploaded: number; needed: number } | null>(null);
  const [pendingOverFiles, setPendingOverFiles] = useState<File[] | null>(null);
  // Re-pick confirm (Phase 3): held selection + how many edited pages would
  // lose their work if it replaced the current photos.
  const [pendingRepick, setPendingRepick] = useState<{ files: File[]; losingCount: number } | null>(null);
  const repickConfirmedRef = useRef(false);
  // Tap-to-swap (Phase 3): the card picked as swap source; the next card
  // tap swaps instead of opening the editor. Touch has no HTML5 drag.
  const [swapSource, setSwapSource] = useState<{ idx: number; surfaceKey: string | null } | null>(null);
  // Per-frame photo replace (Phase 3): which slot the hidden input feeds.
  const [pendingReplace, setPendingReplace] = useState<{ canvasIdx: number; frameIdx: number; surfaceKey: string | null } | null>(null);
  const replacePhotoInputRef = useRef<HTMLInputElement | null>(null);
  // The client-generated id in play before the embed session id was adopted —
  // lets the restore effect fall back to a pre-adoption autosave once.
  const legacyOrderIdRef = useRef<string | null>(null);
  // Device storage full — photos can't be persisted for refresh recovery
  // (Phase 3 quota surfacing). Drives a persistent amber notice.
  const [persistDegraded, setPersistDegraded] = useState(false);
  // Browser blocked IndexedDB entirely (Safari ITP in a cross-site iframe /
  // private mode) — photos live in memory only for this tab (Phase 3).
  const [storageBlocked, setStorageBlocked] = useState(false);
  // Files flagged as truncated/incomplete by the client-side completeness check,
  // held pending the customer's Keep-anyway / Remove decision (see handleFileChange).
  const [pendingTruncated, setPendingTruncated] = useState<{ all: File[]; bad: File[] } | null>(null);
  // Book D3 overflow: more uploaded photos than the current page count can
  // hold. Held pending the customer's Extend / Keep-as-is decision, mirroring
  // pendingTruncated's pause-and-re-enter pattern — see processSelectedFiles.
  const [pendingBookOverflow, setPendingBookOverflow] = useState<{
    files: File[]; currentCapacity: number; suggestedCount: number;
  } | null>(null);
  // Set right before a decided batch re-enters processSelectedFiles so the
  // overflow check doesn't re-prompt for the same files a second time.
  const bookOverflowDecidedRef = useRef(false);
  const [showAutoFillPicker, setShowAutoFillPicker] = useState(false);
  const [pickerSelected, setPickerSelected] = useState<Set<number>>(new Set());
  const { expandPdfPages, pdfPickerElement } = usePdfPageImport();
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  // Include the customer's original uploads in the download ZIP — OFF by default
  // so the archive is just mock + print (much smaller/faster). The ref mirrors
  // it for the async download-URL builder below.
  const [includeUploads, setIncludeUploads] = useState(false);
  const includeUploadsRef = useRef(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  const [showEmbedDisclaimer, setShowEmbedDisclaimer] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Job id behind the embed post-submit status panel (Phase 3).
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);

  // WeakMap allows the File entry to be GC'd when the user removes a frame —
  // a Map would pin every File ever inserted for the lifetime of the page.
  // The parallel Set tracks created URL strings so unmount/cleanup can revoke
  // them (WeakMap isn't iterable).
  const fileUrlCache = useRef<WeakMap<File, string>>(new WeakMap());
  const createdObjectURLs = useRef<Set<string>>(new Set());
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextGenerateRef = useRef(false);

  // ── Canvas-state persistence ──────────────────────────────────────────────
  const [isSaving, setIsSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [dragOverIdx, setDragOverIdx] = useState<{ idx: number, surfaceKey: string | null } | null>(null);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Tracks the 3-second "saved → idle" indicator reset so it can be cancelled
  // on unmount and won't call setState on a dead component.
  const saveIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether we've attempted a restore on this page-load already.
  const restoredRef = useRef(false);
  // Set to true during restore so the resulting state-update doesn't trigger
  // a redundant auto-save of data we just loaded from the server.
  const isRestoringRef = useRef(false);

  /**
   * Strip un-serialisable File objects from a canvas item so it can be
   * stored as JSON.  The dataUrl is kept so the preview is still visible
   * after restore even though the original File is gone.
   */
  const serializeCanvasState = useCallback((items: CanvasItem[]) =>
    items.map(c => ({
      ...c,
      dataUrl: null, // strip base64 preview to reduce payload size — regenerate on restore
      frames: c.frames.map(f => ({ ...f, originalFile: null })),
      overlays: c.overlays.map(o => ({ ...o, originalFile: undefined })),
    }))
    , []);

  const [surfaceStates, setSurfaceStates] = useState<SurfaceState[]>([]);
  const [activeSurfaceKey, setActiveSurfaceKey] = useState<string>('default');

  // Ref-mirrors so the auto-save timeout closure always reads the latest values
  // without needing these in the effect deps (which would restart the debounce
  // on every surface update). Must be declared after the useState lines above.
  const surfaceStatesRef = useRef(surfaceStates);
  useEffect(() => { surfaceStatesRef.current = surfaceStates; }, [surfaceStates]);
  const activeSurfaceKeyRef = useRef(activeSurfaceKey);
  useEffect(() => { activeSurfaceKeyRef.current = activeSurfaceKey; }, [activeSurfaceKey]);
  const [normalizedLayoutState, setNormalizedLayoutState] = useState<NormalizedLayout | null>(null);

  // ── Book product state (BOOK_LAYOUT_PRD.md R1) ────────────────────────────
  // These only matter when layout.productType === 'book'. Page count is
  // CUSTOMER state (D2) — surfaceStates always holds exactly the currently
  // VISIBLE pages (cover, page_01..page_N, back_cover); pages shrunk out of
  // range are held in bookHiddenPages rather than discarded, and restored if
  // the count goes back up. See book-pages.ts::reconcilePageCount, the one
  // place this reconciliation happens (layout load / count change / restore).
  const isBookProduct = layout?.productType === 'book';
  const [bookPageCount, setBookPageCount] = useState<number>(0);
  const [bookHiddenPages, setBookHiddenPages] = useState<Record<string, SurfaceState>>({});
  const bookHiddenPagesRef = useRef(bookHiddenPages);
  useEffect(() => { bookHiddenPagesRef.current = bookHiddenPages; }, [bookHiddenPages]);

  // ── Stored-photo bookkeeping (file-store.ts) ─────────────────────────────
  // The persist effect patches fileIds into surfaceStates only, and the
  // canvases → surfaceStates sync copies the active surface's canvases (which
  // never got them) back over it on the next edit. Keyed by File, the same
  // photo gets its existing id back instead of being stored again — once per
  // edit before this, and once per frame for a qty auto-fill.
  const fileIdByFileRef = useRef(new WeakMap<File, string>());
  const fileSaveInFlightRef = useRef(new WeakMap<File, Promise<string>>());
  // Records this tab saved or restored: the only ones it may delete. Another
  // tab's records are invisible to it and so never deleted from here.
  const sessionFilesRef = useRef(new Map<string, File>());
  // A photo brought back after its record was deleted (modal undo) still
  // carries the old id; the persist effect stores it again.
  const deletedFileIdsRef = useRef(new Set<string>());

  /** Delete the records this tab owns that neither the design just saved nor
   *  the current state uses. Runs after a successful autosave, so the server's
   *  copy of the design never names a deleted photo. */
  const reclaimUnusedFiles = useCallback((savedState: unknown) => {
    const idOfFile = (b: Blob) => (b instanceof File ? fileIdByFileRef.current.get(b) : undefined);
    const unused = unreferencedFileIds(
      sessionFilesRef.current.keys(),
      [savedState, surfaceStatesRef.current, bookHiddenPagesRef.current],
      idOfFile,
    );
    for (const id of unused) {
      const file = sessionFilesRef.current.get(id);
      sessionFilesRef.current.delete(id);
      if (file && fileIdByFileRef.current.get(file) === id) fileIdByFileRef.current.delete(file);
      deletedFileIdsRef.current.add(id);
      void deleteFile(id);
    }
  }, []);

  // ── Calendar product state (PRD §10.3 / audit fix #1) ────────────────────
  // These only matter when layout.productType === 'calendar'. Initialised
  // with the layout-level defaults; customer overrides are tracked here.
  const isCalendarProduct = layout?.productType === 'calendar';
  const [calendarTheme, setCalendarTheme] = useState<CalendarTheme>('modern-minimalist');
  const [calendarType, setCalendarType] = useState<CalendarType>('english');
  const [genzPalette, setGenzPalette] = useState<string | undefined>(undefined);
  const [genzPalettes, setGenzPalettes] = useState<GenzPalette[]>([]);
  const [calendarHolidays, setCalendarHolidays] = useState<HolidayEntry[]>([]);
  // The print carries holidays only when the layout opts in; gated here as
  // well as at fetch time so a previous layout's holidays can never show.
  const printedHolidays = layout?.holidayLocale ? calendarHolidays : NO_HOLIDAYS;
  // Under-DPI frames for the low-resolution print warning (Phase 2 item 4).
  // Non-blocking: shows card pills + a pre-submit notice, never stops submit.
  const [lowDpiFrames, setLowDpiFrames] = useState<LowDpiFrame[]>([]);

  // Product-wide per-day entries, keyed by ISO date (flat map — Phase 2).
  // Entries belong to dates, not tile positions: the old 12-slot positional
  // array lost entries whenever photo-canvas count ≠ 12 and hid in-range
  // entries after an English↔Financial flip remapped slot→month.
  const [calendarCells, setCalendarCells] = useState<Record<string, any[]>>({});
  const [selectedCalendarCell, setSelectedCalendarCell] = useState<{
    surfaceIndex: number; year: number; month: number; iso: string;
  } | null>(null);
  // Phase 8 — cell image upload (calendar-cell-upload.ts orchestrator).
  // Hidden file input ref; result stored as blobUrl for instant preview.
  const calendarCellFileInputRef = useRef<HTMLInputElement | null>(null);
  const [calendarImageUploading, setCalendarImageUploading] = useState(false);
  // Key: iso date, value: blobUrl for preview thumbnail.
  // Blob URLs are revoked when the override is cleared or the page unmounts.
  const [calendarCellImagePreviews, setCalendarCellImagePreviews] = useState<Record<string, string>>({});

  const [selectedFonts, setSelectedFonts] = useState<string[]>(['sans-serif', 'serif', 'monospace']);
  const { fontsLoaded, loadGoogleFont } = useGoogleFonts();
  const [deleteConfirm, setDeleteConfirm] = useState<{ idx: number; surfaceKey: string | null } | null>(null);
  const { setTitle, setDescription, setCenterActions, setRightActions, headerHeight } = useHeader();

  // The toolbar switches to `position: fixed` once scrolled up to where it
  // would go under the fixed dashboard header — driven by this boolean, not
  // CSS `position: sticky`. Sticky's containing block is the toolbar's own
  // direct parent (the `.relative` wrapper below), and that parent is sized
  // to exactly the toolbar's own height — its only other child is a 1px
  // `absolute` sentinel, contributing none — so a sticky toolbar there can
  // only stay stuck for about one toolbar-height of scroll before its own
  // undersized container scrolls out from under it and drags the toolbar
  // away too, right off-screen under the header instead of stopping below
  // it. Confirmed by forcing that wrapper tall at runtime: sticky then held
  // correctly at any scroll depth. `fixed` has no containing-block-height
  // requirement, so it doesn't hit that trap.
  // The sentinel is held in state through a callback ref, like the toolbar
  // below: the toolbar renders only once the layout has loaded, after this
  // effect's first run, and with a plain ref nothing re-ran it once the
  // sentinel existed — so the toolbar never pinned (until 2026-10-07).
  const [toolbarSentinel, setToolbarSentinel] = useState<HTMLDivElement | null>(null);
  const [isToolbarStuck, setIsToolbarStuck] = useState(false);

  useEffect(() => {
    if (!toolbarSentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsToolbarStuck(!entry.isIntersecting),
      { rootMargin: `-${headerHeight + 1}px 0px 0px 0px`, threshold: 0 }
    );
    observer.observe(toolbarSentinel);
    return () => observer.disconnect();
  }, [headerHeight, toolbarSentinel]);

  // The floating qty banner has to clear BOTH bars above it. In the embed
  // iframe no app <header> is mounted at all (headerHeight is 0) and this
  // sticky toolbar is the only thing at the top of the viewport, so a
  // header-only offset would drop the banner straight on top of it. Measured
  // rather than hardcoded — the toolbar is one row on desktop and two on a
  // phone, and it re-flows as the window resizes. A callback ref so the
  // measurement starts the moment the toolbar mounts (it renders only after
  // the layout loads).
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  useLayoutEffect(() => {
    if (!toolbarEl) return;
    const measure = () => setToolbarHeight(Math.round(toolbarEl.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbarEl);
    return () => observer.disconnect();
  }, [toolbarEl]);

  useEffect(() => {
    if (embedToken) return;
    // Dashboard flow only — the embed iframe returns above, so a customer
    // inside printo.in's page never sees internal page naming.
    setTitle('Preview Canvas');
    setDescription('');
    setCenterActions(null);
    setRightActions(
      <button
        onClick={() => router.push('/dashboard')}
        aria-label="Back to templates"
        title="Back to Templates"
        className="text-[11px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-700 p-2.5 md:px-4 md:py-2 rounded-full md:rounded-2xl border-2 border-indigo-100/50 bg-indigo-50/30 hover:bg-indigo-50/60 transition-all flex items-center gap-2 group shadow-sm shadow-indigo-100/50"
      >
        <ArrowLeft className="w-4 h-4 md:w-3.5 md:h-3.5 group-hover:-translate-x-1 transition-transform" />
        <span className="hidden md:inline">Back to Templates</span>
      </button>
    );
  }, [embedToken, router, setTitle, setDescription, setCenterActions, setRightActions]);

  useEffect(() => {
    if ((status === 'unauthenticated' || session?.error === 'RefreshAccessTokenError') && !embedToken) {
      router.push('/login');
    }
  }, [status, session, embedToken, router]);

  // (Fonts are no longer fetched here — they're batched with the layout JSON
  //  in the single /editor/init request below.)

  useEffect(() => {
    selectedFonts.forEach(f => loadGoogleFont(f));
  }, [selectedFonts, loadGoogleFont]);

  useEffect(() => {
    const canFetch = embedToken || status === 'authenticated';
    if (!canFetch || !layoutName) return;

    const fetchLayout = async () => {
      setLayoutLoading(true);
      try {
        // C6 batched mount: one round trip for layout JSON + fonts list.
        // /editor/init re-uses GetLayoutView's cache, so no extra disk hit.
        const surfacesParam = new URLSearchParams(window.location.search).get('surfaces') || '';
        const initUrl = `${apiBase}/editor/init?layout=${encodeURIComponent(layoutName)}${surfacesParam ? `&surfaces=${encodeURIComponent(surfacesParam)}` : ''}`;
        const res = await fetch(initUrl, {
          headers: { ...getAuthHeaders(), Accept: 'application/json' },
        });
        if (!res.ok) {
          setError(res.status === 404 ? 'Layout not found.' : 'Failed to load layout.');
          return;
        }
        const payload = await res.json();
        const item = payload.layout;
        // Embed mode adopts the SESSION order id (Phase 3): the proxy injects
        // it upstream and editor/init echoes it, so autosave/restore and the
        // eventual submit all key the same server row — an iframe reload
        // without ?order_id= no longer orphans the design. Set BEFORE
        // setLayout so React batches them and the run-once restore effect
        // fires with the adopted id. Dashboard: payload.order_id is null.
        if (embedToken && typeof payload.order_id === 'string' && payload.order_id && payload.order_id !== orderId) {
          legacyOrderIdRef.current = orderId;
          setOrderId(payload.order_id);
        }
        // Adopt the SESSION quantity when the caller set one — it outranks the
        // ?qty=N URL param because it is what editor/render enforces. Absent
        // (null) leaves the URL fallback in place; the layout resolves before
        // any file pick, so this is set before the first qty comparison runs.
        if (typeof payload.qty === 'number' && Number.isInteger(payload.qty) && payload.qty > 0) {
          setSessionQty(payload.qty);
        }
        if (Array.isArray(payload.fonts) && payload.fonts.length) {
          setSelectedFonts(payload.fonts);
        }
        let normalized: NormalizedLayout;
        let initSurfaces: SurfaceState[];
        // A book's surfaces are the customer's chosen page count, not a
        // fixed list — normalizeLayout() has no concept of that, so build
        // surfaceStates via the same reconciliation used for every later
        // page-count change (book-pages.ts::reconcilePageCount), starting
        // from the template's default count (BOOK_LAYOUT_PRD.md D2/R1).
        if (item.productType === 'book') {
          const { visible, resolvedCount } = reconcilePageCount(item as BookLayoutLike, undefined, [], {});
          initSurfaces = visible;
          setBookPageCount(resolvedCount);
          setBookHiddenPages({});
          normalized = {
            name: item.name || '',
            type: 'product',
            surfaces: visible.map(s => s.def),
            tags: item.tags || [],
            createdAt: item.createdAt ?? null,
            updatedAt: item.updatedAt ?? null,
            createdBy: item.createdBy || '',
            updatedBy: item.updatedBy || '',
            metadata: item.metadata || [],
            _raw: item,
          };
        } else {
          normalized = normalizeLayout(item);
          if (surfacesParam) {
            normalized = filterSurfaces(normalized, surfacesParam.split(',').map(s => s.trim()));
          }
          initSurfaces = normalized.surfaces.map(s => ({
            key: s.key,
            label: s.label,
            def: s,
            files: [],
            canvases: [],
            globalFitMode: 'contain' as FitMode,
          }));
        }
        setNormalizedLayoutState(normalized);
        setSurfaceStates(initSurfaces);
        const firstKey = normalized.surfaces[0]?.key || 'default';
        setActiveSurfaceKey(firstKey);
        const firstSurface = normalized.surfaces[0];
        setLayout({
          id: item.name,
          name: item.name,
          productType: item.productType || null,
          dimensions: firstSurface?.canvas?.widthMm && firstSurface?.canvas?.heightMm
            ? `${firstSurface.canvas.widthMm.toFixed(2)}x${firstSurface.canvas.heightMm.toFixed(2)}mm` : null,
          height: firstSurface?.canvas?.height || 0,
          canvas: firstSurface?.canvas || {},
          frames: firstSurface?.frames || [],
          tags: item.tags || [],
          maskUrl: firstSurface?.maskUrl || null,
          maskOnExport: firstSurface?.maskOnExport ?? false,
          createdAt: item.createdAt || null,
          updatedAt: item.updatedAt || null,
          createdBy: item.createdBy || 'System',
          updatedBy: item.updatedBy || 'System',
          metadata: item.metadata || [],
          weekStart: item.calendar?.weekStart || 'sunday',
          // null when the print carries no holidays (holidaySource off/absent).
          holidayLocale: printedHolidayLocale(item.calendar),
          calendarDefaultYear: item.monthRange?.defaultYear ?? 'current',
        });
      } catch {
        setError('Failed to load layout.');
      } finally {
        setLayoutLoading(false);
      }
    };
    fetchLayout();
    // orderId is read only for the embed adoption comparison — including it
    // would re-fetch the layout every time the id is adopted (loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutName, embedToken, status, apiBase, getAuthHeaders]);

  const getFileUrl = useCallback((file: File): string => {
    let url = fileUrlCache.current.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      fileUrlCache.current.set(file, url);
      createdObjectURLs.current.add(url);
    }
    return url;
  }, []);

  useEffect(() => {
    const urls = createdObjectURLs.current;
    const timeout = renderTimeoutRef.current;
    return () => {
      urls.forEach(url => URL.revokeObjectURL(url));
      urls.clear();
      if (timeout) clearTimeout(timeout);
      // Cancel pending save / idle-reset timers so they don't call setState
      // on an unmounted component.
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (saveIdleTimeoutRef.current) clearTimeout(saveIdleTimeoutRef.current);
    };
  }, []);

  const activeSurface = surfaceStates.find(s => s.key === activeSurfaceKey) || surfaceStates[0];

  useEffect(() => {
    if (!activeSurface) return;
    setFiles(activeSurface.files);
    setCanvases(activeSurface.canvases);
    setGlobalFitMode(activeSurface.globalFitMode);
    // Keyed on activeSurfaceKey only — we want this to fire on surface
    // SWITCH, not on every surfaceStates mutation (which would clobber
    // in-progress edits with the stored snapshot).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSurfaceKey]);

  useEffect(() => {
    if (!activeSurface || surfaceStates.length === 0) return;

    // Check if we actually need to update surfaceStates to prevent unnecessary re-renders
    const currentSurface = surfaceStates.find(s => s.key === activeSurfaceKey);
    if (currentSurface && (
      currentSurface.files !== files ||
      currentSurface.canvases !== canvases
    )) {
      setSurfaceStates(prev => {
        const sIdx = prev.findIndex(s => s.key === activeSurfaceKey);
        if (sIdx === -1) return prev;
        const s = prev[sIdx];
        if (s.files === files && s.canvases === canvases) return prev;

        const next = [...prev];
        next[sIdx] = { ...s, files, canvases };
        return next;
      });
    }
    // surfaceStates deliberately excluded — we read it inside via a
    // functional updater (`prev => ...`) and via the `currentSurface`
    // lookup, both of which see the latest value at call time.
    // Including it would cause an infinite loop because the setter mutates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, canvases, activeSurfaceKey]);

  useEffect(() => {
    if (!activeSurface?.def || !normalizedLayoutState) return;
    setLayout((prev: any) => prev ? {
      ...prev,
      canvas: activeSurface.def.canvas,
      frames: activeSurface.def.frames,
      maskUrl: activeSurface.def.maskUrl,
      maskOnExport: activeSurface.def.maskOnExport,
      dimensions: activeSurface.def.canvas?.widthMm && activeSurface.def.canvas?.heightMm
        ? `${activeSurface.def.canvas.widthMm.toFixed(2)}x${activeSurface.def.canvas.heightMm.toFixed(2)}mm` : prev?.dimensions,
    } : prev);
  }, [activeSurfaceKey, activeSurface?.def, normalizedLayoutState]);

  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  const renderCanvas = useCallback(async (
    canvasItem: CanvasItem,
    options: {
      excludeFrameIdx?: number | null;
      isExport?: boolean;
      includeMask?: boolean;
      layoutOverride?: any;
      thumbnail?: boolean;
    } = {}
  ) => {
    return renderCanvasCore(canvasItem, options.layoutOverride || layoutRef.current, getFileUrl, options);
  }, [getFileUrl]);

  // ── Auto-save: one debounced writer, three triggers ──────────────────────
  // The triggers below (active surface's canvases, calendar choices, book page
  // count) all go through scheduleAutosave, so they share one timer, one
  // payload and one restore guard. Don't add a trigger that PUTs canvas-state
  // any other way: the calendar and book triggers used to carry their own copy
  // of the save with no restore guard, and a layout-load default (ops theme
  // preset, template page count) fired it mid-restore, overwriting the saved
  // design with pre-restore state.
  //
  // Calendar/book values are read when the timer FIRES rather than when it was
  // armed, so whichever trigger re-armed it last can't write another's state as
  // of an older render.
  const autosaveProductRef = useRef({
    isCalendarProduct, isBookProduct, calendarTheme, calendarType, genzPalette, calendarCells, bookPageCount,
  });
  useEffect(() => {
    autosaveProductRef.current = {
      isCalendarProduct, isBookProduct, calendarTheme, calendarType, genzPalette, calendarCells, bookPageCount,
    };
  }, [isCalendarProduct, isBookProduct, calendarTheme, calendarType, genzPalette, calendarCells, bookPageCount]);

  const scheduleAutosave = useCallback(() => {
    // Never write while a restore is still in flight. State is empty on mount
    // and an empty save is deliberately allowed (see "delete all" below), so a
    // canvas-state GET slower than the 2 s debounce would otherwise lose the
    // race and PUT an empty design over the customer's saved one — silently.
    // Production responses are ~400 ms, but this app is used mostly on phones
    // and tablets where a >2 s response is ordinary.
    if (!restoreSettledRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setIsSaving('saving');

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const product = autosaveProductRef.current;
        // Read from refs so the timeout always uses the latest surface data,
        // even if other surfaces were updated during the 2 s debounce window.
        const latestSurfaces = surfaceStatesRef.current;
        const latestActiveKey = activeSurfaceKeyRef.current;

        // The backend stores `editor_state` as an opaque JSON blob.
        const editorState: Record<string, any> = {
          surfaces: latestSurfaces.map(s => ({
            key: s.key,
            canvases: serializeCanvasState(s.canvases),
            globalFitMode: s.globalFitMode,
          })),
          activeSurfaceKey: latestActiveKey,
          layoutName,
        };
        // Calendar products persist the customer's theme/type/palette/cell
        // choices so they survive page refresh (PRD §10.3 / audit fix #1).
        if (product.isCalendarProduct) {
          editorState.calendarState = {
            themePreset: product.calendarTheme,
            calendarType: product.calendarType,
            genzPalette: product.genzPalette,
            cells: product.calendarCells,
          };
        }
        // Book products persist the customer's page count AND the pages held
        // out of range by a shrink (BOOK_LAYOUT_PRD.md R1) — a NEW top-level
        // key, not appended into `surfaces`, so it can never be mistaken for
        // an active page by `_extract_canvases_meta`/`_extract_book_state`
        // (which only look at `canvases`) even though editor_state is never
        // read by the render path anyway (render_state is submit-time only).
        if (product.isBookProduct) {
          editorState.bookState = {
            pageCount: product.bookPageCount,
            hiddenSurfaces: Object.entries(bookHiddenPagesRef.current).map(([key, s]) => ({
              key,
              canvases: serializeCanvasState(s.canvases),
              globalFitMode: s.globalFitMode,
            })),
          };
        }

        const res = await fetch(`${apiBase}/canvas-state/${orderId}/`, {
          method: 'PUT',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            layout_name: layoutName,   // required by backend
            editor_state: editorState,
          }),
        });

        if (res.ok) {
          setIsSaving('saved');
          // Reset indicator to idle after 3 s; tracked so unmount can cancel it.
          if (saveIdleTimeoutRef.current) clearTimeout(saveIdleTimeoutRef.current);
          saveIdleTimeoutRef.current = setTimeout(() => setIsSaving('idle'), 3000);
          reclaimUnusedFiles(editorState);
        } else {
          setIsSaving('idle');
        }
      } catch {
        setIsSaving('idle');
      }
    }, 2000);
  }, [apiBase, orderId, layoutName, getAuthHeaders, serializeCanvasState, reclaimUnusedFiles]);

  const cancelAutosave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
  }, []);

  // Trigger: the active surface's canvases, and the restore settling.
  useEffect(() => {
    // Don't save before the layout is known or before the orderId is set.
    if (!orderId || !layout) return;
    // Checked here as well as in scheduleAutosave so the restore-suppression
    // flag below is never consumed before the restore has landed.
    // `restoreSettled` must stay in the deps: work done while the restore was
    // in flight is saved by the re-run it triggers.
    if (!restoreSettled) return;
    // Skip the first save that fires as a side-effect of restoring state —
    // we'd just be writing back the exact data we loaded from the server.
    if (isRestoringRef.current) { isRestoringRef.current = false; return; }
    // Allow saving even when canvases is empty — this covers the "delete all"
    // case so that a refresh after clearing doesn't restore the old design.
    scheduleAutosave();
    return cancelAutosave;
    // surfaceStates/activeSurfaceKey are intentionally read via refs so this
    // effect only re-runs when the active surface's canvases actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvases, orderId, layout, restoreSettled]);

  // Trigger: calendar choices. Theme / type / palette / cell edits never touch
  // `canvases`, so without this they would never auto-save.
  useEffect(() => {
    if (!isCalendarProduct || !orderId || !layout) return;
    scheduleAutosave();
    return cancelAutosave;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarTheme, calendarType, genzPalette, calendarCells]);

  // Trigger: book page count. A pure count change (no photo edits) doesn't
  // touch `canvases` either. bookHiddenPages changes together with the count,
  // so it needs no trigger of its own — the writer reads it via ref.
  useEffect(() => {
    if (!isBookProduct || !orderId || !layout) return;
    scheduleAutosave();
    return cancelAutosave;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookPageCount]);

  // ── Regenerate canvas previews (autosave-payload-bloat fix) ──────────────
  // After restore, regenerate base64 previews that were stripped to reduce
  // autosave payload. Runs asynchronously in the background — previews appear
  // as they're ready, never blocking canvas state update.
  const regenerateCanvasPreviews = useCallback(async (canvasesToRender: CanvasItem[]) => {
    if (!layout) return canvasesToRender;

    try {
      const withPreviews = await Promise.all(
        canvasesToRender.map(async (c) => {
          // If dataUrl already exists, skip regeneration
          if (c.dataUrl) return c;
          try {
            const newDataUrl = await renderCanvasCore(c, layout, getFileUrl, { thumbnail: true });
            return { ...c, dataUrl: newDataUrl };
          } catch {
            // On render error, keep the canvas as-is (dataUrl remains null)
            return c;
          }
        }),
      );
      return withPreviews;
    } catch {
      return canvasesToRender;
    }
  }, [layout, getFileUrl]);

  // ── Auto-restore: run once after layout is ready ──────────────────────────
  useEffect(() => {
    if (!orderId || !layout || layoutLoading || restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      try {
        let restoreId = orderId;
        let res = await fetch(`${apiBase}/canvas-state/${restoreId}/`, {
          headers: { ...getAuthHeaders(), Accept: 'application/json' },
        });
        // Pre-adoption fallback (Phase 3): an autosave made before this
        // deploy may live under the old client-generated PE- id. One guarded
        // extra GET recovers it; the next autosave re-keys it to the session
        // id, so this self-migrates.
        if (!res.ok && legacyOrderIdRef.current && legacyOrderIdRef.current !== restoreId) {
          restoreId = legacyOrderIdRef.current;
          res = await fetch(`${apiBase}/canvas-state/${restoreId}/`, {
            headers: { ...getAuthHeaders(), Accept: 'application/json' },
          });
        }
        if (!res.ok) return; // 404 = first visit, no state to restore

        const data = await res.json();
        if (!data?.editor_state?.surfaces?.length) return;

        const savedLayoutName: string | undefined = data.editor_state.layoutName;
        // Don't restore if it belongs to a different layout template.
        if (savedLayoutName && savedLayoutName !== layoutName) return;

        const savedSurfaces: Array<{
          key: string;
          canvases: CanvasItem[];
          globalFitMode: FitMode;
        }> = data.editor_state.surfaces;

        // NOTE: the auto-save suppression flag is deliberately NOT set here.
        // It used to be, which meant a payload that restored nothing (an active
        // surface with zero canvases) still armed it — and the flag then
        // swallowed the customer's next genuine save. It is set below, only on
        // the path that actually applies state.

        // Remove any stale ?canvas= param from a previous session so the modal
        // doesn't auto-open on top of the freshly-restored state.
        const sp = new URLSearchParams(window.location.search);
        if (sp.has('canvas')) {
          sp.delete('canvas');
          window.history.replaceState(null, '', sp.toString() ? `?${sp.toString()}` : window.location.pathname);
        }

        // Bound the store before hydrating (Phase 3): age out other orders'
        // blobs and evict oldest-first under pressure. Never touches the
        // current order.
        void pruneStaleOrders(restoreId);

        // Hydrate Files from IndexedDB (B1 fix). We strip `originalFile` on
        // serialise but persist the raw blob client-side keyed by `fileId`,
        // so refreshing the page recovers everything needed to re-render.
        const fileMap = await getFilesForOrder(restoreId).catch(() => new Map<string, File>());
        const restoredFile = (fileId: string): File | undefined => {
          const file = fileMap.get(fileId);
          if (file) {
            fileIdByFileRef.current.set(file, fileId);
            sessionFilesRef.current.set(fileId, file);
          }
          return file;
        };
        const hydrate = (canvases: CanvasItem[]): CanvasItem[] =>
          canvases.map(c => ({
            ...c,
            frames: c.frames.map(f => {
              if (!f.fileId) return f;
              const file = restoredFile(f.fileId);
              return file ? { ...f, originalFile: file } : f;
            }),
            overlays: c.overlays.map(o => {
              if (o.type !== 'image' || !o.fileId) return o;
              const file = restoredFile(o.fileId);
              if (!file) return o;
              // Re-create the blob URL since the saved one was revoked when
              // the previous browser session ended. getFileUrl caches by File
              // reference so revocation hooks elsewhere still work.
              return { ...o, originalFile: file, src: getFileUrl(file) };
            }),
          }));

        // Book products: `prev` (surfaceStates) was sized at the TEMPLATE
        // DEFAULT page count when the layout loaded — the saved count isn't
        // known until now. Resize it via the same reconciliation a live
        // page-count change uses, BEFORE the generic per-key hydrate below
        // runs (which only UPDATES entries already in `prev` — it can't add
        // ones that aren't there). Skipping this would silently drop every
        // page beyond the template default on restore (BOOK_LAYOUT_PRD.md
        // R1). Two sequential `setSurfaceStates` calls in this effect is
        // safe: React's updater form always sees the previous updater's
        // committed result even within one batch.
        if (isBookProduct) {
          const rawBookLayout = normalizedLayoutState?._raw as BookLayoutLike | undefined;
          const savedBookState = data.editor_state.bookState;
          if (rawBookLayout) {
            const { visible, resolvedCount } = reconcilePageCount(
              rawBookLayout, savedBookState?.pageCount, [], {},
            );
            setSurfaceStates(visible);
            setBookPageCount(resolvedCount);
          }
          if (Array.isArray(savedBookState?.hiddenSurfaces)) {
            const archive: Record<string, SurfaceState> = {};
            for (const h of savedBookState.hiddenSurfaces) {
              if (!h?.key || !Array.isArray(h.canvases) || !h.canvases.length) continue;
              // A held page carries no real `def` while archived — nothing
              // reads it there, and reconcilePageCount always recomputes a
              // fresh `def` the moment the page re-enters `visible`.
              archive[h.key] = {
                key: h.key,
                label: h.key,
                def: {
                  key: h.key, label: h.key,
                  canvas: { width: 0, height: 0 }, frames: [],
                  maskUrl: null, maskOnExport: false,
                },
                files: [],
                canvases: hydrate(h.canvases),
                globalFitMode: h.globalFitMode ?? 'contain',
              };
            }
            setBookHiddenPages(archive);
          }
        }

        // Merge saved canvas data into the surface states that were just
        // initialised from the layout definition.
        setSurfaceStates(prev => prev.map(s => {
          const saved = savedSurfaces.find(ss => ss.key === s.key);
          if (!saved || !saved.canvases?.length) return s;
          return {
            ...s,
            canvases: hydrate(saved.canvases),
            globalFitMode: saved.globalFitMode ?? s.globalFitMode,
          };
        }));

        // Restore calendar state (theme, type, palette, cells) if present.
        const savedCalendar = data.editor_state.calendarState;
        if (savedCalendar && isCalendarProduct) {
          if (savedCalendar.themePreset) setCalendarTheme(savedCalendar.themePreset as CalendarTheme);
          if (savedCalendar.calendarType) setCalendarType(savedCalendar.calendarType as CalendarType);
          if (savedCalendar.genzPalette) setGenzPalette(savedCalendar.genzPalette);
          // Current saves hold a flat ISO-keyed `cells` map; legacy saves hold
          // the 12-slot `cellsPerCanvas` array — merge it flat (ISO dates are
          // globally unique, so union is lossless).
          const flat: Record<string, any[]> = {};
          if (Array.isArray(savedCalendar.cellsPerCanvas)) {
            for (const m of savedCalendar.cellsPerCanvas) Object.assign(flat, m || {});
          }
          if (savedCalendar.cells && typeof savedCalendar.cells === 'object') {
            Object.assign(flat, savedCalendar.cells);
          }
          if (Object.keys(flat).length) setCalendarCells(flat);
        }

        // Activate the surface that was open when the user last saved.
        const savedActiveKey: string | undefined = data.editor_state.activeSurfaceKey;
        if (savedActiveKey) setActiveSurfaceKey(savedActiveKey);

        // Sync the active-surface shortcut state.
        const activeSaved = savedSurfaces.find(
          ss => ss.key === (savedActiveKey ?? activeSurfaceKey)
        );
        if (activeSaved?.canvases?.length) {
          // Correct the placeholder count before the cards swap in, in case the
          // local hint was stale or unavailable.
          setRestoreCount(Math.min(activeSaved.canvases.length, MAX_SKELETON_CARDS));
          const hydrated = hydrate(activeSaved.canvases);
          // Suppress the one auto-save fire these updates trigger — we would
          // just be writing back what we loaded a moment ago.
          isRestoringRef.current = true;
          skipNextGenerateRef.current = true; // suppress generateCanvases trigger
          setCanvases(hydrated);
          // Regenerate canvas previews that were stripped from autosave payload
          // to reduce size. Runs async in the background — previews appear as
          // they're ready, never blocking UI update.
          void regenerateCanvasPreviews(hydrated).then(withPreviews => {
            if (withPreviews.some(c => c.dataUrl !== (hydrated.find(h => h.id === c.id)?.dataUrl || null))) {
              setCanvases(withPreviews);
            }
          });
          // Repopulate `files` from the hydrated frames in the SAME commit
          // (Phase 3): with files left empty the skip flag went stale and
          // swallowed the user's NEXT real upload (blank grid), and any
          // post-restore re-pick lost the identity merge. The flag suppresses
          // exactly this one legitimate generate fire.
          const restoredFiles = hydrated
            .flatMap(c => c.frames.map(f => f.originalFile))
            .filter((f): f is File => !!f);
          if (restoredFiles.length) setFiles(restoredFiles);
          // Restoring the saved fit mode must NOT re-run smartcrop over the
          // customer's manual pans — the fit-mode effect only recomputes
          // offsets for USER toggles (fitModeUserToggledRef).
          setGlobalFitMode(activeSaved.globalFitMode ?? 'contain');
        }

        // Delete this order's older stored photos the restored design doesn't
        // use: ones dropped in a session that closed before its next save, and
        // everything the editor stored before it cleaned up after itself.
        // Only here, once a saved design was actually applied — never on a
        // failed or empty restore, where "unused" would mean every photo.
        void pruneUnreferencedFiles(restoreId, collectFileIds(data.editor_state), ORPHAN_FILE_MIN_AGE_MS);
      } catch {
        // Restore failures are silent — user just starts fresh.
      } finally {
        // Every exit path lands here — 404 (nothing saved), a layout mismatch,
        // a thrown fetch, or success. Leaving this set would strand the
        // skeletons on screen in place of the upload prompt.
        setRestorePending(false);
        restoreSettledRef.current = true;
        setRestoreSettled(true);
      }
    })();
    // Run exactly once when layout becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, layoutLoading, orderId]);

  // Remember the card count for this order so a refresh can size its restore
  // placeholders correctly before the payload lands.
  useEffect(() => {
    if (orderId) writeCardCountHint(orderId, canvases.length);
  }, [canvases.length, orderId]);

  const canvasesRef = useRef<CanvasItem[]>([]);
  useEffect(() => {
    canvasesRef.current = canvases;
  }, [canvases]);

  // ── Persist Files to IndexedDB on add (B1: survives page refresh) ────────
  // Watches surfaceStates for any frame/overlay that has an originalFile but
  // no fileId, persists the blob, then patches the fileId back into state.
  // Self-stabilising: once every File has a fileId the effect no-ops.
  useEffect(() => {
    if (!orderId) return;
    type Pending = { surfaceKey: string; canvasIdx: number; kind: 'frame' | 'overlay'; idx: number; file: File };
    const pending: Pending[] = [];
    const needsId = (fileId?: string) => !fileId || deletedFileIdsRef.current.has(fileId);

    surfaceStates.forEach(s => {
      s.canvases.forEach((c, ci) => {
        c.frames.forEach((f, fi) => {
          if (f.originalFile && needsId(f.fileId)) {
            pending.push({ surfaceKey: s.key, canvasIdx: ci, kind: 'frame', idx: fi, file: f.originalFile });
          }
        });
        c.overlays.forEach((o, oi) => {
          if (o.type === 'image' && o.source === 'local' && o.originalFile && needsId(o.fileId)) {
            pending.push({ surfaceKey: s.key, canvasIdx: ci, kind: 'overlay', idx: oi, file: o.originalFile });
          }
        });
      });
    });

    if (!pending.length) return;

    // One stored copy per File: reuse the id it already has, or join a save
    // already in flight (a re-run of this effect cancels the previous run's
    // patch, not its saves).
    const persistFile = (file: File): Promise<string> => {
      const known = fileIdByFileRef.current.get(file);
      if (known && !deletedFileIdsRef.current.has(known)) return Promise.resolve(known);
      let saving = fileSaveInFlightRef.current.get(file);
      if (!saving) {
        saving = saveFile(orderId, file).then(id => {
          fileIdByFileRef.current.set(file, id);
          sessionFilesRef.current.set(id, file);
          return id;
        });
        fileSaveInFlightRef.current.set(file, saving);
        const settle = () => { fileSaveInFlightRef.current.delete(file); };
        saving.then(settle, settle);
      }
      return saving;
    };

    let cancelled = false;
    (async () => {
      const results = await Promise.all(pending.map(async (p) => {
        try {
          const fileId = await persistFile(p.file);
          return { ...p, fileId };
        } catch (e) {
          // Quota exhaustion must be VISIBLE (Phase 3): the photo still works
          // this session, but it can't be recovered after a refresh — warn
          // instead of silently printing blank later.
          if (e instanceof FileStoreQuotaError) setPersistDegraded(true);
          return null;
        }
      }));
      if (cancelled) return;
      if (getPersistenceMode() === 'memory') setStorageBlocked(true);
      const ok = results.filter((r): r is Pending & { fileId: string } => r !== null);
      if (!ok.length) return;

      setSurfaceStates(prev => prev.map(s => {
        const sIds = ok.filter(i => i.surfaceKey === s.key);
        if (!sIds.length) return s;
        return {
          ...s,
          canvases: s.canvases.map((c, ci) => {
            const cIds = sIds.filter(i => i.canvasIdx === ci);
            if (!cIds.length) return c;
            return {
              ...c,
              frames: c.frames.map((f, fi) => {
                const m = cIds.find(i => i.kind === 'frame' && i.idx === fi);
                return m ? { ...f, fileId: m.fileId } : f;
              }),
              overlays: c.overlays.map((o, oi) => {
                const m = cIds.find(i => i.kind === 'overlay' && i.idx === oi);
                if (!m || o.type !== 'image') return o;
                return { ...o, fileId: m.fileId };
              }),
            };
          }),
        };
      }));
    })();

    return () => { cancelled = true; };
  }, [surfaceStates, orderId]);

  // The template's {min,max,step,default} page-count grid, for the page-count
  // control below. `null` until the (book) layout has loaded.
  const bookPageBounds = useMemo(() => {
    if (!isBookProduct) return null;
    const raw = normalizedLayoutState?._raw as BookLayoutLike | undefined;
    return raw ? pageCountBounds(raw) : null;
  }, [isBookProduct, normalizedLayoutState]);

  // The one place a customer-driven page-count change happens (the control
  // below, and D3's overflow "extend to N pages?" offer) — always goes
  // through reconcilePageCount so growing/shrinking/restoring stay
  // consistent with the layout-load and restore call sites.
  const handleBookPageCountChange = useCallback((requested: number) => {
    const raw = normalizedLayoutState?._raw as BookLayoutLike | undefined;
    if (!raw) return;
    const { visible, archive, resolvedCount } = reconcilePageCount(
      raw, requested, surfaceStatesRef.current, bookHiddenPagesRef.current,
    );
    setSurfaceStates(visible);
    setBookHiddenPages(archive);
    setBookPageCount(resolvedCount);
  }, [normalizedLayoutState]);

  // ── Book: read-only spread preview (D6 — edit single pages, preview
  // spreads) ─────────────────────────────────────────────────────────────
  // Groups the CURRENT VISIBLE pages only (never the held/archived ones —
  // previewing a page the customer can't currently see would be confusing).
  // Reuses each page's already-computed thumbnail (canvases[0].dataUrl, the
  // same one the card grid renders) rather than a fourth frame-drawing path
  // (CLAUDE.md "Three frame renderers") — this view only adds the spread
  // *layout*, never re-renders a frame.
  const [showSpreadPreview, setShowSpreadPreview] = useState(false);
  const { bookSpreads, bookCoverPreview, bookBackCoverPreview } = useMemo(() => {
    if (!isBookProduct) return { bookSpreads: [], bookCoverPreview: null, bookBackCoverPreview: null };
    // mm is the common unit for sizing the cover-wrap panels proportionally
    // against spineWidthMm below; px-only canvases fall back to treating
    // their pixel width as a proportional unit (still correct for the ratio,
    // just not a real mm figure).
    const widthMmOf = (canvas: { width?: number; widthMm?: number; dpi?: number } | undefined): number => {
      if (!canvas) return 0;
      if (canvas.widthMm) return canvas.widthMm;
      if (canvas.width && canvas.dpi) return (canvas.width / canvas.dpi) * 25.4;
      return canvas.width || 0;
    };
    const pages = surfaceStates.map(s => {
      const { role, pageIndex } = roleForSurfaceKey(s.key);
      return {
        key: s.key,
        role,
        pageIndex,
        label: s.label,
        dataUrl: s.canvases[0]?.dataUrl ?? null,
        canvasWidth: s.def.canvas?.width || 1200,
        canvasHeight: s.def.canvas?.height || 1800,
        canvasWidthMm: widthMmOf(s.def.canvas),
      };
    });
    // The standalone cover/back-cover spreads pagesToSpreads() produces are
    // redundant with the cover-wrap panel rendered separately below — filter
    // them out of the regular list rather than showing the cover twice.
    const innerSpreads = pagesToSpreads(pages).filter(spread =>
      !(spread.length === 1 && (spread[0].role === 'cover' || spread[0].role === 'backCover'))
    );
    return {
      bookSpreads: innerSpreads,
      bookCoverPreview: pages.find(p => p.role === 'cover') ?? null,
      bookBackCoverPreview: pages.find(p => p.role === 'backCover') ?? null,
    };
  }, [isBookProduct, surfaceStates]);

  // R2 (BOOK_LAYOUT_PRD.md) — recomputed from the CURRENT page count, same
  // as the backend does at materialize time (D4: spine changes whenever the
  // customer changes the page count, never resolved once at author time).
  const bookSpineWidthMm = useMemo(() => {
    if (!isBookProduct) return null;
    const raw = normalizedLayoutState?._raw as BookLayoutLike | undefined;
    if (!raw?.book) return null;
    return spineWidthMm(bookPageCount, raw.book.paperThicknessMm || 0, raw.book.coverThicknessMm || 0);
  }, [isBookProduct, normalizedLayoutState, bookPageCount]);

  // Pre-submit guards (Phase 3): surfaces that would print blank + photos
  // placed more than once (excluding deliberate qty auto-fill duplicates).
  const intentionalDupesRef = useRef(new Set<string>());
  const emptySurfaces = useMemo(() => {
    // Blank inner pages are an intentional, common outcome for books (D3 —
    // "people leave pages for writing"), not a mistake, so exclude them from
    // this warning; covers being empty should still warn.
    const surfacesToCheck = isBookProduct
      ? surfaceStates.filter(s => !s.key.startsWith('page_'))
      : surfaceStates;
    return collectEmptySurfaces(surfacesToCheck);
  }, [surfaceStates, isBookProduct]);
  const duplicateFills = useMemo(() => {
    const groups = surfaceStates.length > 1
      ? surfaceStates.map(s => ({ label: s.label || s.key, canvases: s.canvases }))
      : [{ label: 'your design', canvases }];
    return collectDuplicateFills(groups, intentionalDupesRef.current);
  }, [surfaceStates, canvases]);

  // Worst under-DPI frame per card, for the amber corner pill. Keyed by
  // `${surfaceKey ?? ''}:${canvasIdx}` to cover both grid variants.
  const lowDpiByCard = useMemo(() => {
    const map = new Map<string, LowDpiFrame>();
    for (const f of lowDpiFrames) {
      const key = `${f.surfaceKey ?? ''}:${f.canvasIdx}`;
      const cur = map.get(key);
      if (!cur || f.dpi < cur.dpi) map.set(key, f);
    }
    return map;
  }, [lowDpiFrames]);

  // ── Tab-close guard (Phase 3) ─────────────────────────────────────────────
  // Warn before unloading ONLY while work is genuinely in flight: an active
  // upload/submit/poll (isDownloading spans the whole window) or an
  // uncommitted auto-save write. Idle closes stay silent — auto-save + IDB
  // persistence already make those safe, and a permanent nag is hostile.
  // (window listener in an effect with cleanup — the sanctioned exception to
  // the no-direct-DOM rule.)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDownloading || isSaving === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDownloading, isSaving]);

  // ── Low-resolution sweep (Phase 2 item 4) ────────────────────────────────
  // Debounced: reacts to placed photos, saved modal zoom (FrameState.scale),
  // rotation, and fit-mode flips. Cache-warm getImageSize keeps re-runs
  // cheap; a first run may decode files not yet in the metadata cache.
  useEffect(() => {
    if (!layout) return;
    // Cancellation flag: an in-flight sweep from a previous state must not
    // land after a newer one and overwrite fresh results with stale ones.
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const groups = surfaceStates.length > 1
          ? surfaceStates.map(s => ({
              canvases: s.canvases,
              layoutDef: s.def,
              surfaceKey: s.key,
              surfaceLabel: s.label || s.key,
            }))
          : [{ canvases, layoutDef: layout, surfaceKey: null }];
        const result = await collectLowDpiFrames(groups as any, getImageSize);
        if (!cancelled) setLowDpiFrames(result);
      } catch {
        // The warning is best-effort — never let it disturb the editor.
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [canvases, surfaceStates, layout]);

  // ── Calendar: fetch Gen-Z palettes + holidays on layout mount ────────────
  // Only runs for productType='calendar' layouts. Gen-Z palettes are needed
  // for the palette swatch picker. Holidays are fetched only when the print
  // will carry them (`holidayLocale` is null otherwise), for every year the
  // print could cover: the layout's defaultYear resolved like the print, for
  // either calendar type (the customer can flip it), plus the following year
  // for FY ranges straddling two calendar years.
  useEffect(() => {
    if (!isCalendarProduct || !layout) return;

    // Apply layout-level ops defaults for customer-controllable fields.
    const rawCalendar = (normalizedLayoutState as any)?._raw?.calendar;
    if (rawCalendar?.themePreset) setCalendarTheme(rawCalendar.themePreset as CalendarTheme);
    if (rawCalendar?.calendarType) setCalendarType(rawCalendar.calendarType as CalendarType);

    // Fetch Gen-Z palettes if theme default is modern-genz.
    fetch(`${apiBase}/calendar-styles/modern-genz`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.palettes?.length) setGenzPalettes(d.palettes); })
      .catch(() => {});

    const locale: string | null = layout.holidayLocale;
    if (!locale) return;
    const holidayYears = Array.from(new Set(
      (['english', 'financial'] as const)
        .map(t => resolveDefaultYear(layout.calendarDefaultYear, t))
        .flatMap(y => [y, y + 1]),
    ));
    let cancelled = false;
    Promise.all(holidayYears.map(yr =>
      fetch(`${apiBase}/holidays/${encodeURIComponent(locale)}/${yr}`, { headers: getAuthHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then(d => (d?.events as HolidayEntry[]) || [])
        .catch(() => [] as HolidayEntry[])
    )).then(perYear => { if (!cancelled) setCalendarHolidays(perYear.flat()); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCalendarProduct, layout?.id]);

  const generateCanvasesForLayout = useCallback(async (
    layoutDef: any, surfaceFiles: File[], fitMode: FitMode,
    existingCanvases: CanvasItem[] = canvasesRef.current
  ): Promise<CanvasItem[]> => {
    if (!layoutDef || surfaceFiles.length === 0) return [];
    const frameCount = layoutDef.frames?.length || 1;
    // Same 12-page cap as generateCanvases for calendar products.
    const canvasCount = layoutDef.productType === 'calendar'
      ? Math.min(Math.ceil(surfaceFiles.length / frameCount), 12)
      : Math.ceil(surfaceFiles.length / frameCount);
    // Identity-based reuse (Phase 3 — never lose edits); see generateCanvases.
    const plannedSlots = planFrameSlots(surfaceFiles, frameCount, canvasCount);
    const reusePlan = planCanvasReuse(existingCanvases, plannedSlots);

    const newCanvases: CanvasItem[] = [];
    for (let i = 0; i < canvasCount; i++) {
      const canvasFrames: FrameState[] = [];

      for (let f = 0; f < frameCount; f++) {
        const file = plannedSlots[i][f];
        const claimedFrame = reusePlan.frames[i][f];

        if (file) {
            if (claimedFrame) {
            canvasFrames.push({
              ...claimedFrame,
              id: f,
              originalFile: file, // Ensure we use the latest file object
              fileName: file.name,
              fileSize: file.size,
            });
          } else {
            const { width: imgW, height: imgH, element: imgEl } = await getImageMetadata(file);
            const canvasSpec = getCanvasSpec(layoutDef) || { width: 1200, height: 1800 };
            const frames = getFrames(layoutDef) || [];
            const frameSpec = frames[f] || { x: 0, y: 0, width: 1, height: 1 };
            const canvasW = canvasSpec.width;
            const canvasH = canvasSpec.height;
            const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
            const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
            const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;

            // Server-side MediaPipe Pose Landmarker decides rotation when the
            // aspect heuristic doesn't already call for a fill-rotate — see
            // resolveRotation. PDF-derived pages are document content, not
            // photos: pose detection would find nothing (wasting a round
            // trip) and the aspect heuristic could rotate a deliberately-
            // designed page just because its ratio doesn't match the frame —
            // skip both entirely for those.
            const rotation = pdfDerivedFiles.has(file)
              ? 0
              : resolveRotation(
                  await detectFileOrientation(apiBase, file, imgEl, getAuthHeaders ? getAuthHeaders() : undefined),
                  imgW, imgH, frameW, frameH,
                );

            let offset = { x: 0, y: 0 };
            if (fitMode === 'cover') {
              const ck = `${file.name}:${file.size}:${file.lastModified}:${frameW}x${frameH}:${rotation}`;
              offset = await calculateSmartCropOffsets(imgEl, frameW, frameH, rotation, ck);
            }

            canvasFrames.push({
              id: f, originalFile: file,
              fileName: file.name, fileSize: file.size,
              offset, scale: 1, rotation, fitMode,
              fillStyle: globalBlurFillRef.current ? 'blur' : undefined, // Blur Effect on by default
            });
          }
        }
      }
      const carry = reusePlan.carry[i];
      const item: CanvasItem = {
        id: i,
        frames: canvasFrames,
        overlays: carry?.overlays || [],
        bgColor: carry?.bgColor || '#ffffff',
        paperColor: carry?.paperColor || '#ffffff',
        dataUrl: carry?.dataUrl || null
      };

      if (!item.dataUrl) {
          // Use thumbnail for grid previews to save memory and CPU
          item.dataUrl = await renderCanvas({ ...item, dataUrl: null }, { thumbnail: true, layoutOverride: layoutDef });
        }

      newCanvases.push(item);
    }
    return newCanvases;
  }, [renderCanvas, apiBase, getAuthHeaders]);

  const generateCanvases = useCallback(async () => {
    if (!layout || files.length === 0 || isProcessing) return;
    setIsProcessing(true);
    setError(null);

    const frameCount = layout.frames?.length || 1;
    // Calendar products render exactly 12 month pages — cap the photo
    // canvases so canvas i previews month i's photo and the ZIP holds 12
    // files, not 12 per photo (server slices per-surface the same way).
    const canvasCount = isCalendarProduct
      ? Math.min(Math.ceil(files.length / frameCount), 12)
      : Math.ceil(files.length / frameCount);
    setRenderProgress({ current: 0, total: canvasCount });
    
    // Use current canvases from ref to preserve transforms without creating a dependency loop
    const existingCanvases = [...canvasesRef.current];

    // Identity-based reuse plan (Phase 3 — never lose edits): each slot's
    // file claims its previous edits by name:size:lastModified, so adding,
    // removing or reordering photos no longer resets pans/zooms or leaves
    // overlays glued to the wrong page. Planned synchronously up front so
    // the parallel batch builders below stay deterministic.
    const plannedSlots: (File | null)[][] = Array.from({ length: canvasCount }, (_, c) =>
      Array.from({ length: frameCount }, (_, f) => files[(c * frameCount + f) % files.length] || null)
    );
    const reusePlan = planCanvasReuse(existingCanvases, plannedSlots);

    try {
      const built: CanvasItem[] = [];
      // 8 simultaneous getImageMetadata + smartcrop calls. Each pins a
      // full-res HTMLImageElement (~50 MB for a 12 MP photo). At 8 in
      // flight we're ceiling at ~400 MB peak, well within desktop and
      // the median tablet's headroom; bumping further (16) reaches the
      // OOM zone on 4 GB devices for 200-photo batches. Was 5 — the
      // next 3 slots roughly halve the metadata+smartcrop wall time on
      // big uploads without changing the memory ceiling enough to
      // matter.
      const BATCH_SIZE = 8;
      
      for (let i = 0; i < canvasCount; i += BATCH_SIZE) {
        const end = Math.min(i + BATCH_SIZE, canvasCount);
        const batchPromises: Promise<CanvasItem>[] = [];

        for (let batchIdx = i; batchIdx < end; batchIdx++) {
          const p: Promise<CanvasItem> = (async () => {
            const canvasFrames: FrameState[] = [];

            for (let f = 0; f < frameCount; f++) {
              const file = plannedSlots[batchIdx][f];
              const claimedFrame = reusePlan.frames[batchIdx][f];

              if (file) {
                if (claimedFrame) {
                  canvasFrames.push({
                    ...claimedFrame,
                    id: f,
                    originalFile: file,
                    fileName: file.name,
                    fileSize: file.size,
                  });
                } else {
                  const { width: imgW, height: imgH, element: imgEl } = await getImageMetadata(file);
                  const frameSpec = layout.frames?.[f] || { width: 1, height: 1 };
                  const canvasW = layout.canvas?.width || layout.surfaces?.[0]?.canvas?.width || 1200;
                  const canvasH = layout.canvas?.height || layout.surfaces?.[0]?.canvas?.height || 1800;
                  const frameW = frameSpec.width <= 1 ? frameSpec.width * canvasW : frameSpec.width;
                  const frameH = frameSpec.height <= 1 ? frameSpec.height * canvasH : frameSpec.height;

                  // PDF-derived pages skip auto-orientation entirely — see
                  // the other call site above for why.
                  const rotation = pdfDerivedFiles.has(file)
                    ? 0
                    : resolveRotation(
                        await detectFileOrientation(apiBase, file, imgEl, getAuthHeaders ? getAuthHeaders() : undefined),
                        imgW, imgH, frameW, frameH,
                      );

                  let offset = { x: 0, y: 0 };
                  if (globalFitModeRef.current === 'cover') {
                    const ck = `${file.name}:${file.size}:${file.lastModified}:${frameW}x${frameH}:${rotation}`;
                    offset = await calculateSmartCropOffsets(imgEl, frameW, frameH, rotation, ck);
                  }

                  canvasFrames.push({
                    id: f, originalFile: file,
                    fileName: file.name, fileSize: file.size,
                    offset, scale: 1, rotation, fitMode: globalFitModeRef.current,
                    fillStyle: globalBlurFillRef.current ? 'blur' : undefined, // Blur Effect on by default
                  });
                }
              }
            }
            
            const carry = reusePlan.carry[batchIdx];
            const item: CanvasItem = {
              id: batchIdx,
              frames: canvasFrames,
              overlays: carry?.overlays || [],
              bgColor: carry?.bgColor || '#ffffff',
              paperColor: carry?.paperColor || '#ffffff',
              // The plan only carries a dataUrl when every frame kept its
              // original slot — anything else needs a fresh thumbnail.
              dataUrl: carry?.dataUrl || null,
            };

            if (!item.dataUrl) {
              item.dataUrl = await renderCanvas({ ...item, dataUrl: null }, { thumbnail: true });
            }
            return item;
          })();
          batchPromises.push(p);
        }

        const batchResults = await Promise.all(batchPromises);
        built.push(...batchResults);
        
        // Update UI every batch
        setCanvases([...built]);
        setRenderProgress({ current: built.length, total: canvasCount });
        
        // Yield to main thread
        await new Promise(r => setTimeout(r, 0));
      }
    } catch (err) {
      console.error(err);
      setError('Failed to process images');
    } finally {
      setIsProcessing(false);
      setRenderProgress(null);
    }
    // isProcessing is read as a re-entry GUARD, not a trigger — including it
    // in deps would cause generateCanvases to re-create on every flip,
    // re-firing the (layout, files, generateCanvases) effect below in a
    // tight loop. globalFitMode similarly excluded — passed through into
    // renderCanvas, which captures the latest value via its own closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, files, renderCanvas]);

  useEffect(() => {
    if (skipNextGenerateRef.current) { skipNextGenerateRef.current = false; return; }
    if (layout && files.length > 0) generateCanvases();
  }, [layout, files, generateCanvases]);

  useEffect(() => {
    if (surfaceStates.length === 0) return;
    // Only a USER toggle of Fit/Cover may recompute smartcrop offsets
    // (Phase 3): restore and surface-switch also set globalFitMode, and
    // letting them through overwrote every manual pan with smartcrop
    // defaults on reload of a cover-mode session.
    if (!fitModeUserToggledRef.current) return;
    fitModeUserToggledRef.current = false;
    let cancelled = false;
    (async () => {
      setIsProcessing(true);
      setRenderProgress({ current: 0, total: surfaceStates.reduce((acc, s) => acc + s.canvases.length, 0) });

      const updatedSurfaces: SurfaceState[] = [];
      let totalProcessed = 0;

      for (const s of surfaceStates) {
        const updatedCanvases: CanvasItem[] = [];
        // Process canvases in small chunks to avoid hanging the UI
        const chunkSize = 5;
        for (let i = 0; i < s.canvases.length; i += chunkSize) {
          if (cancelled) return;
          const chunk = s.canvases.slice(i, i + chunkSize);
          const processedChunk = await Promise.all(chunk.map(async (c) => {
            const patchedFrames = await Promise.all(c.frames.map(async (f, fIdx) => {
              let newOffset = { ...f.offset };
              if (globalFitMode === 'cover' && f.originalFile) {
                const { element: imgEl } = await getImageMetadata(f.originalFile);
                const frames = s.def.frames || [];
                const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
                const canvasW = s.def.canvas?.width || 1200;
                const canvasH = s.def.canvas?.height || 1800;
                const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
                const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
                const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;
                const ck = f.fileId
                  ? `${f.fileId}:${frameW}x${frameH}:${f.rotation}`
                  : `${f.originalFile.name}:${f.originalFile.size}:${f.originalFile.lastModified}:${frameW}x${frameH}:${f.rotation}`;
                newOffset = await calculateSmartCropOffsets(imgEl, frameW, frameH, f.rotation, ck);
              } else if (globalFitMode === 'contain') {
                newOffset = { x: 0, y: 0 };
              }
              return { ...f, fitMode: globalFitMode, offset: newOffset };
            }));
            const patchedCanvas = { ...c, frames: patchedFrames };
            const dataUrl = await renderCanvas(patchedCanvas, { thumbnail: true, layoutOverride: s.def });
            return { ...patchedCanvas, dataUrl };
          }));
          updatedCanvases.push(...processedChunk);
          totalProcessed += processedChunk.length;
          setRenderProgress(prev => prev ? { ...prev, current: totalProcessed } : null);
        }
        updatedSurfaces.push({ ...s, globalFitMode, canvases: updatedCanvases });
      }

      if (cancelled) return;

      setSurfaceStates(updatedSurfaces);
      
      // Synchronize the active canvases state
      const active = updatedSurfaces.find(s => s.key === activeSurfaceKey);
      if (active) {
        setCanvases(active.canvases);
      }

      setIsProcessing(false);
      setRenderProgress(null);
    })();
    return () => { cancelled = true; };
    // surfaceStates + activeSurfaceKey deliberately excluded — including
    // them creates a self-feeding loop because the effect calls
    // setSurfaceStates inside. The latest values are read via a stable
    // setSurfaceStates updater pattern in nearby effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFitMode, renderCanvas]);

  // Global "Blur sides" toggle — set fillStyle on every frame + re-render the
  // grid thumbnails. Guarded so it only fires on a real user toggle, never on
  // mount/restore. Fill shows only on contain frames (the renderer gates it);
  // setting it on cover frames is harmless.
  useEffect(() => {
    if (!blurFillUserToggledRef.current) return;
    blurFillUserToggledRef.current = false;
    let cancelled = false;
    (async () => {
      // Show the same progress UI as the Fit/Cover toggle so the customer sees
      // the thumbnails re-rendering instead of a frozen screen.
      setIsProcessing(true);
      setRenderProgress({ current: 0, total: surfaceStates.reduce((a, s) => a + s.canvases.length, 0) });
      const nextStyle: 'blur' | undefined = globalBlurFill ? 'blur' : undefined;
      const updatedSurfaces: SurfaceState[] = [];
      let done = 0;
      for (const s of surfaceStates) {
        const updatedCanvases: CanvasItem[] = [];
        for (const c of s.canvases) {
          if (cancelled) return;
          const patchedFrames = c.frames.map(f => ({ ...f, fillStyle: nextStyle }));
          const patchedCanvas = { ...c, frames: patchedFrames };
          const dataUrl = await renderCanvas(patchedCanvas, { thumbnail: true, layoutOverride: s.def });
          updatedCanvases.push({ ...patchedCanvas, dataUrl });
          done += 1;
          setRenderProgress(prev => (prev ? { ...prev, current: done } : null));
        }
        updatedSurfaces.push({ ...s, canvases: updatedCanvases });
      }
      if (cancelled) return;
      setSurfaceStates(updatedSurfaces);
      const active = updatedSurfaces.find(su => su.key === activeSurfaceKey);
      if (active) setCanvases(active.canvases);
      setIsProcessing(false);
      setRenderProgress(null);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalBlurFill, renderCanvas]);

  // Keyed by `${surfaceKey ?? ''}:${idx}` — a quick-action toggle (Fit/Cover,
  // Blur, Rotate, BG) commits into `canvases`/`surfaceStates` only after its
  // async re-render finishes inside updateCanvasState. openEditor awaits the
  // matching entry so opening the modal mid-toggle can't seed it with the
  // pre-toggle frame (e.g. Fit Mode showing "Cover" right after the card
  // switched to "Contain").
  const pendingCanvasUpdatesRef = useRef<Map<string, Promise<CanvasItem | undefined>>>(new Map());

  const openEditor = async (idx: number, surfaceKey?: string) => {
    let targetCanvases = canvases;
    if (surfaceKey && surfaceKey !== activeSurfaceKey) {
      setActiveSurfaceKey(surfaceKey);
      const surface = surfaceStates.find(s => s.key === surfaceKey);
      if (surface) targetCanvases = surface.canvases;
    }
    const pendingKey = `${surfaceKey ?? ''}:${idx}`;
    const pending = pendingCanvasUpdatesRef.current.get(pendingKey);
    const c = (pending ? await pending : undefined) ?? targetCanvases[idx];
    if (!c) return;
    setActiveCanvasIdx(idx);
    const sp = new URLSearchParams(window.location.search);
    sp.set('canvas', idx.toString());
    window.history.replaceState({}, '', '?' + sp.toString());
    setEditingCanvas({
      ...c,
      frames: c.frames.map(f => ({ ...f, offset: { ...f.offset } })),
      overlays: c.overlays.map(o => ({ ...o })),
    });
  };

  const closeEditor = () => {
    setActiveCanvasIdx(null);
    setEditingCanvas(null);
    const sp = new URLSearchParams(window.location.search);
    if (sp.has('canvas')) {
      sp.delete('canvas');
      window.history.replaceState({}, '', sp.toString() ? '?' + sp.toString() : window.location.pathname);
    }
  };

  const updateCanvasState = useCallback((idx: number, surfaceKey: string | null, updateFn: (c: CanvasItem) => CanvasItem | Promise<CanvasItem>) => {
    const pendingKey = `${surfaceKey ?? ''}:${idx}`;
    const run = (async (): Promise<CanvasItem | undefined> => {
      if (surfaceKey) {
        const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
        if (sIdx === -1) return undefined;
        const targetSurface = surfaceStates[sIdx];
        const targetCanvas = targetSurface.canvases[idx];
        if (!targetCanvas) return undefined;

        const updatedCanvas = await updateFn(targetCanvas);
        // If every frame is missing its original file (restored from saved state,
        // no re-upload yet), skip the re-render to avoid overwriting the stored
        // dataUrl preview with a blank canvas.
        const canRerender = updatedCanvas.frames.some(f => f.originalFile !== null);
        if (canRerender) updatedCanvas.dataUrl = await renderCanvas(updatedCanvas, { thumbnail: true });

        setSurfaceStates(prev => prev.map((s, i) =>
          i === sIdx ? { ...s, canvases: s.canvases.map((c, ci) => ci === idx ? updatedCanvas : c) } : s
        ));
        if (surfaceKey === activeSurfaceKey) {
          setCanvases(prev => prev.map((c, ci) => ci === idx ? updatedCanvas : c));
        }
        return updatedCanvas;
      } else {
        const targetCanvas = canvases[idx];
        if (!targetCanvas) return undefined;

        const updatedCanvas = await updateFn(targetCanvas);
        const canRerender = updatedCanvas.frames.some(f => f.originalFile !== null);
        if (canRerender) updatedCanvas.dataUrl = await renderCanvas(updatedCanvas, { thumbnail: true });

        setCanvases(prev => prev.map((c, ci) => ci === idx ? updatedCanvas : c));
        return updatedCanvas;
      }
    })();

    pendingCanvasUpdatesRef.current.set(pendingKey, run);
    run.finally(() => {
      if (pendingCanvasUpdatesRef.current.get(pendingKey) === run) {
        pendingCanvasUpdatesRef.current.delete(pendingKey);
      }
    });
    return run;
  }, [surfaceStates, canvases, activeSurfaceKey, renderCanvas]);

  const handleQuickRotate = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, async (c) => {
      const updatedFrames: FrameState[] = await Promise.all(c.frames.map(async (f, fIdx) => {
        const newRotation = (f.rotation + 90) % 360;
        let newOffset = { ...f.offset };
        
        // If the user hasn't manually adjusted the image, we can re-calculate smartcrop for the new rotation
        if (f.fitMode === 'cover' && f.offset.x === 0 && f.offset.y === 0 && f.scale === 1 && f.originalFile) {
          const { element: imgEl } = await getImageMetadata(f.originalFile);
          const layoutDef = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.def : layout;
          const canvasSpec = getCanvasSpec(layoutDef) || { width: 1200, height: 1800 };
          const frames = getFrames(layoutDef) || [];
          const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
          const canvasW = canvasSpec.width;
          const canvasH = canvasSpec.height;
          const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
          const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
          const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;

          newOffset = await calculateSmartCropOffsets(imgEl, frameW, frameH, newRotation);
        }

        return { ...f, rotation: newRotation, offset: newOffset };
      }));
      return { ...c, frames: updatedFrames };
    });
  };

  const handleQuickToggleFit = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, async (c) => {
      const updatedFrames: FrameState[] = await Promise.all(c.frames.map(async (f, fIdx) => {
        const newFitMode: FitMode = f.fitMode === 'contain' ? 'cover' : 'contain';
        let newOffset = { ...f.offset };

        if (newFitMode === 'cover' && f.originalFile) {
          const { element: imgEl } = await getImageMetadata(f.originalFile);
          const layoutDef = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.def : layout;
          const canvasSpec = getCanvasSpec(layoutDef) || { width: 1200, height: 1800 };
          const frames = getFrames(layoutDef) || [];
          const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
          const canvasW = canvasSpec.width;
          const canvasH = canvasSpec.height;
          const isPercent = frameSpec.width <= 1 && frameSpec.height <= 1;
          const frameW = isPercent ? frameSpec.width * canvasW : frameSpec.width;
          const frameH = isPercent ? frameSpec.height * canvasH : frameSpec.height;

          newOffset = await calculateSmartCropOffsets(imgEl, frameW, frameH, f.rotation);
        } else if (newFitMode === 'contain') {
          newOffset = { x: 0, y: 0 };
        }

        return { ...f, fitMode: newFitMode, offset: newOffset };
      }));
      return { ...c, frames: updatedFrames };
    });
  };

  // Per-card Blur Effect toggle — flips fillStyle on this canvas's frames only.
  // The renderer only shows the fill on contain frames, so it's harmless on cover.
  const handleQuickToggleBlur = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, (c) => {
      const nextStyle: 'blur' | undefined = c.frames.some(f => f.fillStyle === 'blur') ? undefined : 'blur';
      return { ...c, frames: c.frames.map(f => ({ ...f, fillStyle: nextStyle })) };
    });
  };

  // ── Drag-to-pan on grid cards (gated by repositionMode) ────────────────────

  /** Resolve the layout def + canvas dims + frame specs for a card. */
  const panGeometry = (surfaceKey: string | null) => {
    const layoutDef = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.def : layout;
    const canvasSpec = getCanvasSpec(layoutDef) || { width: 1200, height: 1800 };
    const frames = getFrames(layoutDef) || [{ x: 0, y: 0, width: 1, height: 1 }];
    return { canvasW: canvasSpec.width, canvasH: canvasSpec.height, frames };
  };

  /** Push the latest offset, coalesced to one re-render per frame and serialised. */
  const commitPan = (p: NonNullable<typeof panRef.current>, x: number, y: number, immediate = false) => {
    panPendingRef.current = { x, y };
    const flush = () => {
      const pending = panPendingRef.current;
      panPendingRef.current = null;
      if (!pending) return;
      panQueueRef.current = panQueueRef.current
        .then(() => updateCanvasState(p.idx, p.surfaceKey, c => ({
          ...c,
          frames: c.frames.map((f, i) => i === p.frameIdx ? { ...f, offset: { x: pending.x, y: pending.y } } : f),
        })).then(() => {}))
        .catch(() => {});
    };
    if (immediate) { flush(); return; }
    if (panFlushScheduledRef.current) return;
    panFlushScheduledRef.current = true;
    requestAnimationFrame(() => { panFlushScheduledRef.current = false; flush(); });
  };

  const handlePanStart = async (e: React.PointerEvent<HTMLDivElement>, idx: number, surfaceKey: string | null = null) => {
    if (!repositionMode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const host = e.currentTarget;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const canvas = surfaceKey
      ? surfaceStates.find(s => s.key === surfaceKey)?.canvases[idx]
      : canvases[idx];
    if (!canvas) return;

    const { canvasW, canvasH, frames } = panGeometry(surfaceKey);
    const ratioX = canvasW / rect.width;
    const ratioY = canvasH / rect.height;

    // Which frame is under the pointer? (single-frame layouts always hit 0)
    const px = (e.clientX - rect.left) * ratioX;
    const py = (e.clientY - rect.top) * ratioY;
    let frameIdx = 0;
    frames.forEach((fs: any, i: number) => {
      const isPct = fs.width <= 1 && fs.height <= 1;
      const fx = isPct ? fs.x * canvasW : fs.x;
      const fy = isPct ? fs.y * canvasH : fs.y;
      const fw = isPct ? fs.width * canvasW : fs.width;
      const fh = isPct ? fs.height * canvasH : fs.height;
      if (px >= fx && px <= fx + fw && py >= fy && py <= fy + fh) frameIdx = i;
    });

    const frame = canvas.frames[frameIdx];
    if (!frame?.originalFile) return; // nothing to pan (state restored without the File)

    const { width: iw, height: ih } = await getImageMetadata(frame.originalFile);
    const rad = ((frame.rotation || 0) * Math.PI) / 180;
    const effW = Math.abs(iw * Math.cos(rad)) + Math.abs(ih * Math.sin(rad));
    const effH = Math.abs(iw * Math.sin(rad)) + Math.abs(ih * Math.cos(rad));

    const fs = frames[frameIdx] || { x: 0, y: 0, width: 1, height: 1 };
    const isPct = fs.width <= 1 && fs.height <= 1;
    const fw = isPct ? fs.width * canvasW : fs.width;
    const fh = isPct ? fs.height * canvasH : fs.height;

    const base = frame.fitMode === 'contain'
      ? Math.min(fw / effW, fh / effH)
      : Math.max(fw / effW, fh / effH);
    const scale = base * (frame.scale || 1);

    // Pan room is the half-difference between the scaled image and the frame.
    // cover  → image overflows, pan reveals hidden edges (never exposes bg).
    // contain → image is inset, pan slides it to the frame edge (never leaves).
    const panRoomX = Math.abs(effW * scale - fw) / 2;
    const panRoomY = Math.abs(effH * scale - fh) / 2;

    try { host.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    panRef.current = {
      pointerId: e.pointerId, idx, surfaceKey, frameIdx,
      startX: e.clientX, startY: e.clientY, startOffset: { ...frame.offset },
      ratioX, ratioY, panRoomX, panRoomY, moved: false,
    };
  };

  const handlePanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || e.pointerId !== p.pointerId) return;
    const dx = (e.clientX - p.startX) * p.ratioX;
    const dy = (e.clientY - p.startY) * p.ratioY;
    if (!p.moved && (Math.abs(e.clientX - p.startX) > 3 || Math.abs(e.clientY - p.startY) > 3)) p.moved = true;
    const nx = Math.max(-p.panRoomX, Math.min(p.panRoomX, p.startOffset.x + dx));
    const ny = Math.max(-p.panRoomY, Math.min(p.panRoomY, p.startOffset.y + dy));
    commitPan(p, nx, ny);
  };

  const handlePanEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || e.pointerId !== p.pointerId) return;
    panRef.current = null;
    try { e.currentTarget.releasePointerCapture(p.pointerId); } catch { /* already released */ }
    if (!p.moved) return;
    panSuppressClickRef.current = true; // swallow the click that follows a drag
    const dx = (e.clientX - p.startX) * p.ratioX;
    const dy = (e.clientY - p.startY) * p.ratioY;
    const nx = Math.max(-p.panRoomX, Math.min(p.panRoomX, p.startOffset.x + dx));
    const ny = Math.max(-p.panRoomY, Math.min(p.panRoomY, p.startOffset.y + dy));
    commitPan(p, nx, ny, true); // final position always lands
  };

  /** Card click guard — a completed pan must not open the editor modal. */
  const handleCardClick = (idx: number, surfaceKey: string | null = null) => {
    if (panSuppressClickRef.current) { panSuppressClickRef.current = false; return; }
    if (swapSource) {
      const src = swapSource;
      setSwapSource(null);
      if (!(src.idx === idx && src.surfaceKey === surfaceKey)) {
        void swapCards(src, { idx, surfaceKey });
      }
      return;
    }
    openEditor(idx, surfaceKey ?? undefined);
  };

  // Kept for the hidden Set-Background-Color button (see the two commented-out
  // JSX blocks below) rather than deleted alongside it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleQuickSetBg = (idx: number, color: string, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, (c) => ({
      ...c,
      bgColor: color
    }));
  };

  const handleQuickDelete = (idx: number, surfaceKey: string | null = null) => {
    setDeleteConfirm({ idx, surfaceKey });
  };

  const confirmDelete = () => {
    if (!deleteConfirm) return;
    const { idx, surfaceKey } = deleteConfirm;
    if (surfaceKey) {
      const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
      if (sIdx !== -1) {
        setSurfaceStates(prev => prev.map((s, i) =>
          i === sIdx ? { ...s, files: [], canvases: [] } : s
        ));
        if (surfaceKey === activeSurfaceKey) {
          setFiles([]);
          setCanvases([]);
        }
      }
    } else {
      // Delete removes ONLY this canvas's photo(s) (Phase 3). idx is a
      // CANVAS index — splice the whole frame-count block of files AND the
      // canvas itself, so every later canvas stays aligned with its photos
      // and the identity merge preserves their edits.
      const frameCount = layout?.frames?.length || 1;
      const nextFiles = [
        ...files.slice(0, idx * frameCount),
        ...files.slice((idx + 1) * frameCount),
      ];
      setCanvases(prev => prev.filter((_, i) => i !== idx));
      setFiles(nextFiles);
      // Deleting can drop the placed count back under the order quantity —
      // re-run the same check processSelectedFiles does so the shortfall
      // banner reappears/updates instead of only ever reflecting upload-time.
      const qtyVerdict = checkOrderQty(nextFiles.length, orderQty, surfaceStates.length);
      setQtyUnder(qtyVerdict.status === 'under' ? { uploaded: qtyVerdict.uploaded, needed: qtyVerdict.needed } : null);
    }
    setDeleteConfirm(null);
  };

  // Quick-download — the button that called this is commented out in the
  // JSX (see the two card-grid blocks below) rather than deleted, so this
  // stays too even though nothing currently calls it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleQuickDownload = async (idx: number, surfaceKey: string | null = null) => {
    const targetCanvases = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey)?.canvases : canvases;
    const c = targetCanvases?.[idx];
    if (!c) return;

    // Always re-render with isExport — c.dataUrl is a preview artifact
    // (thumbnail renders carry frame outlines + "Frame N" labels at reduced
    // resolution; the modal's toFullResDataURL dumps the live editor canvas
    // with safe-zone dashes). Downloads must be chrome-free full resolution.
    let dataUrl: string | null = null;
    try {
      const layoutDef = surfaceKey
        ? surfaceStates.find(s => s.key === surfaceKey)?.def
        : layout;
      dataUrl = await renderCanvas(c, { isExport: true, includeMask: false, layoutOverride: layoutDef });
    } catch (err) {
      console.error('[quick-download] render failed:', err);
      return;
    }
    if (!dataUrl) return;

    // Detached on purpose: a link needn't be in the document to download.
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${layout?.id || 'canvas'}-${surfaceKey || 'canvas'}-${idx + 1}.png`;
    a.click();
  };

  useEffect(() => {
    if (canvases.length > 0 && activeCanvasIdx === null) {
      const idx = parseInt(new URLSearchParams(window.location.search).get('canvas') || '');
      if (!isNaN(idx) && idx >= 0 && idx < canvases.length) {
        setActiveCanvasIdx(idx);
        const c = canvases[idx];
        setEditingCanvas({
          ...c,
          frames: c.frames.map(f => ({ ...f, offset: { ...f.offset } })),
          overlays: c.overlays.map(o => ({ ...o })),
        });
      }
    }
  }, [canvases, activeCanvasIdx]);

  const handleDrop = async (e: React.DragEvent, idx: number, surfaceKey: string | null = null) => {
    e.preventDefault();
    setDragOverIdx(null);
    if (isProcessing || heicConverting) return;

    const rawDroppedFiles = Array.from(e.dataTransfer.files);
    // A PDF dropped onto one specific surface card can only contribute as many
    // photos as that surface has print areas, so constrain the page picker to
    // that many rather than letting the customer pick more and having the
    // surfaceKey branch below silently discard the surplus (see the plan's
    // "single-select mode" note).
    const dropSurface = surfaceKey ? surfaceStates.find(s => s.key === surfaceKey) : null;
    const droppedFiles = await expandPdfPages(rawDroppedFiles, {
      maxSelectable: surfaceKey ? surfaceFrameCount(dropSurface?.def) : null,
    });

    if (droppedFiles.length > 0) {
      // ── Handle external files ──────────────────────────────────────────────
      // Validate by extension (matches the backend). A plain
      // `type.startsWith('image/')` check would let .svg through —
      // image/svg+xml is an image MIME the renderer can't accept. HEIC/HEIF
      // are converted to JPEG first — drag-and-drop ignores <input accept>,
      // so an iPhone HEIC can arrive here directly (see heic-convert.ts).
      const heicPresent = droppedFiles.some(isHeicFile);
      if (heicPresent) setHeicConverting(true);
      const { accepted: okFiles, warning } = await convertAndPartitionFiles(droppedFiles, serverHeicConvert);
      if (heicPresent) setHeicConverting(false);
      setUnsupportedWarning(warning);
      if (okFiles.length === 0) return;

      if (surfaceKey) {
        // Multi-surface: update that specific surface's files — as many as the
        // surface has print areas, so a two-page spread takes two of the
        // dropped photos instead of repeating the first one across both.
        const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
        if (sIdx === -1) return;

        const s = surfaceStates[sIdx];
        const surfaceFiles = okFiles.slice(0, surfaceFrameCount(s.def));
        const surfaceLayout = {
          ...normalizedLayoutState?._raw,
          canvas: s.def.canvas,
          frames: s.def.frames,
          maskUrl: s.def.maskUrl,
          maskOnExport: s.def.maskOnExport,
        };
        
        const newCanvases = await generateCanvasesForLayout(surfaceLayout, surfaceFiles, s.globalFitMode);
        setSurfaceStates(prev => prev.map((ps, pi) =>
          pi === sIdx ? { ...ps, files: surfaceFiles, canvases: newCanvases } : ps
        ));

        if (surfaceKey === activeSurfaceKey) {
          setFiles(surfaceFiles);
          setCanvases(newCanvases);
        }
      } else {
        // Single surface: update files array at index idx
        const frameCount = layout?.frames?.length || 1;
        const fileIdx = idx * frameCount; // Start file index for this canvas
        
        const nextFiles = [...files];
        // Replace/Insert files starting at the target index
        nextFiles.splice(fileIdx, okFiles.length, ...okFiles);
        setFiles(nextFiles);
      }
    } else {
      // ── Handle internal image swap ──────────────────────────────────────────
      const sourceIdx = e.dataTransfer.getData('canvasIdx');
      const sourceSurface = e.dataTransfer.getData('surfaceKey') || null;

      if (sourceIdx !== '') {
        await swapCards({ idx: parseInt(sourceIdx), surfaceKey: sourceSurface }, { idx, surfaceKey });
      }
    }
  };

  /**
   * Swap the photos of two cards. Shared by desktop drag-drop and the
   * touch-friendly tap-to-swap flow (Phase 3 — HTML5 drag events never fire
   * on touch, so phones had no way to swap at all).
   */
  const swapCards = async (
    source: { idx: number; surfaceKey: string | null },
    target: { idx: number; surfaceKey: string | null },
  ) => {
    if (source.idx === target.idx && source.surfaceKey === target.surfaceKey) return;

    if (target.surfaceKey || source.surfaceKey) {
      // Multi-surface swap
      const targetSurfaceIdx = surfaceStates.findIndex(s => s.key === target.surfaceKey);
      const sourceSurfaceIdx = surfaceStates.findIndex(s => s.key === source.surfaceKey);

      if (targetSurfaceIdx !== -1 && sourceSurfaceIdx !== -1) {
        // Swap the surfaces' whole photo sets, not just slot 0 — a spread
        // holds one photo per print area, and swapping only the first left
        // the second behind on the original card. Each side is clamped to its
        // OWN capacity: dropping a 2-page spread onto a 1-frame cover must not
        // hand that cover two photos, which would spill it into a second
        // canvas the surface has no page for.
        const targetCap = surfaceFrameCount(surfaceStates[targetSurfaceIdx].def);
        const sourceCap = surfaceFrameCount(surfaceStates[sourceSurfaceIdx].def);
        const targetFiles = surfaceStates[sourceSurfaceIdx].files.slice(0, targetCap);
        const sourceFiles = surfaceStates[targetSurfaceIdx].files.slice(0, sourceCap);

        // Regenerate canvases for both surfaces
        const updatedSurfaces = [...surfaceStates];

        // Update target
        const targetS = updatedSurfaces[targetSurfaceIdx];
        updatedSurfaces[targetSurfaceIdx] = {
          ...targetS,
          files: targetFiles,
          canvases: await generateCanvasesForLayout({ ...normalizedLayoutState?._raw, ...targetS.def }, targetFiles, targetS.globalFitMode)
        };

        // Update source
        const sourceS = updatedSurfaces[sourceSurfaceIdx];
        updatedSurfaces[sourceSurfaceIdx] = {
          ...sourceS,
          files: sourceFiles,
          canvases: await generateCanvasesForLayout({ ...normalizedLayoutState?._raw, ...sourceS.def }, sourceFiles, sourceS.globalFitMode)
        };

        setSurfaceStates(updatedSurfaces);

        // Sync active states
        const active = updatedSurfaces.find(s => s.key === activeSurfaceKey);
        if (active) {
          setFiles(active.files);
          setCanvases(active.canvases);
        }
      }
    } else {
      // Single surface: swap in files array
      const frameCount = layout?.frames?.length || 1;
      const targetFileIdx = target.idx * frameCount;
      const sourceFileIdx = source.idx * frameCount;

      const nextFiles = [...files];
      const temp = nextFiles[targetFileIdx];
      nextFiles[targetFileIdx] = nextFiles[sourceFileIdx];
      nextFiles[sourceFileIdx] = temp;
      setFiles(nextFiles);
    }
  };

  const handleDragOver = (e: React.DragEvent, idx: number, surfaceKey: string | null = null) => {
    e.preventDefault();
    if (dragOverIdx?.idx !== idx || dragOverIdx?.surfaceKey !== surfaceKey) {
      setDragOverIdx({ idx, surfaceKey });
    }
  };

  const handleDragStart = (e: React.DragEvent, idx: number, surfaceKey: string | null = null) => {
    e.dataTransfer.setData('canvasIdx', idx.toString());
    if (surfaceKey) e.dataTransfer.setData('surfaceKey', surfaceKey);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;

    // Reject unsupported types up-front (e.g. .svg) and name them, so the
    // customer learns which file is wrong here — not via a cryptic failure at
    // render time. Supported files still proceed. Done before the URL-revoke
    // below so an only-unsupported selection leaves existing previews intact.
    // Routed through unsupportedWarning (not `error`) so the notice isn't wiped
    // by generateCanvases() when a partial selection still produces canvases.
    // iPhone HEIC photos are converted to JPEG here first (see heic-convert.ts)
    // — neither the Fabric canvas preview nor the backend can open HEIC.
    // PDFs are expanded into customer-picked page images even earlier (see
    // pdf-import.ts) — before HEIC conversion, so its downstream checks
    // never need to know a file originated from a PDF.
    const rawFiles = await expandPdfPages(Array.from(e.target.files), { maxSelectable: null });
    const heicPresent = rawFiles.some(isHeicFile);
    if (heicPresent) setHeicConverting(true);
    const { accepted: newlyPicked, warning } = await convertAndPartitionFiles(rawFiles, serverHeicConvert);
    if (heicPresent) setHeicConverting(false);
    setUnsupportedWarning(warning);
    if (newlyPicked.length === 0) return;

    // "Add Files" — a native <input> selection is never cumulative (picking
    // again hands back only the new files, not the old ones), but this button
    // is meant to APPEND onto whatever's already on the canvas, filling the
    // next empty frame slots and spilling into new canvases once the current
    // one is full — not replace canvas 1's photo with whatever was just
    // picked. Multi-surface layouts are excluded: a pick there re-deals the
    // whole selection across the surfaces (one photo per print area, see
    // allocateFilesToSurfaces) rather than appending onto a "next canvas",
    // because each surface is a fixed physical side, not an extendable page
    // run. Picking again therefore still REPLACES the whole product's photos.
    const allFiles = surfaceStates.length > 1 ? newlyPicked : [...files, ...newlyPicked];

    // Catch truncated / incomplete photos up-front. A file cut off during
    // transfer (common with phone & WhatsApp images) still decodes leniently in
    // the browser preview, but would print with a missing/grey edge and fails
    // the strict server decode. Name them and let the customer choose
    // Keep-anyway vs Remove BEFORE we compose anything — not at render time.
    // Only the newly-picked files need checking; already-added ones were
    // vetted on a previous pass.
    const completeness = await Promise.all(newlyPicked.map(f => isImageComplete(f)));
    const truncated = newlyPicked.filter((_, i) => !completeness[i]);
    if (truncated.length > 0) {
      setPendingTruncated({ all: allFiles, bad: truncated });
      return; // wait for the decision, which re-enters via processSelectedFiles()
    }

    await processSelectedFiles(allFiles);
  };

  // Process a vetted set of selected files: reset previews, run CMYK + quantity
  // checks, then build canvases (single- or multi-surface). Split out of
  // handleFileChange so the truncated-image prompt can re-enter it with the
  // customer's chosen subset. `extendToPageCount` is set only when a book
  // overflow decision re-enters after the customer chose to extend (D3) —
  // it must be applied and used SYNCHRONOUSLY within this call (not via a
  // separate setBookPageCount + re-render) or this run would still see the
  // pre-extend page count.
  const processSelectedFiles = async (allFiles: File[], extendToPageCount?: number) => {
    // Revoke any URLs from the previous batch — start the new selection clean.
    createdObjectURLs.current.forEach(url => URL.revokeObjectURL(url));
    createdObjectURLs.current.clear();
    fileUrlCache.current = new WeakMap();

    // ── CMYK color space detection ──────────────────────────────────────────
    setColorWarning(null);
    const colorSpaces = await Promise.all(allFiles.map(f => detectJpegColorSpace(f)));
    const cmykFiles = allFiles.filter((_, i) => colorSpaces[i] === 'CMYK');
    if (cmykFiles.length > 0) {
      setColorWarning(
        `${cmykFiles.length === 1 ? `"${cmykFiles[0].name}"` : `${cmykFiles.length} files`} use CMYK colour (ISOCoated). Colours may shift — convert to sRGB for accurate on-screen preview.`
      );
    }
    // ── Calendar capacity (12 month pages) ──────────────────────────────────
    // The product renders exactly 12 pages; photos beyond 12×frames can never
    // print. Truncate up front and say so, instead of silently ignoring them.
    if (isCalendarProduct) {
      const maxFiles = (layout?.frames?.length || 1) * 12;
      if (allFiles.length > maxFiles) {
        setUploadWarning(
          `Calendars hold ${maxFiles} photo${maxFiles !== 1 ? 's' : ''} — only the first ${maxFiles} were kept.`
        );
        setTimeout(() => setUploadWarning(null), 5000);
        allFiles = allFiles.slice(0, maxFiles);
      }
    }

    // ── Qty enforcement (single-surface only) ──────────────────────────────
    // Over-qty is a HARD cap: the customer keeps the first `allowed` photos or
    // discards the pick and chooses again. There is deliberately no
    // proceed-with-all path, so a submit can never carry more photos than were
    // ordered; POST /api/editor/render re-checks the same cap, so bypassing
    // this modal does not get past it. Under-qty stays warn-and-proceed — this
    // banner plus a notice in the pre-submit modal, and the server accepts a
    // shortfall too — because a wrong qty from the caller must never
    // hard-block a customer's checkout.
    setQtyUnder(null);
    setPendingOverFiles(null);
    const qtyVerdict = checkOrderQty(allFiles.length, orderQty, surfaceStates.length);
    if (qtyVerdict.status === 'under') {
      setQtyUnder({ uploaded: qtyVerdict.uploaded, needed: qtyVerdict.needed });
    } else if (qtyVerdict.status === 'over') {
      setPendingOverFiles(allFiles);
      return; // held for the Keep-first-N / Choose-again decision
    }

    if (surfaceStates.length > 1 && normalizedLayoutState) {
      // A book overflow decision to extend applies the new page count HERE,
      // synchronously, rather than via setBookPageCount + a second render —
      // see the comment on `extendToPageCount` above.
      let workingSurfaces = surfaceStates;
      let workingHiddenPages = bookHiddenPages;
      let workingPageCount = bookPageCount;
      if (isBookProduct && extendToPageCount && extendToPageCount !== bookPageCount) {
        const raw = normalizedLayoutState._raw as BookLayoutLike;
        const reconciled = reconcilePageCount(
          raw, extendToPageCount, surfaceStatesRef.current, bookHiddenPagesRef.current,
        );
        workingSurfaces = reconciled.visible;
        workingHiddenPages = reconciled.archive;
        workingPageCount = reconciled.resolvedCount;
      }

      // Capacity is the sum of each surface's OWN frame count, not the number
      // of surfaces: a book spread is ONE surface with TWO print areas, and
      // handing it a single photo made the generator's modulo top the second
      // area up with the same photo — the customer's picture printed twice.
      const maxFiles = totalSurfaceCapacity(workingSurfaces);
      if (allFiles.length > maxFiles) {
        // D3 (BOOK_LAYOUT_PRD.md): more photos than the book currently holds
        // — offer to extend the page count instead of silently truncating.
        // Skipped once the customer has already decided for this batch
        // (bookOverflowDecidedRef), whether they chose to extend or not.
        if (isBookProduct && !bookOverflowDecidedRef.current) {
          const raw = normalizedLayoutState._raw as BookLayoutLike;
          const innerDef = workingSurfaces.find(s => s.key.startsWith('page_'))?.def;
          const perPageCapacity = surfaceFrameCount(innerDef);
          const fixedCapacity = totalSurfaceCapacity(
            workingSurfaces.filter(s => !s.key.startsWith('page_'))
          );
          const neededPages = Math.max(
            workingPageCount,
            Math.ceil(Math.max(0, allFiles.length - fixedCapacity) / perPageCapacity),
          );
          const suggestedCount = resolvePageCount(raw, neededPages);
          if (suggestedCount > workingPageCount) {
            setPendingBookOverflow({ files: allFiles, currentCapacity: maxFiles, suggestedCount });
            return; // wait for the decision — re-enters via handleBookOverflowDecision
          }
        }
        setUploadWarning(`Only ${maxFiles} image${maxFiles !== 1 ? 's' : ''} were selected.`);
        setTimeout(() => setUploadWarning(null), 5000);
      }
      bookOverflowDecidedRef.current = false; // consumed — reset for the next distinct batch

      setIsProcessing(true);
      setError(null);
      const perSurfaceFiles = allocateFilesToSurfaces(workingSurfaces, allFiles.slice(0, maxFiles));
      const updatedSurfaces: SurfaceState[] = [];
      for (let idx = 0; idx < workingSurfaces.length; idx++) {
        const s = workingSurfaces[idx];
        const surfaceFiles = perSurfaceFiles[idx];
        const surfaceLayout = {
          ...normalizedLayoutState._raw,
          canvas: s.def.canvas,
          frames: s.def.frames,
          maskUrl: s.def.maskUrl,
          maskOnExport: s.def.maskOnExport,
        };
        let canvases: CanvasItem[] = [];
        if (surfaceFiles.length > 0) {
          canvases = await generateCanvasesForLayout(surfaceLayout, surfaceFiles, s.globalFitMode);
        }
        updatedSurfaces.push({ ...s, files: surfaceFiles, canvases });
      }
      setSurfaceStates(updatedSurfaces);
      if (isBookProduct) {
        setBookHiddenPages(workingHiddenPages);
        setBookPageCount(workingPageCount);
      }
      const activeIdx = updatedSurfaces.findIndex(s => s.key === activeSurfaceKey);
      const activeSurfaceState = updatedSurfaces[activeIdx >= 0 ? activeIdx : 0];
      setFiles(activeSurfaceState?.files || []);
      setCanvases(activeSurfaceState?.canvases || []);
      setIsProcessing(false);
      return;
    }
    // NOTE (Phase 3): canvases are deliberately NOT cleared here. The
    // identity-based reuse plan in generateCanvases reconciles old edits
    // against the new selection; clearing first is what used to wipe every
    // pan/zoom/overlay on any re-pick. When the new selection drops edited
    // photos entirely, ask before discarding that work.
    const losing = countCanvasesLosingEdits(canvasesRef.current, allFiles);
    if (losing > 0 && !repickConfirmedRef.current) {
      setPendingRepick({ files: allFiles, losingCount: losing });
      return;
    }
    repickConfirmedRef.current = false;
    setFiles(allFiles);
  };

  // ── Per-frame photo replace (Phase 3) ─────────────────────────────────────
  // Replaces exactly one frame slot's File; the identity merge in the
  // generators recomputes just that slot (fresh orientation + smartcrop, no
  // fileId so the B1 effect persists the new blob) and preserves everything
  // else. Also the recovery path for "photo missing" after a failed restore.
  const requestReplacePhoto = (canvasIdx: number, frameIdx: number, surfaceKey: string | null = null) => {
    setPendingReplace({ canvasIdx, frameIdx, surfaceKey });
    replacePhotoInputRef.current?.click();
  };

  const handleReplaceFileSelected = async (file: File) => {
    if (!pendingReplace) return;
    const { canvasIdx, frameIdx, surfaceKey } = pendingReplace;
    setPendingReplace(null);
    // A single slot can only ever take one photo — single-select picker.
    const [expandedFile] = await expandPdfPages([file], { maxSelectable: 1 });
    if (!expandedFile) return; // PDF picker was cancelled
    file = expandedFile;
    const wasHeic = isHeicFile(file);
    if (wasHeic) setHeicConverting(true);
    try {
      file = await convertHeicFileIfNeeded(file, serverHeicConvert);
    } catch (err) {
      setUnsupportedWarning(err instanceof Error ? err.message : `"${file.name}" couldn't be converted.`);
      return;
    } finally {
      if (wasHeic) setHeicConverting(false);
    }
    if (!isAllowedImageFile(file)) {
      setUnsupportedWarning(unsupportedFilesMessage([file]));
      return;
    }
    if (!(await isImageComplete(file))) {
      setError('That image appears incomplete — please re-export it and try again.');
      return;
    }
    if (surfaceKey) {
      // Surface cards hold one canvas; the slot is the frame index within
      // the surface's own files array.
      const s = surfaceStates.find(x => x.key === surfaceKey);
      if (!s) return;
      const nextFiles = [...s.files];
      nextFiles[frameIdx] = file;
      const canvases = await generateCanvasesForLayout(s.def, nextFiles, s.globalFitMode, s.canvases);
      setSurfaceStates(prev => prev.map(x => x.key === surfaceKey ? { ...x, files: nextFiles, canvases } : x));
      if (surfaceKey === activeSurfaceKey) {
        skipNextGenerateRef.current = true;
        setFiles(nextFiles);
        setCanvases(canvases);
      }
    } else {
      const frameCount = layout?.frames?.length || 1;
      const slot = canvasIdx * frameCount + frameIdx;
      setFiles(prev => {
        const next = [...prev];
        next[slot] = file;
        return next;
      });
    }
  };

  // Re-pick confirm (Phase 3 — ask before discarding edits). Mirrors the
  // pendingOverFiles pattern: hold the selection, show a modal, re-enter on
  // confirm with the guard ref set so we don't re-prompt.
  const handleRepickConfirm = (proceed: boolean) => {
    if (!pendingRepick) return;
    const { files: held } = pendingRepick;
    setPendingRepick(null);
    if (proceed) {
      repickConfirmedRef.current = true;
      void processSelectedFiles(held);
    }
  };

  // ── Qty: fill with user-chosen duplicates from picker ─────────────────────
  const handleFillWithPicked = () => {
    if (!qtyUnder || pickerSelected.size === 0) return;
    const needed = qtyUnder.needed - files.length;
    const picks = Array.from(pickerSelected).slice(0, needed).map(i => files[i]);
    // Pad with auto-cycling if picker selection was fewer than needed
    const filled = [...files, ...picks];
    if (filled.length < qtyUnder.needed) {
      for (let i = 0; filled.length < qtyUnder.needed; i++) filled.push(files[i % files.length]);
    }
    // Deliberate duplication — exempt from the duplicate-fill warning.
    filled.forEach(f => intentionalDupesRef.current.add(duplicateFingerprint(f)));
    setQtyUnder(null);
    setShowAutoFillPicker(false);
    setPickerSelected(new Set());
    setFiles(filled);
  };

  // ── Qty: over-upload — hard cap, keep-first-N or discard ──────────────────
  // `keepFirst` trims the selection down to the ordered quantity; otherwise the
  // whole pick is dropped and the existing photos are left untouched so the
  // customer can choose a different set. Neither branch can produce a selection
  // larger than orderQty — that is the point of the cap.
  const handleOverConfirm = (keepFirst: boolean) => {
    if (!pendingOverFiles || orderQty === null) return;
    if (keepFirst) {
      setFiles(pendingOverFiles.slice(0, orderQty));
    } else {
      // "Choose again" promises to let the customer pick exactly the ones
      // they want, but discarding the pick and closing the modal alone left
      // them looking at the same at-quota screen with no visible way to try
      // a different selection — the header's "Add Photos" pill is plain info
      // once quota is met, and the shortfall banner (with its own "Choose
      // which to repeat") only exists while under quota. Reopen the picker
      // immediately so the button actually does what it says.
      uploadInputRef.current?.click();
    }
    setPendingOverFiles(null);
  };

  // ── Incomplete/truncated images — customer chose Keep-anyway or Remove ─────
  const handleTruncatedDecision = (decision: 'keep' | 'remove') => {
    if (!pendingTruncated) return;
    const { all, bad } = pendingTruncated;
    setPendingTruncated(null);
    const chosen = decision === 'keep' ? all : all.filter(f => !bad.includes(f));
    if (chosen.length === 0) {
      setUnsupportedWarning(
        `All selected image${bad.length > 1 ? 's were' : ' was'} incomplete and removed — please re-upload.`
      );
      return;
    }
    void processSelectedFiles(chosen);
  };

  // ── Book overflow (D3) — customer chose Extend or Keep-as-is ───────────────
  const handleBookOverflowDecision = (decision: 'extend' | 'keep') => {
    if (!pendingBookOverflow) return;
    const { files: held, suggestedCount } = pendingBookOverflow;
    setPendingBookOverflow(null);
    bookOverflowDecidedRef.current = true;
    void processSelectedFiles(held, decision === 'extend' ? suggestedCount : undefined);
  };

  const imposition = useImposition({ layout, surfaceStates, canvases, renderCanvas, setError, setRenderProgress });
  const { showImpositionModal, setShowImpositionModal, isImposing } = imposition;

  // ── Escape closes dialogs (Phase 4 a11y) ──────────────────────────────────
  // One document-level handler (effect + cleanup — the sanctioned no-DOM
  // exception) closes whichever dialog is open, so keyboard users aren't
  // trapped. The dialogs only manage focus (useModalA11y with onClose: null)
  // and leave Escape here, so one press closes one dialog: the top one. The
  // confirms are drawn above the print-sheet window, and it above the download
  // options. On the file-pick prompts it cancels the pick. The full editor
  // modal manages its own keys (Fabric uses Escape for text editing) and is not
  // included here. It sits after useImposition, whose state it reads.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showAutoFillPicker) return setShowAutoFillPicker(false);
      if (pendingRepick) return setPendingRepick(null);
      if (deleteConfirm) return setDeleteConfirm(null);
      if (pendingOverFiles) return setPendingOverFiles(null);
      if (pendingTruncated) return setPendingTruncated(null);
      if (pendingBookOverflow) return setPendingBookOverflow(null);
      if (showImpositionModal) return setShowImpositionModal(false);
      if (showDownloadModal) return setShowDownloadModal(false);
      if (showEmbedDisclaimer) return setShowEmbedDisclaimer(false);
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [showAutoFillPicker, pendingRepick, deleteConfirm, pendingOverFiles, pendingTruncated, pendingBookOverflow, showImpositionModal, setShowImpositionModal, showDownloadModal, showEmbedDisclaimer]);

  // All exports go through the server-side pipeline (Celery + Pillow at 300 DPI).
  // The previous "≤20 canvases → render in browser, JSZip" optimisation was
  // removed in v1.8 — uniform contract, predictable progress UI, and the
  // server pipeline is faster on big jobs while the small-job overhead
  // (~10–20 s of upload + poll) is acceptable.
  const executeServerRender = async () => {
    setIsDownloading(true);
    // Embed customers get plain product wording; the dashboard keeps the
    // operational labels staff rely on to tell a slow upload from a slow
    // render. The work is identical either way — only the copy differs.
    setServerRenderLabel(embedToken ? 'Saving your design…' : 'Preparing upload…');
    setRenderProgress({ current: 0, total: 100 });
    try {
      // 1. Collect all canvases in order across all surfaces. A surface the
      // customer left EMPTY is included as one blank canvas (null upload_ids)
      // rather than dropped: dropping it used to make the engine render that
      // surface with the other surface's photos (Phase 3 wrong-print fix) —
      // now it prints blank and the pre-submit warning tells the customer so.
      const allCanvases = surfaceStates.length > 1
        ? surfaceStates.flatMap(s =>
            s.canvases.length > 0
              ? s.canvases.map(c => ({ ...c, surfaceKey: s.key }))
              : [{
                  id: 0,
                  frames: (s.def.frames || [{ }]).map((_, fi) => ({
                    id: fi,
                    originalFile: null,
                    offset: { x: 0, y: 0 },
                    scale: 1,
                    rotation: 0,
                    fitMode: s.globalFitMode,
                  })) as FrameState[],
                  overlays: [] as Overlay[],
                  bgColor: '#ffffff',
                  paperColor: '#ffffff',
                  dataUrl: null,
                  surfaceKey: s.key,
                }]
          )
        // Send the REAL surface key, not a literal 'canvas'. For a single
        // surface of a type:product layout (e.g. a ?surfaces=front view of a
        // 2-sided product) the engine's per-surface grouping keys off this;
        // the literal matched no surface and printed every side blank. Legacy
        // type:single layouts fall back to 'canvas', which the engine ignores.
        : canvases.map(c => ({ ...c, surfaceKey: surfaceStates[0]?.key ?? activeSurfaceKey ?? 'canvas' }));

      // 2. Collect unique File objects in frame order, then any local
      //    image-overlay files (stickers the customer uploaded) so they upload
      //    in the same batch and the server can resolve them for the print.
      const allFiles: File[] = [];
      const seenFiles = new Set<File>();
      for (const c of allCanvases) {
        for (const frame of c.frames) {
          if (frame.originalFile && !seenFiles.has(frame.originalFile)) {
            seenFiles.add(frame.originalFile);
            allFiles.push(frame.originalFile);
          }
        }
        for (const ov of c.overlays) {
          if (ov.type === 'image' && ov.originalFile && !seenFiles.has(ov.originalFile)) {
            seenFiles.add(ov.originalFile);
            allFiles.push(ov.originalFile);
          }
        }
      }

      // Guard: a frame that once held a photo (it carries a persisted fileId)
      // but whose File did not rehydrate this session (originalFile === null)
      // would submit an empty slot. Rather than silently ship an incomplete
      // design, block the submit and name the photos to re-upload. This closes
      // the client side of the silent wrong-print bug (the backend now renders
      // such a slot blank instead of shifting other photos into it).
      const lostFrames: string[] = [];
      allCanvases.forEach((c, ci) => {
        c.frames.forEach((frame, fi) => {
          if ((frame.fileId || frame.fileName) && !frame.originalFile) {
            lostFrames.push(
              allCanvases.length > 1 ? `page ${ci + 1}, photo ${fi + 1}` : `photo ${fi + 1}`,
            );
          }
        });
      });
      if (lostFrames.length > 0) {
        const shown = lostFrames.slice(0, 3).join('; ');
        const more = lostFrames.length > 3 ? `, and ${lostFrames.length - 3} more` : '';
        setError(
          `${lostFrames.length} photo${lostFrames.length > 1 ? 's' : ''} could not be ` +
          `recovered (${shown}${more}). Please re-upload ` +
          `${lostFrames.length > 1 ? 'them' : 'it'} before continuing so your print ` +
          `matches your design.`,
        );
        return;
      }

      if (allFiles.length === 0) {
        setError('No files to upload for server render.');
        return;
      }

      // Block unsupported types before uploading so the failure names the file
      // (e.g. a .svg restored from a prior session) instead of surfacing the
      // backend's cryptic "Upload complete failed for …" mid-batch.
      const badFiles = allFiles.filter(f => !isAllowedImageFile(f));
      if (badFiles.length > 0) {
        setError(unsupportedFilesMessage(badFiles));
        return;
      }

      // 3. Upload files — progress 0–60%
      setServerRenderLabel(embedToken ? 'Saving your photos…' : 'Uploading files…');
      const uploadResults = await uploadFiles(
        allFiles,
        apiBase,
        getAuthHeaders,
        (completed, total) => {
          setRenderProgress({ current: Math.round((completed / total) * 60), total: 100 });
        },
        orderId,
      );

      // 4. Build render payload: canvases → frames → upload_id + per-frame transforms
      setServerRenderLabel(embedToken ? 'Finishing up…' : 'Submitting render job…');
      setRenderProgress({ current: 65, total: 100 });

      const canvasesPayload = allCanvases.map((c, canvasIdx) => ({
        canvas_index: canvasIdx,
        surface_key: (c as any).surfaceKey,
        // Phase 2 (WYSIWYG): carry the customer's canvas background + paper mat
        // colours so the print matches the preview (engine defaulted to white).
        bg_color: (c as any).bgColor ?? null,
        paper_color: (c as any).paperColor ?? null,
        frames: c.frames.map((frame, frameIdx) => {
          const up = frame.originalFile ? uploadResults.get(frame.originalFile) : null;
          return {
            frame_index: frameIdx,
            upload_id: up?.uploadId ?? null,
            offset_x: frame.offset.x,
            offset_y: frame.offset.y,
            scale: frame.scale,
            rotation: frame.rotation,
            fit_mode: frame.fitMode,
            // WYSIWYG extras. Fill sides (contain-only). Captions are a
            // per-template opt-in (layout.frameCaptionsEnabled), OFF by default,
            // so we never carry a caption into the print for a product that
            // wasn't designed for one — even if stale state has one set.
            fill_style: frame.fillStyle ?? null,
            caption: (layout as any)?.frameCaptionsEnabled ? (frame.caption?.trim() || null) : null,
            caption_enabled: Boolean((layout as any)?.frameCaptionsEnabled && frame.captionEnabled),
          };
        }),
        // Phase 2 (WYSIWYG): carry text / shape / image overlays into the print.
        // The engine already renders them (services/overlay_renderer.py); they
        // were just never sent. Shapes already match the backend union. Drop the
        // non-serialisable File; for a local image overlay set fileId to the
        // server upload id so the backend can resolve the bytes, and drop the
        // (revoked) blob src. Clipart/icon overlays keep their src path.
        overlays: c.overlays.map((ov) => {
          if (ov.type !== 'image') return ov;
          const up = ov.originalFile ? uploadResults.get(ov.originalFile) : null;
          const rest: Record<string, unknown> = { ...ov };
          delete rest.originalFile;
          rest.fileId = up?.uploadId ?? ov.fileId ?? null;
          rest.src = ov.source === 'local' ? null : ov.src;
          return rest;
        }),
      }));

      // For calendar products, attach the product-wide calendar block to every
      // canvas entry. Cells are ONE flat ISO-keyed map (entries belong to
      // dates, not photo canvases) — the server merges duplicates
      // idempotently and each month's renderer draws only its own dates.
      if (isCalendarProduct) {
        canvasesPayload.forEach((c) => {
          (c as any).calendar = {
            themePreset: calendarTheme,
            calendarType,
            genzPalette,
            cells: calendarCells,
          };
        });
      }

      // For book products, attach the customer's chosen page count (D2) so
      // the engine's materialize_pages() produces the SAME page count the
      // customer edited — `_extract_book_state` reads this the same way
      // `_extract_calendar_state` reads the calendar block above. No
      // pageOverrides here — that's the ops escape hatch (bespoke per-page
      // content authored on the template), never customer-editable.
      if (isBookProduct) {
        canvasesPayload.forEach((c) => {
          (c as any).book = { pageCount: bookPageCount };
        });
      }

      const renderRes = await fetch(`${apiBase}/editor/render`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout_name: layoutName,
          order_id: orderId,
          canvases: canvasesPayload,
          // True when the pre-submit modal showed QtyShortfallWarning and the
          // customer submitted anyway. The server recounts the photos itself
          // and only forwards this flag in the webhook's qty_summary.
          qty_shortfall_acknowledged: qtyNeeded > 0 && totalUploadedCount < qtyNeeded,
        }),
      });

      if (!renderRes.ok) {
        const err = await renderRes.json().catch(() => ({}));
        throw new Error(err.detail ?? `Render job submission failed: ${renderRes.status}`);
      }

      const { job_id, order_id: serverOrderId } = await renderRes.json();

      // 5. Embed path: fire postMessage, then show the LIVE status panel
      // (Phase 3 — no more dead-end): the overlay polls render-status via the
      // embed proxy, surfaces queued/rendering/done/failed honestly, and
      // offers a way back into the editor.
      if (embedToken) {
        window.parent.postMessage({
          type: 'pe:render_job',
          jobId: job_id,
          orderID: serverOrderId || orderId,
        }, parentOrigin);
        setSubmittedJobId(job_id);
        setSubmitted(true);
        return;
      }

      // 6. Direct/admin path: poll render-status until done.
      // Exponential backoff: starts at 2 s, doubles to 10 s cap, with ±20%
      // jitter so concurrent jobs don't synchronise their polls. A 10-min
      // render now triggers ~50 requests instead of the previous 150.
      setServerRenderLabel('Rendering on server…');
      setRenderProgress({ current: 70, total: 100 });

      const POLL_DEADLINE = Date.now() + 10 * 60 * 1000; // 10 minutes
      let pollDelay = 2000;
      let pollCount = 0;
      while (Date.now() < POLL_DEADLINE) {
        const jitter = 0.8 + Math.random() * 0.4; // 0.8x - 1.2x
        await new Promise(r => setTimeout(r, Math.round(pollDelay * jitter)));
        pollDelay = Math.min(pollDelay * 1.5, 10000);
        pollCount += 1;

        const statusRes = await fetch(`${apiBase}/render-status/${job_id}/`, {
          headers: getAuthHeaders(),
        });
        if (!statusRes.ok) continue;

        const jobStatus = await statusRes.json();

        // Honest wait status (Phase 3): show the REAL queue position/state
        // from RenderStatusView instead of a synthetic "rendering" animation.
        if (jobStatus.status === 'queued') {
          setServerRenderLabel(
            jobStatus.estimated_wait_seconds != null
              ? `Queued — about ${formatWait(jobStatus.estimated_wait_seconds)} wait`
              : 'Queued…'
          );
          setRenderProgress({ current: 70, total: 100 });
          continue;
        }
        if (jobStatus.status === 'processing') {
          setServerRenderLabel('Rendering your print files…');
        }

        if (jobStatus.status === 'completed') {
          setServerRenderLabel('Downloading…');
          setRenderProgress({ current: 100, total: 100 });

          // Trigger a native browser download instead of fetch+blob.
          // For 200-photo jobs the ZIP is 500–700 MB — buffering that into
          // a JS Blob via `await dlRes.blob()` pushes the browser tab past
          // its heap budget AND fights Cloudflare's 100 s time-to-first-
          // byte limit. A `<a download>` navigation streams chunks
          // straight to disk via the browser's native download manager
          // (its own progress UI included). The internal proxy already
          // forwards Content-Disposition from Django so the saved
          // filename is correct without us having to set the `download`
          // attribute. Cookie auth flows through navigation just like fetch.
          const downloadUrl = `${apiBase}/jobs/${job_id}/download/?include_uploads=${includeUploadsRef.current ? '1' : '0'}`;
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.rel = 'noopener';
          // download attr is a hint — Content-Disposition from upstream wins
          // when present (Django sends "<layout>-<short-id>.zip"). This is just
          // the fallback name if that header is ever stripped.
          a.download = `${layout?.name || layoutName}.zip`;
          // Detached on purpose: a link needn't be in the document to download.
          a.click();
          return;
        }

        if (jobStatus.status === 'failed') {
          throw new Error(jobStatus.error || 'Server render failed');
        }

        // Ease progress 70 → 99 while rendering (cap at poll #15 so the bar
        // doesn't stall when polls slow down due to backoff).
        setRenderProgress({ current: Math.min(99, 70 + Math.min(pollCount, 15) * 2), total: 100 });
      }

      throw new Error('Render job timed out after 10 minutes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Server render failed.');
    } finally {
      setIsDownloading(false);
      setShowDownloadModal(false);
      setServerRenderLabel(null);
      setRenderProgress(null);
    }
  };

  // Dashboard ZIP download: always server-render. The previous client-side
  // path (in-browser canvas-to-blob → JSZip → downloadBlob) was removed in
  // v1.8 to give all users — regardless of canvas count — the same Celery
  // pipeline. The server pipeline is faster on large batches, more memory-
  // friendly on small ones, and produces identical output. Trade-off: small
  // (≤20 canvas) jobs now incur an upload + poll round-trip (~10–20 s extra
  // on a fast connection) instead of rendering instantly in the browser.
  const executeBatchDownload = async () => {
    const allCanvases = surfaceStates.length > 1
      ? surfaceStates.flatMap(s => s.canvases)
      : canvases;
    if (allCanvases.length === 0) {
      setError('No canvases to download.');
      return;
    }
    setShowDownloadModal(false);
    return executeServerRender();
  };

  // ── Calendar cell editing helpers (PRD §10.3 / audit fix #1) ─────────────

  const calendarCellEntries = (iso: string): any[] => calendarCells[iso] || [];

  const updateCellEntries = useCallback((iso: string, updater: (prev: any[]) => any[]) => {
    setCalendarCells(prev => {
      const next = { ...prev };
      const updated = updater(next[iso] || []);
      if (updated.length === 0) {
        delete next[iso];
      } else {
        next[iso] = updated;
      }
      return next;
    });
  }, []);

  // Phase 8 — cell image override upload
  const handleCellImageFileSelected = useCallback(async (file: File) => {
    if (!selectedCalendarCell || !orderId) return;
    // A calendar cell can only ever take one photo — single-select picker.
    const [expandedFile] = await expandPdfPages([file], { maxSelectable: 1 });
    if (!expandedFile) return; // PDF picker was cancelled
    file = expandedFile;
    // HEIC/HEIF pass this gate too — uploadCalendarCellImage converts them to
    // JPEG as its first step (see calendar-cell-upload.ts).
    if (!isAllowedImageFile(file) && !isHeicFile(file)) {
      setUnsupportedWarning(unsupportedFilesMessage([file]));
      return;
    }
    const { iso } = selectedCalendarCell;
    setCalendarImageUploading(true);
    try {
      const result = await uploadCalendarCellImage(file, {
        apiBase,
        orderId,
        getAuthHeaders,
      });
      // Replace any existing entries on this cell with the image override.
      updateCellEntries(iso, () => [{ type: 'image', uploadId: result.uploadId }]);
      if (result.persistDegraded) setPersistDegraded(true);
      // Cache the blob URL for the panel preview (keyed by ISO — dates are
      // globally unique, so the key survives calendar-type flips).
      setCalendarCellImagePreviews(prev => {
        if (prev[iso]) URL.revokeObjectURL(prev[iso]);
        return { ...prev, [iso]: result.blobUrl };
      });
    } catch (err) {
      if (err instanceof CalendarCellUploadError) {
        setError(err.message);
      } else {
        setError('Failed to upload image for this date. Please try again.');
      }
    } finally {
      setCalendarImageUploading(false);
    }
  }, [selectedCalendarCell, orderId, apiBase, getAuthHeaders, updateCellEntries, expandPdfPages]);

  const handleCalendarMonthTileClick = (surfaceIndex: number, year: number, month: number) => {
    // Open the first day of the month by default — customer can tap a specific cell after.
    const firstIso = `${year}-${String(month).padStart(2, '0')}-01`;
    setSelectedCalendarCell({ surfaceIndex, year, month, iso: firstIso });
  };

  // Embed Save & Continue: always server-render. The Celery render task
  // produces a downloadable ZIP and (when the parent registered a callback at
  // session creation) POSTs the download URL + HMAC-signed payload to the
  // parent's webhook. The iframe additionally fires `pe:render_job` so the
  // parent's frontend can show "your design is being prepared" UX.
  const handleSubmitDesign = async () => {
    const allCanvases = surfaceStates.length > 1
      ? surfaceStates.flatMap(s => s.canvases)
      : canvases;
    if (allCanvases.length === 0) return;
    return executeServerRender();
  };

  if (status === 'loading' && !embedToken) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
    </div>
  );
  if (layoutLoading) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50">
      <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Loading template…</p>
    </div>
  );
  if (!layout) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="text-center"><p className="text-slate-600 font-medium">Layout not found.</p></div></div>;

  // `files` mirrors only the ACTIVE surface, so on a multi-surface product it
  // under-reports the product-wide total (a 4-photo book read as "2"). Sum the
  // surfaces there; single-surface keeps reading `files` as before.
  const surfaceFileTotal = surfaceStates.reduce((acc, s) => acc + s.files.length, 0);
  const totalUploadedCount = surfaceStates.length > 1
    ? surfaceFileTotal
    : (files.length > 0 ? files.length : surfaceFileTotal);

  // Ordered quantity as the upload box and pre-submit modals see it. They
  // compare against the LIVE placed count rather than the pick-time `qtyUnder`
  // banner state, which the customer can dismiss. 0 disables the notice: no qty
  // from the session or URL, or a multi-surface product — the same gate as
  // checkOrderQty.
  const qtyNeeded = orderQty !== null && surfaceStates.length <= 1 ? orderQty : 0;

  return (
    <div className="min-h-screen bg-slate-50/50 flex flex-col">
      <GoogleFontLinks fonts={fontsLoaded} />
      {swapSource && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200000] bg-indigo-600 text-white px-5 py-2.5 rounded-2xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-300" role="status">
          <ArrowLeftRight className="w-4 h-4" />
          <span className="text-xs font-semibold">Tap another photo to swap</span>
          <button onClick={() => setSwapSource(null)} className="p-1 hover:bg-white/20 rounded-lg transition-all" aria-label="Cancel swap">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {(persistDegraded || storageBlocked) && (
        <div className="fixed bottom-6 right-8 z-[200000] max-w-sm bg-white/90 backdrop-blur-2xl border border-amber-300/60 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-amber-900/10 flex items-start gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group" role="status" aria-live="polite">
          <div className="w-7 h-7 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0 mt-1">
            <AlertTriangle className="w-3.5 h-3.5" />
          </div>
          <span className="flex-1 text-[10px] font-bold text-amber-900/80 tracking-tight leading-snug py-1.5">
            {storageBlocked
              ? "Your browser is blocking local storage — your photos stay safe in this tab, but refreshing will remove them. Finish and submit in one session."
              : "This device's storage is full, so your photos can't be backed up for recovery. Don't refresh or close this tab before submitting."}
          </span>
          <button onClick={() => { setPersistDegraded(false); setStorageBlocked(false); }} className="p-2 hover:bg-amber-50 rounded-xl transition-all" aria-label="Dismiss storage warning">
            <X className="w-3.5 h-3.5 text-amber-400" />
          </button>
        </div>
      )}
      {uploadWarning && (
        <div className="fixed top-24 right-8 z-[200000] max-w-xs bg-white/80 backdrop-blur-2xl border border-amber-200/50 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-amber-900/5 flex items-center gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group">
          <div className="w-7 h-7 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0">
            <span className="text-[14px] font-black">!</span>
          </div>
          <span className="flex-1 text-[10px] font-bold text-amber-900/80 uppercase tracking-tight leading-none">{uploadWarning}</span>
          <button onClick={() => setUploadWarning(null)} className="p-2 hover:bg-amber-50 rounded-xl transition-all group-hover:rotate-90">
            <X className="w-3.5 h-3.5 text-amber-400" />
          </button>
        </div>
      )}
      {colorWarning && (
        <div className={`fixed ${uploadWarning ? 'top-44' : 'top-24'} right-8 z-[200001] max-w-sm bg-white/90 backdrop-blur-2xl border border-orange-300/60 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-orange-900/10 flex items-start gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group`}>
          <div className="w-7 h-7 mt-0.5 rounded-xl bg-orange-500/10 text-orange-600 flex items-center justify-center shrink-0">
            <span className="text-[13px] font-black">⚠</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black text-orange-900/90 uppercase tracking-tight leading-none mb-1">CMYK → RGB colour shift</p>
            <p className="text-[10px] font-medium text-orange-800/70 leading-snug">{colorWarning}</p>
          </div>
          <button onClick={() => setColorWarning(null)} className="p-2 mt-0.5 hover:bg-orange-50 rounded-xl transition-all shrink-0">
            <X className="w-3.5 h-3.5 text-orange-400" />
          </button>
        </div>
      )}
      {unsupportedWarning && (
        <div className={clsx(
          'fixed right-8 z-[200001] max-w-sm bg-white/90 backdrop-blur-2xl border border-rose-300/60 p-1.5 pl-4 rounded-2xl shadow-2xl shadow-rose-900/10 flex items-start gap-3 animate-in fade-in slide-in-from-right-8 duration-500 group',
          ['top-24', 'top-44', 'top-64'][(uploadWarning ? 1 : 0) + (colorWarning ? 1 : 0)],
        )}>
          <div className="w-7 h-7 mt-0.5 rounded-xl bg-rose-500/10 text-rose-600 flex items-center justify-center shrink-0">
            <span className="text-[13px] font-black">!</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black text-rose-900/90 uppercase tracking-tight leading-none mb-1">Unsupported file</p>
            <p className="text-[10px] font-medium text-rose-800/70 leading-snug">{unsupportedWarning}</p>
          </div>
          <button onClick={() => setUnsupportedWarning(null)} className="p-2 mt-0.5 hover:bg-rose-50 rounded-xl transition-all shrink-0">
            <X className="w-3.5 h-3.5 text-rose-400" />
          </button>
        </div>
      )}
      {/* ── Under-upload banner ─────────────────────────────────────────────── */}
      {/* Offset by the MEASURED header height rather than a hardcoded `top-24`:
          the mobile header is two rows (72 + 56 px), so the old 96 px offset
          parked this card on top of it. Full-bleed with gutters on phones,
          centred card from `sm` up. */}
      {qtyUnder && (
        <div
          role="status"
          aria-live="polite"
          style={{ top: headerHeight + toolbarHeight + 12 }}
          className="fixed left-3 right-3 sm:left-1/2 sm:right-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 z-[200002] bg-white/95 backdrop-blur-2xl border border-indigo-200/60 rounded-2xl shadow-2xl shadow-indigo-900/10 p-4 sm:p-5 animate-in fade-in slide-in-from-top-4 duration-400"
        >
          <div className="flex items-start gap-3 sm:gap-4">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
              <ImagePlus className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] sm:text-sm font-black text-slate-900 uppercase tracking-tight leading-tight">
                {qtyUnder.uploaded} of {qtyUnder.needed} images uploaded
              </p>
              <p className="text-[12px] text-slate-500 mt-1.5 leading-relaxed">
                Upload {qtyUnder.needed - qtyUnder.uploaded} more photo{qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''}, or repeat from the images already uploaded.
              </p>
            </div>
            <button
              onClick={() => setQtyUnder(null)}
              aria-label="Dismiss"
              className="p-2 -mt-1 -mr-1 hover:bg-slate-100 rounded-xl transition-all shrink-0"
            >
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>

          {/* The count IS the message, so show it as a bar too. */}
          <div className="mt-4 h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-indigo-600 transition-all duration-500"
              style={{ width: `${Math.min(100, Math.round((qtyUnder.uploaded / qtyUnder.needed) * 100))}%` }}
            />
          </div>

          {/* Stacked on phones — side by side, these two labels wrap to three
              lines each inside a 375 px viewport. */}
          <div className="mt-4 flex flex-col sm:flex-row items-stretch gap-2">
            <button
              onClick={() => { setShowAutoFillPicker(true); setPickerSelected(new Set()); }}
              className="flex-1 min-h-[44px] px-4 py-3 text-[11px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
            >
              Choose which to repeat
            </button>
            <button
              onClick={() => uploadInputRef.current?.click()}
              className="flex-1 min-h-[44px] px-4 py-3 text-[11px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
            >
              Upload More
            </button>
          </div>
        </div>
      )}

      {/* ── Auto-fill picker modal ──────────────────────────────────────────── */}
      {showAutoFillPicker && qtyUnder && (
        <AutoFillPickerDialog
          qtyUnder={qtyUnder}
          files={files}
          getFileUrl={getFileUrl}
          pickerSelected={pickerSelected}
          setPickerSelected={setPickerSelected}
          onClose={() => setShowAutoFillPicker(false)}
          onConfirm={handleFillWithPicked}
        />
      )}

      {/* ── Delete confirm modal ─────────────────────────────────────────────── */}
      {deleteConfirm && (
        <DeleteConfirmDialog onConfirm={confirmDelete} onCancel={() => setDeleteConfirm(null)} />
      )}

      {/* ── Re-pick confirm modal (Phase 3 — ask before discarding edits) ──── */}
      {pendingRepick && (
        <RepickConfirmDialog losingCount={pendingRepick.losingCount} onDecide={handleRepickConfirm} />
      )}

      {/* Hidden input feeding the per-frame photo replace (Phase 3). */}
      <input
        ref={replacePhotoInputRef}
        type="file"
        accept={IMAGE_AND_PDF_ACCEPT_ATTR}
        className="hidden"
        aria-hidden
        onChange={e => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handleReplaceFileSelected(file);
        }}
      />

      {/* The one "add photos" picker, mounted unconditionally. Both entry points
          open it through this ref: the empty-state drop zone and the "Add Photos"
          bar. It used to live INSIDE the bar, which only renders once a photo
          exists — so on an empty editor the ref was null and clicking the drop
          zone silently did nothing, leaving drag-and-drop as the only way in. */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        accept={IMAGE_AND_PDF_ACCEPT_ATTR}
        className="hidden"
        aria-hidden
        onChange={(e) => {
          // Clearing the value once the handler is done is what lets the SAME
          // photo be picked twice in a row — an unchanged value fires no change
          // event, so the second pick would look like a dead click. handleFileChange
          // copies e.target.files before its first await, so this can't race it.
          const el = e.target;
          void handleFileChange(e).finally(() => { el.value = ''; });
        }}
      />

      {/* ── Over-upload confirm modal ───────────────────────────────────────── */}
      {pendingOverFiles && orderQty && (
        <OverQuantityDialog orderQty={orderQty} selectedCount={pendingOverFiles.length} onDecide={handleOverConfirm} />
      )}

      {pendingTruncated && (
        <TruncatedImagesDialog badFiles={pendingTruncated.bad} onDecide={handleTruncatedDecision} />
      )}

      {/* ── Book D3: more photos than pages — warn and offer to extend ───── */}
      {pendingBookOverflow && (
        <BookOverflowDialog overflow={pendingBookOverflow} pageCount={bookPageCount} onDecide={handleBookOverflowDecision} />
      )}

      {/* ── Book: read-only spread preview (D6) ─────────────────────────── */}
      {showSpreadPreview && (
        <div className="fixed inset-0 z-[200004] bg-black/60 backdrop-blur-sm flex flex-col animate-in fade-in duration-200">
          <div className="flex items-center justify-between px-6 py-4 bg-white/95 border-b border-slate-200 shrink-0">
            <div>
              <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight">Spread preview</h2>
              <p className="text-[10px] text-slate-400 font-medium">Read-only — edit individual pages in the grid</p>
            </div>
            <button
              onClick={() => setShowSpreadPreview(false)}
              aria-label="Close spread preview"
              className="p-2 hover:bg-slate-100 rounded-xl transition-colors"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center gap-8">
            {bookSpreads.length === 0 && !bookCoverPreview && !bookBackCoverPreview && (
              <p className="text-sm text-slate-400 mt-10">No pages to preview yet.</p>
            )}

            {/* ── Cover wrap: back · spine · front, joined edge-to-edge as one
                physical printed sheet (R2/D4) — placeholders make the spine's
                real proportion to the covers visible before it's printed. ─ */}
            {(bookCoverPreview || bookBackCoverPreview) && (() => {
              const frontMm = bookCoverPreview?.canvasWidthMm || 1;
              const backMm = bookBackCoverPreview?.canvasWidthMm || frontMm;
              const spineMm = Math.max(bookSpineWidthMm || 0, 0);
              const wrapHeight = bookCoverPreview?.canvasHeight || bookBackCoverPreview?.canvasHeight || 1800;
              const wrapWidth = bookCoverPreview?.canvasWidth || bookBackCoverPreview?.canvasWidth || 1200;
              return (
                <div className="flex flex-col items-center gap-2">
                  <div
                    className="flex items-stretch shadow-xl rounded-lg overflow-hidden bg-white"
                    style={{ aspectRatio: `${wrapWidth * ((backMm + spineMm + frontMm) / frontMm)} / ${wrapHeight}`, height: '38vh' }}
                  >
                    <div className="relative bg-slate-100 flex items-center justify-center" style={{ flex: `${backMm} 0 0px` }}>
                      {bookBackCoverPreview?.dataUrl ? (
                        <img src={bookBackCoverPreview.dataUrl} alt="Back cover" className="w-full h-full object-fill" />
                      ) : (
                        <Layout className="w-8 h-8 text-slate-300 opacity-40" />
                      )}
                    </div>
                    <div
                      className="relative bg-gradient-to-b from-amber-100 to-amber-200 border-x-2 border-amber-300 flex items-center justify-center shrink-0"
                      style={{ flex: `${spineMm || 0.001} 0 0px`, minWidth: spineMm > 0 ? '6px' : '0px' }}
                      title={bookSpineWidthMm != null ? `Spine: ${bookSpineWidthMm.toFixed(1)}mm` : undefined}
                    >
                      {spineMm > 3 && (
                        <span
                          className="text-[7px] font-black text-amber-700 uppercase tracking-widest whitespace-nowrap"
                          style={{ writingMode: 'vertical-rl' }}
                        >
                          Spine
                        </span>
                      )}
                    </div>
                    <div className="relative bg-slate-100 flex items-center justify-center" style={{ flex: `${frontMm} 0 0px` }}>
                      {bookCoverPreview?.dataUrl ? (
                        <img src={bookCoverPreview.dataUrl} alt="Front cover" className="w-full h-full object-fill" />
                      ) : (
                        <Layout className="w-8 h-8 text-slate-300 opacity-40" />
                      )}
                    </div>
                  </div>
                  <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide">
                    Cover wrap — back · spine
                    {bookSpineWidthMm != null ? ` (~${bookSpineWidthMm.toFixed(1)}mm)` : ''} · front
                  </p>
                </div>
              );
            })()}

            {bookSpreads.map((spread, i) => (
              <div key={i} className="flex flex-col items-center gap-2">
                <div className="flex items-stretch shadow-xl rounded-lg overflow-hidden bg-white">
                  {spread.map((page, pi) => (
                    <div
                      key={page.key}
                      className={clsx(
                        'relative bg-slate-100 flex items-center justify-center',
                        spread.length === 2 && pi === 0 && 'border-r-2 border-slate-300',
                      )}
                      style={{ aspectRatio: `${page.canvasWidth} / ${page.canvasHeight}`, height: '38vh' }}
                    >
                      {page.dataUrl ? (
                        <img src={page.dataUrl} alt={page.label} className="w-full h-full object-fill" />
                      ) : (
                        <Layout className="w-8 h-8 text-slate-300 opacity-40" />
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide">
                  {spread.map(p => p.label).join(' · ')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="fixed top-4 right-4 z-[200000] max-w-sm bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl shadow-lg flex items-center gap-3">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}
      {submitted && submittedJobId && (
        <EmbedSubmittedOverlay
          jobId={submittedJobId}
          apiBase={apiBase}
          getAuthHeaders={getAuthHeaders}
          onBackToEditor={() => { setSubmitted(false); setSubmittedJobId(null); }}
        />
      )}
      {submitted && !submittedJobId && (
        <div className="fixed inset-0 z-[300000] flex items-center justify-center bg-white/80 backdrop-blur-sm">
          <div className="text-center p-10">
            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900">Design Submitted</h2>
          </div>
        </div>
      )}

      {/* overflow-x-clip, not overflow-x-hidden: setting only one axis to
          'hidden' makes the browser force the other axis to 'auto' (the
          CSS overflow spec's visible/auto pairing rule), silently turning
          `main` into a scroll container. Since `main` itself never actually
          scrolls (the window does), that container became the sticky
          toolbar's positioning reference instead of the viewport, so the
          toolbar below never pinned below the fixed dashboard header once
          scrolled — it just slid underneath it. `clip` clips the same
          horizontal bleed (the toolbar's own -mx-4/-mx-8) without pairing
          the Y axis into 'auto'. */}
      <main className="w-full px-4 md:px-8 pt-0 pb-6 md:pb-8 flex-1 overflow-x-clip">
        <div className="max-w-[1440px] mx-auto space-y-6 md:space-y-8">
          {/* Wrapper keeps the sentinel from becoming a real space-y sibling of the
              toolbar below (which would add an unwanted margin-top to it and throw
              off its natural resting position). The sentinel marks that resting
              spot; see the isToolbarStuck comment above for why the toolbar goes
              `fixed` instead of `sticky` once scrolled past it, and the spacer
              directly below for how the vacated flow space is replaced. */}
          <div className="relative">
            <div ref={setToolbarSentinel} className="absolute top-0 inset-x-0 h-px" aria-hidden />
            {isToolbarStuck && <div style={{ height: toolbarHeight }} aria-hidden />}
            <div
              ref={setToolbarEl}
              style={isToolbarStuck ? {
                position: 'fixed', top: headerHeight, left: 0, right: 0,
                maxWidth: 1440, marginLeft: 'auto', marginRight: 'auto',
              } : undefined}
              className={clsx(
                'z-40 px-4 md:px-8 py-3 bg-white/60 backdrop-blur-3xl border-b border-slate-200/50 flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4 shadow-sm',
                !isToolbarStuck && '-mx-4 md:-mx-8',
              )}
            >
            {/* Heading + Add Files share one row on mobile so the upload box doesn't
                push the toolbar down a whole extra row; `md:contents` removes this
                wrapper from the desktop layout so heading/box/toolbar go back to
                being three independent flex-row siblings, unchanged from before. */}
            <div className="flex items-center justify-between gap-3 md:contents">
            <div className="flex items-center gap-3 min-w-0 md:flex-none">
              {/* Embed only — the iframe has no "Back to Templates" destination to
                  push to (that's dashboard-only, see the HeaderContext effect
                  above). Deliberately NOT router.back()/history.back(): a nested
                  iframe shares its ONE browser-tab history with the parent page
                  (there is no separate per-iframe back stack), so calling it here
                  could navigate the PARENT printo.in page backward — or, if the
                  tab's history has nothing printo.in-related immediately prior,
                  take the customer off printo.in's site entirely mid-checkout.
                  Instead this mirrors the existing pe:render_job pattern: tell the
                  parent the customer wants to go back and let THEIR app decide
                  what that means. No-op until printo.in adds a listener — see
                  docs/INTEGRATION.md. */}
              {embedToken && (
                <button
                  onClick={() => window.parent.postMessage({ type: 'pe:back', orderID: orderId }, parentOrigin)}
                  aria-label="Back"
                  title="Back"
                  className="p-2 md:p-2.5 rounded-full hover:bg-slate-100 transition-all text-slate-600 hover:text-slate-900 shrink-0"
                >
                  <ArrowLeft className="w-4 h-4 md:w-5 md:h-5" />
                </button>
              )}
              <img src="/printo-logo.webp" alt="Printo" className="h-10 md:h-12 w-auto shrink-0" />
              <div className="w-px h-8 md:h-10 bg-slate-200 shrink-0" />
              {/* Layout name display — hidden per CEO request (2026-09-09), restored per
                  management feedback (2026-09-15): the original ask was to drop the raw
                  technical identifier (e.g. "retro_polaroid_-_4.2x3.5_in"), not the name
                  entirely. Prefer the ops-curated displayName (2026-09-16) — a real field
                  ops can write a clean product name into — over formatLayoutDisplayName(),
                  which is only a mechanical fallback for a layout that predates the field. */}
              <h1 className="text-xl md:text-2xl font-black text-slate-900 tracking-tighter truncate">
                {layout?.displayName || formatLayoutDisplayName(layout?.name || layoutName)}
              </h1>
            </div>
            {/* Top upload section — hidden when empty (empty state shows primary upload
                area only); revealed once user uploads at least one photo (secondary "Add more" action).
                Also hidden while the qty-shortfall banner is up (below) — its own "Upload More"
                button already does the exact same thing, so showing both at once read as two
                competing ways to add photos rather than one clear one. */}
            {(files.length > 0 || surfaceStates.some(s => s.files.length > 0)) && !qtyUnder && (
              <div className="shrink-0 max-w-[55%] md:w-full md:max-w-md md:flex-1 md:shrink relative group">
                {qtyNeeded > 0 && totalUploadedCount >= qtyNeeded ? (
                  // Order quantity fully met — show plain info, not a clickable
                  // "add more" pill: clicking it would immediately hit the
                  // over-qty hard-cap modal (there's nowhere left to add to),
                  // so an actionable-looking control here is a dead end.
                  <div className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 rounded-2xl border border-emerald-200/60 bg-emerald-50/30">
                    <div className="w-7 h-7 md:w-8 md:h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500 text-white">
                      <Check className="w-3.5 h-3.5 md:w-4 md:h-4" />
                    </div>
                    <p className="flex-1 min-w-0 truncate text-[10px] md:text-[11px] font-black text-emerald-700/80 uppercase tracking-tight">
                      {`${totalUploadedCount} of ${qtyNeeded} images uploaded`}
                    </p>
                  </div>
                ) : (
                  <div
                    className={clsx("relative flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 rounded-2xl border-2 border-dashed transition-all cursor-pointer", 'border-emerald-200 bg-emerald-50/30')}
                    role="button"
                    tabIndex={0}
                    onClick={() => uploadInputRef.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                        e.preventDefault();
                        uploadInputRef.current?.click();
                      }
                    }}
                  >
                    <div className="w-7 h-7 md:w-8 md:h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm bg-emerald-500 text-white">
                      <Plus className="w-3.5 h-3.5 md:w-4 md:h-4" />
                    </div>
                    <p className="flex-1 min-w-0 truncate text-[10px] md:text-[11px] font-black text-slate-800/70 uppercase tracking-tight">
                      <span className="md:hidden">
                        {`Add Files (${totalUploadedCount}${qtyNeeded ? `/${qtyNeeded}` : ''})`}
                      </span>
                      <span className="hidden md:inline">
                        {`Add Photos | Currently uploaded (${totalUploadedCount}${qtyNeeded ? ` of ${qtyNeeded}` : ''})`}
                      </span>
                    </p>
                  </div>
                )}
              </div>
            )}
            </div>
            <div className="flex items-center justify-center flex-nowrap gap-1 md:gap-3 w-full md:w-auto">
              <div className="flex items-center bg-slate-100/80 p-1 rounded-xl border border-slate-200/50 shrink-0">
                {(['contain', 'cover'] as FitMode[]).map(mode => (
                  <button key={mode} onClick={() => { if (mode !== globalFitMode) { fitModeUserToggledRef.current = true; setGlobalFitMode(mode); } }} className={clsx('px-2 md:px-3 py-1.5 text-[9px] md:text-[10px] font-black rounded-lg transition-all uppercase', globalFitMode === mode ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500')}>{mode === 'contain' ? 'Fit' : 'Cover'}</button>
                ))}
              </div>
              <button
                onClick={() => { blurFillUserToggledRef.current = true; setGlobalBlurFill(v => !v); }}
                title={globalBlurFill
                  ? 'Blur Effect is ON — empty space is filled with a blurred copy of the photo. Click to turn off.'
                  : 'Blur Effect — fill the empty space around a photo with a blurred copy of it.'}
                aria-label="Toggle blur effect"
                className={clsx(
                  'flex items-center justify-center gap-1 md:gap-1.5 px-2 md:px-3 py-2.5 md:py-2 text-[9px] md:text-[10px] font-black rounded-xl border transition-all uppercase tracking-tight md:tracking-wide shrink-0',
                  globalBlurFill
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                    : 'bg-slate-100/80 text-slate-500 border-slate-200/50 hover:text-slate-700',
                )}>
                <Droplets className="w-3.5 h-3.5 md:w-3.5 md:h-3.5 shrink-0" />
                <span className="whitespace-nowrap">Blur Effect</span>
              </button>
              {/* Reposition-lock toggle — hidden from the UI on request, kept
                  in source in case it needs to come back. repositionMode
                  itself is untouched (still gates drag-to-pan below) and
                  stays at its default (locked) with no way to flip it now.
              <button
                onClick={() => setRepositionMode(v => !v)}
                title={repositionMode
                  ? 'Reposition on — drag a photo inside its card. Click to lock.'
                  : 'Photos are locked. Click to drag-reposition them.'}
                aria-label={repositionMode ? 'Lock photos' : 'Unlock photos to reposition'}
                className={clsx(
                  'hidden md:flex items-center justify-center gap-1.5 p-2.5 md:px-3 md:py-2 text-[10px] font-black rounded-xl border transition-all uppercase tracking-wide',
                  repositionMode
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                    : 'bg-slate-100/80 text-slate-500 border-slate-200/50 hover:text-slate-700',
                )}>
                {repositionMode ? <Move className="w-4 h-4 md:w-3.5 md:h-3.5" /> : <Lock className="w-4 h-4 md:w-3.5 md:h-3.5" />}
                <span className="hidden md:inline">{repositionMode ? 'Reposition' : 'Locked'}</span>
              </button>
              */}
              {embedToken ? (
                <button onClick={() => { setDisclaimerChecked(false); setShowEmbedDisclaimer(true); }} disabled={isDownloading || (files.length === 0 && !surfaceStates.some(s => s.files.length > 0))} aria-label="Save and continue" className="flex items-center justify-center gap-2 text-[11px] font-black text-white bg-indigo-600 p-2.5 md:px-5 md:py-2.5 rounded-xl hover:bg-indigo-700 transition-all uppercase tracking-widest">
                  {isDownloading ? <Loader2 className="w-4 h-4 md:w-3.5 md:h-3.5 animate-spin" /> : <SendHorizonal className="w-4 h-4 md:w-3.5 md:h-3.5" />} <span className="hidden md:inline">Save &amp; Continue</span>
                </button>
              ) : (
                <button onClick={() => { setDisclaimerChecked(false); setShowDownloadModal(true); }} disabled={files.length === 0 && !surfaceStates.some(s => s.files.length > 0)} aria-label="Download" className="flex items-center justify-center gap-1 md:gap-2 text-[9px] md:text-[11px] font-black text-white bg-slate-900 px-2.5 md:px-5 py-2.5 rounded-xl hover:bg-slate-800 transition-all uppercase tracking-tight md:tracking-widest shrink-0">
                  <Download className="w-3.5 h-3.5 md:w-3.5 md:h-3.5 shrink-0" /> <span className="whitespace-nowrap">Download</span>
                </button>
              )}
            </div>
          </div>
          </div>

          {/* ── Fixed Processing Overlay ────────────────────────────────────── */}
          {/* isImposing included: executeImposition sets renderProgress on every
              placed item, but this overlay never rendered during an imposition,
              so the download showed a bare spinner. With no feedback, a slow
              render and a hung one look identical — which is exactly how a
              never-settling pica resize went unnoticed. */}
          {(isProcessing || isDownloading || isImposing) && renderProgress && (
            <div className="fixed inset-0 z-[300001] flex items-center justify-center bg-white/60 backdrop-blur-md animate-in fade-in duration-300">
              <div className="w-full max-w-sm bg-white p-8 rounded-3xl shadow-2xl border border-slate-100 space-y-5 animate-in zoom-in-95 duration-300">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px] font-black text-slate-900 uppercase tracking-tight">
                      {/* Only the SUBMIT pass (isDownloading) is reworded for
                          embed — this same overlay also covers canvas preview
                          generation after a photo pick, which is not a save. */}
                      {isDownloading
                        ? (embedToken ? 'Saving Your Design' : 'Preparing Download')
                        : 'Processing Your Design'}
                    </span>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      {isDownloading
                        ? (embedToken ? 'This may take a moment' : 'Bundling high-res print files')
                        : 'Optimizing images for print'}
                    </span>
                  </div>
                  <span className="text-[14px] font-black text-indigo-600 tabular-nums bg-indigo-50 px-3 py-1 rounded-xl">
                    {Math.round((renderProgress.current / renderProgress.total) * 100)}%
                  </span>
                </div>
                
                <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden p-0.5">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-300 ease-out shadow-[0_0_12px_rgba(99,102,241,0.4)]"
                    style={{ width: `${Math.round((renderProgress.current / renderProgress.total) * 100)}%` }}
                  />
                </div>
                
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin" />
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">
                    {serverRenderLabel
                      ? serverRenderLabel
                      : isDownloading
                        ? (renderProgress.total === 100 ? `Zipping... ${renderProgress.current}%` : `Rendering File ${renderProgress.current} of ${renderProgress.total}`)
                        : `Rendering File ${renderProgress.current} of ${renderProgress.total}`
                    }
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── HEIC → JPEG conversion (iPhone photos) ──────────────────────── */}
          {/* No percentage: heic2any's WASM decoder doesn't report progress,
              and this step is usually well under a couple of seconds. */}
          {heicConverting && (
            <div className="fixed inset-0 z-[300001] flex items-center justify-center bg-white/60 backdrop-blur-md animate-in fade-in duration-300">
              <div className="w-full max-w-sm bg-white p-8 rounded-3xl shadow-2xl border border-slate-100 space-y-3 animate-in zoom-in-95 duration-300 flex flex-col items-center">
                <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
                <span className="text-[12px] font-black text-slate-900 uppercase tracking-tight">
                  Converting iPhone Photo
                </span>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  Preparing HEIC image for editing
                </span>
              </div>
            </div>
          )}

          {/* ── Book: page-count control (BOOK_LAYOUT_PRD.md D2/R1) ─────────── */}
          {/* Visible regardless of upload state — pages exist as blank cards
              via the generic multi-surface grid below the moment the count
              is set, same as any other multi-surface product. */}
          {isBookProduct && bookPageBounds && (
            <div className="flex items-center justify-between gap-4 bg-white rounded-2xl border-2 border-slate-100 px-4 py-3 mx-4">
              <div>
                <p className="text-[11px] font-black text-slate-900 uppercase tracking-tight">Pages</p>
                <p className="text-[10px] text-slate-400 font-medium">
                  {bookPageBounds[0]}–{bookPageBounds[1]} pages, in steps of {bookPageBounds[2]}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleBookPageCountChange(bookPageCount - bookPageBounds[2])}
                  disabled={bookPageCount <= bookPageBounds[0]}
                  aria-label="Fewer pages"
                  className="w-8 h-8 rounded-full border-2 border-slate-200 text-slate-500 font-black text-lg flex items-center justify-center disabled:opacity-30 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
                >
                  −
                </button>
                <span className="text-sm font-black text-slate-900 tabular-nums min-w-[6rem] text-center">
                  {bookPageCount} pages
                </span>
                <button
                  type="button"
                  onClick={() => handleBookPageCountChange(bookPageCount + bookPageBounds[2])}
                  disabled={bookPageCount >= bookPageBounds[1]}
                  aria-label="More pages"
                  className="w-8 h-8 rounded-full border-2 border-slate-200 text-slate-500 font-black text-lg flex items-center justify-center disabled:opacity-30 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setShowSpreadPreview(true)}
                  className="ml-2 text-[10px] font-black uppercase tracking-widest text-indigo-600 bg-indigo-50 px-3 py-2 rounded-full border-2 border-indigo-100/50 hover:bg-indigo-100 transition-colors"
                >
                  Preview spreads
                </button>
              </div>
            </div>
          )}

          {/* ── Restoring a saved design ──────────────────────────────────── */}
          {!isProcessing && canvases.length === 0 && restorePending && (
            <CanvasCardSkeleton
              count={restoreCount || 3}
              aspectRatio={`${layout.canvas?.width || 1200} / ${layout.canvas?.height || 1800}`}
            />
          )}

          {/* ── Empty state (no canvases, not processing, nothing to restore) ─ */}
          {!isProcessing && canvases.length === 0 && !restorePending && (
            <div 
              className={clsx(
                "flex flex-col items-center justify-center py-24 gap-5 select-none border-2 border-dashed rounded-3xl transition-all cursor-pointer",
                dragOverIdx?.idx === -1 
                  ? "border-indigo-500 bg-indigo-50/50 scale-[1.01]" 
                  : "border-slate-200 bg-slate-50/50"
              )}
              role="button"
              tabIndex={0}
              onClick={() => uploadInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                  e.preventDefault();
                  uploadInputRef.current?.click();
                }
              }}
              onDragOver={(e) => { e.preventDefault(); setDragOverIdx({ idx: -1, surfaceKey: null }); }}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOverIdx(null);
                const droppedFiles = Array.from(e.dataTransfer.files);
                if (droppedFiles.length > 0) {
                  const event = { target: { files: e.dataTransfer.files } } as unknown as React.ChangeEvent<HTMLInputElement>;
                  handleFileChange(event);
                }
              }}
            >
              <div className="w-16 h-16 rounded-3xl bg-indigo-50 flex items-center justify-center">
                <Upload className="w-7 h-7 text-indigo-400" />
              </div>
              <div className="text-center space-y-1.5">
                <p className="text-[13px] font-black text-slate-800 uppercase tracking-tight">
                  No images selected
                </p>
                <p className="text-[11px] text-slate-400 font-medium max-w-[220px]">
                  Drag and drop your photos here to get started
                </p>
              </div>
            </div>
          )}

          {canvases.length > 0 && (
            <section className="space-y-6 pt-0">
              {surfaceStates.length > 1 ? (
                <div className="flex gap-6 items-start justify-center overflow-x-auto pb-4 px-4 w-full custom-scrollbar">
                  {surfaceStates.map((surface) => {
                    const cw = surface.def.canvas?.width || 1200;
                    const ch = surface.def.canvas?.height || 1800;
                    const surfaceCanvas = surface.canvases[0] || null;
                    return (
                      <div 
                        key={surface.key} 
                        className="shrink-0 flex flex-col gap-3"
                        style={{ width: cw > ch ? '400px' : '280px' }}
                        draggable={!repositionMode}
                        onDragStart={(e) => handleDragStart(e, 0, surface.key)}
                        onDragOver={(e) => handleDragOver(e, 0, surface.key)}
                        onDragLeave={() => setDragOverIdx(null)}
                        onDrop={(e) => handleDrop(e, 0, surface.key)}
                      >
                        <div className="flex items-center justify-between px-1">
                          <h3 className="text-xs font-black text-slate-900 uppercase tracking-tight truncate">{surface.label}</h3>
                          <button onClick={() => openEditor(0, surface.key)} className="text-[9px] font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100 uppercase tracking-wide">Edit</button>
                        </div>
                        <div className={clsx(
                          "bg-white rounded-2xl border-2 transition-all overflow-hidden cursor-pointer group/card relative",
                          dragOverIdx?.idx === 0 && dragOverIdx?.surfaceKey === surface.key 
                            ? "border-indigo-500 bg-indigo-50/50 scale-[1.02] shadow-xl shadow-indigo-100" 
                            : "border-slate-100 hover:border-indigo-400"
                        )} onClick={() => handleCardClick(0, surface.key)}
                          role="button"
                          tabIndex={0}
                          aria-label={`Edit ${surface.label || surface.key}`}
                          onKeyDown={(e) => { if (activatesCard(e)) { e.preventDefault(); handleCardClick(0, surface.key); } }}
                        >
                          <div
                            className={clsx(
                              'relative overflow-hidden bg-slate-100',
                              repositionMode && 'cursor-grab active:cursor-grabbing touch-none',
                            )}
                            style={{ aspectRatio: `${cw} / ${ch}` }}
                            onPointerDown={(e) => handlePanStart(e, 0, surface.key)}
                            onPointerMove={handlePanMove}
                            onPointerUp={handlePanEnd}
                            onPointerCancel={handlePanEnd}
                          >
                            {surfaceCanvas?.dataUrl ? <img src={surfaceCanvas.dataUrl} className="absolute inset-0 w-full h-full object-fill" alt={surface.label} /> : <div className="absolute inset-0 flex items-center justify-center text-slate-300"><Layout className="w-10 h-10 opacity-20" /></div>}

                            {surfaceCanvas?.frames.some(f => (f.fileId || f.fileName) && !f.originalFile) ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const missingIdx = surfaceCanvas.frames.findIndex(f => (f.fileId || f.fileName) && !f.originalFile);
                                  requestReplacePhoto(0, Math.max(0, missingIdx), surface.key);
                                }}
                                className="absolute bottom-2 left-2 z-20 flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold shadow-sm bg-amber-50/90 border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors"
                                title="This photo couldn't be recovered on this device — tap to re-upload it."
                              >
                                <AlertTriangle className="w-3 h-3" />
                                Photo missing — tap to re-upload
                              </button>
                            ) : lowDpiByCard.has(`${surface.key}:0`) && (
                              <div
                                className={clsx(
                                  'absolute bottom-2 left-2 z-20 flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold shadow-sm',
                                  lowDpiByCard.get(`${surface.key}:0`)!.severity === 'critical'
                                    ? 'bg-rose-50/90 border-rose-200 text-rose-700'
                                    : 'bg-amber-50/90 border-amber-200 text-amber-700'
                                )}
                                title="This photo is below print resolution — it may look soft or pixelated when printed. Use a larger photo or zoom out."
                              >
                                <AlertTriangle className="w-3 h-3" />
                                Low res ~{Math.round(lowDpiByCard.get(`${surface.key}:0`)!.dpi)} DPI
                              </div>
                            )}

                            <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-20 p-1.5 bg-white/40 backdrop-blur-md rounded-2xl border border-white/40 shadow-sm">
                              <button onClick={(e) => { e.stopPropagation(); handleQuickRotate(0, surface.key); }} className="p-2 bg-indigo-50/80 text-indigo-600 rounded-xl hover:bg-indigo-100 hover:scale-105 transition-all" title="Rotate 90°">
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleQuickToggleFit(0, surface.key); }}
                                className="p-2 bg-emerald-50/80 text-emerald-600 rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all"
                                title={surfaceCanvas?.frames.some(f => f.fitMode === 'contain')
                                  ? 'Switch to Cover'
                                  : 'Switch to Fit'}
                              >
                                <Maximize className="w-3.5 h-3.5" />
                              </button>
                              {/* Set Background Color — hidden from the UI on request, kept in
                                  source in case it needs to come back. handleQuickSetBg itself
                                  is untouched.
                              <div className="relative">
                                <button onClick={(e) => { e.stopPropagation(); const el = e.currentTarget.nextElementSibling as HTMLInputElement; if (el) el.click(); }} className="p-2 bg-amber-50/80 text-amber-600 rounded-xl hover:bg-amber-100 hover:scale-105 transition-all" title="Set Background Color">
                                  <Palette className="w-3.5 h-3.5" />
                                </button>
                                <input
                                  type="color"
                                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer pointer-events-none"
                                  value={surfaceCanvas?.bgColor || '#ffffff'}
                                  onChange={(e) => handleQuickSetBg(0, e.target.value, surface.key)}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                              */}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleQuickToggleBlur(0, surface.key); }}
                                className={clsx('p-2 rounded-xl hover:scale-105 transition-all',
                                  surfaceCanvas?.frames.some(f => f.fillStyle === 'blur')
                                    ? 'bg-indigo-600 text-white'
                                    : 'bg-cyan-50/80 text-cyan-600 hover:bg-cyan-100')}
                                title={surfaceCanvas?.frames.some(f => f.fillStyle === 'blur')
                                  ? 'Remove Blur'
                                  : 'Add Blur'}
                              >
                                <Droplets className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSwapSource(prev =>
                                    prev && prev.idx === 0 && prev.surfaceKey === surface.key ? null : { idx: 0, surfaceKey: surface.key }
                                  );
                                }}
                                className={clsx('p-2 rounded-xl hover:scale-105 transition-all block md:hidden',
                                  swapSource?.idx === 0 && swapSource?.surfaceKey === surface.key
                                    ? 'bg-indigo-600 text-white'
                                    : 'bg-violet-50/80 text-violet-600 hover:bg-violet-100')}
                                title="Swap Photo"
                              >
                                <ArrowLeftRight className="w-3.5 h-3.5" />
                              </button>
                              {/* Quick-download — hidden from the UI on request, kept in
                                  source in case it needs to come back. handleQuickDownload
                                  itself is untouched.
                              <button onClick={(e) => { e.stopPropagation(); handleQuickDownload(0, surface.key); }} className="p-2 bg-slate-100/80 text-slate-700 rounded-xl hover:bg-slate-200 hover:scale-105 transition-all" title="Download">
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              */}
                              <button onClick={(e) => { e.stopPropagation(); handleQuickDelete(0, surface.key); }} className="p-2 bg-rose-50/80 text-rose-600 rounded-xl hover:bg-rose-100 hover:scale-105 transition-all" title="Remove Photo">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          <div className="px-3 py-2 flex items-center justify-between bg-white border-t border-slate-50">
                            <span className="text-[10px] font-bold text-slate-400">{surface.def.canvas?.widthMm}×{surface.def.canvas?.heightMm}mm</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                // `justify-items-center` + the card's `sm:w-auto` made each card
                // shrink to its CONTENT width (~187px, set by the meta label and
                // action rail) and centre inside a much wider grid column. The
                // surplus showed up as dead space between cards — 63px of visible
                // gap at 5 columns despite gap-3.5, and worse as columns widen.
                // Shrinking `gap` never touched it.
                //
                // Stretch from sm up so a card fills its column: the gutter is
                // then exactly the gap, and the thumbnail gets the reclaimed
                // width instead. Mobile keeps centring, where the card is a fixed
                // 86vw and is meant to sit centred.
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7 gap-3 sm:gap-3.5 justify-items-center sm:justify-items-stretch">
                  {canvases.map((canvas, idx) => (
                    <div key={idx} className="w-[86vw] max-w-sm sm:w-auto sm:max-w-none">
                      {/* Deliberately outside the bordered card below — this is a UI
                          label, not part of the printed design, and boxing it together
                          with the photo made it read as if it were. Dimensions/frame
                          count are shown once already, in the page header above — not
                          repeated per card. */}
                      <div className="px-1 py-1.5">
                        <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight truncate">
                          Image {idx + 1}
                        </h3>
                      </div>
                      <div
                        className={clsx(
                          // Mobile: one card per row, capped so ~1.5 cards show per
                          // viewport (portrait prints) — a full-width 2-col card was
                          // too short and clipped the quick-action rail.
                          // Square corners throughout, no exceptions — this card is a
                          // preview of the actual print shape (e.g. retro polaroid
                          // layouts are square-cornered), and rounding any part of it,
                          // even just the frame around the photo, reads as if the
                          // print itself had rounded corners.
                          "bg-white border-2 transition-all cursor-pointer group/card relative",
                          dragOverIdx?.idx === idx && dragOverIdx?.surfaceKey === null
                            ? "border-indigo-500 bg-indigo-50/50 scale-[1.02] shadow-xl shadow-indigo-100"
                            : "border-slate-200 hover:border-indigo-400"
                        )}
                        onClick={() => handleCardClick(idx)}
                        role="button"
                        tabIndex={0}
                        aria-label={`Edit canvas ${idx + 1}`}
                        onKeyDown={(e) => { if (activatesCard(e)) { e.preventDefault(); handleCardClick(idx); } }}
                        draggable={!repositionMode}
                        onDragStart={(e) => handleDragStart(e, idx)}
                        onDragOver={(e) => handleDragOver(e, idx)}
                        onDragLeave={() => setDragOverIdx(null)}
                        onDrop={(e) => handleDrop(e, idx)}
                      >
                        <div
                          className={clsx(
                            'relative overflow-hidden bg-slate-100',
                            repositionMode && 'cursor-grab active:cursor-grabbing touch-none',
                          )}
                          style={{ aspectRatio: `${layout.canvas?.width || 1200} / ${layout.canvas?.height || 1800}` }}
                          onPointerDown={(e) => handlePanStart(e, idx)}
                          onPointerMove={handlePanMove}
                          onPointerUp={handlePanEnd}
                          onPointerCancel={handlePanEnd}
                        >
                          {canvas.dataUrl && <LazyImg src={canvas.dataUrl} className="absolute inset-0 w-full h-full object-fill" alt={`Canvas ${idx + 1}`} />}

                        {canvas.frames.some(f => (f.fileId || f.fileName) && !f.originalFile) ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const missingIdx = canvas.frames.findIndex(f => (f.fileId || f.fileName) && !f.originalFile);
                              requestReplacePhoto(idx, Math.max(0, missingIdx));
                            }}
                            className="absolute bottom-2 left-2 z-20 flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold shadow-sm bg-amber-50/90 border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors"
                            title="This photo couldn't be recovered on this device — tap to re-upload it."
                          >
                            <AlertTriangle className="w-3 h-3" />
                            Photo missing — tap to re-upload
                          </button>
                        ) : lowDpiByCard.has(`:${idx}`) && (
                          <div
                            className={clsx(
                              'absolute bottom-2 left-2 z-20 flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold shadow-sm',
                              lowDpiByCard.get(`:${idx}`)!.severity === 'critical'
                                ? 'bg-rose-50/90 border-rose-200 text-rose-700'
                                : 'bg-amber-50/90 border-amber-200 text-amber-700'
                            )}
                            title="This photo is below print resolution — it may look soft or pixelated when printed. Use a larger photo or zoom out."
                          >
                            <AlertTriangle className="w-3 h-3" />
                            Low res ~{Math.round(lowDpiByCard.get(`:${idx}`)!.dpi)} DPI
                          </div>
                        )}

                        <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-20 p-1.5 bg-white/40 backdrop-blur-md rounded-2xl border border-white/40 shadow-sm">
                          <button onClick={(e) => { e.stopPropagation(); handleQuickRotate(idx); }} className="p-2 bg-indigo-50/80 text-indigo-600 rounded-xl hover:bg-indigo-100 hover:scale-105 transition-all" title="Rotate 90°">
                            <RotateCw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleQuickToggleFit(idx); }}
                            className="p-2 bg-emerald-50/80 text-emerald-600 rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all"
                            title={canvas.frames.some(f => f.fitMode === 'contain')
                              ? 'Switch to Cover'
                              : 'Switch to Fit'}
                          >
                            <Maximize className="w-3.5 h-3.5" />
                          </button>
                          {/* Set Background Color — hidden from the UI on request, kept in
                              source in case it needs to come back. handleQuickSetBg itself
                              is untouched.
                          <div className="relative">
                            <button onClick={(e) => { e.stopPropagation(); const el = e.currentTarget.nextElementSibling as HTMLInputElement; if (el) el.click(); }} className="p-2 bg-amber-50/80 text-amber-600 rounded-xl hover:bg-amber-100 hover:scale-105 transition-all" title="Set Background Color">
                              <Palette className="w-3.5 h-3.5" />
                            </button>
                            <input
                              type="color"
                              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer pointer-events-none"
                              value={canvas.bgColor || '#ffffff'}
                              onChange={(e) => handleQuickSetBg(idx, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                          */}
                          {(layout.frames?.length || 1) === 1 && (
                            <button onClick={(e) => { e.stopPropagation(); requestReplacePhoto(idx, 0); }} className="p-2 bg-sky-50/80 text-sky-600 rounded-xl hover:bg-sky-100 hover:scale-105 transition-all" title="Replace Photo">
                              <ImagePlus className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); handleQuickToggleBlur(idx); }}
                            className={clsx('p-2 rounded-xl hover:scale-105 transition-all',
                              canvas.frames.some(f => f.fillStyle === 'blur')
                                ? 'bg-indigo-600 text-white'
                                : 'bg-cyan-50/80 text-cyan-600 hover:bg-cyan-100')}
                            title={canvas.frames.some(f => f.fillStyle === 'blur')
                              ? 'Remove Blur'
                              : 'Add Blur'}
                          >
                            <Droplets className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSwapSource(prev =>
                                prev && prev.idx === idx && prev.surfaceKey === null ? null : { idx, surfaceKey: null }
                              );
                            }}
                            className={clsx('p-2 rounded-xl hover:scale-105 transition-all block md:hidden',
                              swapSource?.idx === idx && swapSource?.surfaceKey === null
                                ? 'bg-indigo-600 text-white'
                                : 'bg-violet-50/80 text-violet-600 hover:bg-violet-100')}
                            title="Swap Photo"
                          >
                            <ArrowLeftRight className="w-3.5 h-3.5" />
                          </button>
                          {/* Quick-download — hidden from the UI on request, kept in
                              source in case it needs to come back. handleQuickDownload
                              itself is untouched.
                          <button onClick={(e) => { e.stopPropagation(); handleQuickDownload(idx); }} className="p-2 bg-slate-100/80 text-slate-700 rounded-xl hover:bg-slate-200 hover:scale-105 transition-all" title="Download">
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          */}
                          <button onClick={(e) => { e.stopPropagation(); handleQuickDelete(idx); }} className="p-2 bg-rose-50/80 text-rose-600 rounded-xl hover:bg-rose-100 hover:scale-105 transition-all" title="Remove Photo">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ── Calendar product: 12-month preview + cell editor ─────────── */}
          {isCalendarProduct && (
            <section className="space-y-4 pt-2">
              <CalendarProductPreview
                themePreset={calendarTheme}
                onThemePresetChange={setCalendarTheme}
                genzPalette={genzPalette}
                genzPalettes={genzPalettes}
                onGenzPaletteChange={setGenzPalette}
                calendarType={calendarType}
                onCalendarTypeChange={setCalendarType}
                onMonthTileClick={handleCalendarMonthTileClick}
                cells={calendarCells}
                holidays={printedHolidays}
                weekStart={layout?.weekStart as any || 'sunday'}
                defaultYear={layout?.calendarDefaultYear ?? 'current'}
              />
              {selectedCalendarCell && (
                <div className="fixed inset-y-0 right-0 z-[50000] flex">
                  <CalendarEditPanel
                    iso={selectedCalendarCell.iso}
                    cellEntries={calendarCellEntries(selectedCalendarCell.iso)}
                    holidaysForCell={printedHolidays.filter(h => h.date === selectedCalendarCell.iso)}
                    imagePreviewUrl={calendarCellImagePreviews[selectedCalendarCell.iso]}
                    imageExpired={
                      calendarCellEntries(selectedCalendarCell.iso).some(o => o.type === 'image') &&
                      !calendarCellImagePreviews[selectedCalendarCell.iso]
                    }
                    isImageUploading={calendarImageUploading}
                    onAddTextEntry={text =>
                      updateCellEntries(selectedCalendarCell.iso, prev => [
                        ...prev, { type: 'text', text },
                      ])
                    }
                    onRemoveTextEntryByIndex={idx =>
                      updateCellEntries(selectedCalendarCell.iso, prev =>
                        prev.filter((_, i) => i !== idx)
                      )
                    }
                    onRequestImageOverride={() => calendarCellFileInputRef.current?.click()}
                    onRemoveImageOverride={() => {
                      const key = selectedCalendarCell.iso;
                      setCalendarCellImagePreviews(prev => {
                        if (prev[key]) URL.revokeObjectURL(prev[key]);
                        const next = { ...prev };
                        delete next[key];
                        return next;
                      });
                      updateCellEntries(selectedCalendarCell.iso, prev =>
                        prev.filter(o => o.type !== 'image')
                      );
                    }}
                    onToggleHide={() =>
                      updateCellEntries(selectedCalendarCell.iso, prev => {
                        const hasHide = prev.some(o => o.type === 'hide');
                        return hasHide ? prev.filter(o => o.type !== 'hide') : [{ type: 'hide' }];
                      })
                    }
                    onReset={() => {
                      const key = selectedCalendarCell.iso;
                      setCalendarCellImagePreviews(prev => {
                        if (prev[key]) URL.revokeObjectURL(prev[key]);
                        const next = { ...prev };
                        delete next[key];
                        return next;
                      });
                      updateCellEntries(selectedCalendarCell.iso, () => []);
                    }}
                    onClose={() => setSelectedCalendarCell(null)}
                  />
                </div>
              )}
              {/* Hidden file input for cell image override (Phase 8) */}
              <input
                ref={calendarCellFileInputRef}
                type="file"
                accept={IMAGE_AND_PDF_ACCEPT_ATTR}
                className="hidden"
                aria-hidden
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleCellImageFileSelected(file);
                  e.target.value = '';  // reset so same file can be re-picked
                }}
              />
            </section>
          )}

          {/* Dashboard: combined disclaimer + download options modal */}
          {showDownloadModal && (
            <DownloadOptionsDialog
              disclaimerChecked={disclaimerChecked}
              onDisclaimerChange={setDisclaimerChecked}
              includeUploads={includeUploads}
              onIncludeUploadsChange={(checked) => { setIncludeUploads(checked); includeUploadsRef.current = checked; }}
              lowDpiFrames={lowDpiFrames}
              emptySurfaces={emptySurfaces}
              duplicateFills={duplicateFills}
              totalUploadedCount={totalUploadedCount}
              qtyNeeded={qtyNeeded}
              onClose={() => setShowDownloadModal(false)}
              onDownloadZip={executeBatchDownload}
              onImposition={() => { setShowDownloadModal(false); setShowImpositionModal(true); }}
            />
          )}

          {/* Embed: disclaimer-only modal before Save & Continue */}
          {showEmbedDisclaimer && (
            <EmbedDisclaimerDialog
              disclaimerChecked={disclaimerChecked}
              onDisclaimerChange={setDisclaimerChecked}
              lowDpiFrames={lowDpiFrames}
              emptySurfaces={emptySurfaces}
              duplicateFills={duplicateFills}
              totalUploadedCount={totalUploadedCount}
              qtyNeeded={qtyNeeded}
              onClose={() => setShowEmbedDisclaimer(false)}
              onProceed={() => { setShowEmbedDisclaimer(false); handleSubmitDesign(); }}
            />
          )}

          {showImpositionModal && (
            <ImpositionModal imposition={imposition} />
          )}
        </div>
      </main>

      {activeCanvasIdx !== null && editingCanvas && (
        <CanvasEditorModal
          key={`modal-${activeSurfaceKey}-${activeCanvasIdx}`}
          activeCanvasIdx={activeCanvasIdx}
          editingCanvas={editingCanvas}
          canvases={canvases}
          surfaceStates={surfaceStates}
          activeSurfaceKey={activeSurfaceKey}
          layout={layout}
          globalFitMode={globalFitMode}
          selectedFonts={selectedFonts}
          apiBase={apiBase}
          getAuthHeaders={getAuthHeaders}
          setEditingCanvas={setEditingCanvas}
          setCanvases={setCanvases}
          setFiles={setFiles}
          setError={setError}
          onClose={closeEditor}
          onOpenCanvas={openEditor}
          getFileUrl={getFileUrl}
          loadGoogleFont={loadGoogleFont}
          skipNextGenerateRef={skipNextGenerateRef}
          expandPdfPages={expandPdfPages}
          serverHeicConvert={serverHeicConvert}
        />
      )}
      {pdfPickerElement}
    </div>
  );
}
