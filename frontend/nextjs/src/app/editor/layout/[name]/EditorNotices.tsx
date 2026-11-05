'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Toast, ToastStack } from '@/components/ui/Toast';
import type { LowDpiFrame } from '@/lib/dpi-utils';
import type { DuplicateFill, EmptySurface } from '@/lib/submit-guards';
import type { UnprintableText } from './useUnprintableText';

/** What the five notices show — both pre-submit dialogs pass it through. */
export type PreSubmitNoticeData = {
  lowDpiFrames: LowDpiFrame[];
  emptySurfaces: EmptySurface[];
  duplicateFills: DuplicateFill[];
  unprintableTexts: UnprintableText[];
  totalUploadedCount: number;
  qtyNeeded: number;
};

/** The one sentence shown wherever text holds characters the print can't draw. */
export const UNPRINTABLE_HELP =
  'Emoji and some special characters typed as text won’t print. ' +
  'Please use the cliparts, images or icons from the sidebar instead.';

/** Shown once the canvas editor has taken unsupported characters out of a text box. */
export const UNSUPPORTED_REMOVED =
  'Emoji and some special characters are not supported in text, so they were removed. ' +
  'Please use the cliparts, images or icons from the sidebar instead.';

/**
 * The toast the canvas editor shows each time unsupported characters are
 * taken out of a text box. The note under the text box says the same, but it
 * sits in the sidebar below the fold on a small screen and is not there at
 * all when the text was typed on the canvas (found on production the day the
 * removal shipped: the emoji vanished and nothing said why).
 * It sits in the middle of the screen and stays fifteen seconds, by request:
 * at the top left for eight it was easy to miss.
 *
 * `removals` is the running count from useUnprintableText. The count at the
 * time the editor opened, and then at each dismissal, is what has been seen;
 * anything above it shows the toast, and each new removal restarts its timer.
 */
/** How long the toast stays unless dismissed. */
export const TEXT_REMOVED_TOAST_MS = 15000;

export function TextRemovedToast({ removals }: { removals: number }) {
  const [seen, setSeen] = useState(removals);
  return (
    <ToastStack placement="center">
      <Toast
        key={removals}
        message={removals > seen ? UNSUPPORTED_REMOVED : null}
        tone="warning"
        duration={TEXT_REMOVED_TOAST_MS}
        onDismiss={() => setSeen(removals)}
      />
    </ToastStack>
  );
}

/** Under the text box in the canvas editor. The editor does not keep a
 *  character the print can't draw (useUnprintableText.ts): `removed` says one
 *  was taken out while this editor was open. `chars` covers the moment before
 *  that, while such a character is still in the box. */
export function UnprintableTextNote({ chars, removed = false }: { chars: string[]; removed?: boolean }) {
  if (chars.length === 0 && !removed) return null;
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-900">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
      <p className="text-[11px] leading-relaxed">{removed ? UNSUPPORTED_REMOVED : UNPRINTABLE_HELP}</p>
    </div>
  );
}

/** Amber pre-submit notice for text holding characters the print can't draw.
 *  Warn-and-proceed like the other guards. */
export function UnprintableTextWarning({ texts }: { texts: UnprintableText[] }) {
  if (texts.length === 0) return null;
  const named = texts.map(t => t.where).filter(Boolean);
  const shown = named.slice(0, 3).join(', ');
  const rest = named.length - 3;
  return (
    <div className="mx-7 mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        Some of your text won’t print
      </div>
      {named.length > 0 && (
        <p className="text-xs mt-1.5 font-medium">{shown}{rest > 0 ? ` and ${rest} more` : ''}</p>
      )}
      <p className="text-xs mt-1 leading-relaxed">{UNPRINTABLE_HELP}</p>
    </div>
  );
}

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
      {/* {' '} rather than a plain space: SWC drops that space when the text holds an entity and wraps. */}
      <p className="text-xs mt-1 leading-relaxed">
        {surfaces.map(s => s.label).join(', ')}{' '}will print blank. You can continue if that&apos;s intended.
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
