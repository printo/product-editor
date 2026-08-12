'use client';

/**
 * /layout/[name]  —  Canvas editor page
 */

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useHeader } from '@/context/HeaderContext';
import {
  Upload, Loader2, CheckCircle2, X,
  Archive, FileText, Layout,
  SendHorizonal, RotateCw, Maximize, Palette, Download, ChevronRight, Trash2,
  Move, Lock, AlertTriangle, ImagePlus, ArrowLeftRight, Droplets, ArrowLeft, Plus,
} from 'lucide-react';
import { clsx } from 'clsx';
import { createZipFromDataUrls, downloadBlob } from '@/lib/zip-utils';
import {
  uploadFiles,
  unsupportedFilesMessage,
  isAllowedImageFile,
  IMAGE_AND_PDF_ACCEPT_ATTR,
} from '@/lib/upload-utils';
import { convertHeicFileIfNeeded, convertAndPartitionFiles, isHeicFile } from '@/lib/heic-convert';
import { pdfDerivedFiles } from '@/lib/pdf-import';
import { usePdfPageImport } from '@/components/use-pdf-page-import';
import { saveFile, getFilesForOrder, pruneStaleOrders, FileStoreQuotaError, getPersistenceMode } from '@/lib/file-store';
import { LazyImg } from '@/components/LazyImg';
import CanvasCardSkeleton from '@/components/CanvasCardSkeleton';
import { normalizeLayout, filterSurfaces, type NormalizedLayout } from '@/lib/layout-utils';
import { getImageMetadata, getImageSize, detectJpegColorSpace, isImageComplete } from '@/lib/image-utils';
import { collectLowDpiFrames, type LowDpiFrame } from '@/lib/dpi-utils';
import { planCanvasReuse, countCanvasesLosingEdits } from './canvas-merge';
import {
  collectEmptySurfaces, collectDuplicateFills, duplicateFingerprint,
  type EmptySurface, type DuplicateFill,
} from '@/lib/submit-guards';
import type { FitMode, FrameState, CanvasItem, ImpositionSettings, SurfaceState, Overlay } from './types';
import { renderCanvas as renderCanvasCore, calculateSmartCropOffsets } from './fabric-renderer';
import { detectFileOrientation, type OrientationOutcome } from '@/lib/ml-orientation';
// Type-only import — erased at compile time, zero bundle impact.
// The actual Fabric.js runtime is loaded lazily inside executeImposition / the
// imposition preview useEffect so it does NOT inflate the initial page bundle.
import type { StaticCanvas as FabricStaticCanvas } from 'fabric';
import {
  MM_TO_IN,
  CROP_MARK_LEN_MM,
  CROP_MARK_LEN_MIN_MM,
  CROP_MARK_LEN_MAX_MM,
  canvasSpecToInches,
  computeImpositionLayout,
  cropMarkLengthsFor,
  resolveSheetSize,
  type ItemSize,
} from './imposition';
import { CanvasEditorModal } from './CanvasEditorModal';
import { CalendarProductPreview } from '@/components/CalendarProductPreview';
import { CalendarEditPanel } from '@/components/CalendarEditPanel';
import { GoogleFontLinks, useGoogleFonts } from '@/components/GoogleFontLinks';
import type { CalendarTheme, CalendarType, GenzPalette, HolidayEntry } from '@/types/calendar';
import {
  uploadCalendarCellImage,
  CalendarCellUploadError,
} from '@/lib/calendar-cell-upload';

// ─── Fabric-based imposition / export ─────────────────────────────────────

/** Bounded fallback for measuring the imposition preview box when a
 *  ResizeObserver can't report (a hidden document runs no rendering steps). */
const MEASURE_RETRY_MS = 100;
const MEASURE_RETRY_LIMIT = 50;

/**
 * Decide whether a freshly-uploaded image should be auto-rotated 90° to fit
 * the target frame.
 *
 * The previous rule was a binary orientation match
 * (`(imgRatio > 1) !== (frameRatio > 1) → rotate`). That worked for layouts
 * whose frames span the full canvas (Classic prints: frame is 1500×2100, a
 * clear portrait) but mis-fired on layouts where the frame is a sub-region
 * with a near-square aspect — e.g. Retro polaroid 4.2×3.5, whose frame is
 * 945×921 (ratio 1.026). 1.026 is technically "landscape" by the strict `> 1`
 * test, so every portrait selfie tripped the mismatch and got rotated 90°,
 * landing sideways inside the polaroid window.
 *
 * The new rule rotates only when rotation provides a *meaningful* improvement
 * in aspect-ratio fit — at least 30% closer to the frame's aspect than the
 * original orientation. Near-square frames produce small differences either
 * way and stay un-rotated (preserving the photo's natural orientation);
 * frames with a clear portrait/landscape bias still get aggressive rotation
 * (a landscape photo into a 5×7 portrait frame still rotates correctly).
 *
 * Worked examples:
 *   - Classic 5×7 (frame ratio 0.714), portrait selfie (0.75):
 *     originalGap=0.04, rotatedGap=0.62 → don't rotate. ✓
 *   - Classic 5×7 (0.714), landscape photo (1.333):
 *     originalGap=0.62, rotatedGap=0.04 → rotate. ✓
 *   - Retro polaroid (frame ratio 1.026), portrait selfie (0.75):
 *     originalGap=0.28, rotatedGap=0.31 → don't rotate. ✓ (was the bug)
 *   - Retro polaroid (1.026), landscape photo (1.333):
 *     originalGap=0.31, rotatedGap=0.28 → marginal; 0.28 > 0.31×0.7 → don't rotate.
 */
function shouldAutoRotate90(
  imgW: number, imgH: number,
  frameW: number, frameH: number,
): boolean {
  if (imgW <= 0 || imgH <= 0 || frameW <= 0 || frameH <= 0) return false;
  const imgRatio = imgW / imgH;
  const targetRatio = frameW / frameH;
  // Near-square frames (e.g. the retro-polaroid window ≈ 1.03): rotating a photo
  // 90° can't meaningfully improve fill on a square-ish frame — it only lays the
  // subject on its side. Skip rotate-to-fill here and let the Blur Effect fill
  // the letterbox instead. Clearly rectangular products (portrait / landscape
  // frames) fall through below and keep rotate-to-fill.
  if (targetRatio >= 0.8 && targetRatio <= 1.25) return false;
  const originalGap = Math.abs(imgRatio - targetRatio);
  const rotatedGap = Math.abs((1 / imgRatio) - targetRatio);
  return rotatedGap < originalGap * 0.7;
}

/**
 * Resolve the final frame rotation, prioritising FRAME FILL.
 *
 * Ops decision (2026-05-19): a photo should be auto-rotated to FILL its
 * print frame, even when that lays a wide group shot on its side — the
 * ops person rotates that canvas back manually if they want it upright.
 * Filling the frame beats auto-keeping people upright.
 *
 * Decision order, per photo:
 *
 *  1. `shouldAutoRotate90` — does rotating 90° make the photo fill the
 *     frame meaningfully better? If yes → rotate 90°. This is the FILL
 *     case: a landscape photo into a portrait classic frame, etc.
 *     For a near-square frame this is always false (rotation can't
 *     improve fill on a square) — which is exactly the "if the frame is
 *     square it shouldn't rotate" rule.
 *
 *  2. Aspect rotation gained nothing (photo already matches the frame's
 *     orientation, or the frame is near-square). Now the ML result
 *     decides — it rotates a genuinely-sideways photo (camera held
 *     wrong, scanned print) upright. This is what fixes the Retro
 *     polaroid baby photo, whose near-square frame means step 1 never
 *     fires.
 *
 *  3. ML disabled / declined / errored → leave the photo as-is.
 *
 * The customer can always override with the per-canvas manual rotate.
 */
function resolveRotation(
  outcome: OrientationOutcome,
  imgW: number, imgH: number, frameW: number, frameH: number,
): number {
  // 1. FILL priority — rotate to best fill a clearly portrait/landscape frame.
  if (shouldAutoRotate90(imgW, imgH, frameW, frameH)) return 90;
  // 2. Aspect-neutral / near-square frame — let the ML correct genuine
  //    sideways content (Retro polaroid case).
  if (typeof outcome === 'object') return outcome.rotation;
  // 3. ML off / declined → as-is.
  return 0;
}

