'use client';

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { MmRectFields, type RectFrac } from '@/components/CalendarMmRectFields';
import { NumberField } from '@/components/ui/NumberField';

/** One cover sheet of a calendar, as the ops editor holds it. The saved layout
 *  stores it as a plain generic-layout block (`frontCover` / `backCover`);
 *  see services/calendar_covers.py. */
export interface CoverDraft {
  canvasWidthMm: number;
  canvasHeightMm: number;
  dpi: number;
  frames: RectFrac[];
  /** Stored path, or the chosen file's bare name until it uploads on save. */
  maskUrl?: string | null;
  maskOnExport?: boolean;
}

export type CoverKey = 'frontCover' | 'backCover';
export const MAX_COVER_FRAMES = 12;

const COVER_TITLE: Record<CoverKey, string> = { frontCover: 'Front cover', backCover: 'Back cover' };

/** A new cover: the calendar's own page size, one photo window with a margin. */
export function defaultCover(base: { canvasWidthMm: number; canvasHeightMm: number; dpi: number }): CoverDraft {
  return {
    canvasWidthMm: base.canvasWidthMm,
    canvasHeightMm: base.canvasHeightMm,
    dpi: base.dpi,
    frames: [{ x: 0.08, y: 0.08, width: 0.84, height: 0.84 }],
    maskUrl: null,
    maskOnExport: false,
  };
}

const WINDOW_GAP = 0.02;
const MIN_WINDOW_HEIGHT = 0.1;

/** The photo windows after adding one, placed so it never starts on top of an
 *  existing window: straight below the last one (same left edge and width, its
 *  height or what is left of the page). When there is no room below, which is
 *  the case for a first window that fills the page, the last window is split
 *  in two, top and bottom. Only when it is too short to split does the new one
 *  go to the top-left, where ops can move it. */
export function addWindow(frames: RectFrac[]): RectFrac[] {
  const last = frames[frames.length - 1];
  if (!last) return [{ x: 0.08, y: 0.08, width: 0.84, height: 0.84 }];
  const y = last.y + last.height + WINDOW_GAP;
  const room = 1 - y;
  if (room >= MIN_WINDOW_HEIGHT) {
    return [...frames, { x: last.x, y, width: last.width, height: Math.min(last.height, room) }];
  }
  const half = (last.height - WINDOW_GAP) / 2;
  if (half >= MIN_WINDOW_HEIGHT) {
    return [
      ...frames.slice(0, -1),
      { ...last, height: half },
      { x: last.x, y: last.y + half + WINDOW_GAP, width: last.width, height: half },
    ];
  }
  return [...frames, { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }];
}

export function coverToJson(c: CoverDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {
    canvas: {
      width: Math.round((c.canvasWidthMm * c.dpi) / 25.4),
      height: Math.round((c.canvasHeightMm * c.dpi) / 25.4),
      widthMm: c.canvasWidthMm,
      heightMm: c.canvasHeightMm,
      dpi: c.dpi,
    },
    frames: c.frames,
  };
  if (c.maskUrl) {
    out.maskUrl = c.maskUrl;
    out.maskOnExport = c.maskOnExport ?? false;
  }
  return out;
}

/** The saved block back into a draft; null when the layout has no such cover. */
export function coverFromJson(block: unknown): CoverDraft | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as {
    canvas?: { width?: number; height?: number; widthMm?: number; heightMm?: number; dpi?: number };
    frames?: RectFrac[]; maskUrl?: string | null; maskOnExport?: boolean;
  };
  if (!b.canvas || !Array.isArray(b.frames)) return null;
  const dpi = b.canvas.dpi ?? 300;
  return {
    canvasWidthMm: b.canvas.widthMm ?? ((b.canvas.width ?? 0) / dpi) * 25.4,
    canvasHeightMm: b.canvas.heightMm ?? ((b.canvas.height ?? 0) / dpi) * 25.4,
    dpi,
    frames: b.frames,
    maskUrl: b.maskUrl ?? null,
    maskOnExport: b.maskOnExport ?? false,
  };
}

/** The first problem with a cover, in words ops can act on, else null. Mirrors
 *  validate_calendar_covers in api/validators.py. */
export function validateCover(key: CoverKey, c: CoverDraft | null | undefined): string | null {
  if (!c) return null;
  const t = COVER_TITLE[key];
  if (!(c.canvasWidthMm > 0) || !(c.canvasHeightMm > 0)) return `${t}: page size must be positive.`;
  if (!(c.dpi > 0)) return `${t}: DPI must be positive.`;
  if (c.frames.length === 0) return `${t}: add at least one photo window.`;
  for (let i = 0; i < c.frames.length; i++) {
    const f = c.frames[i];
    if (f.x < 0 || f.y < 0 || f.width <= 0 || f.height <= 0) return `${t}: photo window ${i + 1} must have a size and sit inside the page.`;
    if (f.x + f.width > 1 + 1e-6 || f.y + f.height > 1 + 1e-6) return `${t}: photo window ${i + 1} goes past the page edge.`;
  }
  return null;
}

