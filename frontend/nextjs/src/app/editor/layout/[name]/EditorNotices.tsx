'use client';

import { AlertTriangle } from 'lucide-react';
import type { LowDpiFrame } from '@/lib/dpi-utils';
import type { DuplicateFill, EmptySurface } from '@/lib/submit-guards';

/** Amber pre-submit notice for surfaces that will print without a photo
 *  (Phase 3 guard). Warn-and-proceed — never blocks. */
export function EmptySurfaceWarning({ surfaces }: { surfaces: EmptySurface[] }) {
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
export function DuplicateFillWarning({ duplicates }: { duplicates: DuplicateFill[] }) {
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
export function LowDpiWarning({ frames }: { frames: LowDpiFrame[] }) {
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

/** Amber pre-submit notice when fewer photos are placed than the ordered
 *  quantity. Warn-and-proceed like the other guards: going UNDER is
 *  allowed, because qty comes from the caller and a wrong one must
 *  never block a checkout. Going OVER is capped at pick time instead — see the
 *  qty block in processSelectedFiles. */
export function QtyShortfallWarning({ uploaded, needed }: { uploaded: number; needed: number }) {
  if (needed <= 0 || uploaded >= needed) return null;
  const short = needed - uploaded;
  return (
    <div className="mx-7 mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        You have uploaded only {uploaded} out of {needed} photos
      </div>
      <p className="text-xs mt-1 leading-relaxed">
        Go back to add more or repeat from uploaded ones.
      </p>
    </div>
  );
}
