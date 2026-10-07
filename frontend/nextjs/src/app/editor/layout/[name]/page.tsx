'use client';

/**
 * /layout/[name]  —  Canvas editor page
 */

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import { useHeader } from '@/context/HeaderContext';
import { Loader2, CheckCircle2 } from 'lucide-react';
import {
  uploadFiles,
  unsupportedFilesMessage,
  isAllowedImageFile,
  IMAGE_AND_PDF_ACCEPT_ATTR,
} from '@/lib/upload-utils';
import { convertHeicFileIfNeeded, convertAndPartitionFiles, isHeicFile } from '@/lib/heic-convert';
import { usePdfPageImport } from '@/components/use-pdf-page-import';
import {
  saveFile, deleteFile, getFilesForOrder, pruneStaleOrders, pruneUnreferencedFiles,
  FileStoreQuotaError, getPersistenceMode,
} from '@/lib/file-store';
import { collectFileIds, unreferencedFileIds } from './file-refs';
import type { NormalizedLayout } from '@/lib/layout-utils';
import { detectJpegColorSpace, isImageComplete } from '@/lib/image-utils';
import { countCanvasesLosingEdits } from './canvas-merge';
import {
  allocateFilesToSurfaces, surfaceFrameCount, totalSurfaceCapacity,
} from './surface-allocation';
import {
  collectDuplicateFills, duplicateFingerprint, checkOrderQty,
} from '@/lib/submit-guards';
import type { FitMode, FrameState, CanvasItem, SurfaceState, Overlay } from './types';
import { renderCanvas as renderCanvasCore } from './fabric-renderer';
import { CanvasEditorModal } from './CanvasEditorModal';
import { GoogleFontLinks, useGoogleFonts } from '@/components/GoogleFontLinks';
import type { CalendarTheme, CalendarType } from '@/types/calendar';
import { reconcilePageCount } from './book-pages';
import { resolvePageCount, type BookLayoutLike } from '@/lib/book-layout';
import {
  formatWait,
  MAX_SKELETON_CARDS, ORPHAN_FILE_MIN_AGE_MS, readCardCountHint, writeCardCountHint,
} from './editor-utils';
import { EmbedSubmittedOverlay } from './EmbedSubmittedOverlay';
import { ImpositionModal } from './ImpositionModal';
import { useImposition } from './useImposition';
import { useStickyToolbar } from './useStickyToolbar';
import { EditorToolbar, useDashboardHeader } from './EditorToolbar';
import { EditorBanners, ErrorBanner } from './EditorBanners';
import { ProcessingOverlay } from './ProcessingOverlay';
import { BookPageCount, BookSpreadPreview } from './BookSpreadPreview';
import { EmptyState } from './EmptyState';
import { CanvasGrid } from './CanvasGrid';
import { CalendarSection } from './CalendarSection';
import { useEditorEnvironment, useLoginRedirect } from './useEditorEnvironment';
import { useActiveSurfaceLayout, useLayoutLoader } from './useLayoutLoader';
import { useSubmitGuards } from './useSubmitGuards';
import { useCalendarDefaults, useCalendarEditor } from './useCalendarEditor';
import { useBookPages } from './useBookPages';
import { useCardActions } from './useCardActions';
import { useCanvasGeneration, useObjectUrls, useRenderCanvas } from './useCanvasGeneration';
import { AutoFillPickerDialog } from './dialogs/AutoFillPickerDialog';
import { BookOverflowDialog } from './dialogs/BookOverflowDialog';
import { DeleteConfirmDialog } from './dialogs/DeleteConfirmDialog';
import { DownloadOptionsDialog } from './dialogs/DownloadOptionsDialog';
import { EmbedDisclaimerDialog } from './dialogs/EmbedDisclaimerDialog';
import { OverQuantityDialog } from './dialogs/OverQuantityDialog';
import { RepickConfirmDialog } from './dialogs/RepickConfirmDialog';
import { TruncatedImagesDialog } from './dialogs/TruncatedImagesDialog';

