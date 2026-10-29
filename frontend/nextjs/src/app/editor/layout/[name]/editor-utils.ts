import type { CSSProperties } from 'react';
import type { OrientationOutcome } from '@/lib/ml-orientation';
import type { HolidayEntry } from '@/types/calendar';
import type { Overlay } from './types';

// ─── Fabric-based imposition / export ─────────────────────────────────────

/** Bounded fallback for measuring the imposition preview box when a
 *  ResizeObserver can't report (a hidden document runs no rendering steps). */
export const MEASURE_RETRY_MS = 100;
export const MEASURE_RETRY_LIMIT = 50;

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
export function shouldAutoRotate90(
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
 *     frame meaningfully better? If yes → rotate a quarter turn. This is
 *     the FILL case: a landscape photo into a portrait classic frame, etc.
 *     Either quarter turn fills the frame equally, so when the pose model
 *     found which way is up and that is a quarter turn (90 or 270), it
 *     picks the direction; otherwise it is 90. A fixed 90 used to stand
 *     people stored sideways with their heads to the right on their heads.
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
 * `fillByRotating: false` skips step 1, so the photo is treated as if the
 * frame were near-square: calendars pass it (2026-10-17), because an upright
 * portrait of people laid on its side to fill a landscape month photo reads
 * as a mistake on a wall calendar. Fit + Blur Effect fill the sides instead.
 *
 * The customer can always override with the per-canvas manual rotate.
 */
export function resolveRotation(
  outcome: OrientationOutcome,
  imgW: number, imgH: number, frameW: number, frameH: number,
  { fillByRotating = true }: { fillByRotating?: boolean } = {},
): number {
  // 1. FILL priority — rotate to best fill a clearly portrait/landscape frame,
  //    in the direction the pose model says is upright when it knows.
  if (fillByRotating && shouldAutoRotate90(imgW, imgH, frameW, frameH)) {
    if (typeof outcome === 'object' && (outcome.rotation === 90 || outcome.rotation === 270)) return outcome.rotation;
    return 90;
  }
  // 2. Aspect-neutral / near-square frame — let the ML correct genuine
  //    sideways content (Retro polaroid case).
  if (typeof outcome === 'object') return outcome.rotation;
  // 3. ML off / declined → as-is.
  return 0;
}

/** "~30 s" / "~2 min" for the honest render-wait label (Phase 3). */
export function formatWait(seconds: number): string {
  if (seconds < 90) return `~${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `~${Math.round(seconds / 60)} min`;
}

/**
 * Fallback product name for a layout with no ops-set `displayName`:
 * de-underscores and title-cases the identifier, so a slug like
 * "retro_polaroid_-_4.2x3.5_in" reads "Retro Polaroid - 4.2x3.5 In".
 * Display only — the identifier itself is never changed. Must match the
 * backend's `default_display_name_for` (api/models.py); both sides' tests
 * share the same cases.
 */
export function formatLayoutDisplayName(rawName: string): string {
  return rawName
    .replace(/_+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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
export const MAX_SKELETON_CARDS = 24;

/** How many cards still count as "a few": they get a comfortable size of their
 *  own (`canvasCardStyle`); more than this and the cards share the row. */
export const FEW_CARDS = 3;

/** Root classes of a card in the canvas row (`CanvasCard`, `CalendarRepeatCard`).
 *  The row is a centred, wrapping flex row, so a short row (one card, or the
 *  last few) sits in the middle instead of hugging the left edge. On mobile
 *  the card is a fixed 86vw, centred. From `sm` up:
 *  - a few cards take the width `canvasCardStyle` gives (`--card-w`); a share
 *    of the row made a lone card a seventh of a wide monitor;
 *  - many cards take the share a column of the 2/3/4/5/7-column grid had, less
 *    the row's gap (`sm:gap-3.5` = 0.875rem), so a full row still fills the
 *    width edge to edge. */
export function canvasCardWidthClass(cardCount: number): string {
  return cardCount <= FEW_CARDS
    ? 'w-[86vw] max-w-sm sm:max-w-none sm:w-[var(--card-w)]'
    : 'w-[86vw] max-w-sm sm:max-w-none sm:w-[calc((100%-0.875rem)/2)] md:w-[calc((100%-2*0.875rem)/3)] lg:w-[calc((100%-3*0.875rem)/4)] xl:w-[calc((100%-4*0.875rem)/5)] 2xl:w-[calc((100%-6*0.875rem)/7)]';
}

/** The width of a "few cards" card: as large as the window comfortably holds.
 *  Up to 70% of the window's width and ~75% of its height, and never taller
 *  than the window less ~15.5rem: the dashboard puts two header bars, the
 *  label and some margin above the card, so on a short window the percentage
 *  alone pushes the card past the bottom. A portrait print is limited by
 *  height and a landscape one by width. Never wider than the row, never
 *  narrower than 12rem. */
export function canvasCardStyle(canvasWidth: number, canvasHeight: number): CSSProperties {
  const ratio = canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : 2 / 3;
  return { '--card-w': `min(100%, 70vw, max(12rem, calc(min(75vh, 100vh - 15.5rem) * ${ratio.toFixed(4)})))` } as CSSProperties;
}

/** Gap between the sides of a multi-side product, in rem (`gap-6`). */
export const SIDE_GAP_REM = 1.5;

/** The width of one side of a front/back product when it has a few sides
 *  (`FEW_CARDS` or fewer; a book's many pages keep a fixed width). The sides
 *  share up to 70% of the window's width between them, and none is taller
 *  than ~70% of the window's height or the window less ~16.5rem (a side's
 *  label row is taller than a single card's; see `canvasCardStyle`).
 *  Never narrower than the old fixed width (400px landscape, 280px portrait).
 *  Used from `sm` up; a phone keeps the fixed width and scrolls the row. */
export function surfaceCardStyle(canvasWidth: number, canvasHeight: number, sideCount: number): CSSProperties {
  const ratio = canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : 2 / 3;
  const n = Math.max(1, sideCount);
  const share = `(70vw - ${((n - 1) * SIDE_GAP_REM).toFixed(2)}rem) / ${n}`;
  const floor = ratio > 1 ? '400px' : '280px';
  return { '--card-w': `max(${floor}, min(calc(${share}), calc(min(70vh, 100vh - 16.5rem) * ${ratio.toFixed(4)})))` } as CSSProperties;
}

/** Stored photos the restored design doesn't use are deleted on restore only
 *  once this old, so a second tab on the same order keeps the photos it has
 *  just added (they are referenced only by that tab's unsaved state). */
export const ORPHAN_FILE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Stable empty list, so a calendar without holidays doesn't hand the
 *  preview a fresh array every render. */
export const NO_HOLIDAYS: HolidayEntry[] = [];

function cardCountHintKey(orderId: string): string {
  return `${CARD_COUNT_HINT_PREFIX}${orderId}`;
}

export function readCardCountHint(): number {
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

export function writeCardCountHint(orderId: string, count: number): void {
  if (typeof window === 'undefined' || !orderId) return;
  try {
    if (count > 0) window.localStorage.setItem(cardCountHintKey(orderId), String(count));
    else window.localStorage.removeItem(cardCountHintKey(orderId));
  } catch {
    /* storage blocked — the hint is optional */
  }
}

/**
 * Enter or Space pressed on a `role="button"` card itself. A key pressed on a
 * button inside the card (Remove Photo, Rotate, …) belongs to that button: the
 * card used to catch it, cancel the button's click and open the editor instead.
 */
export function activatesCard(e: { key: string; target: EventTarget; currentTarget: EventTarget }): boolean {
  return e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ');
}

/**
 * A customer's own added image (Uploads tab, or a photo moved out of its
 * frame) whose File did not come back after a restore: IndexedDB on another
 * device, blocked in the embed, or full when it was added. The print can only
 * draw it from an upload, so without the File it would be left out.
 */
export function isLostLocalImage(o: Overlay): boolean {
  return o.type === 'image' && o.source === 'local' && !o.originalFile;
}

/** Where a card's photo windows sit, as fractions of the canvas. */
export type PhotoZone = { x: number; y: number; width: number; height: number };

/**
 * The box around every photo window of a layout, as canvas fractions, so a
 * card can highlight the photo and nothing else (a calendar page also carries
 * a date grid and blank paper). Frames may be stored as fractions or as
 * canvas pixels, read the same way as the thumbnail renderer reads them.
 * Null when no frame is readable: the caller highlights the whole card.
 */
export function photoZoneOf(
  frames: unknown[] | undefined,
  canvas: { width?: number; height?: number } | undefined,
): PhotoZone | null {
  const cw = canvas?.width || 1200;
  const ch = canvas?.height || 1800;
  const rects = (frames ?? []).flatMap(f => {
    const { x, y, width, height } = (f ?? {}) as Record<string, unknown>;
    if (![x, y, width, height].every(v => typeof v === 'number' && Number.isFinite(v))) return [];
    const [fx, fy, fw, fh] = [x, y, width, height] as number[];
    if (fw <= 0 || fh <= 0) return [];
    const isFraction = fw <= 1 && fh <= 1;
    return [isFraction ? [fx, fy, fw, fh] : [fx / cw, fy / ch, fw / cw, fh / ch]];
  });
  if (rects.length === 0) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const left = clamp(Math.min(...rects.map(r => r[0])));
  const top = clamp(Math.min(...rects.map(r => r[1])));
  const right = clamp(Math.max(...rects.map(r => r[0] + r[2])));
  const bottom = clamp(Math.max(...rects.map(r => r[1] + r[3])));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
