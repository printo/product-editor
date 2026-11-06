'use client';

import { useRef, useState } from 'react';
import { clsx } from 'clsx';
import { RotateCw, X } from 'lucide-react';
import { CalendarCellPhoto } from '@/components/CalendarCellPhoto';
import { useModalA11y } from '@/lib/use-modal-a11y';
import type { CellImagePlacement } from '@/types/calendar';

const FITS = [
  { fit: 'cover', label: 'Fill', hint: 'Fill the date; the edges of the photo are cut' },
  { fit: 'contain', label: 'Fit', hint: 'Show the whole photo' },
] as const;

/**
 * Places a date's photo: fill or fit, quarter turns, blurred sides, over a
 * preview in the date's own shape. Opens once a photo is picked for a date
 * and again from the date editor's Edit button. Every change is applied to
 * the design at once, so this preview, the date editor's and the month
 * grid's never disagree; Cancel, the close button and Escape put the photo
 * back the way it was when the pop-up opened. A click outside does nothing,
 * so a stray click cannot throw the placement away.
 */
export function CalendarCellPhotoDialog({ src, placement, cellAspect = 1, dateLabel, onChange, onSave, onCancel }: {
  src: string;
  /** How the photo is placed now. */
  placement: CellImagePlacement;
  /** Width over height of the box the print fits the photo into. Default 1. */
  cellAspect?: number;
  dateLabel: string;
  /** A change to the placement, to apply to the design straight away. */
  onChange: (change: Partial<CellImagePlacement>) => void;
  /** Keep the placement as it now is and close. */
  onSave: () => void;
  /** Close, putting back the placement the pop-up opened with. */
  onCancel: (original: CellImagePlacement) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [original] = useState(placement);
  const cancel = () => onCancel(original);
  useModalA11y(dialogRef, cancel, true);
  const aspect = Number.isFinite(cellAspect) && cellAspect > 0 ? cellAspect : 1;

  return (
    <div
      className="fixed inset-0 z-[50001] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
      data-testid="cell-photo-dialog-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cell-photo-dialog-title"
        tabIndex={-1}
        data-testid="cell-photo-dialog"
        className="w-full max-h-[90vh] overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl ring-1 ring-slate-900/5 outline-none sm:max-w-md sm:rounded-xl"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id="cell-photo-dialog-title" className="text-base font-semibold text-slate-900">Place the photo</h2>
            <p className="mt-0.5 text-sm text-slate-500">{dateLabel}</p>
          </div>
          <button
            type="button"
            onClick={cancel}
            aria-label="Close without saving"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="mt-4 flex justify-center rounded-lg bg-slate-100 p-5">
          <div
            className="bg-white shadow-sm ring-1 ring-slate-300"
            style={aspect >= 1
              ? { width: 'min(18rem, 100%)', aspectRatio: String(aspect) }
              : { height: '18rem', aspectRatio: String(aspect) }}
          >
            <CalendarCellPhoto src={src} placement={placement} alt="How this date will print" className="relative h-full w-full" />
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-slate-500">How this date will print</p>

        <div className="mt-4 flex items-stretch gap-2">
          <div role="group" aria-label="Photo fit" className="flex flex-1 rounded-lg border border-slate-300 p-0.5">
            {FITS.map(option => (
              <button
                key={option.fit}
                type="button"
                aria-pressed={placement.fit === option.fit}
                title={option.hint}
                onClick={() => onChange({ fit: option.fit })}
                data-testid={`cell-photo-fit-${option.fit}`}
                className={clsx(
                  'flex-1 rounded-md px-3 py-2 text-sm font-medium',
                  placement.fit === option.fit ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onChange({ rotation: ((placement.rotation + 90) % 360) as CellImagePlacement['rotation'] })}
            data-testid="cell-photo-rotate"
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:border-slate-900 hover:text-slate-900"
          >
            <RotateCw className="h-4 w-4" aria-hidden />
            Rotate
          </button>
        </div>
        <label className={clsx('mt-3 flex items-center gap-2 text-sm', placement.fit === 'contain' ? 'cursor-pointer text-slate-700' : 'text-slate-400')}>
          <input
            type="checkbox"
            checked={placement.blur}
            disabled={placement.fit !== 'contain'}
            onChange={e => onChange({ blur: e.target.checked })}
            data-testid="cell-photo-blur"
            className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
          />
          Blur the empty sides {placement.fit !== 'contain' && <span className="text-xs">(with Fit)</span>}
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            data-testid="cell-photo-cancel"
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            data-testid="cell-photo-save"
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
