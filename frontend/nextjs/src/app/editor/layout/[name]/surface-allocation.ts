/**
 * Photo allocation across the surfaces of a multi-surface product.
 *
 * The multi-surface upload path used to hand every surface exactly ONE photo
 * (`maxFiles = surfaceStates.length`, `[cappedFiles[idx]]`), on the assumption
 * that a surface is always a single physical side holding a single photo. That
 * holds for a laptop sleeve (front / back, one frame each) but not for a book
 * spread, which is one surface with two print areas — so the surface received
 * one photo for two frames, the generator's `% surfaceFiles.length` wrap-around
 * topped the second frame up with the SAME photo, and the spread printed the
 * customer's picture twice. Extra photos were meanwhile discarded by the cap.
 *
 * Allocation is therefore driven by each surface's OWN frame count. Once a
 * surface holds as many photos as it has frames the modulo never wraps, so the
 * repeat-fill behaviour that passport / stamp / 4-up sheets depend on (upload
 * one photo, fill every slot) is left completely untouched — those are
 * single-surface layouts on a different code path.
 *
 * Kept pure and separate from page.tsx so the index arithmetic is unit-testable.
 */

/** Frame count of one surface, floored at 1 (a surface always has a slot). */
export function surfaceFrameCount(def: { frames?: unknown[] } | null | undefined): number {
  return Math.max(1, def?.frames?.length || 1);
}

/** Total photos a product can hold: the sum of every surface's frame count. */
export function totalSurfaceCapacity(
  surfaces: ReadonlyArray<{ def?: { frames?: unknown[] } | null }>,
): number {
  return surfaces.reduce((sum, s) => sum + surfaceFrameCount(s.def), 0);
}

/**
 * Plan which File lands in each frame slot of a surface's canvases.
 *
 * The `%` wrap-around is deliberate and load-bearing: it is what lets a
 * repeat-fill sheet top every remaining slot up with the photo the customer
 * uploaded (passport prints fill 6 slots from 1 photo). It only ever engages
 * when there are FEWER photos than slots — so once allocateFilesToSurfaces has
 * given a surface one photo per frame, it is a no-op and each print area gets
 * its own distinct photo.
 */
export function planFrameSlots(
  files: ReadonlyArray<File>,
  frameCount: number,
  canvasCount: number,
): (File | null)[][] {
  return Array.from({ length: canvasCount }, (_, c) =>
    Array.from({ length: frameCount }, (_, f) =>
      files.length ? (files[(c * frameCount + f) % files.length] || null) : null,
    ),
  );
}

/**
 * Split `files` across `surfaces` in order, giving each surface as many photos
 * as it has frames. Surfaces past the end of the selection get an empty array
 * (they render blank and are reported by the empty-surface guard), and files
 * past the total capacity are dropped — the caller warns about those.
 *
 * @example front(1 frame) + spread(2 frames) with [a,b,c] → [[a], [b,c]]
 */
export function allocateFilesToSurfaces<T extends { def?: { frames?: unknown[] } | null }>(
  surfaces: ReadonlyArray<T>,
  files: ReadonlyArray<File>,
): File[][] {
  let cursor = 0;
  return surfaces.map(s => {
    const take = surfaceFrameCount(s.def);
    const slice = files.slice(cursor, cursor + take);
    cursor += take;
    return slice;
  });
}
