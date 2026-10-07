'use client';

/**
 * /layout/[name]  —  Canvas editor page
 */

import React, {
  useState, useEffect, useMemo, useRef,
} from 'react';
import { useHeader } from '@/context/HeaderContext';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { IMAGE_AND_PDF_ACCEPT_ATTR } from '@/lib/upload-utils';
import { usePdfPageImport } from '@/components/use-pdf-page-import';
import type { NormalizedLayout } from '@/lib/layout-utils';
import { collectDuplicateFills } from '@/lib/submit-guards';
import type { FitMode, CanvasItem, SurfaceState } from './types';
import { CanvasEditorModal } from './CanvasEditorModal';
import { GoogleFontLinks, useGoogleFonts } from '@/components/GoogleFontLinks';
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
import { useFileIntake } from './useFileIntake';
import { useServerRender } from './useServerRender';
import { useAutosaveAndRestore, usePhotoStore } from './useDesignPersistence';
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
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [colorWarning, setColorWarning] = useState<string | null>(null);
  // Unsupported-file (e.g. .svg) notice. Its own channel — NOT `error` — so a
  // partial selection's "skipped" message survives generateCanvases()'s
  // setError(null). Self-clears on the next clean selection.
  const [unsupportedWarning, setUnsupportedWarning] = useState<string | null>(null);
  // Qty enforcement state
  const [qtyUnder, setQtyUnder] = useState<{ uploaded: number; needed: number } | null>(null);
  // Tap-to-swap (Phase 3): the card picked as swap source; the next card
  // tap swaps instead of opening the editor. Touch has no HTML5 drag.
  const [swapSource, setSwapSource] = useState<{ idx: number; surfaceKey: string | null } | null>(null);
  // Device storage full — photos can't be persisted for refresh recovery
  // (Phase 3 quota surfacing). Drives a persistent amber notice.
  const [persistDegraded, setPersistDegraded] = useState(false);
  // Browser blocked IndexedDB entirely (Safari ITP in a cross-site iframe /
  // private mode) — photos live in memory only for this tab (Phase 3).
  const [storageBlocked, setStorageBlocked] = useState(false);
  const { expandPdfPages, pdfPickerElement } = usePdfPageImport();
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showEmbedDisclaimer, setShowEmbedDisclaimer] = useState(false);

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextGenerateRef = useRef(false);

  const [dragOverIdx, setDragOverIdx] = useState<{ idx: number, surfaceKey: string | null } | null>(null);

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
      // The autosave timers are cancelled by useAutosaveAndRestore, which owns them.
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

  const {
    restorePending, restoreCount, isSaving, fileIdByFileRef, fileSaveInFlightRef, sessionFilesRef, deletedFileIdsRef,
  } = useAutosaveAndRestore({
    layout, layoutLoading, layoutName, orderId, apiBase, getAuthHeaders, legacyOrderIdRef, normalizedLayoutState,
    canvases, setCanvases, setFiles, surfaceStatesRef, setSurfaceStates, activeSurfaceKey, activeSurfaceKeyRef, setActiveSurfaceKey,
    setGlobalFitMode, getFileUrl, skipNextGenerateRef,
    isCalendarProduct, calendarTheme, setCalendarTheme, calendarType, setCalendarType, genzPalette, setGenzPalette,
    calendarCells, setCalendarCells, isBookProduct, bookPageCount, setBookPageCount, bookHiddenPagesRef, setBookHiddenPages,
  });

  const canvasesRef = useRef<CanvasItem[]>([]);
  useEffect(() => {
    canvasesRef.current = canvases;
  }, [canvases]);

  usePhotoStore({
    orderId, surfaceStates, setSurfaceStates, fileIdByFileRef, fileSaveInFlightRef, sessionFilesRef, deletedFileIdsRef,
    setPersistDegraded, setStorageBlocked,
  });

  // Pre-submit guard (Phase 3): photos placed more than once (excluding
  // deliberate qty auto-fill duplicates, which useFileIntake records in
  // intentionalDupesRef). The rest of the guards are in useSubmitGuards. This
  // one stays here because it reads that ref during render, which React's
  // compiler lint rejects wherever hook rules aren't suppressed, and this
  // component suppresses them.
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

  const {
    pendingOverFiles, setPendingOverFiles, pendingRepick, setPendingRepick, replacePhotoInputRef,
    pendingTruncated, setPendingTruncated, showAutoFillPicker, setShowAutoFillPicker, pickerSelected, setPickerSelected,
    handleFileChange, requestReplacePhoto, handleReplaceFileSelected, handleRepickConfirm, handleFillWithPicked,
    handleOverConfirm, handleTruncatedDecision, handleBookOverflowDecision,
  } = useFileIntake({
    layout, files, setFiles, setCanvases, canvasesRef, surfaceStates, setSurfaceStates, surfaceStatesRef, activeSurfaceKey,
    normalizedLayoutState, isCalendarProduct, isBookProduct, bookPageCount, setBookPageCount, bookHiddenPages, setBookHiddenPages,
    bookHiddenPagesRef, bookOverflowDecidedRef, pendingBookOverflow, setPendingBookOverflow, orderQty, qtyUnder, setQtyUnder,
    intentionalDupesRef, uploadInputRef, createdObjectURLs, fileUrlCache, generateCanvasesForLayout, skipNextGenerateRef,
    expandPdfPages, serverHeicConvert, setHeicConverting, setIsProcessing, setError, setColorWarning, setUploadWarning,
    setUnsupportedWarning,
  });

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
  }, [showAutoFillPicker, pendingRepick, deleteConfirm, pendingOverFiles, pendingTruncated, pendingBookOverflow, setPendingBookOverflow, showImpositionModal, setShowImpositionModal, showDownloadModal, showEmbedDisclaimer, setShowAutoFillPicker, setPendingRepick, setPendingOverFiles, setPendingTruncated]);

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

  const {
    serverRenderLabel, includeUploads, setIncludeUploads, includeUploadsRef, disclaimerChecked, setDisclaimerChecked,
    submitted, setSubmitted, submittedJobId, setSubmittedJobId, executeBatchDownload, handleSubmitDesign,
  } = useServerRender({
    layout, layoutName, embedToken, parentOrigin, apiBase, getAuthHeaders, orderId, surfaceStates, canvases, activeSurfaceKey,
    isCalendarProduct, calendarTheme, calendarType, genzPalette, calendarCells, isBookProduct, bookPageCount,
    qtyNeeded, totalUploadedCount, setIsDownloading, setShowDownloadModal, setRenderProgress, setError,
  });

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
