'use client';

import { useRef, useState, type PointerEvent } from 'react';
import { clsx } from 'clsx';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCw, X } from 'lucide-react';
import { CalendarCellPhoto } from '@/components/CalendarCellPhoto';
import { cellImageOverflow } from '@/lib/calendar';
import { useModalA11y } from '@/lib/use-modal-a11y';
import type { CellImagePlacement } from '@/types/calendar';

/** One press of an arrow moves the photo an eighth of the way across its room. */
const PAN_STEP = 0.25;
const clampPan = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 1000 || 0;

const MOVES = [
  { key: 'left', label: 'Move photo left', Icon: ArrowLeft, axis: 'panX', by: -PAN_STEP },
  { key: 'up', label: 'Move photo up', Icon: ArrowUp, axis: 'panY', by: -PAN_STEP },
  { key: 'down', label: 'Move photo down', Icon: ArrowDown, axis: 'panY', by: PAN_STEP },
  { key: 'right', label: 'Move photo right', Icon: ArrowRight, axis: 'panX', by: PAN_STEP },
] as const;

const FITS = [
  { fit: 'cover', label: 'Fill', hint: 'Fill the date; the edges of the photo are cut' },
  { fit: 'contain', label: 'Fit', hint: 'Show the whole photo' },
] as const;

/**
 * Places a date's photo: fill or fit, quarter turns, blurred sides, and where
 * a photo that fills the date sits (dragged in the preview or nudged with the
 * four arrows; left, right, up and down only, no zoom), over a preview in the
 * date's own shape. Opens once a photo is picked for a date
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
  // The photo's own pixel size, once loaded: says which way it can move.
  const [photoSize, setPhotoSize] = useState<[number, number] | null>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; roomX: number; roomY: number } | null>(null);
  const filling = placement.fit === 'cover';
  const roomFor = (boxW: number, boxH: number): [number, number] =>
    photoSize ? cellImageOverflow(photoSize[0], photoSize[1], placement.rotation, boxW, boxH) : [0, 0];
  // Until the photo's size is known every direction is offered.
  const [roomX, roomY] = photoSize ? roomFor(cellAspect > 0 ? cellAspect : 1, 1) : [1, 1];
  const canMove = { panX: filling && roomX > 1e-6, panY: filling && roomY > 1e-6 };

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!filling) return;
    const box = e.currentTarget.getBoundingClientRect();
    const [rx, ry] = roomFor(box.width, box.height);
    if (rx < 1 && ry < 1) return;
    drag.current = { x: e.clientX, y: e.clientY, panX: placement.panX, panY: placement.panY, roomX: rx, roomY: ry };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // The room spans the whole range from -1 to 1.
    const panX = d.roomX >= 1 ? clampPan(d.panX + (2 * (e.clientX - d.x)) / d.roomX) : d.panX;
    const panY = d.roomY >= 1 ? clampPan(d.panY + (2 * (e.clientY - d.y)) / d.roomY) : d.panY;
    if (panX !== placement.panX || panY !== placement.panY) onChange({ panX, panY });
  };
  const endDrag = () => { drag.current = null; };
  useModalA11y(dialogRef, cancel, true);
  const aspect = Number.isFinite(cellAspect) && cellAspect > 0 ? cellAspect : 1;

  return (
    <div
      className="fixed inset-0 z-[200003] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
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
            className={clsx(
              'bg-white shadow-sm ring-1 ring-slate-300 select-none',
              (canMove.panX || canMove.panY) && 'cursor-grab touch-none active:cursor-grabbing',
            )}
            style={aspect >= 1
              ? { width: 'min(18rem, 100%)', aspectRatio: String(aspect) }
              : { height: '18rem', aspectRatio: String(aspect) }}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            data-testid="cell-photo-preview"
          >
            <CalendarCellPhoto
              src={src}
              placement={placement}
              alt="How this date will print"
              className="relative h-full w-full"
              onPhotoSize={(w, h) => setPhotoSize([w, h])}
            />
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-slate-500">
          How this date will print{(canMove.panX || canMove.panY) && '. Drag the photo to move it.'}
        </p>

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
            onClick={() => onChange({ rotation: ((placement.rotation + 90) % 360) as CellImagePlacement['rotation'], panX: 0, panY: 0 })}
            data-testid="cell-photo-rotate"
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:border-slate-900 hover:text-slate-900"
          >
            <RotateCw className="h-4 w-4" aria-hidden />
            Rotate
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2" role="group" aria-label="Move photo">
          <span className={clsx('mr-1 text-sm', filling ? 'text-slate-700' : 'text-slate-400')}>
            Move {!filling && <span className="text-xs">(with Fill)</span>}
          </span>
          {MOVES.map(({ key, label, Icon, axis, by }) => {
            const next = clampPan(placement[axis] + by);
            return (
              <button
                key={key}
                type="button"
                aria-label={label}
                title={label}
                disabled={!canMove[axis] || next === placement[axis]}
                onClick={() => onChange({ [axis]: next })}
                data-testid={`cell-photo-move-${key}`}
                className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:border-slate-900 hover:text-slate-900 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
              >
                <Icon className="h-4 w-4" aria-hidden />
              </button>
            );
          })}
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
