'use client';

/**
 * Ops authoring UI for the book/booklet/photobook product type
 * (BOOK_LAYOUT_PRD.md §6 Phase 5).
 *
 * Controlled component — parent owns the layout JSON + handles HTTP, exactly
 * like CalendarLayoutEditor (this component does NOT call fetch()). Cloned
 * from that component's SHAPE (props contract, draft/serialize/validate
 * split, numeric-field + percent-positioned-div preview pattern) — not its
 * content. A book needs a much smaller surface: per D2a the ops author
 * authors exactly TWO templates (cover, innerPage) plus an optional
 * backCover, each with its own canvas (D7) — no wizard steps, no per-page
 * override UI (pageOverrides stays a JSON-only escape hatch for v1, same as
 * how the calendar's surfaceOverrides predates its own override UI).
 *
 * Validation mirrors `validate_book_layout()` in api/validators.py so ops
 * gets immediate feedback before Save. The server re-validates regardless.
 */

import { useState } from 'react';

// ─── Draft types ─────────────────────────────────────────────────────────────

export interface BookFrameDraft {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BookRoleDraft {
  canvasWidthMm: number;
  canvasHeightMm: number;
  dpi: number;
  frames: BookFrameDraft[];
}

export interface BookLayoutDraft {
  name: string;
  productType: 'book';
  bleedMm: number;
  gutterMm: number;
  paperThicknessMm: number;
  coverThicknessMm: number;
  pageCountMin: number;
  pageCountMax: number;
  pageCountStep: number;
  pageCountDefault: number;
  cover: BookRoleDraft;
  innerPage: BookRoleDraft;
  /** Back cover is optional (D4) — when off, it inherits the cover's canvas
   *  and prints blank (services/book_layout.py's documented fallback). */
  hasBackCover: boolean;
  backCover: BookRoleDraft;
}

export interface BookLayoutEditorProps {
  /** Initial draft to seed the editor — pass undefined for a brand-new layout. */
  initial?: Partial<BookLayoutDraft>;
  /** Override the new-layout name (defaults to "untitled_book"). */
  newLayoutName?: string;
  /** Called when ops clicks Save. Parent serialises + POSTs. */
  onSave: (layoutJson: Record<string, unknown>) => void | Promise<void>;
  /** Called on Cancel button click. Parent navigates away or resets. */
  onCancel?: () => void;
}

function defaultRole(widthMm: number, heightMm: number): BookRoleDraft {
  return {
    canvasWidthMm: widthMm,
    canvasHeightMm: heightMm,
    dpi: 300,
    frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }],
  };
}

function defaultBookLayout(name: string): BookLayoutDraft {
  return {
    name,
    productType: 'book',
    bleedMm: 3,
    gutterMm: 10,
    paperThicknessMm: 0.12,
    coverThicknessMm: 0,
    pageCountMin: 20,
    pageCountMax: 60,
    pageCountStep: 4,
    pageCountDefault: 24,
    cover: defaultRole(303, 216),
    innerPage: defaultRole(297, 210),
    hasBackCover: false,
    backCover: defaultRole(303, 216),
  };
}

// ─── Layout-JSON serializer ─────────────────────────────────────────────────

function roleToJson(role: BookRoleDraft): Record<string, unknown> {
  const width = Math.round((role.canvasWidthMm * role.dpi) / 25.4);
  const height = Math.round((role.canvasHeightMm * role.dpi) / 25.4);
  return {
    canvas: {
      width, height,
      widthMm: role.canvasWidthMm,
      heightMm: role.canvasHeightMm,
      dpi: role.dpi,
    },
    frames: role.frames,
  };
}

/**
 * Flatten the editor draft into the canonical layout JSON shape consumed by
 * api/validators.py::validate_book_layout + services/book_layout.py.
 */
