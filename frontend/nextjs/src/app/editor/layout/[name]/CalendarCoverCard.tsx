'use client';

import { useRef } from 'react';
import { AlertTriangle, ImagePlus, Loader2, Pencil } from 'lucide-react';
import { clsx } from 'clsx';
import { isCoverKey, type CoverKey } from '@/lib/calendar-covers';
import { isLostLocalImage } from './editor-utils';
import type { SurfaceState } from './types';

/** One of a calendar's two cover sheets, shown as a card of its own ahead of
 *  the months (front) or after them (back). Only the printed side is shown:
 *  the unprinted inside of a cover is not offered or mentioned. */
export function CalendarCoverCard({ surface, busy, onAddPhotos, onEdit }: {
  surface: SurfaceState;
  busy: boolean;
  onAddPhotos: (key: CoverKey, files: File[]) => void;
  onEdit: (idx: number, surfaceKey?: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (!isCoverKey(surface.key)) return null;
  const key = surface.key;
  const cw = surface.def.canvas?.width || 1200;
  const ch = surface.def.canvas?.height || 1800;
  const card = surface.canvases[0] ?? null;
  const lost = Boolean(card?.frames.some(f => (f.fileId || f.fileName) && !f.originalFile) || card?.overlays.some(isLostLocalImage));
  const windows = surface.def.frames?.length ?? 1;
  const pick = () => inputRef.current?.click();

  return (
    <section
      className="mx-auto flex w-[240px] sm:w-[280px] shrink-0 flex-col gap-2"
      aria-label={surface.label}
      data-testid={`calendar-cover-${key}`}
    >
      <div className="flex items-center justify-between px-1">
        <h3 className="text-xs font-black text-slate-900 uppercase tracking-tight truncate">{surface.label}</h3>
        {card && (
          <button
            type="button"
            onClick={() => onEdit(0, key)}
            className="relative flex items-center gap-1 text-[9px] font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100 uppercase tracking-wide before:absolute before:-inset-x-3 before:-inset-y-3 before:content-[''] sm:before:hidden"
          >
            <Pencil className="w-3 h-3" aria-hidden /> Edit
          </button>
        )}
      </div>

      {card ? (
        <div className="relative bg-white rounded-xl border-2 border-slate-100 hover:border-indigo-400 overflow-hidden transition-colors">
          <button
            type="button"
            onClick={() => (lost ? pick() : onEdit(0, key))}
            aria-label={`Edit ${surface.label}`}
            className="relative block w-full bg-slate-100"
            style={{ aspectRatio: `${cw} / ${ch}` }}
          >
            {card.dataUrl && <img src={card.dataUrl} alt={surface.label} className="absolute inset-0 h-full w-full object-fill" />}
          </button>
          {lost && (
            <button
              type="button"
              onClick={pick}
              className="absolute bottom-2 left-2 right-2 z-20 flex items-center gap-1 rounded-lg border border-amber-200 bg-white/90 px-2 py-1 text-left text-[10px] font-bold leading-tight text-amber-700 shadow-sm"
            >
              <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden />
              <span>Photo not on this device — tap to add</span>
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className={clsx(
            'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white/60 px-4 text-center text-sm font-semibold text-slate-600 transition-colors hover:border-indigo-400 hover:text-indigo-700',
            busy && 'opacity-60',
          )}
          style={{ aspectRatio: `${cw} / ${ch}` }}
        >
          {busy ? <Loader2 className="w-6 h-6 animate-spin" aria-hidden /> : <ImagePlus className="w-6 h-6" aria-hidden />}
          <span>Add {windows > 1 ? 'photos' : 'a photo'} for the {surface.label.toLowerCase()}</span>
        </button>
      )}

      {card && (
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className="self-center inline-flex min-h-11 items-center px-3 text-[11px] font-bold text-slate-500 underline-offset-2 hover:text-indigo-700 hover:underline disabled:opacity-60 sm:min-h-0 sm:px-0"
        >
          {busy ? 'Adding…' : windows > 1 ? 'Choose different photos' : 'Choose a different photo'}
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif"
        multiple={windows > 1}
        className="hidden"
        onChange={e => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (picked.length) onAddPhotos(key, picked);
        }}
      />
    </section>
  );
}