/** A window moved by a drag of (dx, dy) in page fractions, kept on the page. */
export function moveWindow(r: RectFrac, dx: number, dy: number): RectFrac {
  return {
    ...r,
    x: Math.min(Math.max(0, r.x + dx), 1 - r.width),
    y: Math.min(Math.max(0, r.y + dy), 1 - r.height),
  };
}

/** A window resized from its bottom-right corner by (dx, dy), at least `min`
 *  (a fraction of the page side) wide and tall and never past the page edge. */
export function resizeWindow(r: RectFrac, dx: number, dy: number, minW = 0.02, minH = 0.02): RectFrac {
  return {
    ...r,
    width: Math.min(Math.max(minW, r.width + dx), 1 - r.x),
    height: Math.min(Math.max(minH, r.height + dy), 1 - r.y),
  };
}

type Drag = { index: number; mode: 'move' | 'resize'; startX: number; startY: number; origin: RectFrac };

/** The cover as a to-scale page. Drag a photo window to move it, drag its
 *  corner square to resize it, or focus it and use the arrow keys (1 mm a
 *  step, Shift for 10 mm). The millimetre fields below stay in step. */
function CoverSketch({ cover, onFrame }: { cover: CoverDraft; onFrame: (i: number, next: RectFrac) => void }) {
  const ratio = cover.canvasWidthMm > 0 && cover.canvasHeightMm > 0 ? cover.canvasWidthMm / cover.canvasHeightMm : 0.7;
  const pageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const begin = (e: PointerEvent<HTMLElement>, index: number, mode: Drag['mode']) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { index, mode, startX: e.clientX, startY: e.clientY, origin: cover.frames[index] };
    setActive(index);
  };
  const update = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const box = pageRef.current?.getBoundingClientRect();
    if (!d || !box || !(box.width > 0) || !(box.height > 0)) return;
    const dx = (e.clientX - d.startX) / box.width;
    const dy = (e.clientY - d.startY) / box.height;
    onFrame(d.index, d.mode === 'move' ? moveWindow(d.origin, dx, dy) : resizeWindow(d.origin, dx, dy));
  };
  const end = (e: PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
  };
  const nudge = (e: KeyboardEvent<HTMLElement>, index: number) => {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    const f = cover.frames[index];
    const mx = (dx * step) / cover.canvasWidthMm;
    const my = (dy * step) / cover.canvasHeightMm;
    onFrame(index, e.altKey ? resizeWindow(f, mx, my) : moveWindow(f, mx, my));
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        ref={pageRef}
        data-testid="cover-sketch"
        className="relative w-48 touch-none select-none rounded-sm border border-zinc-300 bg-white shadow-sm"
        style={{ aspectRatio: String(ratio) }}
      >
        {cover.frames.map((f, i) => (
          <div
            key={i}
            role="group"
            tabIndex={0}
            data-testid={`cover-window-${i}`}
            aria-label={`Photo window ${i + 1}. Drag to move, drag the corner to resize, or use the arrow keys.`}
            onPointerDown={(e) => begin(e, i, 'move')}
            onPointerMove={update}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => nudge(e, i)}
            onFocus={() => setActive(i)}
            className={`absolute cursor-move rounded-[2px] border bg-emerald-200/70 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              active === i ? 'border-emerald-600 bg-emerald-300/70' : 'border-emerald-500'
            }`}
            style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` }}
          >
            <span className="pointer-events-none absolute left-0.5 top-0 text-[9px] font-semibold text-emerald-800">{i + 1}</span>
            <div
              data-testid={`cover-window-${i}-resize`}
              aria-hidden
              onPointerDown={(e) => begin(e, i, 'resize')}
              onPointerMove={update}
              onPointerUp={end}
              onPointerCancel={end}
              className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-[2px] border border-emerald-700 bg-white"
            />
          </div>
        ))}
      </div>
      <p className="text-[11px] text-zinc-500">Drag a window to move it, its corner to resize.</p>
    </div>
  );
}

/** "Cover pages (optional)": a front and/or a back cover, each its own printed
 *  sheet with its own page size and photo windows. A cover has no date grid.
 *  Only the printed side exists: nothing here mentions the inside. */
export function CalendarCoversPanel({ covers, onChange, maskFiles, onMaskFile, base }: {
  covers: Partial<Record<CoverKey, CoverDraft | null>>;
  onChange: (key: CoverKey, next: CoverDraft | null) => void;
  maskFiles: Partial<Record<CoverKey, File | null>>;
  onMaskFile: (key: CoverKey, file: File | null) => void;
  base: { canvasWidthMm: number; canvasHeightMm: number; dpi: number };
}) {
  return (
    <section data-testid="covers-panel" className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">Cover pages (optional)</h3>
        <p className="text-xs text-zinc-500">
          A front cover prints before the months and a back cover after them, each on its own sheet.
        </p>
      </div>
      {(['frontCover', 'backCover'] as CoverKey[]).map((key) => {
        const cover = covers[key] ?? null;
        const title = COVER_TITLE[key];
        const id = key === 'frontCover' ? 'front' : 'back';
        if (!cover) {
          return (
            <div key={key} className="flex items-center justify-between rounded-lg border border-dashed border-zinc-300 px-3 py-2">
              <span className="text-sm text-zinc-600">{title}</span>
              <button
                type="button"
                data-testid={`cover-add-${id}`}
                onClick={() => onChange(key, defaultCover(base))}
                className="rounded border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
              >
                Add {title.toLowerCase()}
              </button>
            </div>
          );
        }
        const patch = (next: Partial<CoverDraft>) => onChange(key, { ...cover, ...next });
        const setFrame = (i: number, next: Partial<RectFrac>) =>
          patch({ frames: cover.frames.map((f, idx) => (idx === i ? { ...f, ...next } : f)) });
        const maskFile = maskFiles[key] ?? null;
        return (
          <div key={key} data-testid={`cover-${id}`} className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-zinc-900">{title}</h4>
              <button
                type="button"
                data-testid={`cover-remove-${id}`}
                onClick={() => { onMaskFile(key, null); onChange(key, null); }}
                className="text-xs text-zinc-500 hover:text-red-600"
              >
                ✕ Remove
              </button>
            </div>
            <CoverSketch cover={cover} onFrame={(i, next) => setFrame(i, next)} />
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Page width (mm)" value={cover.canvasWidthMm} step={0.5} min={1} onChange={(n) => patch({ canvasWidthMm: n })} />
              <NumberField label="Page height (mm)" value={cover.canvasHeightMm} step={0.5} min={1} onChange={(n) => patch({ canvasHeightMm: n })} />
            </div>
            {cover.frames.map((f, i) => (
              <div key={i} className="flex flex-col gap-1.5" data-testid={`cover-${id}-frame-${i}`}>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-zinc-700">Photo window {i + 1}</span>
                  {cover.frames.length > 1 && (
                    <button
                      type="button"
                      onClick={() => patch({ frames: cover.frames.filter((_, idx) => idx !== i) })}
                      className="text-zinc-500 hover:text-red-600"
                      aria-label={`Remove photo window ${i + 1} from the ${title.toLowerCase()}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <MmRectFields
                  rect={f} canvasW={cover.canvasWidthMm} canvasH={cover.canvasHeightMm}
                  onPatch={(next) => setFrame(i, next)}
                />
              </div>
            ))}
            {cover.frames.length < MAX_COVER_FRAMES && (
              <button
                type="button"
                data-testid={`cover-${id}-add-frame`}
                onClick={() => patch({ frames: addWindow(cover.frames) })}
                className="self-start rounded border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
              >
                + Add photo window
              </button>
            )}
            <div className="flex flex-col gap-1.5 border-t border-zinc-100 pt-2">
              <label className="flex cursor-pointer items-center gap-2">
                <span className="shrink-0 rounded border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
                  {cover.maskUrl ? 'Replace mask' : 'Upload mask (PNG or SVG)'}
                </span>
                <span className="truncate text-xs text-zinc-500" data-testid={`cover-${id}-mask-current`}>
                  {maskFile ? `${maskFile.name} — uploads when you save` : cover.maskUrl ? cover.maskUrl.split('/').pop() : 'No mask'}
                </span>
                <input
                  type="file" accept="image/png,image/svg+xml,.svg" className="sr-only" data-testid={`cover-${id}-mask-input`}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    onMaskFile(key, f);
                    if (f) patch({ maskUrl: f.name });
                    e.target.value = '';
                  }}
                />
              </label>
              {cover.maskUrl && (
                <>
                  <label className="flex items-center gap-2 text-xs text-zinc-600">
                    <input type="checkbox" checked={!!cover.maskOnExport} onChange={(e) => patch({ maskOnExport: e.target.checked })} />
                    Apply mask on export
                  </label>
                  <button
                    type="button"
                    onClick={() => { onMaskFile(key, null); patch({ maskUrl: null, maskOnExport: false }); }}
                    className="self-start text-xs text-zinc-500 hover:text-red-600"
                  >
                    ✕ Remove mask
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
