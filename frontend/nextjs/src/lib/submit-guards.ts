/**
 * Pre-submit guards (Phase 3): empty-surface and duplicate-fill detection.
 * Pure collectors in the dpi-utils.ts style — warn-and-proceed only, the
 * banners never block a submit.
 */

interface FrameLike {
  originalFile: File | null;
  fileId?: string;
}

interface CanvasLike {
  frames: ReadonlyArray<FrameLike>;
}

interface SurfaceLike {
  key: string;
  label?: string;
  canvases: ReadonlyArray<CanvasLike>;
}

export interface EmptySurface {
  key: string;
  label: string;
}

/**
 * Surfaces that will print without a photo: no canvases at all, or every
 * frame photo-less. A frame with a fileId but no recovered File does NOT
 * count as empty — the lost-photo submit guard owns that case.
 */
export function collectEmptySurfaces(surfaces: ReadonlyArray<SurfaceLike>): EmptySurface[] {
  if (surfaces.length <= 1) return [];
  return surfaces
    .filter(s =>
      s.canvases.length === 0 ||
      s.canvases.every(c => c.frames.every(f => !f.originalFile && !f.fileId))
    )
    .map(s => ({ key: s.key, label: s.label || s.key }));
}

export interface DuplicateFill {
  fileName: string;
  placements: string[];   // human labels, e.g. "Front" or "page 3, photo 1"
}

function fingerprint(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

/** Fingerprint used to mark deliberate duplication (qty auto-fill). */
export function duplicateFingerprint(f: File): string {
  return fingerprint(f);
}

/**
 * Photos placed more than once, excluding fingerprints the customer
 * duplicated deliberately (qty auto-fill / fill-with-picked mark them).
 */
export function collectDuplicateFills(
  groups: ReadonlyArray<{ label: string; canvases: ReadonlyArray<CanvasLike> }>,
  intentional: ReadonlySet<string>,
): DuplicateFill[] {
  const seen = new Map<string, { fileName: string; placements: string[] }>();
  groups.forEach(group => {
    group.canvases.forEach((c, ci) => {
      c.frames.forEach((f, fi) => {
        if (!f.originalFile) return;
        const key = fingerprint(f.originalFile);
        if (intentional.has(key)) return;
        const placement = group.canvases.length > 1
          ? `${group.label}, page ${ci + 1}${c.frames.length > 1 ? `, photo ${fi + 1}` : ''}`
          : `${group.label}${c.frames.length > 1 ? `, photo ${fi + 1}` : ''}`;
        const entry = seen.get(key);
        if (entry) entry.placements.push(placement);
        else seen.set(key, { fileName: f.originalFile.name, placements: [placement] });
      });
    });
  });
  return Array.from(seen.values()).filter(e => e.placements.length > 1);
}
