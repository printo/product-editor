'use client';

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

/** A to-scale sketch of the cover: the page and its photo windows. */
function CoverSketch({ cover }: { cover: CoverDraft }) {
  const ratio = cover.canvasWidthMm > 0 && cover.canvasHeightMm > 0 ? cover.canvasWidthMm / cover.canvasHeightMm : 0.7;
  return (
    <div
      className="relative mx-auto w-28 rounded-sm border border-zinc-300 bg-white shadow-sm"
      style={{ aspectRatio: String(ratio) }}
      aria-hidden
    >
      {cover.frames.map((f, i) => (
        <div
          key={i}
          className="absolute rounded-[2px] border border-emerald-500 bg-emerald-200/70"
          style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` }}
        />
      ))}
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
                className="text-xs text-zinc-400 hover:text-red-600"
              >
                ✕ Remove
              </button>
            </div>
            <CoverSketch cover={cover} />
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
                      className="text-zinc-400 hover:text-red-600"
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
                onClick={() => patch({ frames: [...cover.frames, { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }] })}
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
                    className="self-start text-xs text-zinc-400 hover:text-red-600"
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
