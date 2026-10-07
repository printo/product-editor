'use client';

import { useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type React from 'react';
import { convertAndPartitionFiles, convertHeicFileIfNeeded, isHeicFile } from '@/lib/heic-convert';
import { detectJpegColorSpace, isImageComplete } from '@/lib/image-utils';
import { checkOrderQty, duplicateFingerprint } from '@/lib/submit-guards';
import { isAllowedImageFile, unsupportedFilesMessage } from '@/lib/upload-utils';
import { resolvePageCount, type BookLayoutLike } from '@/lib/book-layout';
import type { NormalizedLayout } from '@/lib/layout-utils';
import { reconcilePageCount } from './book-pages';
import { countCanvasesLosingEdits } from './canvas-merge';
import { allocateFilesToSurfaces, surfaceFrameCount, totalSurfaceCapacity } from './surface-allocation';
import type { CanvasItem, FitMode, SurfaceState } from './types';

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;
type BookOverflow = { files: File[]; currentCapacity: number; suggestedCount: number };

/** Getting photos in: Add Photos (which appends), the per-frame Replace, and
 *  the prompts a pick can stop at — incomplete photos, more photos than
 *  ordered (a hard cap) or than the book holds, and re-picking over edited
 *  pages — plus filling an order up with repeats. The state those prompts
 *  hold lives here; the photos and cards are the page's. */
export function useFileIntake({
  layout, files, setFiles, setCanvases, canvasesRef, surfaceStates, setSurfaceStates, surfaceStatesRef, activeSurfaceKey,
  normalizedLayoutState, isCalendarProduct, isBookProduct, bookPageCount, setBookPageCount, bookHiddenPages, setBookHiddenPages,
  bookHiddenPagesRef, bookOverflowDecidedRef, pendingBookOverflow, setPendingBookOverflow, orderQty, qtyUnder, setQtyUnder,
  intentionalDupesRef, uploadInputRef, createdObjectURLs, fileUrlCache, generateCanvasesForLayout, skipNextGenerateRef,
  expandPdfPages, serverHeicConvert, setHeicConverting, setIsProcessing, setError, setColorWarning, setUploadWarning,
  setUnsupportedWarning,
}: {
  layout: any;
  files: File[];
  setFiles: Setter<File[]>;
  setCanvases: Setter<CanvasItem[]>;
  canvasesRef: Ref<CanvasItem[]>;
  surfaceStates: SurfaceState[];
  setSurfaceStates: Setter<SurfaceState[]>;
  surfaceStatesRef: Ref<SurfaceState[]>;
  activeSurfaceKey: string;
  normalizedLayoutState: NormalizedLayout | null;
  isCalendarProduct: boolean;
  isBookProduct: boolean;
  bookPageCount: number;
  setBookPageCount: Setter<number>;
  bookHiddenPages: Record<string, SurfaceState>;
  setBookHiddenPages: Setter<Record<string, SurfaceState>>;
  bookHiddenPagesRef: Ref<Record<string, SurfaceState>>;
  bookOverflowDecidedRef: Ref<boolean>;
  pendingBookOverflow: BookOverflow | null;
  setPendingBookOverflow: Setter<BookOverflow | null>;
  orderQty: number | null;
  qtyUnder: { uploaded: number; needed: number } | null;
  setQtyUnder: Setter<{ uploaded: number; needed: number } | null>;
  intentionalDupesRef: Ref<Set<string>>;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  createdObjectURLs: Ref<Set<string>>;
  fileUrlCache: Ref<WeakMap<File, string>>;
  generateCanvasesForLayout: (layoutDef: any, files: File[], fitMode: FitMode, existingCanvases?: CanvasItem[]) => Promise<CanvasItem[]>;
  skipNextGenerateRef: Ref<boolean>;
  expandPdfPages: (files: File[], opts: { maxSelectable: number | null }) => Promise<File[]>;
  serverHeicConvert: Parameters<typeof convertAndPartitionFiles>[1];
  setHeicConverting: Setter<boolean>;
  setIsProcessing: Setter<boolean>;
  setError: Setter<string | null>;
  setColorWarning: Setter<string | null>;
  setUploadWarning: Setter<string | null>;
  setUnsupportedWarning: Setter<string | null>;
}) {
  const [pendingOverFiles, setPendingOverFiles] = useState<File[] | null>(null);
  // Re-pick confirm (Phase 3): held selection + how many edited pages would
  // lose their work if it replaced the current photos.
  const [pendingRepick, setPendingRepick] = useState<{ files: File[]; losingCount: number } | null>(null);
  const repickConfirmedRef = useRef(false);
  // Per-frame photo replace (Phase 3): which slot the hidden input feeds.
  const [pendingReplace, setPendingReplace] = useState<{ canvasIdx: number; frameIdx: number; surfaceKey: string | null } | null>(null);
  const replacePhotoInputRef = useRef<HTMLInputElement | null>(null);
  // Files flagged as truncated/incomplete by the client-side completeness check,
  // held pending the customer's Keep-anyway / Remove decision (see handleFileChange).
  const [pendingTruncated, setPendingTruncated] = useState<{ all: File[]; bad: File[] } | null>(null);
  const [showAutoFillPicker, setShowAutoFillPicker] = useState(false);
  const [pickerSelected, setPickerSelected] = useState<Set<number>>(new Set());

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

  return {
    pendingOverFiles, setPendingOverFiles, pendingRepick, setPendingRepick, replacePhotoInputRef,
    pendingTruncated, setPendingTruncated, showAutoFillPicker, setShowAutoFillPicker, pickerSelected, setPickerSelected,
    handleFileChange, requestReplacePhoto, handleReplaceFileSelected, handleRepickConfirm, handleFillWithPicked,
    handleOverConfirm, handleTruncatedDecision, handleBookOverflowDecision,
  };
}