export function draftToLayoutJson(draft: BookLayoutDraft): Record<string, unknown> {
  const book: Record<string, unknown> = {
    bleedMm: draft.bleedMm,
    gutterMm: draft.gutterMm,
    paperThicknessMm: draft.paperThicknessMm,
    coverThicknessMm: draft.coverThicknessMm,
    pageCount: {
      min: draft.pageCountMin,
      max: draft.pageCountMax,
      step: draft.pageCountStep,
      default: draft.pageCountDefault,
    },
    cover: roleToJson(draft.cover),
    innerPage: roleToJson(draft.innerPage),
  };
  if (draft.hasBackCover) {
    book.backCover = roleToJson(draft.backCover);
  }
  return {
    name: draft.name,
    productType: draft.productType,
    book,
  };
}

// ─── Client-side validation (mirrors api/validators.py::validate_book_layout) ─

function validateRole(role: BookRoleDraft, label: string): string | null {
  if (role.canvasWidthMm <= 0 || role.canvasHeightMm <= 0) {
    return `${label} canvas dimensions must be positive.`;
  }
  if (role.dpi <= 0) return `${label} DPI must be positive.`;
  for (let i = 0; i < role.frames.length; i++) {
    const f = role.frames[i];
    if (f.x < 0 || f.y < 0 || f.width <= 0 || f.height <= 0) {
      return `${label} frame ${i + 1} must have positive dimensions and non-negative origin.`;
    }
    if (f.x + f.width > 1 + 1e-6) return `${label} frame ${i + 1} extends past the right canvas edge.`;
    if (f.y + f.height > 1 + 1e-6) return `${label} frame ${i + 1} extends past the bottom canvas edge.`;
  }
  return null;
}

export function validateDraft(draft: BookLayoutDraft): string | null {
  if (!draft.name.trim()) return 'Layout name is required.';
  if (!/^[a-z0-9_-]+$/i.test(draft.name)) {
    return 'Layout name may contain letters, digits, hyphen, underscore only.';
  }
  const { pageCountMin: lo, pageCountMax: hi, pageCountStep: step, pageCountDefault: def } = draft;
  if (!Number.isInteger(lo) || lo < 1) return 'Page count min must be a positive integer.';
  if (!Number.isInteger(hi) || hi < 1) return 'Page count max must be a positive integer.';
  if (!Number.isInteger(step) || step < 1) return 'Page count step must be a positive integer.';
  if (hi < lo) return 'Page count max must be ≥ min.';
  if ((hi - lo) % step !== 0) {
    return `Page count max (${hi}) must be reachable from min (${lo}) in steps of ${step} — books step in multiples of the signature size.`;
  }
  if (!Number.isInteger(def) || def < lo || def > hi || (def - lo) % step !== 0) {
    return `Page count default (${def}) must be within [${lo}, ${hi}] and on the step-${step} grid.`;
  }
  for (const field of ['bleedMm', 'gutterMm', 'paperThicknessMm', 'coverThicknessMm'] as const) {
    if (draft[field] < 0) return `${field} must be a non-negative number.`;
  }
  const coverErr = validateRole(draft.cover, 'Cover');
  if (coverErr) return coverErr;
  const innerErr = validateRole(draft.innerPage, 'Inner page');
  if (innerErr) return innerErr;
  if (draft.hasBackCover) {
    const backErr = validateRole(draft.backCover, 'Back cover');
    if (backErr) return backErr;
  }
  return null;
}

// ─── Small reusable inputs (mirrors CalendarLayoutEditor's NumberField) ──────

function NumberField({
  label, value, onChange, step = 0.01, min, max, suffix,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-zinc-700">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="w-24 rounded border border-zinc-300 px-2 py-1 text-sm
                     focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
        {suffix && <span className="text-zinc-500">{suffix}</span>}
      </span>
    </label>
  );
}

// ─── One role's canvas + frames + preview (cover / innerPage / backCover) ────

