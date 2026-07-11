/**
 * Identity-based canvas/frame reuse planning (Phase 3 — "never lose edits").
 *
 * The canvas generators used to merge old state POSITIONALLY
 * (existingCanvases[i].frames[f]): adding, removing or reordering files
 * shifted the batching so every shifted frame lost its pan/zoom/rotation to
 * smartcrop defaults, while overlays/backgrounds stayed glued to the canvas
 * INDEX and landed on the wrong photo.
 *
 * planCanvasReuse plans the merge BY FILE IDENTITY (name:size:lastModified)
 * instead, synchronously and purely so it is unit-testable:
 *   - each existing frame's edits are claimable exactly once (a queue per
 *     file key handles duplicate files deterministically);
 *   - canvas-level state (overlays, colours) is carried only when EVERY
 *     frame of the new canvas was claimed from the SAME source canvas and
 *     that source contributed all of its photo-bearing frames — i.e. the
 *     canvas provably represents the same page the customer edited;
 *   - the cached thumbnail (dataUrl) is additionally reused only when every
 *     frame sits in its original slot, since any slot shuffle makes the
 *     cached pixels stale.
 */
import type { CanvasItem, FrameState, Overlay } from './types';

export function fileKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

export interface CanvasCarry {
  overlays: Overlay[];
  bgColor: string;
  paperColor: string;
  /** Only set when the frame slot order is unchanged (thumbnail still valid). */
  dataUrl: string | null;
}

export interface ReusePlan {
  /** frames[canvasIdx][frameIdx] — the existing FrameState whose edits this
   *  slot inherits, or null when the slot must be computed fresh. */
  frames: (FrameState | null)[][];
  /** carry[canvasIdx] — canvas-level state to inherit, or null for defaults. */
  carry: (CanvasCarry | null)[];
}

interface ClaimEntry {
  frame: FrameState;
  canvasIdx: number;
  frameIdx: number;
}

/**
 * @param existing  canvases currently in state (source of edits)
 * @param slots     slots[canvasIdx][frameIdx] — the File planned for each
 *                  new frame slot (null for an empty slot)
 */
export function planCanvasReuse(
  existing: ReadonlyArray<CanvasItem>,
  slots: ReadonlyArray<ReadonlyArray<File | null>>,
): ReusePlan {
  // Queue of claimable frames per file key, in stable (canvas, frame) order.
  const claimable = new Map<string, ClaimEntry[]>();
  const photoFrameCount: number[] = existing.map(() => 0);
  existing.forEach((canvas, canvasIdx) => {
    (canvas.frames || []).forEach((frame, frameIdx) => {
      if (!frame?.originalFile) return;
      photoFrameCount[canvasIdx]++;
      const key = fileKey(frame.originalFile);
      const queue = claimable.get(key);
      if (queue) queue.push({ frame, canvasIdx, frameIdx });
      else claimable.set(key, [{ frame, canvasIdx, frameIdx }]);
    });
  });

  const frames: (FrameState | null)[][] = [];
  const claims: (ClaimEntry | null)[][] = [];
  // contributed[srcIdx] = Map<newCanvasIdx, count>
  const contributed: Map<number, number>[] = existing.map(() => new Map());

  slots.forEach((canvasSlots, newIdx) => {
    const rowFrames: (FrameState | null)[] = [];
    const rowClaims: (ClaimEntry | null)[] = [];
    canvasSlots.forEach(file => {
      if (!file) {
        rowFrames.push(null);
        rowClaims.push(null);
        return;
      }
      const queue = claimable.get(fileKey(file));
      const entry = queue?.shift() ?? null;
      rowFrames.push(entry ? entry.frame : null);
      rowClaims.push(entry);
      if (entry) {
        const m = contributed[entry.canvasIdx];
        m.set(newIdx, (m.get(newIdx) || 0) + 1);
      }
    });
    frames.push(rowFrames);
    claims.push(rowClaims);
  });

  const carry: (CanvasCarry | null)[] = slots.map((canvasSlots, newIdx) => {
    const rowClaims = claims[newIdx];
    const filledSlots = canvasSlots.filter(Boolean).length;
    if (filledSlots === 0) return null;
    const hits = rowClaims.filter(Boolean) as ClaimEntry[];
    if (hits.length !== filledSlots) return null;          // some slot is new
    const sources = new Set(hits.map(h => h.canvasIdx));
    if (sources.size !== 1) return null;                    // mixed pages
    const srcIdx = hits[0].canvasIdx;
    // The source page must have given ALL its photos to this new canvas —
    // otherwise its overlays/colours belong to photos that went elsewhere.
    if ((contributed[srcIdx].get(newIdx) || 0) !== photoFrameCount[srcIdx]) return null;
    const src = existing[srcIdx];
    const slotOrderUnchanged =
      srcIdx === newIdx && rowClaims.every((c, p) => !c || c.frameIdx === p);
    return {
      overlays: src.overlays || [],
      bgColor: src.bgColor || '#ffffff',
      paperColor: src.paperColor || '#ffffff',
      dataUrl: slotOrderUnchanged ? (src.dataUrl || null) : null,
    };
  });

  return { frames, carry };
}

/**
 * True when a canvas carries edits the customer would miss: a moved/zoomed/
 * rotated frame, any overlay, or a non-default background. Used by the
 * re-pick confirm to decide whether replacing photos needs an "are you
 * sure" (Phase 3 — ask before discarding work).
 */
export function canvasHasRealEdits(canvas: CanvasItem): boolean {
  if ((canvas.overlays || []).length > 0) return true;
  if ((canvas.bgColor || '#ffffff').toLowerCase() !== '#ffffff') return true;
  if ((canvas.paperColor || '#ffffff').toLowerCase() !== '#ffffff') return true;
  return (canvas.frames || []).some(f =>
    !!f?.originalFile && (
      f.offset.x !== 0 || f.offset.y !== 0 || f.scale !== 1 || f.rotation !== 0
    )
  );
}

/**
 * Count canvases whose edits would be lost if `newFiles` replaced the
 * current selection: edited canvases none of whose files appear in the new
 * selection (identity claim would fail for every frame).
 */
export function countCanvasesLosingEdits(
  existing: ReadonlyArray<CanvasItem>,
  newFiles: ReadonlyArray<File>,
): number {
  const newKeys = new Set(newFiles.map(fileKey));
  return existing.filter(c =>
    canvasHasRealEdits(c) &&
    (c.frames || []).some(f => f?.originalFile) &&
    !(c.frames || []).some(f => f?.originalFile && newKeys.has(fileKey(f.originalFile)))
  ).length;
}
