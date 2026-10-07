import type { OrientationOutcome } from '@/lib/ml-orientation';
import type { HolidayEntry } from '@/types/calendar';

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
export function resolveRotation(
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
export function formatWait(seconds: number): string {
  if (seconds < 90) return `~${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `~${Math.round(seconds / 60)} min`;
}

/**
 * Display-only prettifier for the header title. `layout.name` IS the
 * filename stem (views.py forces them to match — see "Layout Identity Is
 * the Filename" in CLAUDE.md), so ops-authored slugs like
 * "retro_polaroid_-_4.2x3.5_in" render as readable text here without ever
 * touching the identifier itself or anything sent to the API.
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