function RoleEditor({
  title, role, onChange, testIdPrefix,
}: {
  title: string;
  role: BookRoleDraft;
  onChange: (next: BookRoleDraft) => void;
  testIdPrefix: string;
}) {
  const patchFrame = (i: number, next: Partial<BookFrameDraft>) => {
    const frames = [...role.frames];
    frames[i] = { ...frames[i], ...next };
    onChange({ ...role, frames });
  };
  const addFrame = () => {
    const offset = (role.frames.length * 0.04) % 0.5;
    onChange({
      ...role,
      frames: [...role.frames, { x: 0.1 + offset, y: 0.1 + offset, width: 0.3, height: 0.3 }],
    });
  };
  const removeFrame = (i: number) => {
    if (role.frames.length <= 1) return;
    onChange({ ...role, frames: role.frames.filter((_, idx) => idx !== i) });
  };

  return (
    <section
      className="rounded-lg border border-zinc-200 p-4"
      data-testid={`role-section-${testIdPrefix}`}
    >
      <h3 className="text-sm font-semibold text-zinc-900 mb-3">{title}</h3>
      <div className="grid lg:grid-cols-[1fr_200px] gap-5">
        <div>
          <div className="flex flex-wrap gap-3 mb-4">
            <NumberField
              label="Width" value={role.canvasWidthMm} step={0.1} min={0.1} suffix="mm"
              onChange={(n) => onChange({ ...role, canvasWidthMm: n })}
            />
            <NumberField
              label="Height" value={role.canvasHeightMm} step={0.1} min={0.1} suffix="mm"
              onChange={(n) => onChange({ ...role, canvasHeightMm: n })}
            />
            <NumberField
              label="DPI" value={role.dpi} step={1} min={1}
              onChange={(n) => onChange({ ...role, dpi: n })}
            />
          </div>

          <div className="flex items-baseline justify-between mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Frames (print areas)
            </h4>
            <button
              type="button"
              onClick={addFrame}
              data-testid={`${testIdPrefix}-add-frame`}
              className="text-xs px-2 py-1 rounded border border-zinc-300 hover:border-zinc-900"
            >
              + Add
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {role.frames.map((f, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end"
                data-testid={`${testIdPrefix}-frame-${i}`}
              >
                <NumberField label={`#${i + 1} X`} value={f.x} step={0.01} min={0} max={1}
                  onChange={(n) => patchFrame(i, { x: n })} />
                <NumberField label="Y" value={f.y} step={0.01} min={0} max={1}
                  onChange={(n) => patchFrame(i, { y: n })} />
                <NumberField label="W" value={f.width} step={0.01} min={0.01} max={1}
                  onChange={(n) => patchFrame(i, { width: n })} />
                <NumberField label="H" value={f.height} step={0.01} min={0.01} max={1}
                  onChange={(n) => patchFrame(i, { height: n })} />
                <button
                  type="button"
                  onClick={() => removeFrame(i)}
                  disabled={role.frames.length <= 1}
                  aria-label={`Remove frame ${i + 1}`}
                  className="self-end mb-0.5 text-zinc-400 hover:text-red-600 text-lg disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <aside className="flex flex-col gap-2" data-testid={`${testIdPrefix}-preview`}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Preview
          </h4>
          <div
            className="relative rounded border border-zinc-200 bg-white overflow-hidden"
            style={{ aspectRatio: `${role.canvasWidthMm} / ${role.canvasHeightMm}` }}
          >
            {role.frames.map((f, i) => (
              <div
                key={i}
                className="absolute rounded-sm bg-emerald-50 border border-dashed border-emerald-400"
                style={{
                  left: `${f.x * 100}%`,
                  top: `${f.y * 100}%`,
                  width: `${f.width * 100}%`,
                  height: `${f.height * 100}%`,
                }}
              />
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function BookLayoutEditor({
  initial,
  newLayoutName = 'untitled_book',
  onSave,
  onCancel,
}: BookLayoutEditorProps) {
  const [draft, setDraft] = useState<BookLayoutDraft>(() => ({
    ...defaultBookLayout(newLayoutName),
    ...initial,
    cover: { ...defaultBookLayout(newLayoutName).cover, ...(initial?.cover ?? {}) },
    innerPage: { ...defaultBookLayout(newLayoutName).innerPage, ...(initial?.innerPage ?? {}) },
    backCover: { ...defaultBookLayout(newLayoutName).backCover, ...(initial?.backCover ?? {}) },
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (next: Partial<BookLayoutDraft>) => setDraft((d) => ({ ...d, ...next }));

  const handleSave = async () => {
    setError(null);
    const validationError = validateDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    try {
      await onSave(draftToLayoutJson(draft));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6" data-testid="book-layout-editor">
      <div className="mb-6">
        <label className="flex flex-col gap-1 text-xs max-w-xs">
          <span className="font-medium text-zinc-700">Layout name</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            data-testid="book-name-input"
            className="rounded border border-zinc-300 px-2 py-1.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </label>
      </div>

      <section className="rounded-lg border border-zinc-200 p-4 mb-5">
        <h3 className="text-sm font-semibold text-zinc-900 mb-3">Book settings</h3>
        <div className="flex flex-wrap gap-4">
          <NumberField label="Bleed" value={draft.bleedMm} step={0.5} min={0} suffix="mm"
            onChange={(n) => patch({ bleedMm: n })} />
          <NumberField label="Gutter" value={draft.gutterMm} step={0.5} min={0} suffix="mm"
            onChange={(n) => patch({ gutterMm: n })} />
          <NumberField label="Paper thickness" value={draft.paperThicknessMm} step={0.01} min={0} suffix="mm"
            onChange={(n) => patch({ paperThicknessMm: n })} />
          <NumberField label="Cover thickness" value={draft.coverThicknessMm} step={0.01} min={0} suffix="mm"
            onChange={(n) => patch({ coverThicknessMm: n })} />
        </div>
        <div className="flex flex-wrap gap-4 mt-4">
          <NumberField label="Min pages" value={draft.pageCountMin} step={1} min={1}
            onChange={(n) => patch({ pageCountMin: n })} />
          <NumberField label="Max pages" value={draft.pageCountMax} step={1} min={1}
            onChange={(n) => patch({ pageCountMax: n })} />
          <NumberField label="Step" value={draft.pageCountStep} step={1} min={1}
            onChange={(n) => patch({ pageCountStep: n })} />
          <NumberField label="Default pages" value={draft.pageCountDefault} step={1} min={1}
            onChange={(n) => patch({ pageCountDefault: n })} />
        </div>
      </section>

      <div className="flex flex-col gap-5">
        <RoleEditor
          title="Front cover"
          role={draft.cover}
          onChange={(cover) => patch({ cover })}
          testIdPrefix="cover"
        />
        <RoleEditor
          title="Inner page"
          role={draft.innerPage}
          onChange={(innerPage) => patch({ innerPage })}
          testIdPrefix="inner-page"
        />

        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={draft.hasBackCover}
            onChange={(e) => patch({ hasBackCover: e.target.checked })}
            data-testid="has-back-cover-checkbox"
          />
          Author a distinct back cover
        </label>
        {!draft.hasBackCover && (
          <p className="text-xs text-zinc-500 -mt-3">
            Without one, the back cover prints blank at the front cover&apos;s size —
            a legitimate, common choice, not an error.
          </p>
        )}
        {draft.hasBackCover && (
          <RoleEditor
            title="Back cover"
            role={draft.backCover}
            onChange={(backCover) => patch({ backCover })}
            testIdPrefix="back-cover"
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-zinc-200">
        {error && (
          <span className="text-xs text-red-600 mr-auto" data-testid="save-error">
            {error}
          </span>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-zinc-600 hover:text-zinc-900"
            data-testid="cancel-btn"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          data-testid="save-btn"
          className="px-4 py-1.5 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