/** "~30 s" / "~2 min" for the honest render-wait label (Phase 3). */
function formatWait(seconds: number): string {
  if (seconds < 90) return `~${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `~${Math.round(seconds / 60)} min`;
}

// ── Restore-skeleton card-count hint ───────────────────────────────────────
// How many cards the order had last time, remembered locally so the restore
// placeholders render at the right count on the very first paint instead of
// snapping when the payload arrives. Cosmetic only — never a source of truth,
// and every access is guarded: localStorage throws outright in some privacy
// modes and in cross-site iframes (Safari ITP), which is exactly where the
// embed flow runs.
const CARD_COUNT_HINT_PREFIX = 'pe:cards:';
/** Upper bound on placeholders, so a corrupt hint can't render 10k nodes. */
const MAX_SKELETON_CARDS = 24;

function cardCountHintKey(orderId: string): string {
  return `${CARD_COUNT_HINT_PREFIX}${orderId}`;
}

function readCardCountHint(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const id = new URLSearchParams(window.location.search).get('order_id');
    if (!id) return 0;
    const n = Number(window.localStorage.getItem(cardCountHintKey(id)));
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_SKELETON_CARDS) : 0;
  } catch {
    return 0;
  }
}

function writeCardCountHint(orderId: string, count: number): void {
  if (typeof window === 'undefined' || !orderId) return;
  try {
    if (count > 0) window.localStorage.setItem(cardCountHintKey(orderId), String(count));
    else window.localStorage.removeItem(cardCountHintKey(orderId));
  } catch {
    /* storage blocked — the hint is optional */
  }
}

/** Embed post-submit status panel (Phase 3 — no more dead-end): polls
 *  render-status through the embed proxy and surfaces queued / rendering /
 *  done / failed honestly, with a way back into the editor. */
function EmbedSubmittedOverlay({
  jobId, apiBase, getAuthHeaders, onBackToEditor,
}: {
  jobId: string;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  onBackToEditor: () => void;
}) {
  const [state, setState] = useState<{
    status: 'queued' | 'processing' | 'completed' | 'failed';
    waitSeconds: number | null;
    error: string | null;
  }>({ status: 'queued', waitSeconds: null, error: null });

  useEffect(() => {
    let cancelled = false;
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${apiBase}/render-status/${jobId}/`, { headers: getAuthHeaders() });
        if (res.ok) {
          const s = await res.json();
          if (cancelled) return;
          setState({
            status: s.status === 'processing' ? 'processing'
              : s.status === 'completed' ? 'completed'
              : s.status === 'failed' ? 'failed' : 'queued',
            waitSeconds: typeof s.estimated_wait_seconds === 'number' ? s.estimated_wait_seconds : null,
            error: s.error || null,
          });
          if (s.status === 'completed' || s.status === 'failed') return; // stop polling
        }
      } catch {
        // Transient poll failure — keep the last known state and retry.
      }
      delay = Math.min(delay * 1.5, 10000);
      timer = setTimeout(poll, Math.round(delay * (0.8 + Math.random() * 0.4)));
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, apiBase, getAuthHeaders]);

  return (
    <div className="fixed inset-0 z-[300000] flex items-center justify-center bg-white/85 backdrop-blur-sm" role="status" aria-live="polite">
      <div className="text-center p-10 max-w-md">
        {state.status === 'failed' ? (
          <>
            <X className="w-14 h-14 text-rose-500 mx-auto mb-4 p-2.5 rounded-full bg-rose-50" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Something went wrong preparing your design</h2>
            <p className="text-sm text-slate-500 mb-6">
              {state.error || 'The print files could not be generated.'} Your design is safe — you can go back, check it, and submit again.
            </p>
            <button
              onClick={onBackToEditor}
              className="px-6 py-3 text-sm font-semibold rounded-2xl bg-indigo-600 text-white hover:bg-indigo-700 transition-all"
            >
              Back to editor
            </button>
          </>
        ) : state.status === 'completed' ? (
          <>
            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Your design is ready</h2>
            <p className="text-sm text-slate-500 mb-6">The print files are prepared. You can close this window and continue with your order.</p>
            <button
              onClick={onBackToEditor}
              className="px-5 py-2.5 text-xs font-semibold rounded-2xl border-2 border-slate-200 text-slate-600 hover:bg-slate-50 transition-all"
            >
              Edit design again
            </button>
          </>
        ) : (
          <>
            <Loader2 className="w-14 h-14 text-indigo-500 mx-auto mb-4 animate-spin" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">
              {state.status === 'queued'
                ? (state.waitSeconds != null ? `Queued — about ${formatWait(state.waitSeconds)} wait` : 'Design submitted — queued…')
                : 'Preparing your print files…'}
            </h2>
            <p className="text-sm text-slate-500 mb-6">You can keep this window open, or close it — your design is submitted either way.</p>
            <button
              onClick={onBackToEditor}
              className="px-5 py-2.5 text-xs font-semibold rounded-2xl border-2 border-slate-200 text-slate-600 hover:bg-slate-50 transition-all"
            >
              Edit design
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Amber pre-submit notice for surfaces that will print without a photo
 *  (Phase 3 guard). Warn-and-proceed — never blocks. */
function EmptySurfaceWarning({ surfaces }: { surfaces: EmptySurface[] }) {
  if (surfaces.length === 0) return null;
  return (
    <div className="mx-7 mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        {surfaces.length === 1 ? 'One side has no photo' : 'Some sides have no photo'}
      </div>
      <p className="text-xs mt-1 leading-relaxed">
        {surfaces.map(s => s.label).join(', ')} will print blank. You can continue if that&apos;s intended.
      </p>
    </div>
  );
}

/** Amber pre-submit notice for the same photo placed more than once
 *  (Phase 3 guard). Deliberate qty auto-fill duplicates are excluded. */
function DuplicateFillWarning({ duplicates }: { duplicates: DuplicateFill[] }) {
  if (duplicates.length === 0) return null;
  const shown = duplicates.slice(0, 3);
  return (
    <div className="mx-7 mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        {duplicates.length === 1 ? 'A photo is used more than once' : 'Some photos are used more than once'}
      </div>
      <ul className="text-xs mt-1 space-y-0.5 leading-relaxed">
        {shown.map((d, i) => (
          <li key={i}>{d.fileName} — {d.placements.join(' and ')}</li>
        ))}
        {duplicates.length > 3 && <li>…and {duplicates.length - 3} more</li>}
      </ul>
      <p className="text-xs mt-1 leading-relaxed">If that&apos;s what you wanted, continue as normal.</p>
    </div>
  );
}

/** Amber pre-submit notice listing under-DPI photos (Phase 2 item 4).
 *  Warn-and-proceed per the PRD — buttons and checkbox stay untouched. */
function LowDpiWarning({ frames }: { frames: LowDpiFrame[] }) {
  if (frames.length === 0) return null;
  const shown = frames.slice(0, 3);
  const rest = frames.length - shown.length;
  return (
    <div className="mx-7 mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        Some photos are below print resolution
      </div>
      <p className="text-xs mt-1 leading-relaxed">
        You can continue, but they may look soft or pixelated in print (300 DPI recommended).
      </p>
      <ul className="text-xs mt-1.5 space-y-0.5 font-medium">
        {shown.map((f, i) => (
          <li key={i}>
            {f.surfaceLabel ?? `Canvas ${f.canvasIdx + 1}`}, photo {f.frameIdx + 1} — ~{Math.round(f.dpi)} DPI
          </li>
        ))}
        {rest > 0 && <li>…and {rest} more</li>}
      </ul>
    </div>
  );
}

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

  // Quantity enforcement — optional ?qty=N URL param (single-surface only)
  const orderQty = useMemo<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const v = new URLSearchParams(window.location.search).get('qty');
    const n = v ? parseInt(v, 10) : NaN;
    return isNaN(n) || n <= 0 ? null : n;
  }, []);

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

  const isAdmin = !embedToken &&
    (session?.user?.role === 'admin' || session?.is_ops_team === true);

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
  const [showImpositionModal, setShowImpositionModal] = useState(false);
  const [isImposing, setIsImposing] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Job id behind the embed post-submit status panel (Phase 3).
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);
  const [impositionSettings, setImpositionSettings] = useState<ImpositionSettings>({
    preset: 'a4', widthIn: 8.27, heightIn: 11.69, marginMm: 6, gutterMm: 5, orientation: 'portrait',
    cropMarksEnabled: true, cropMarkLenMm: CROP_MARK_LEN_MM,
  });

  // WeakMap allows the File entry to be GC'd when the user removes a frame —
  // a Map would pin every File ever inserted for the lifetime of the page.
  // The parallel Set tracks created URL strings so unmount/cleanup can revoke
  // them (WeakMap isn't iterable).
  const fileUrlCache = useRef<WeakMap<File, string>>(new WeakMap());
  const createdObjectURLs = useRef<Set<string>>(new Set());
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const renderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impositionPreviewRef = useRef<HTMLCanvasElement>(null);
  const impositionPreviewBoxRef = useRef<HTMLDivElement>(null);
  const [previewBox, setPreviewBox] = useState({ w: 0, h: 0 });
  const impositionFabricRef = useRef<FabricStaticCanvas | null>(null);
  const skipNextGenerateRef = useRef(false);
  const [previewSheetIdx, setPreviewSheetIdx] = useState(0);

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

  // ── Calendar product state (PRD §10.3 / audit fix #1) ────────────────────
  // These only matter when layout.productType === 'calendar'. Initialised
  // with the layout-level defaults; customer overrides are tracked here.
  const isCalendarProduct = layout?.productType === 'calendar';
  const [calendarTheme, setCalendarTheme] = useState<CalendarTheme>('modern-minimalist');
  const [calendarType, setCalendarType] = useState<CalendarType>('english');
  const [genzPalette, setGenzPalette] = useState<string | undefined>(undefined);
  const [genzPalettes, setGenzPalettes] = useState<GenzPalette[]>([]);
  const [calendarHolidays, setCalendarHolidays] = useState<HolidayEntry[]>([]);
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

  // position:sticky's `top` offsets the element from its static position even
  // before it needs to stick (same math as position:relative) — with `top`
  // permanently set to headerHeight, that adds a phantom headerHeight-sized
  // gap above the toolbar AND an equal overlap into whatever renders below it,
  // since the reserved flow space is based on the un-shifted static position.
  // Fix: only apply the header-clearing offset once the toolbar has actually
  // scrolled to where it would go under the header — before that, `top: 0`
  // exactly matches its natural position (main has no top padding), so no
  // offset is needed at all.
  const toolbarSentinelRef = useRef<HTMLDivElement>(null);
  const [isToolbarStuck, setIsToolbarStuck] = useState(false);

  useEffect(() => {
    const sentinel = toolbarSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsToolbarStuck(!entry.isIntersecting),
      { rootMargin: `-${headerHeight + 1}px 0px 0px 0px`, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [headerHeight]);

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
        if (Array.isArray(payload.fonts) && payload.fonts.length) {
          setSelectedFonts(payload.fonts);
        }
        let normalized = normalizeLayout(item);
        if (surfacesParam) {
          normalized = filterSurfaces(normalized, surfacesParam.split(',').map(s => s.trim()));
        }
        setNormalizedLayoutState(normalized);
        const initSurfaces: SurfaceState[] = normalized.surfaces.map(s => ({
          key: s.key,
          label: s.label,
          def: s,
          files: [],
          canvases: [],
          globalFitMode: 'contain' as FitMode,
        }));
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
          holidayLocale: item.calendar?.holidaySource?.locale || 'en-IN',
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

  // ── Auto-save: debounce 2 s after canvases change ────────────────────────
  useEffect(() => {
    // Don't save before the layout is known or before the orderId is set.
    if (!orderId || !layout) return;
    // Never write while a restore is still in flight. `canvases` is empty on
    // mount and the save below is deliberately allowed to write an empty state
    // (see "delete all" note), so without this guard a canvas-state GET slower
    // than the 2 s debounce loses the race and PUTs an empty design over the
    // customer's saved one — silently and unrecoverably. Production responses
    // are ~400 ms, but this app is used mostly on phones and tablets where a
    // >2 s response is ordinary. Cleared on every exit path of the restore
    // effect, so nothing can strand the editor in a non-saving state.
    if (restorePending) return;
    // Skip the first save that fires as a side-effect of restoring state —
    // we'd just be writing back the exact data we loaded from the server.
    if (isRestoringRef.current) { isRestoringRef.current = false; return; }
    // Allow saving even when canvases is empty — this covers the "delete all"
    // case so that a refresh after clearing doesn't restore the old design.

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setIsSaving('saving');

    saveTimeoutRef.current = setTimeout(async () => {
      try {
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
        if (isCalendarProduct) {
          editorState.calendarState = {
            themePreset: calendarTheme,
            calendarType,
            genzPalette,
            cells: calendarCells,
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
        } else {
          setIsSaving('idle');
        }
      } catch {
        setIsSaving('idle');
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
    // surfaceStates/activeSurfaceKey are intentionally read via refs so this
    // effect only re-runs when the active surface's canvases actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvases, orderId, layout, restorePending]);

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
        const hydrate = (canvases: CanvasItem[]): CanvasItem[] =>
          canvases.map(c => ({
            ...c,
            frames: c.frames.map(f => {
              if (!f.fileId) return f;
              const file = fileMap.get(f.fileId);
              return file ? { ...f, originalFile: file } : f;
            }),
            overlays: c.overlays.map(o => {
              if (o.type !== 'image' || !o.fileId) return o;
              const file = fileMap.get(o.fileId);
              if (!file) return o;
              // Re-create the blob URL since the saved one was revoked when
              // the previous browser session ended. getFileUrl caches by File
              // reference so revocation hooks elsewhere still work.
              return { ...o, originalFile: file, src: getFileUrl(file) };
            }),
          }));

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
      } catch {
        // Restore failures are silent — user just starts fresh.
      } finally {
        // Every exit path lands here — 404 (nothing saved), a layout mismatch,
        // a thrown fetch, or success. Leaving this set would strand the
        // skeletons on screen in place of the upload prompt.
        setRestorePending(false);
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

    surfaceStates.forEach(s => {
      s.canvases.forEach((c, ci) => {
        c.frames.forEach((f, fi) => {
          if (f.originalFile && !f.fileId) {
            pending.push({ surfaceKey: s.key, canvasIdx: ci, kind: 'frame', idx: fi, file: f.originalFile });
          }
        });
        c.overlays.forEach((o, oi) => {
          if (o.type === 'image' && o.source === 'local' && o.originalFile && !o.fileId) {
            pending.push({ surfaceKey: s.key, canvasIdx: ci, kind: 'overlay', idx: oi, file: o.originalFile });
          }
        });
      });
    });

    if (!pending.length) return;

    let cancelled = false;
    (async () => {
      const results = await Promise.all(pending.map(async (p) => {
        try {
          const fileId = await saveFile(orderId, p.file);
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

  // ── Calendar auto-save: trigger save when calendar state changes ─────────
  // The main auto-save effect keys on `canvases`. For calendar products the
  // primary interaction (changing theme / adding cell entries) never touches
  // `canvases`, so cell edits would never auto-save without this separate
  // effect. We set canvases to a dummy value increment to piggyback on the
  // main debounce — simpler than duplicating the full save logic.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isCalendarProduct || !orderId || !layout) return;
    // Touch the save trigger by calling the existing save path directly.
    // We do this by firing the saveTimeoutRef path — same debounce, same logic.
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setIsSaving('saving');
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const latestSurfaces = surfaceStatesRef.current;
        const latestActiveKey = activeSurfaceKeyRef.current;
        const editorState: Record<string, any> = {
          surfaces: latestSurfaces.map(s => ({
            key: s.key,
            canvases: serializeCanvasState(s.canvases),
            globalFitMode: s.globalFitMode,
          })),
          activeSurfaceKey: latestActiveKey,
          layoutName,
          calendarState: {
            themePreset: calendarTheme,
            calendarType,
            genzPalette,
            cells: calendarCells,
          },
        };
        const res = await fetch(`${apiBase}/canvas-state/${orderId}/`, {
          method: 'PUT',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ layout_name: layoutName, editor_state: editorState }),
        });
        if (res.ok) {
          setIsSaving('saved');
          if (saveIdleTimeoutRef.current) clearTimeout(saveIdleTimeoutRef.current);
          saveIdleTimeoutRef.current = setTimeout(() => setIsSaving('idle'), 3000);
        } else {
          setIsSaving('idle');
        }
      } catch { setIsSaving('idle'); }
    }, 2000);
  // Calendar state changes trigger this save; layout/orderId guard against
  // firing before the session is ready.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarTheme, calendarType, genzPalette, calendarCells]);

  // Pre-submit guards (Phase 3): surfaces that would print blank + photos
  // placed more than once (excluding deliberate qty auto-fill duplicates).
  const intentionalDupesRef = useRef(new Set<string>());
  const emptySurfaces = useMemo(() => collectEmptySurfaces(surfaceStates), [surfaceStates]);
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

  // ── Escape closes confirm dialogs (Phase 4 a11y) ──────────────────────────
  // One document-level handler (effect + cleanup — the sanctioned no-DOM
  // exception) closes whichever confirm modal is open, so keyboard users
  // aren't trapped. The full editor modal manages its own keys (Fabric uses
  // Escape for text editing) and is not included here.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pendingRepick) return setPendingRepick(null);
      if (deleteConfirm) return setDeleteConfirm(null);
      if (pendingOverFiles) return setPendingOverFiles(null);
      if (showDownloadModal) return setShowDownloadModal(false);
      if (showEmbedDisclaimer) return setShowEmbedDisclaimer(false);
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [pendingRepick, deleteConfirm, pendingOverFiles, showDownloadModal, showEmbedDisclaimer]);

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
  // for the palette swatch picker. Holidays are fetched for the resolved
  // year range (current year + next year covers FY mode straddling years).
  useEffect(() => {
    if (!isCalendarProduct || !layout) return;
    const locale = layout.holidayLocale || 'en-IN';
    const today = new Date();
    const yr1 = today.getFullYear();
    const yr2 = yr1 + 1;

    // Apply layout-level ops defaults for customer-controllable fields.
    const rawCalendar = (normalizedLayoutState as any)?._raw?.calendar;
    if (rawCalendar?.themePreset) setCalendarTheme(rawCalendar.themePreset as CalendarTheme);
    if (rawCalendar?.calendarType) setCalendarType(rawCalendar.calendarType as CalendarType);

    // Fetch Gen-Z palettes if theme default is modern-genz.
    fetch(`${apiBase}/calendar-styles/modern-genz`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.palettes?.length) setGenzPalettes(d.palettes); })
      .catch(() => {});

    // Fetch holidays for current + next year so FY calendars (Apr..Mar) have
    // holiday data for both calendar years in their range.
    Promise.all([yr1, yr2].map(yr =>
      fetch(`${apiBase}/holidays/${locale}/${yr}`, { headers: getAuthHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then(d => (d?.events as HolidayEntry[]) || [])
        .catch(() => [] as HolidayEntry[])
    )).then(([h1, h2]) => setCalendarHolidays([...h1, ...h2]));
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
    const plannedSlots: (File | null)[][] = Array.from({ length: canvasCount }, (_, c) =>
      Array.from({ length: frameCount }, (_, f) => surfaceFiles[(c * frameCount + f) % surfaceFiles.length] || null)
    );
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
            const frames = (layoutDef?.canvas?.width ? layoutDef.frames : (layoutDef as any)?.surfaces?.[0]?.frames) || [];
            const frameSpec = frames[f] || { x: 0, y: 0, width: 1, height: 1 };
            const canvasW = layoutDef?.canvas?.width || (layoutDef as any)?.surfaces?.[0]?.canvas?.width || 1200;
            const canvasH = layoutDef?.canvas?.height || (layoutDef as any)?.surfaces?.[0]?.canvas?.height || 1800;
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

  const openEditor = (idx: number, surfaceKey?: string) => {
    let targetCanvases = canvases;
    if (surfaceKey && surfaceKey !== activeSurfaceKey) {
      setActiveSurfaceKey(surfaceKey);
      const surface = surfaceStates.find(s => s.key === surfaceKey);
      if (surface) targetCanvases = surface.canvases;
    }
    const c = targetCanvases[idx];
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

  const updateCanvasState = useCallback(async (idx: number, surfaceKey: string | null, updateFn: (c: CanvasItem) => CanvasItem | Promise<CanvasItem>) => {
    if (surfaceKey) {
      const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
      if (sIdx === -1) return;
      const targetSurface = surfaceStates[sIdx];
      const targetCanvas = targetSurface.canvases[idx];
      if (!targetCanvas) return;

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
    } else {
      const targetCanvas = canvases[idx];
      if (!targetCanvas) return;

      const updatedCanvas = await updateFn(targetCanvas);
      const canRerender = updatedCanvas.frames.some(f => f.originalFile !== null);
      if (canRerender) updatedCanvas.dataUrl = await renderCanvas(updatedCanvas, { thumbnail: true });

      setCanvases(prev => prev.map((c, ci) => ci === idx ? updatedCanvas : c));
    }
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
          const frames = (layoutDef?.canvas?.width ? layoutDef.frames : (layoutDef as any)?.surfaces?.[0]?.frames) || [];
          const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
          const canvasW = layoutDef?.canvas?.width || (layoutDef as any)?.surfaces?.[0]?.canvas?.width || 1200;
          const canvasH = layoutDef?.canvas?.height || (layoutDef as any)?.surfaces?.[0]?.canvas?.height || 1800;
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
          const frames = (layoutDef?.canvas?.width ? layoutDef.frames : (layoutDef as any)?.surfaces?.[0]?.frames) || [];
          const frameSpec = frames[fIdx] || { x: 0, y: 0, width: 1, height: 1 };
          const canvasW = layoutDef?.canvas?.width || (layoutDef as any)?.surfaces?.[0]?.canvas?.width || 1200;
          const canvasH = layoutDef?.canvas?.height || (layoutDef as any)?.surfaces?.[0]?.canvas?.height || 1800;
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
    const canvasW = layoutDef?.canvas?.width || (layoutDef as any)?.surfaces?.[0]?.canvas?.width || 1200;
    const canvasH = layoutDef?.canvas?.height || (layoutDef as any)?.surfaces?.[0]?.canvas?.height || 1800;
    const frames = (layoutDef?.canvas?.width ? layoutDef.frames : (layoutDef as any)?.surfaces?.[0]?.frames)
      || [{ x: 0, y: 0, width: 1, height: 1 }];
    return { canvasW, canvasH, frames };
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
        })))
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

  const handleQuickCycleBg = (idx: number, surfaceKey: string | null = null) => {
    updateCanvasState(idx, surfaceKey, (c) => ({
      ...c,
      bgColor: c.bgColor === '#ffffff' ? '#000000' : c.bgColor === '#000000' ? '#f8fafc' : '#ffffff'
    }));
  };

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
      setCanvases(prev => prev.filter((_, i) => i !== idx));
      setFiles(prev => [
        ...prev.slice(0, idx * frameCount),
        ...prev.slice((idx + 1) * frameCount),
      ]);
    }
    setDeleteConfirm(null);
  };

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

    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${layout?.id || 'canvas'}-${surfaceKey || 'canvas'}-${idx + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
    // A PDF dropped onto one specific surface card can only ever contribute
    // one photo — each surface holds exactly one by design — so constrain
    // the picker to single-select there rather than letting the customer
    // pick more pages and having the surfaceKey branch below silently keep
    // only the first (see the plan's "single-select mode" note).
    const droppedFiles = await expandPdfPages(rawDroppedFiles, { maxSelectable: surfaceKey ? 1 : null });

    if (droppedFiles.length > 0) {
      // ── Handle external files ──────────────────────────────────────────────
      // Validate by extension (matches the backend). A plain
      // `type.startsWith('image/')` check would let .svg through —
      // image/svg+xml is an image MIME the renderer can't accept. HEIC/HEIF
      // are converted to JPEG first — drag-and-drop ignores <input accept>,
      // so an iPhone HEIC can arrive here directly (see heic-convert.ts).
      const heicPresent = droppedFiles.some(isHeicFile);
      if (heicPresent) setHeicConverting(true);
      const { accepted: okFiles, warning } = await convertAndPartitionFiles(droppedFiles);
      if (heicPresent) setHeicConverting(false);
      setUnsupportedWarning(warning);
      if (okFiles.length === 0) return;
      const firstFile = okFiles[0];

      if (surfaceKey) {
        // Multi-surface: update that specific surface's file
        const sIdx = surfaceStates.findIndex(s => s.key === surfaceKey);
        if (sIdx === -1) return;
        
        const s = surfaceStates[sIdx];
        const surfaceLayout = {
          ...normalizedLayoutState?._raw,
          canvas: s.def.canvas,
          frames: s.def.frames,
          maskUrl: s.def.maskUrl,
          maskOnExport: s.def.maskOnExport,
        };
        
        const newCanvases = await generateCanvasesForLayout(surfaceLayout, [firstFile], s.globalFitMode);
        setSurfaceStates(prev => prev.map((ps, pi) => 
          pi === sIdx ? { ...ps, files: [firstFile], canvases: newCanvases } : ps
        ));
        
        if (surfaceKey === activeSurfaceKey) {
          setFiles([firstFile]);
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
        const targetFiles = [...surfaceStates[targetSurfaceIdx].files];
        const sourceFiles = [...surfaceStates[sourceSurfaceIdx].files];

        // Swap files
        const temp = targetFiles[0];
        targetFiles[0] = sourceFiles[0];
        sourceFiles[0] = temp;

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
    const { accepted: newlyPicked, warning } = await convertAndPartitionFiles(rawFiles);
    if (heicPresent) setHeicConverting(false);
    setUnsupportedWarning(warning);
    if (newlyPicked.length === 0) return;

    // "Add Files" — a native <input> selection is never cumulative (picking
    // again hands back only the new files, not the old ones), but this button
    // is meant to APPEND onto whatever's already on the canvas, filling the
    // next empty frame slots and spilling into new canvases once the current
    // one is full — not replace canvas 1's photo with whatever was just
    // picked. Multi-surface layouts are excluded: each surface holds exactly
    // one photo (a distinct physical side), so there's no "next canvas" for
    // it to append to — picking there still replaces that surface's photo.
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
  // customer's chosen subset.
  const processSelectedFiles = async (allFiles: File[]) => {
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
    if (orderQty !== null && surfaceStates.length <= 1) {
      setQtyUnder(null);
      setPendingOverFiles(null);
      if (allFiles.length < orderQty) {
        // Under: generate with what we have, show persistent banner
        setQtyUnder({ uploaded: allFiles.length, needed: orderQty });
      } else if (allFiles.length > orderQty) {
        // Over: hold files, show confirm modal
        setPendingOverFiles(allFiles);
        return; // don't process yet — wait for user confirm
      }
      // Exact match or under (proceed with current files)
    }

    if (surfaceStates.length > 1 && normalizedLayoutState) {
      setIsProcessing(true);
      setError(null);
      const maxFiles = surfaceStates.length;
      if (allFiles.length > maxFiles) {
        setUploadWarning(`Only ${maxFiles} image${maxFiles !== 1 ? 's' : ''} were selected.`);
        setTimeout(() => setUploadWarning(null), 5000);
      }
      const cappedFiles = allFiles.slice(0, maxFiles);
      const updatedSurfaces: SurfaceState[] = [];
      for (let idx = 0; idx < surfaceStates.length; idx++) {
        const s = surfaceStates[idx];
        const surfaceFiles = idx < cappedFiles.length ? [cappedFiles[idx]] : [];
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
      file = await convertHeicFileIfNeeded(file);
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

  // ── Qty: auto-fill (cycle images to fill remaining slots) ─────────────────
  const handleAutoFill = () => {
    if (!qtyUnder || files.length === 0) return;
    const needed = qtyUnder.needed - files.length;
    const filled = [...files];
    for (let i = 0; i < needed; i++) filled.push(files[i % files.length]);
    // These duplicates are deliberate — exempt them from the duplicate-fill
    // pre-submit warning (Phase 3).
    filled.forEach(f => intentionalDupesRef.current.add(duplicateFingerprint(f)));
    setQtyUnder(null);
    setFiles(filled);
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

  // ── Qty: over-upload — user confirmed, process all pending files ───────────
  const handleOverConfirm = (proceed: boolean) => {
    if (!pendingOverFiles) return;
    if (proceed) {
      setFiles(pendingOverFiles);
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

  /** The canvases destined for the sheet, in placement order. */
  const impositionCanvases = useMemo(
    () => (surfaceStates.length > 1 ? surfaceStates.flatMap(s => s.canvases) : canvases),
    [surfaceStates, canvases],
  );

  /**
   * Physical size of each of those canvases, in inches — index for index.
   *
   * Every surface contributes ITS OWN dimensions: a multi-surface product whose
   * sides differ in size must not be imposed at the first side's size. `null`
   * means the layout carries no usable dimensions, in which case imposition is
   * refused rather than guessing a size (a wrong guess prints at the wrong
   * scale with no visible symptom).
   */
  const impositionItems = useMemo<ItemSize[] | null>(() => {
    if (!layout) return null;
    if (surfaceStates.length > 1) {
      const sizes: ItemSize[] = [];
      for (const s of surfaceStates) {
        const size = canvasSpecToInches(s.def?.canvas);
        if (!size) return null;
        for (let i = 0; i < s.canvases.length; i++) sizes.push(size);
      }
      return sizes;
    }
    // Single surface: `canvases` is the live array (surfaceStates[0].canvases
    // only re-syncs on surface switch), but the physical size still comes from
    // the surface definition.
    const size = canvasSpecToInches(surfaceStates[0]?.def?.canvas ?? layout.canvas);
    return size ? canvases.map(() => size) : null;
  }, [layout, surfaceStates, canvases]);

  const impositionResult = useMemo(
    () => computeImpositionLayout(impositionSettings, impositionItems ?? []),
    [impositionSettings, impositionItems],
  );

  const sheetCount = impositionResult.sheets.length;
  const impositionPlacedTotal = useMemo(
    () => impositionResult.placedPerCanvas.reduce((a, b) => a + b, 0),
    [impositionResult],
  );
  const impositionSheetLabel = impositionSettings.preset === 'custom'
    ? `${impositionSettings.widthIn}″ × ${impositionSettings.heightIn}″`
    : impositionSettings.preset.toUpperCase();

  // Keep the page selector inside range when the settings change the sheet
  // count, and start every visit to the modal on sheet 1.
  useEffect(() => {
    setPreviewSheetIdx(p => (p < sheetCount ? p : Math.max(0, sheetCount - 1)));
  }, [sheetCount]);
  useEffect(() => {
    if (showImpositionModal) setPreviewSheetIdx(0);
  }, [showImpositionModal]);

  // The preview scales to the box it is actually given. A fixed pixel budget
  // overflowed the pane on landscape sheets, and `max-w-full` then squashed
  // the canvas horizontally while Fabric's inline height held — the sheet
  // rendered at the wrong aspect ratio.
  useEffect(() => {
    const el = impositionPreviewBoxRef.current;
    if (!el || !showImpositionModal) return;

    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    // Only publish a genuinely new size. Returning a fresh object on every
    // observer tick would re-run the draw effect, which resizes the canvas
    // inside this very box — a feedback loop that disposed and rebuilt the
    // Fabric scene forever and never reached the final render.
    const measure = () => {
      const w = Math.floor(el.clientWidth), h = Math.floor(el.clientHeight);
      setPreviewBox(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
      // A ResizeObserver only delivers during the document's rendering steps,
      // and a hidden document runs none — so if the box has no size yet, the
      // observer alone may never report the real one and the preview would
      // stay blank until the operator happened to change a setting. Poll
      // briefly to cover that; the observer takes over once a size exists.
      if ((w <= 0 || h <= 0) && attempts < MEASURE_RETRY_LIMIT) {
        attempts++;
        retry = setTimeout(measure, MEASURE_RETRY_MS);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // A tab that was hidden when the modal opened delivered no observer
    // callbacks at all; re-measure the moment it becomes visible again.
    document.addEventListener('visibilitychange', measure);
    return () => {
      ro.disconnect();
      document.removeEventListener('visibilitychange', measure);
      if (retry) clearTimeout(retry);
    };
  }, [showImpositionModal]);

  // Decoded sheet thumbnails, keyed by dataUrl. Rebuilding the preview used to
  // re-decode every placed image on every keystroke; a gang run of one design
  // now decodes once.
  const previewImgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  useEffect(() => {
    if (!showImpositionModal) previewImgCache.current.clear();
  }, [showImpositionModal]);

  useEffect(() => {
    const canvasEl = impositionPreviewRef.current;
    const { sheets, cropMarks } = impositionResult;
    if (!canvasEl || sheets.length === 0 || !showImpositionModal) return;
    // Measure the box HERE rather than trusting the observer's last delivery.
    // previewBox stays in the dependency list purely as a resize trigger: if
    // the box happens to be zero-width on first paint and the observer hasn't
    // reported yet, a live read still gets the real size on the next run.
    const boxEl = impositionPreviewBoxRef.current;
    const availW = boxEl?.clientWidth ?? 0;
    const availH = boxEl?.clientHeight ?? 0;
    if (availW <= 0 || availH <= 0) return;
    const sheet = sheets[Math.min(previewSheetIdx, sheets.length - 1)];
    if (!sheet) return;

    const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
    const scale = Math.min(availW / sheetWIn, availH / sheetHIn);
    if (!(scale > 0) || !Number.isFinite(scale)) return;
    const pw = Math.round(sheetWIn * scale), ph = Math.round(sheetHIn * scale);
    const mPx = (impositionSettings.marginMm / MM_TO_IN) * scale;
    const markOffset = cropMarks.offsetIn * scale;

    let aborted = false;

    // Lazy-load Fabric.js only when the imposition modal is actually opened.
    const run = async () => {
      const { StaticCanvas, Rect: FabricRect, FabricImage, Line } = await import('fabric');
      if (aborted) return;

      if (impositionFabricRef.current) {
        impositionFabricRef.current.dispose();
        impositionFabricRef.current = null;
      }
      const fc = new StaticCanvas(canvasEl, {
        width: pw, height: ph, backgroundColor: '#f8fafc', renderOnAddRemove: false,
      });
      impositionFabricRef.current = fc;
      fc.add(new FabricRect({
        left: mPx, top: mPx, originX: 'left', originY: 'top', width: pw - 2 * mPx, height: ph - 2 * mPx,
        fill: '#ffffff', stroke: '#e2e8f0', strokeWidth: 1,
        strokeDashArray: [4, 3], selectable: false, evented: false,
      }));
      fc.add(new FabricRect({
        left: 0, top: 0, originX: 'left', originY: 'top', width: pw, height: ph,
        fill: 'transparent', stroke: '#94a3b8', strokeWidth: 1.5,
        selectable: false, evented: false,
      }));

      const loadEl = async (dataUrl: string) => {
        const hit = previewImgCache.current.get(dataUrl);
        if (hit) return hit;
        const decoded = await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
        const el = decoded.getElement() as HTMLImageElement;
        previewImgCache.current.set(dataUrl, el);
        return el;
      };

      for (const item of sheet.items) {
        if (aborted) return;
        const [px, py, iw, ih] = [item.x * scale, item.y * scale, item.w * scale, item.h * scale];
        const c = impositionCanvases[item.canvasIdx];
        if (c?.dataUrl) {
          try {
            const el = await loadEl(c.dataUrl);
            if (aborted) return;
            const img = new FabricImage(el, { selectable: false, evented: false });
            if (item.rotated) {
              img.set({
                left: px + iw / 2, top: py + ih / 2,
                originX: 'center', originY: 'center',
                scaleX: ih / (img.width || 1), scaleY: iw / (img.height || 1),
                angle: -90,
              });
            } else {
              img.set({
                left: px, top: py, originX: 'left', originY: 'top',
                scaleX: iw / (img.width || 1), scaleY: ih / (img.height || 1),
              });
            }
            fc.add(img);
          } catch { }
        }
        // Skipped entirely when the gutter/margin leaves no room — drawing them
        // anyway put black lines across the neighbouring photo.
        // Per-side lengths: an edge facing the paper gets a usable mark, an
        // edge facing another photo stays short enough not to bleed onto it.
        const L = cropMarkLengthsFor(item, sheet.items, impositionSettings, sheetWIn, sheetHIn);
        const vLen = { '-1': L.top * scale, '1': L.bottom * scale } as Record<string, number>;
        const hLen = { '-1': L.left * scale, '1': L.right * scale } as Record<string, number>;
        for (const [cx, cy, dx, dy] of [
          [px, py, -1, -1], [px + iw, py, 1, -1],
          [px, py + ih, -1, 1], [px + iw, py + ih, 1, 1],
        ] as [number, number, number, number][]) {
          const vl = vLen[String(dy)];
          const hl = hLen[String(dx)];
          if (vl > 0) fc.add(new Line([cx, cy + dy * markOffset, cx, cy + dy * (markOffset + vl)], { stroke: '#64748b', strokeWidth: 0.5, selectable: false, evented: false }));
          if (hl > 0) fc.add(new Line([cx + dx * markOffset, cy, cx + dx * (markOffset + hl), cy], { stroke: '#64748b', strokeWidth: 0.5, selectable: false, evented: false }));
        }
      }
      // renderAll, not requestRenderAll: the whole scene is built in one pass,
      // so there is nothing to coalesce, and the rAF that requestRenderAll
      // schedules never fires while the document is hidden — a backgrounded tab
      // would show an empty preview until something forced a repaint.
      if (!aborted) fc.renderAll();
    };

    // Debounced so holding a key in the margin/gutter field doesn't tear down
    // and rebuild the whole Fabric scene on every digit.
    const timer = setTimeout(run, 100);
    return () => {
      aborted = true;
      clearTimeout(timer);
      if (impositionFabricRef.current) {
        impositionFabricRef.current.dispose();
        impositionFabricRef.current = null;
      }
    };
  }, [impositionResult, previewSheetIdx, impositionSettings, impositionCanvases, showImpositionModal, previewBox]);

  // All exports go through the server-side pipeline (Celery + Pillow at 300 DPI).
  // The previous "≤20 canvases → render in browser, JSZip" optimisation was
  // removed in v1.8 — uniform contract, predictable progress UI, and the
  // server pipeline is faster on big jobs while the small-job overhead
  // (~10–20 s of upload + poll) is acceptable.
  const executeServerRender = async () => {
    setIsDownloading(true);
    setServerRenderLabel('Preparing upload…');
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
      setServerRenderLabel('Uploading files…');
      const uploadResults = await uploadFiles(
        allFiles,
        apiBase,
        getAuthHeaders,
        (completed, total) => {
          setRenderProgress({ current: Math.round((completed / total) * 60), total: 100 });
        },
      );

      // 4. Build render payload: canvases → frames → upload_id + per-frame transforms
      setServerRenderLabel('Submitting render job…');
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

      const renderRes = await fetch(`${apiBase}/editor/render`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout_name: layoutName,
          order_id: orderId,
          canvases: canvasesPayload,
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
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
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

  const executeImposition = async () => {
    if (!impositionItems) {
      setError('This layout has no physical dimensions, so it cannot be imposed.');
      return;
    }
    setIsImposing(true);
    try {
      const dpi = 300;
      const { sheets: impositionSheets, cropMarks } = computeImpositionLayout(
        impositionSettings,
        impositionItems,
      );
      const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
      const sheetW = Math.round(sheetWIn * dpi), sheetH = Math.round(sheetHIn * dpi);

      // 1. Prepare for sheet generation
      const cropMarkOff = Math.round(cropMarks.offsetIn * dpi);
      const sheetBlobs: { name: string; blob: Blob }[] = [];
      // StaticCanvas, not Canvas: the interactive one allocates a second
      // full-size "upper canvas" it never uses (~139 MB per A4 sheet), and
      // retina scaling would silently export every sheet at 2x on a Mac.
      const { StaticCanvas, FabricImage, Line } = await import('fabric');

      // A gang run places the same design dozens of times. Render each distinct
      // canvas once at full resolution and reuse it, instead of once per slot.
      const renderedByIdx = new Map<number, string>();
      const renderOnce = async (idx: number) => {
        const hit = renderedByIdx.get(idx);
        if (hit !== undefined) return hit;
        const dataUrl = (await renderCanvas(impositionCanvases[idx], { isExport: true, includeMask: true })) || '';
        renderedByIdx.set(idx, dataUrl);
        return dataUrl;
      };

      const totalItems = impositionSheets.reduce((acc, s) => acc + s.items.length, 0);
      let done = 0;

      // 2. Process each sheet sequentially to keep memory usage low
      for (let si = 0; si < impositionSheets.length; si++) {
        const sheet = impositionSheets[si];
        const sheetEl = document.createElement('canvas');
        sheetEl.width = sheetW; sheetEl.height = sheetH;
        const fabricSheet = new StaticCanvas(sheetEl, {
          width: sheetW, height: sheetH, backgroundColor: 'white',
          renderOnAddRemove: false, enableRetinaScaling: false,
        });

        // For each item in the sheet, render the high-res canvas and place it
        for (let ii = 0; ii < sheet.items.length; ii++) {
          const item = sheet.items[ii];
          const [px, py, pw, ph] = [Math.round(item.x * dpi), Math.round(item.y * dpi), Math.round(item.w * dpi), Math.round(item.h * dpi)];

          try {
            const dataUrl = await renderOnce(item.canvasIdx);
            if (dataUrl) {
              const img = await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
              if (item.rotated) {
                img.set({ left: px + pw / 2, top: py + ph / 2, originX: 'center', originY: 'center', scaleX: ph / img.width!, scaleY: pw / img.height!, angle: -90, selectable: false, evented: false });
              } else {
                img.set({ left: px, top: py, originX: 'left', originY: 'top', scaleX: pw / img.width!, scaleY: ph / img.height!, selectable: false, evented: false });
              }
              fabricSheet.add(img);
            }
          } catch (err) {
            console.error('Failed to render imposition item:', err);
          }

          // Crop marks, clamped by resolveCropMarkGeometry so they can never
          // reach into the neighbouring photo or run off the sheet edge.
          const L = cropMarkLengthsFor(item, sheet.items, impositionSettings, sheetWIn, sheetHIn);
          const vPx = { '-1': Math.round(L.top * dpi), '1': Math.round(L.bottom * dpi) } as Record<string, number>;
          const hPx = { '-1': Math.round(L.left * dpi), '1': Math.round(L.right * dpi) } as Record<string, number>;
          for (const [cx, cy, dx, dy] of [[px, py, -1, -1], [px + pw, py, 1, -1], [px, py + ph, -1, 1], [px + pw, py + ph, 1, 1]] as [number, number, number, number][]) {
            const vl = vPx[String(dy)];
            const hl = hPx[String(dx)];
            if (vl > 0) fabricSheet.add(new Line([cx, cy + dy * cropMarkOff, cx, cy + dy * (cropMarkOff + vl)], { stroke: '#000', strokeWidth: 1, selectable: false, evented: false }));
            if (hl > 0) fabricSheet.add(new Line([cx + dx * cropMarkOff, cy, cx + dx * (cropMarkOff + hl), cy], { stroke: '#000', strokeWidth: 1, selectable: false, evented: false }));
          }

          done++;
          setRenderProgress({ current: done, total: totalItems });
          await new Promise(r => setTimeout(r, 0));
        }

        fabricSheet.renderAll();
        const blob = await new Promise<Blob>(res => sheetEl.toBlob(b => res(b!), 'image/png'));
        sheetBlobs.push({ name: `imposition-sheet-${si + 1}.png`, blob });
        fabricSheet.dispose();
      }

      if (sheetBlobs.length === 0) {
        setError('Nothing could be placed on the sheet — try a larger sheet size or smaller margins.');
        return;
      }
      if (sheetBlobs.length === 1) downloadBlob(sheetBlobs[0].blob, sheetBlobs[0].name);
      else {
        downloadBlob(await createZipFromDataUrls(sheetBlobs), 'imposition-sheets.zip');
      }
    } catch (err) {
      console.error('Imposition failed:', err);
      setError('Imposition failed.');
    } finally {
      setIsImposing(false);
      setShowImpositionModal(false);
      setRenderProgress(null);
    }
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

  const handleCalendarCellClick = (surfaceIndex: number, year: number, month: number, iso: string) => {
    setSelectedCalendarCell({ surfaceIndex, year, month, iso });
  };

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

  const totalUploadedCount = files.length > 0 ? files.length : surfaceStates.reduce((acc, s) => acc + s.files.length, 0);

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
      {qtyUnder && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200002] w-full max-w-md bg-white/95 backdrop-blur-2xl border border-indigo-200/60 rounded-2xl shadow-2xl shadow-indigo-900/10 p-4 animate-in fade-in slide-in-from-top-4 duration-400">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0 text-[15px] font-black">↑</div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-black text-slate-900 uppercase tracking-tight">
                {qtyUnder.uploaded} of {qtyUnder.needed} images uploaded
              </p>
              <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                {qtyUnder.needed - qtyUnder.uploaded} more needed to match your order quantity. You can upload more, or fill the remaining slots from your existing images.
              </p>
            </div>
            <button onClick={() => setQtyUnder(null)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-all shrink-0">
              <X className="w-3.5 h-3.5 text-slate-400" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAutoFill}
              className="flex-1 py-2 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
            >
              Auto-fill {qtyUnder.needed - qtyUnder.uploaded} remaining
            </button>
            <button
              onClick={() => { setShowAutoFillPicker(true); setPickerSelected(new Set()); }}
              className="flex-1 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
            >
              Choose which to repeat
            </button>
          </div>
        </div>
      )}

      {/* ── Auto-fill picker modal ──────────────────────────────────────────── */}
      {showAutoFillPicker && qtyUnder && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-5 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[12px] font-black text-slate-900 uppercase tracking-tight">Choose images to repeat</p>
              <button onClick={() => setShowAutoFillPicker(false)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-all">
                <X className="w-3.5 h-3.5 text-slate-400" />
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mb-3">
              Select {qtyUnder.needed - qtyUnder.uploaded} image{qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''} to duplicate into the remaining slots.
            </p>
            <div className="grid grid-cols-3 gap-2 mb-4 max-h-56 overflow-y-auto custom-scrollbar">
              {files.map((f, i) => {
                // Use the helper so the URL is tracked for cleanup; the bare
                // URL.createObjectURL fallback used to leak in the qty-picker.
                const url = getFileUrl(f);
                const isSelected = pickerSelected.has(i);
                return (
                  <button
                    key={i}
                    onClick={() => setPickerSelected(prev => {
                      const next = new Set(prev);
                      isSelected ? next.delete(i) : next.add(i);
                      return next;
                    })}
                    className={clsx('relative aspect-square rounded-xl overflow-hidden border-2 transition-all active:scale-95', isSelected ? 'border-indigo-500 shadow-md shadow-indigo-200' : 'border-slate-200 hover:border-indigo-300')}
                  >
                    <img src={url} alt={f.name} className="w-full h-full object-cover" />
                    {isSelected && (
                      <div className="absolute inset-0 bg-indigo-500/20 flex items-center justify-center">
                        <div className="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px] font-black">\u2713</div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleFillWithPicked}
              disabled={pickerSelected.size === 0}
              className="w-full py-2.5 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Use selected to fill {qtyUnder.needed - qtyUnder.uploaded} slot{qtyUnder.needed - qtyUnder.uploaded !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      )}

      {/* ── Delete confirm modal ─────────────────────────────────────────────── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-7 animate-in zoom-in-95 duration-200">
            <p className="text-sm font-black text-slate-900 uppercase tracking-tight mb-2">Remove image?</p>
            <p className="text-xs text-slate-500 leading-relaxed mb-6">This image will be removed from the canvas. This cannot be undone.</p>
            <div className="flex items-center gap-3">
              <button
                onClick={confirmDelete}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-red-500 text-white rounded-xl hover:bg-red-600 transition-all active:scale-95"
              >
                Remove
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Re-pick confirm modal (Phase 3 — ask before discarding edits) ──── */}
      {pendingRepick && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-7 animate-in zoom-in-95 duration-200" role="alertdialog" aria-modal="true" aria-label="Replacing photos will discard edits">
            <p className="text-sm font-black text-slate-900 uppercase tracking-tight mb-2">Replace photos?</p>
            <p className="text-xs text-slate-500 leading-relaxed mb-6">
              {pendingRepick.losingCount === 1
                ? 'One page you edited uses photos that are not in the new selection — its adjustments will be discarded.'
                : `${pendingRepick.losingCount} pages you edited use photos that are not in the new selection — their adjustments will be discarded.`}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => handleRepickConfirm(true)}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
              >
                Replace anyway
              </button>
              <button
                onClick={() => handleRepickConfirm(false)}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
              >
                Keep my edits
              </button>
            </div>
          </div>
        </div>
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

      {/* ── Over-upload confirm modal ───────────────────────────────────────── */}
      {pendingOverFiles && orderQty && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-5 animate-in zoom-in-95 duration-200">
            <p className="text-[12px] font-black text-slate-900 uppercase tracking-tight mb-1">More images than ordered</p>
            <p className="text-[10px] text-slate-500 leading-snug mb-4">
              You uploaded <span className="font-black text-slate-800">{pendingOverFiles.length} images</span> but your order quantity is <span className="font-black text-slate-800">{orderQty}</span>. Do you want to proceed with all {pendingOverFiles.length}, or go back and remove some?
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleOverConfirm(true)}
                className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
              >
                Proceed with all {pendingOverFiles.length}
              </button>
              <button
                onClick={() => handleOverConfirm(false)}
                className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
              >
                Go back
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingTruncated && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-5 animate-in zoom-in-95 duration-200">
            <p className="text-[12px] font-black text-slate-900 uppercase tracking-tight mb-1">
              {pendingTruncated.bad.length === 1 ? 'Incomplete image detected' : `${pendingTruncated.bad.length} incomplete images detected`}
            </p>
            <p className="text-[10px] text-slate-500 leading-snug mb-3">
              {pendingTruncated.bad.length === 1 ? 'This file looks cut off (often from an interrupted download or transfer) and may print with a missing or grey edge:' : 'These files look cut off (often from an interrupted download or transfer) and may print with a missing or grey edge:'}
            </p>
            <ul className="text-[10px] text-slate-700 font-semibold max-h-24 overflow-y-auto mb-4 space-y-0.5">
              {pendingTruncated.bad.map((f, i) => <li key={i} className="truncate">• {f.name}</li>)}
            </ul>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleTruncatedDecision('remove')}
                className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
              >
                Remove {pendingTruncated.bad.length > 1 ? 'them' : 'it'}
              </button>
              <button
                onClick={() => handleTruncatedDecision('keep')}
                className="flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
              >
                Keep anyway
              </button>
            </div>
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

      <main className="w-full px-4 md:px-8 pt-0 pb-6 md:pb-8 flex-1 overflow-x-hidden">
        <div className="max-w-[1440px] mx-auto space-y-6 md:space-y-8">
          {/* Wrapper keeps the sentinel from becoming a real space-y sibling of the
              sticky toolbar below (which would add an unwanted margin-top to it and
              throw off the very offset this is trying to fix). The sentinel marks the
              toolbar's natural resting spot — see the IntersectionObserver above for
              why `top` only activates once this scrolls near the header. */}
          <div className="relative">
            <div ref={toolbarSentinelRef} className="absolute top-0 inset-x-0 h-px" aria-hidden />
            <div
              style={{ top: isToolbarStuck ? headerHeight : 0 }}
              className="sticky z-40 -mx-4 md:-mx-8 px-4 md:px-8 py-3 bg-white/60 backdrop-blur-3xl border-b border-slate-200/50 flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4 shadow-sm"
            >
            {/* Heading + Add Files share one row on mobile so the upload box doesn't
                push the toolbar down a whole extra row; `md:contents` removes this
                wrapper from the desktop layout so heading/box/toolbar go back to
                being three independent flex-row siblings, unchanged from before. */}
            <div className="flex items-center justify-between gap-3 md:contents">
            <div className="flex flex-col min-w-0 flex-1 md:flex-none">
              <h1 className="text-base font-black text-slate-900 uppercase tracking-tighter truncate">
                {layout?.name || layoutName}
              </h1>
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-tight truncate">
                  {layout?.dimensions ? `${layout.dimensions} | ` : ''}
                  {(files.length > 0 || surfaceStates.some(s => s.files.length > 0)) ? 'Generated Canvases' : 'Upload File'}
                </p>
                {/* Auto-save status indicator */}
                {isSaving === 'saving' && (
                  <span className="flex items-center gap-1 text-[9px] font-bold text-slate-400 uppercase tracking-widest shrink-0">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" /> Saving…
                  </span>
                )}
                {isSaving === 'saved' && (
                  <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 uppercase tracking-widest shrink-0">
                    <CheckCircle2 className="w-2.5 h-2.5" /> Saved
                  </span>
                )}
                {orderId && (
                  <span className="text-[9px] font-mono text-slate-300 shrink-0 hidden sm:inline">
                    {orderId}
                  </span>
                )}
              </div>
            </div>
            <div className="shrink-0 max-w-[55%] md:w-full md:max-w-md md:flex-1 md:shrink relative group">
              <div className={clsx("relative flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 rounded-2xl border-2 border-dashed transition-all", (files.length > 0 || surfaceStates.some(s => s.files.length > 0)) ? 'border-emerald-200 bg-emerald-50/30' : 'border-indigo-200 bg-indigo-50/30 hover:border-indigo-400')}>
                <input ref={uploadInputRef} type="file" multiple onChange={handleFileChange} accept={IMAGE_AND_PDF_ACCEPT_ATTR} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className={clsx("w-7 h-7 md:w-8 md:h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm", totalUploadedCount > 0 ? 'bg-emerald-500 text-white' : 'bg-indigo-600 text-white')}>
                  <Plus className="w-3.5 h-3.5 md:w-4 md:h-4" />
                </div>
                <p className="flex-1 min-w-0 truncate text-[10px] md:text-[11px] font-black text-slate-800/70 uppercase tracking-tight">
                  <span className="md:hidden">
                    {totalUploadedCount > 0 ? `Add Files (${totalUploadedCount})` : 'Add Files'}
                  </span>
                  <span className="hidden md:inline">
                    {totalUploadedCount > 0
                      ? `Add Photos | Currently uploaded (${totalUploadedCount})`
                      : surfaceStates.length > 1
                        ? `Add Files | Multi-Surface: Add ${surfaceStates.length} photos`
                        : 'Add Files'}
                  </span>
                </p>
              </div>
            </div>
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
                      {isDownloading ? 'Preparing Download' : 'Processing Your Design'}
                    </span>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      {isDownloading ? 'Bundling high-res print files' : 'Optimizing images for print'}
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
                  Drag and drop your photos here, or use the upload bar above
                </p>
              </div>
            </div>
          )}

          {canvases.length > 0 && (
            <section className="space-y-6 pt-0">
              {surfaceStates.length > 1 ? (
                <div className="flex gap-6 items-start justify-center overflow-x-auto pb-4 px-4 w-full custom-scrollbar">
                  {surfaceStates.map((surface, sIdx) => {
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
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardClick(0, surface.key); } }}
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
                              <button onClick={(e) => { e.stopPropagation(); handleQuickToggleFit(0, surface.key); }} className="p-2 bg-emerald-50/80 text-emerald-600 rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all" title="Toggle Fit/Cover">
                                <Maximize className="w-3.5 h-3.5" />
                              </button>
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
                              <button
                                onClick={(e) => { e.stopPropagation(); handleQuickToggleBlur(0, surface.key); }}
                                className={clsx('p-2 rounded-xl hover:scale-105 transition-all',
                                  surfaceCanvas?.frames.some(f => f.fillStyle === 'blur')
                                    ? 'bg-indigo-600 text-white'
                                    : 'bg-cyan-50/80 text-cyan-600 hover:bg-cyan-100')}
                                title={surfaceCanvas?.frames.some(f => f.fillStyle === 'blur')
                                  ? 'Blur Effect is ON — empty space is filled with a blurred copy of the photo. Tap to turn off.'
                                  : 'Blur Effect — fill the empty space around the photo with a blurred copy of it.'}
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
                                className={clsx('p-2 rounded-xl hover:scale-105 transition-all',
                                  swapSource?.idx === 0 && swapSource?.surfaceKey === surface.key
                                    ? 'bg-indigo-600 text-white'
                                    : 'bg-violet-50/80 text-violet-600 hover:bg-violet-100')}
                                title="Swap with another photo (tap this, then tap the other card)"
                              >
                                <ArrowLeftRight className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); handleQuickDownload(0, surface.key); }} className="p-2 bg-slate-100/80 text-slate-700 rounded-xl hover:bg-slate-200 hover:scale-105 transition-all" title="Download">
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); handleQuickDelete(0, surface.key); }} className="p-2 bg-rose-50/80 text-rose-600 rounded-xl hover:bg-rose-100 hover:scale-105 transition-all" title="Delete">
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
                    <div
                      key={idx}
                      className={clsx(
                        // Mobile: one card per row, capped so ~1.5 cards show per
                        // viewport (portrait prints) — a full-width 2-col card was
                        // too short and clipped the quick-action rail.
                        "bg-white rounded-2xl border-2 transition-all cursor-pointer group/card relative w-[86vw] max-w-sm sm:w-auto sm:max-w-none",
                        dragOverIdx?.idx === idx && dragOverIdx?.surfaceKey === null
                          ? "border-indigo-500 bg-indigo-50/50 scale-[1.02] shadow-xl shadow-indigo-100"
                          : "border-slate-200 hover:border-indigo-400"
                      )}
                      onClick={() => handleCardClick(idx)}
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit canvas ${idx + 1}`}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardClick(idx); } }}
                      draggable={!repositionMode}
                      onDragStart={(e) => handleDragStart(e, idx)}
                      onDragOver={(e) => handleDragOver(e, idx)}
                      onDragLeave={() => setDragOverIdx(null)}
                      onDrop={(e) => handleDrop(e, idx)}
                    >
                      <div
                        className={clsx(
                          'relative rounded-t-2xl overflow-hidden bg-slate-100',
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
                          <button onClick={(e) => { e.stopPropagation(); handleQuickToggleFit(idx); }} className="p-2 bg-emerald-50/80 text-emerald-600 rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all" title="Toggle Fit/Cover">
                            <Maximize className="w-3.5 h-3.5" />
                          </button>
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
                          {(layout.frames?.length || 1) === 1 && (
                            <button onClick={(e) => { e.stopPropagation(); requestReplacePhoto(idx, 0); }} className="p-2 bg-sky-50/80 text-sky-600 rounded-xl hover:bg-sky-100 hover:scale-105 transition-all" title="Replace photo">
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
                              ? 'Blur Effect is ON — empty space is filled with a blurred copy of the photo. Tap to turn off.'
                              : 'Blur Effect — fill the empty space around the photo with a blurred copy of it.'}
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
                            className={clsx('p-2 rounded-xl hover:scale-105 transition-all',
                              swapSource?.idx === idx && swapSource?.surfaceKey === null
                                ? 'bg-indigo-600 text-white'
                                : 'bg-violet-50/80 text-violet-600 hover:bg-violet-100')}
                            title="Swap with another photo (tap this, then tap the other card)"
                          >
                            <ArrowLeftRight className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleQuickDownload(idx); }} className="p-2 bg-slate-100/80 text-slate-700 rounded-xl hover:bg-slate-200 hover:scale-105 transition-all" title="Download">
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleQuickDelete(idx); }} className="p-2 bg-rose-50/80 text-rose-600 rounded-xl hover:bg-rose-100 hover:scale-105 transition-all" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="px-3 py-2">
                        <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight truncate group-hover:text-indigo-600 transition-colors">
                          Canvas {idx + 1}
                        </h3>
                        {layout.dimensions && (
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide mt-0.5 flex items-center gap-1.5 truncate">
                            <span>{layout.dimensions}</span>
                            <span>•</span>
                            <span>{layout.frames?.length || 0} Frames</span>
                          </p>
                        )}
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
                holidays={calendarHolidays}
                weekStart={layout?.weekStart as any || 'sunday'}
              />
              {selectedCalendarCell && (
                <div className="fixed inset-y-0 right-0 z-[50000] flex">
                  <CalendarEditPanel
                    iso={selectedCalendarCell.iso}
                    cellEntries={calendarCellEntries(selectedCalendarCell.iso)}
                    holidaysForCell={calendarHolidays.filter(h => h.date === selectedCalendarCell.iso)}
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
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
              <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" onClick={() => setShowDownloadModal(false)} />
              <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-[0_32px_80px_-12px_rgba(0,0,0,0.25)] overflow-hidden animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="px-7 pt-7 pb-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2.5 mb-1.5">
                        <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center">
                          <Download className="w-4 h-4 text-indigo-600" />
                        </div>
                        <h3 className="text-base font-bold text-slate-900 tracking-tight">Ready to Download?</h3>
                      </div>
                      <p className="text-sm text-slate-500 leading-relaxed">Please review and confirm before generating your print-ready files.</p>
                    </div>
                    <button onClick={() => setShowDownloadModal(false)} className="mt-0.5 p-1.5 hover:bg-slate-100 rounded-xl transition-colors shrink-0">
                      <X className="w-4 h-4 text-slate-400" />
                    </button>
                  </div>
                </div>

                {/* Divider */}
                <div className="mx-7 border-t border-slate-100" />

                {/* Confirmation checkbox */}
                <div className="px-7 py-5">
                  <label className="flex items-start gap-3.5 cursor-pointer group">
                    <div className="relative mt-0.5 shrink-0">
                      <input
                        type="checkbox"
                        checked={disclaimerChecked}
                        onChange={(e) => setDisclaimerChecked(e.target.checked)}
                        className="peer w-4.5 h-4.5 rounded-md accent-indigo-600 cursor-pointer"
                      />
                    </div>
                    <span className="text-sm text-slate-600 leading-relaxed group-hover:text-slate-800 transition-colors">
                      I have previewed my design, all images are correctly placed in their frames, and I&apos;m ready to generate the final print-ready files.
                    </span>
                  </label>
                </div>

                {/* Optional — include the customer's original uploaded photos.
                    Off by default: keeps the ZIP small and the download fast. */}
                <div className="px-7 pb-5">
                  <label className="flex items-start gap-3.5 cursor-pointer group">
                    <div className="relative mt-0.5 shrink-0">
                      <input
                        type="checkbox"
                        checked={includeUploads}
                        onChange={(e) => { setIncludeUploads(e.target.checked); includeUploadsRef.current = e.target.checked; }}
                        className="peer w-4.5 h-4.5 rounded-md accent-indigo-600 cursor-pointer"
                      />
                    </div>
                    <span className="text-sm text-slate-600 leading-relaxed group-hover:text-slate-800 transition-colors">
                      Also include the customer&apos;s original uploaded photos in the ZIP. Off by default — leaving it off makes the download much smaller and faster; turn it on only when you need the source files.
                    </span>
                  </label>
                </div>

                <LowDpiWarning frames={lowDpiFrames} />
                <EmptySurfaceWarning surfaces={emptySurfaces} />
                <DuplicateFillWarning duplicates={duplicateFills} />

                {/* Download options */}
                <div className="px-7 pb-7 flex gap-3">
                  <button
                    onClick={executeBatchDownload}
                    disabled={!disclaimerChecked}
                    className="flex-1 group flex flex-col items-center gap-3 p-5 rounded-2xl border-2 transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed border-slate-100 bg-slate-50/50 enabled:hover:border-indigo-300 enabled:hover:bg-indigo-50 enabled:hover:shadow-md enabled:hover:shadow-indigo-100/60"
                  >
                    <div className="w-11 h-11 rounded-xl bg-white border border-slate-200 flex items-center justify-center shadow-sm group-enabled:group-hover:border-indigo-200 group-enabled:group-hover:shadow-indigo-100 transition-all">
                      <Archive className="w-5 h-5 text-indigo-600" />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-bold text-slate-800 tracking-tight">ZIP Archive</div>
                      <div className="text-xs text-slate-400 mt-0.5">All files packed</div>
                    </div>
                  </button>
                  <button
                    onClick={() => { setShowDownloadModal(false); setShowImpositionModal(true); }}
                    disabled={!disclaimerChecked}
                    className="flex-1 group flex flex-col items-center gap-3 p-5 rounded-2xl border-2 transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed border-slate-100 bg-slate-50/50 enabled:hover:border-emerald-300 enabled:hover:bg-emerald-50 enabled:hover:shadow-md enabled:hover:shadow-emerald-100/60"
                  >
                    <div className="w-11 h-11 rounded-xl bg-white border border-slate-200 flex items-center justify-center shadow-sm group-enabled:group-hover:border-emerald-200 group-enabled:group-hover:shadow-emerald-100 transition-all">
                      <FileText className="w-5 h-5 text-emerald-600" />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-bold text-slate-800 tracking-tight">Imposition</div>
                      <div className="text-xs text-slate-400 mt-0.5">Print sheet layout</div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Embed: disclaimer-only modal before Save & Continue */}
          {showEmbedDisclaimer && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
              <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" onClick={() => setShowEmbedDisclaimer(false)} />
              <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-[0_32px_80px_-12px_rgba(0,0,0,0.25)] overflow-hidden animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="px-7 pt-7 pb-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2.5 mb-1.5">
                        <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center">
                          <SendHorizonal className="w-4 h-4 text-indigo-600" />
                        </div>
                        <h3 className="text-base font-bold text-slate-900 tracking-tight">Ready to Submit?</h3>
                      </div>
                      <p className="text-sm text-slate-500 leading-relaxed">Please confirm before sending your design for production.</p>
                    </div>
                    <button onClick={() => setShowEmbedDisclaimer(false)} className="mt-0.5 p-1.5 hover:bg-slate-100 rounded-xl transition-colors shrink-0">
                      <X className="w-4 h-4 text-slate-400" />
                    </button>
                  </div>
                </div>
                <div className="mx-7 border-t border-slate-100" />
                {/* Confirmation checkbox */}
                <div className="px-7 py-5">
                  <label className="flex items-start gap-3.5 cursor-pointer group">
                    <div className="relative mt-0.5 shrink-0">
                      <input
                        type="checkbox"
                        checked={disclaimerChecked}
                        onChange={(e) => setDisclaimerChecked(e.target.checked)}
                        className="peer w-4.5 h-4.5 rounded-md accent-indigo-600 cursor-pointer"
                      />
                    </div>
                    <span className="text-sm text-slate-600 leading-relaxed group-hover:text-slate-800 transition-colors">
                      I have previewed my design, all images are correctly placed in their frames, and I&apos;m ready to send for production.
                    </span>
                  </label>
                </div>
                <LowDpiWarning frames={lowDpiFrames} />
                <EmptySurfaceWarning surfaces={emptySurfaces} />
                <DuplicateFillWarning duplicates={duplicateFills} />
                {/* Actions */}
                <div className="px-7 pb-7 flex gap-3">
                  <button
                    onClick={() => setShowEmbedDisclaimer(false)}
                    className="flex-1 text-sm font-semibold px-5 py-3 rounded-2xl border-2 border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all"
                  >
                    Go Back
                  </button>
                  <button
                    onClick={() => { setShowEmbedDisclaimer(false); handleSubmitDesign(); }}
                    disabled={!disclaimerChecked}
                    className="flex-1 text-sm font-semibold px-5 py-3 rounded-2xl bg-indigo-600 text-white hover:bg-indigo-700 transition-all disabled:opacity-35 disabled:cursor-not-allowed shadow-md shadow-indigo-200 enabled:hover:shadow-indigo-300"
                  >
                    Yes, Proceed
                  </button>
                </div>
              </div>
            </div>
          )}

          {showImpositionModal && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setShowImpositionModal(false)} />
              <div className="relative w-full max-w-3xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row max-h-[85vh] border border-slate-200">
                {/* Left: Preview */}
                <div className="flex-[1.1] bg-slate-50 p-6 pt-16 flex flex-col items-center relative border-r border-slate-200">
                  <div className="absolute top-5 left-6">
                    <h3 className="text-sm font-semibold text-slate-900">Sheet preview</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {sheetCount === 0
                        ? 'Nothing fits on this sheet'
                        : `Sheet ${Math.min(previewSheetIdx + 1, sheetCount)} of ${sheetCount}`}
                    </p>
                  </div>

                  {/* The canvas is sized from this box, measured at runtime. It
                      is positioned ABSOLUTELY so it never contributes to the
                      box's own size — otherwise resizing the canvas resizes the
                      box that determines the canvas size, and the two oscillate
                      forever without the scene ever finishing a render. */}
                  <div ref={impositionPreviewBoxRef} className="relative flex-1 w-full min-h-[220px] overflow-hidden">
                    {sheetCount === 0 ? (
                      <p className="absolute inset-0 flex items-center justify-center text-xs text-slate-400 text-center px-4">
                        {impositionResult.noUsableArea
                          ? 'The margin leaves no printable area on this sheet.'
                          : 'No canvas fits inside this sheet size.'}
                      </p>
                    ) : (
                      <canvas
                        ref={impositionPreviewRef}
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded shadow-sm border border-slate-200 bg-white"
                      />
                    )}
                  </div>

                  {sheetCount > 1 && (
                    <div className="mt-4 flex items-center gap-1 bg-white border border-slate-200 rounded-full p-1 shadow-sm">
                      <button
                        aria-label="Previous sheet"
                        disabled={previewSheetIdx === 0}
                        onClick={() => setPreviewSheetIdx(p => Math.max(0, p - 1))}
                        className="p-1.5 text-slate-500 hover:text-indigo-600 disabled:opacity-30 transition rounded-full hover:bg-slate-50"
                      >
                        <ChevronRight className="w-4 h-4 rotate-180" />
                      </button>
                      <span className="text-xs font-medium text-slate-700 min-w-[70px] text-center">
                        {previewSheetIdx + 1} / {sheetCount}
                      </span>
                      <button
                        aria-label="Next sheet"
                        disabled={previewSheetIdx >= sheetCount - 1}
                        onClick={() => setPreviewSheetIdx(p => Math.min(sheetCount - 1, p + 1))}
                        className="p-1.5 text-slate-500 hover:text-indigo-600 disabled:opacity-30 transition rounded-full hover:bg-slate-50"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Right: Controls */}
                <div className="flex-1 p-6 flex flex-col gap-5 bg-white overflow-y-auto custom-scrollbar">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center">
                        <FileText className="w-4 h-4" />
                      </div>
                      <h3 className="text-base font-semibold text-slate-900">Print settings</h3>
                    </div>
                    <button onClick={() => setShowImpositionModal(false)} className="p-1.5 hover:bg-slate-100 rounded-md transition-colors">
                      <X className="w-4 h-4 text-slate-500" />
                    </button>
                  </div>

                  <div className="space-y-5">
                    {/* Presets */}
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-slate-500">Sheet size</label>
                      <div className="grid grid-cols-3 gap-1.5">
                        {(['a4', 'a3', '12x18', '13x19', 'custom'] as const).map(p => (
                          <button
                            key={p}
                            onClick={() => setImpositionSettings(s => ({ ...s, preset: p }))}
                            className={clsx(
                              'py-2 text-xs font-semibold rounded-md border transition uppercase',
                              impositionSettings.preset === p
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50',
                            )}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Custom W × H — only when preset === 'custom' */}
                    {impositionSettings.preset === 'custom' && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-slate-500">Width</label>
                          <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-md border border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition">
                            <input
                              type="number"
                              step="0.1"
                              min="1"
                              value={impositionSettings.widthIn}
                              onChange={e => setImpositionSettings(s => ({ ...s, widthIn: Math.max(1, Number(e.target.value) || 0) }))}
                              className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full"
                            />
                            <span className="text-xs text-slate-400">in</span>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-slate-500">Height</label>
                          <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-md border border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition">
                            <input
                              type="number"
                              step="0.1"
                              min="1"
                              value={impositionSettings.heightIn}
                              onChange={e => setImpositionSettings(s => ({ ...s, heightIn: Math.max(1, Number(e.target.value) || 0) }))}
                              className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full"
                            />
                            <span className="text-xs text-slate-400">in</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Orientation */}
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-slate-500">Orientation</label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {(['portrait', 'landscape'] as const).map(o => (
                          <button
                            key={o}
                            onClick={() => setImpositionSettings(s => ({ ...s, orientation: o }))}
                            className={clsx(
                              'py-2 text-xs font-semibold rounded-md border transition capitalize',
                              impositionSettings.orientation === o
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50',
                            )}
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Gutter & Margin */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-slate-500">Gutter (gap)</label>
                        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-md border border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition">
                          <input
                            type="number"
                            value={impositionSettings.gutterMm}
                            onChange={e => setImpositionSettings(s => ({ ...s, gutterMm: Number(e.target.value) }))}
                            className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full"
                          />
                          <span className="text-xs text-slate-400">mm</span>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-slate-500">Margin</label>
                        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-md border border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition">
                          <input
                            type="number"
                            value={impositionSettings.marginMm}
                            onChange={e => setImpositionSettings(s => ({ ...s, marginMm: Number(e.target.value) }))}
                            className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full"
                          />
                          <span className="text-xs text-slate-400">mm</span>
                        </div>
                      </div>
                    </div>

                    {/* Crop marks — on/off plus a requested length. The length is
                        a MAXIMUM: resolveCropMarkGeometry clamps it to the room
                        the gutter and margin actually leave, so a mark can never
                        print over the neighbouring photo. */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={impositionSettings.cropMarksEnabled}
                            onChange={e => setImpositionSettings(s => ({ ...s, cropMarksEnabled: e.target.checked }))}
                            className="w-4 h-4 rounded accent-indigo-600 cursor-pointer"
                          />
                          <span className="text-xs font-medium text-slate-500">Crop marks</span>
                        </label>
                        <div className={clsx(
                          'flex items-center gap-2 px-3 py-1.5 rounded-md border transition w-28',
                          impositionSettings.cropMarksEnabled
                            ? 'bg-slate-50 border-slate-200 focus-within:border-indigo-400 focus-within:bg-white'
                            : 'bg-slate-50/50 border-slate-100 opacity-50',
                        )}>
                          <input
                            type="number"
                            min={CROP_MARK_LEN_MIN_MM}
                            max={CROP_MARK_LEN_MAX_MM}
                            disabled={!impositionSettings.cropMarksEnabled}
                            value={impositionSettings.cropMarkLenMm}
                            onChange={e => setImpositionSettings(s => ({
                              ...s,
                              cropMarkLenMm: Math.min(
                                CROP_MARK_LEN_MAX_MM,
                                Math.max(CROP_MARK_LEN_MIN_MM, Number(e.target.value) || 0),
                              ),
                            }))}
                            aria-label="Crop mark length"
                            className="bg-transparent text-sm font-medium text-slate-900 outline-none w-full disabled:cursor-not-allowed"
                          />
                          <span className="text-xs text-slate-400">mm</span>
                        </div>
                      </div>
                      {impositionSettings.cropMarksEnabled && impositionResult.cropMarks.shortened && impositionResult.cropMarks.maxLenIn > 0 && (
                        <p className="text-xs text-slate-500 leading-relaxed">
                          {impositionResult.cropMarks.minLenIn < impositionResult.cropMarks.maxLenIn - 1e-9
                            ? `Marks are ${(impositionResult.cropMarks.minLenIn * MM_TO_IN).toFixed(1)}–${(impositionResult.cropMarks.maxLenIn * MM_TO_IN).toFixed(1)} mm — the shorter ones sit where the gutter or margin is tight, so they stay clear of the artwork.`
                            : `Shortened to ${(impositionResult.cropMarks.maxLenIn * MM_TO_IN).toFixed(1)} mm so they stay clear of the artwork. Widen the gutter and margin for full-length marks.`}
                        </p>
                      )}
                    </div>

                    {/* What this will actually produce */}
                    <div className="px-4 py-3 bg-indigo-50 rounded-md border border-indigo-100 flex items-start gap-2.5">
                      <div className="w-4 h-4 mt-0.5 bg-indigo-600 text-white rounded-full flex items-center justify-center text-[10px] flex-shrink-0">
                        ✓
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-indigo-900">
                          {impositionResult.mode === 'gang' ? 'Auto-repeat' : 'Batch layout'}
                        </p>
                        <p className="text-xs text-indigo-700/80 mt-0.5 leading-relaxed">
                          {impositionResult.mode === 'gang'
                            ? `Your design is repeated ${impositionPlacedTotal}× to fill one ${impositionSheetLabel} sheet.`
                            : `${impositionPlacedTotal} ${impositionPlacedTotal === 1 ? 'canvas' : 'canvases'} laid out across ${sheetCount} ${sheetCount === 1 ? 'sheet' : 'sheets'} of ${impositionSheetLabel}, one copy each.`}
                        </p>
                      </div>
                    </div>

                    {/* Nothing may leave the sheet without the operator knowing. */}
                    {impositionResult.unplacedCount > 0 && (
                      <div className="px-4 py-3 bg-amber-50 rounded-md border border-amber-200 flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-amber-900">
                            {impositionResult.unplacedCount} {impositionResult.unplacedCount === 1 ? 'canvas' : 'canvases'} will not be printed
                          </p>
                          <p className="text-xs text-amber-800/80 mt-0.5 leading-relaxed">
                            Too large for a {impositionSheetLabel} sheet at this margin. Pick a bigger sheet size or reduce the margin.
                          </p>
                        </div>
                      </div>
                    )}

                    {impositionResult.cropMarks.maxLenIn === 0 && !impositionResult.cropMarks.disabled && (
                      <div className="px-4 py-3 bg-slate-50 rounded-md border border-slate-200 flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 mt-0.5 text-slate-500 flex-shrink-0" />
                        <p className="text-xs text-slate-600 leading-relaxed min-w-0">
                          No room for crop marks — they would print over the artwork. Increase the gutter past 4&nbsp;mm and the margin past 2&nbsp;mm to get them back.
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="mt-auto pt-5 border-t border-slate-100">
                    <button
                      onClick={executeImposition}
                      disabled={isImposing || sheetCount === 0}
                      className="w-full py-2.5 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
                    >
                      {isImposing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      {sheetCount > 1 ? `Download ${sheetCount} print sheets` : 'Download print sheet'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
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
        />
      )}
      {pdfPickerElement}
    </div>
  );
}