export default function LayoutEditorPage() {
  const {
    layoutName, router, session, status, embedToken, parentOrigin, setSessionQty, orderQty,
    orderId, setOrderId, getAuthHeaders, apiBase, serverHeicConvert,
  } = useEditorEnvironment();

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
  // Device storage full — photos can't be persisted for refresh recovery
  // (Phase 3 quota surfacing). Drives a persistent amber notice.
  const [persistDegraded, setPersistDegraded] = useState(false);
  // Browser blocked IndexedDB entirely (Safari ITP in a cross-site iframe /
  // private mode) — photos live in memory only for this tab (Phase 3).
  const [storageBlocked, setStorageBlocked] = useState(false);
  // Files flagged as truncated/incomplete by the client-side completeness check,
  // held pending the customer's Keep-anyway / Remove decision (see handleFileChange).
  const [pendingTruncated, setPendingTruncated] = useState<{ all: File[]; bad: File[] } | null>(null);
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

  const {
    isBookProduct, bookPageCount, setBookPageCount, bookHiddenPages, setBookHiddenPages, bookHiddenPagesRef,
    pendingBookOverflow, setPendingBookOverflow, bookOverflowDecidedRef,
    bookPageBounds, handleBookPageCountChange, showSpreadPreview, setShowSpreadPreview,
    bookSpreads, bookCoverPreview, bookBackCoverPreview, bookSpineWidthMm,
  } = useBookPages({ layout, normalizedLayoutState, surfaceStates, surfaceStatesRef, setSurfaceStates });

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
  }, [bookHiddenPagesRef]);

  const {
    isCalendarProduct, calendarTheme, setCalendarTheme, calendarType, setCalendarType, genzPalette, setGenzPalette,
    genzPalettes, setGenzPalettes, setCalendarHolidays, printedHolidays, calendarCells, setCalendarCells,
    selectedCalendarCell, setSelectedCalendarCell, calendarCellFileInputRef, calendarImageUploading,
    calendarCellImagePreviews, setCalendarCellImagePreviews,
    calendarCellEntries, updateCellEntries, handleCellImageFileSelected, handleCalendarMonthTileClick,
  } = useCalendarEditor({
    layout, orderId, apiBase, getAuthHeaders, expandPdfPages, setUnsupportedWarning, setPersistDegraded, setError,
  });

  const [selectedFonts, setSelectedFonts] = useState<string[]>(['sans-serif', 'serif', 'monospace']);
  const { fontsLoaded, loadGoogleFont } = useGoogleFonts();
  const [deleteConfirm, setDeleteConfirm] = useState<{ idx: number; surfaceKey: string | null } | null>(null);
  const { headerHeight } = useHeader();

  const { setToolbarSentinel, isToolbarStuck, setToolbarEl, toolbarHeight } = useStickyToolbar(headerHeight);

  useDashboardHeader(embedToken, router);

  useLoginRedirect({ status, session, embedToken, router });

  const { legacyOrderIdRef } = useLayoutLoader({
    layoutName, embedToken, status, apiBase, getAuthHeaders, orderId, setOrderId, setSessionQty,
    selectedFonts, setSelectedFonts, loadGoogleFont, setError, setLayout, setLayoutLoading,
    setNormalizedLayoutState, setSurfaceStates, setActiveSurfaceKey, setBookPageCount, setBookHiddenPages,
  });

  const { getFileUrl, fileUrlCache, createdObjectURLs } = useObjectUrls();

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
  }, [createdObjectURLs]);

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

  useActiveSurfaceLayout({ activeSurfaceKey, activeSurface, normalizedLayoutState, setLayout });

  const renderCanvas = useRenderCanvas(layout, getFileUrl);

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
  }, [apiBase, orderId, layoutName, getAuthHeaders, serializeCanvasState, reclaimUnusedFiles, bookHiddenPagesRef]);

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

  // Pre-submit guard (Phase 3): photos placed more than once (excluding
  // deliberate qty auto-fill duplicates). The rest of the guards are in
  // useSubmitGuards; this one stays beside the file intake that fills
  // intentionalDupesRef until both move (split plan C6). It reads that ref
  // during render, which React's compiler lint rejects wherever hook rules
  // aren't suppressed, and this component suppresses them.
  const intentionalDupesRef = useRef(new Set<string>());
  const duplicateFills = useMemo(() => {
    const groups = surfaceStates.length > 1
      ? surfaceStates.map(s => ({ label: s.label || s.key, canvases: s.canvases }))
      : [{ label: 'your design', canvases }];
    return collectDuplicateFills(groups, intentionalDupesRef.current);
  }, [surfaceStates, canvases]);

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

  const { lowDpiFrames, emptySurfaces, lowDpiByCard } = useSubmitGuards({ layout, surfaceStates, canvases, isBookProduct });

  useCalendarDefaults({
    isCalendarProduct, layout, normalizedLayoutState, apiBase, getAuthHeaders,
    setCalendarTheme, setCalendarType, setGenzPalettes, setCalendarHolidays,
  });

  const { generateCanvasesForLayout } = useCanvasGeneration({
    layout, files, isProcessing, setIsProcessing, setError, isCalendarProduct, setRenderProgress, canvasesRef, setCanvases,
    renderCanvas, apiBase, getAuthHeaders, globalFitModeRef, globalBlurFillRef, skipNextGenerateRef, surfaceStates,
    setSurfaceStates, fitModeUserToggledRef, globalFitMode, activeSurfaceKey, blurFillUserToggledRef, globalBlurFill,
  });

  const {
    openEditor, closeEditor, handleQuickRotate, handleQuickToggleFit, handleQuickToggleBlur,
    handlePanStart, handlePanMove, handlePanEnd, handleCardClick, handleQuickDelete, confirmDelete,
    handleDrop, handleDragOver, handleDragStart,
  } = useCardActions({
    layout, files, setFiles, canvases, setCanvases, surfaceStates, setSurfaceStates, activeSurfaceKey, setActiveSurfaceKey,
    normalizedLayoutState, activeCanvasIdx, setActiveCanvasIdx, setEditingCanvas, renderCanvas, generateCanvasesForLayout,
    repositionMode, swapSource, setSwapSource, deleteConfirm, setDeleteConfirm, orderQty, setQtyUnder,
    dragOverIdx, setDragOverIdx, isProcessing, heicConverting, setHeicConverting, expandPdfPages, serverHeicConvert,
    setUnsupportedWarning,
  });

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
  }, [showAutoFillPicker, pendingRepick, deleteConfirm, pendingOverFiles, pendingTruncated, pendingBookOverflow, setPendingBookOverflow, showImpositionModal, setShowImpositionModal, showDownloadModal, showEmbedDisclaimer]);

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
      <EditorBanners
        swapSource={swapSource} setSwapSource={setSwapSource}
        persistDegraded={persistDegraded} setPersistDegraded={setPersistDegraded}
        storageBlocked={storageBlocked} setStorageBlocked={setStorageBlocked}
        uploadWarning={uploadWarning} setUploadWarning={setUploadWarning}
        colorWarning={colorWarning} setColorWarning={setColorWarning}
        unsupportedWarning={unsupportedWarning} setUnsupportedWarning={setUnsupportedWarning}
        qtyUnder={qtyUnder} setQtyUnder={setQtyUnder} headerHeight={headerHeight} toolbarHeight={toolbarHeight}
        setShowAutoFillPicker={setShowAutoFillPicker} setPickerSelected={setPickerSelected} uploadInputRef={uploadInputRef}
      />

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

      <BookSpreadPreview
        showSpreadPreview={showSpreadPreview} setShowSpreadPreview={setShowSpreadPreview} bookSpreads={bookSpreads}
        bookCoverPreview={bookCoverPreview} bookBackCoverPreview={bookBackCoverPreview} bookSpineWidthMm={bookSpineWidthMm}
      />

      <ErrorBanner error={error} setError={setError} />
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
          <EditorToolbar
            setToolbarSentinel={setToolbarSentinel} isToolbarStuck={isToolbarStuck} toolbarHeight={toolbarHeight}
            setToolbarEl={setToolbarEl} headerHeight={headerHeight}
            embedToken={embedToken} orderId={orderId} parentOrigin={parentOrigin} layout={layout} layoutName={layoutName}
            files={files} surfaceStates={surfaceStates} qtyUnder={qtyUnder} qtyNeeded={qtyNeeded}
            totalUploadedCount={totalUploadedCount} uploadInputRef={uploadInputRef}
            globalFitMode={globalFitMode} setGlobalFitMode={setGlobalFitMode} fitModeUserToggledRef={fitModeUserToggledRef}
            globalBlurFill={globalBlurFill} setGlobalBlurFill={setGlobalBlurFill} blurFillUserToggledRef={blurFillUserToggledRef}
            isDownloading={isDownloading} setDisclaimerChecked={setDisclaimerChecked}
            setShowEmbedDisclaimer={setShowEmbedDisclaimer} setShowDownloadModal={setShowDownloadModal}
          />

          <ProcessingOverlay
            isProcessing={isProcessing} isDownloading={isDownloading} isImposing={isImposing}
            renderProgress={renderProgress} serverRenderLabel={serverRenderLabel}
            heicConverting={heicConverting} embedToken={embedToken}
          />

          <BookPageCount
            isBookProduct={isBookProduct} bookPageBounds={bookPageBounds} bookPageCount={bookPageCount}
            handleBookPageCountChange={handleBookPageCountChange} setShowSpreadPreview={setShowSpreadPreview}
          />

          <EmptyState
            isProcessing={isProcessing} canvases={canvases} restorePending={restorePending} restoreCount={restoreCount}
            layout={layout} dragOverIdx={dragOverIdx} setDragOverIdx={setDragOverIdx}
            uploadInputRef={uploadInputRef} handleFileChange={handleFileChange}
          />

          <CanvasGrid
            canvases={canvases} surfaceStates={surfaceStates} layout={layout}
            dragOverIdx={dragOverIdx} setDragOverIdx={setDragOverIdx} repositionMode={repositionMode}
            handleDragStart={handleDragStart} handleDragOver={handleDragOver} handleDrop={handleDrop}
            openEditor={openEditor} handleCardClick={handleCardClick}
            handlePanStart={handlePanStart} handlePanMove={handlePanMove} handlePanEnd={handlePanEnd}
            requestReplacePhoto={requestReplacePhoto} lowDpiByCard={lowDpiByCard}
            handleQuickRotate={handleQuickRotate} handleQuickToggleFit={handleQuickToggleFit} handleQuickToggleBlur={handleQuickToggleBlur}
            swapSource={swapSource} setSwapSource={setSwapSource} handleQuickDelete={handleQuickDelete}
          />

          <CalendarSection
            isCalendarProduct={isCalendarProduct} layout={layout}
            calendarTheme={calendarTheme} setCalendarTheme={setCalendarTheme} genzPalette={genzPalette} genzPalettes={genzPalettes}
            setGenzPalette={setGenzPalette} calendarType={calendarType} setCalendarType={setCalendarType}
            handleCalendarMonthTileClick={handleCalendarMonthTileClick} calendarCells={calendarCells} printedHolidays={printedHolidays}
            selectedCalendarCell={selectedCalendarCell} setSelectedCalendarCell={setSelectedCalendarCell}
            calendarCellEntries={calendarCellEntries} updateCellEntries={updateCellEntries}
            calendarCellImagePreviews={calendarCellImagePreviews} setCalendarCellImagePreviews={setCalendarCellImagePreviews}
            calendarImageUploading={calendarImageUploading} calendarCellFileInputRef={calendarCellFileInputRef}
            handleCellImageFileSelected={handleCellImageFileSelected}
          />

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
