'use client';

/**
 * Ops authoring UI for calendar product layouts
 * (CALENDAR_FEATURE_PRD §5 Phase 6 Day 1).
 *
 * Controlled component — parent owns the layout JSON + handles HTTP.
 * The component composes:
 *   - Product-type picker (Single / Multi-surface / Calendar)
 *   - Mode toggle (multi-surface 12×1 vs poster 1×12)
 *   - Canvas dimensions (mm + pixel readback)
 *   - Calendar primitive placer (numeric x/y/w/h percentages for v1;
 *     drag-and-drop is a Day 2+ enhancement)
 *   - Calendar style controls (theme, calendarType default, weekStart,
 *     defaultGenzPalette when theme=Gen-Z, holidaySource)
 *   - Live `MonthTileThumb` preview of January under the active style
 *
 * Validation mirrors `validate_calendar_layout()` in api/validators.py
 * so ops gets immediate feedback before hitting Save. Submitted JSON is
 * still validated server-side as a defence in depth.
 *
 * The component intentionally does NOT call fetch() — the host page wires
 * onSave to `/api/internal/proxy/ops/layouts/<name>` so this stays unit-
 * testable without HTTP mocks.
 */

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  MONTH_NAMES_EN,
  displayLabelFor,
  resolveBaseYear,
  resolveSurfaceMonth,
  resolveThemeColors,
} from '@/lib/calendar';
import { MonthTileThumb } from '@/components/MonthTileThumb';

// Fabric.js references `window` at module load time — skip SSR.
const CalendarFabricPreview = dynamic(
  () => import('@/components/CalendarFabricPreview').then((m) => ({
    default: m.CalendarFabricPreview,
  })),
  {
    ssr: false,
    loading: () => (
      <div className="w-full min-h-[400px] rounded-2xl bg-slate-100 animate-pulse" />
    ),
  },
);
import type {
  CalendarTheme,
  CalendarType,
  GenzPalette,
  HolidayLocale,
  HolidayEntry,
  LayoutCalendar,
  LayoutCalendarStyle,
  SurfaceOverride,
  WeekStart,
} from '@/types/calendar';

// ─── Mode helpers ───────────────────────────────────────────────────────────

export type CalendarMode = 'multi-surface' | 'poster';

/**
 * Map an ops UI mode choice to (monthRange.count, calendars.length). v1 only
 * ships the two configurations enumerated by PRD §11.1.
 */
function modeToCounts(mode: CalendarMode): { count: number; calendars: number } {
  return mode === 'poster'
    ? { count: 1, calendars: 12 }
    : { count: 12, calendars: 1 };
}

// ─── Field defaults for "new layout" mode ───────────────────────────────────

function defaultCalendarLayout(name: string): CalendarLayoutDraft {
  return {
    name,
    productType: 'calendar',
    mode: 'multi-surface',
    canvasWidthMm: 127,
    canvasHeightMm: 177.8,
    dpi: 300,
    frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.42 }],
    calendars: [{ x: 0.05, y: 0.55, width: 0.9, height: 0.42 }],
    style: {
      themePreset: 'modern-minimalist',
      calendarType: 'english',
      weekStart: 'sunday',
      holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      defaultGenzPalette: 'butter',
    },
    defaultYear: 'current',
    maskUrl: null,
    maskOnExport: false,
  };
}

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Draft state held by this editor — keeps mm + pixel coords un-coupled so
 * the user can edit either independently. The `toLayoutJson()` helper
 * flattens this into the canonical layout JSON shape that the validator
 * + materialize_surfaces expect.
 */
export interface CalendarLayoutDraft {
  name: string;
  productType: 'calendar';
  mode: CalendarMode;
  canvasWidthMm: number;
  canvasHeightMm: number;
  dpi: number;
  frames: Array<{ x: number; y: number; width: number; height: number }>;
  calendars: LayoutCalendar[];
  style: LayoutCalendarStyle;
  defaultYear: number | 'current';
  /** Path to the paper mask in storage/masks/ (review fix #5). Empty → no mask. */
  maskUrl?: string | null;
  maskOnExport?: boolean;
  /**
   * Per-month structural overrides (PRD §10.2.1 + Phase 6.2). Sparse map
   * keyed by surface key ("month_01".."month_12"). Each entry can override
   * `frames` and/or `calendars` and/or `overlays` for that month; absent
   * keys inherit the template. Banned fields (canvas, monthRange,
   * themePreset, calendarType, weekStart) are rejected by the server-side
   * validator at save time.
   */
  surfaceOverrides?: import('@/types/calendar').SurfaceOverrideMap;
}

export interface CalendarLayoutEditorProps {
  /** Initial draft to seed the editor — pass undefined for a brand-new layout. */
  initial?: Partial<CalendarLayoutDraft>;
  /** Override the new-layout name (defaults to "untitled_calendar"). */
  newLayoutName?: string;
  /** Available Gen-Z palettes — host page fetches from /api/calendar-styles/modern-genz. */
  genzPalettes: GenzPalette[];
  /** Sample holidays to show in the live preview thumb. Host page fetches per locale+year. */
  previewHolidays?: HolidayEntry[];
  /** Called when ops clicks Save. Parent serialises + POSTs. */
  onSave: (layoutJson: Record<string, unknown>) => void | Promise<void>;
  /** Called on Cancel button click. Parent navigates away or resets. */
  onCancel?: () => void;
}

// ─── Layout-JSON serializer ─────────────────────────────────────────────────

/**
 * Flatten the editor draft into the canonical layout JSON shape consumed
 * by api/validators.py::validate_calendar_layout +
 * services/calendar_layout.py::materialize_surfaces.
 *
 * In v1 the mode toggle drives both monthRange.count and how many
 * calendar primitives are emitted; ops doesn't directly edit those
 * fields.
 */
export function draftToLayoutJson(
  draft: CalendarLayoutDraft,
  options?: { posterCustomLayout?: boolean },
): Record<string, unknown> {
  const { count } = modeToCounts(draft.mode);

  let outCalendars: LayoutCalendar[];
  if (draft.mode === 'poster') {
    if (options?.posterCustomLayout && draft.calendars.length === 12) {
      // Custom layout — pass draft.calendars verbatim, only ensuring every
      // entry has a monthOffset. Fix #3 from P6.1 review.
      outCalendars = draft.calendars.map((c, i) => ({ ...c, monthOffset: i }));
    } else {
      // Default 4×3 auto-tile from the first entry's size. Ops gets a
      // sensible starting point without having to position each one.
      const base = draft.calendars[0] ?? { x: 0, y: 0, width: 0.25, height: 0.2 };
      outCalendars = Array.from({ length: 12 }, (_, i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        return {
          x: base.x + col * base.width,
          y: base.y + row * base.height,
          width: base.width,
          height: base.height,
          monthOffset: i,
        };
      });
    }
  } else {
    // Multi-surface: one calendar primitive shared across all 12 surfaces.
    outCalendars = [{ ...(draft.calendars[0] ?? { x: 0, y: 0, width: 1, height: 1 }) }];
  }

  const widthPx = Math.round((draft.canvasWidthMm * draft.dpi) / 25.4);
  const heightPx = Math.round((draft.canvasHeightMm * draft.dpi) / 25.4);

  const out: Record<string, unknown> = {
    name: draft.name,
    productType: draft.productType,
    canvas: {
      width: widthPx,
      height: heightPx,
      widthMm: draft.canvasWidthMm,
      heightMm: draft.canvasHeightMm,
      dpi: draft.dpi,
    },
    frames: draft.frames,
    calendars: outCalendars,
    calendar: draft.style,
    monthRange: { count, defaultYear: draft.defaultYear },
  };
  // Mask is layout-global per PRD §10.2.1 — only emit when ops set it,
  // so layouts without masks stay JSON-tidy.
  if (draft.maskUrl) {
    out.maskUrl = draft.maskUrl;
    out.maskOnExport = draft.maskOnExport ?? false;
  }
  // Per-month surfaceOverrides (P6.2). Only emit when at least one month
  // is customised — sparse map keeps the JSON minimal for the common case
  // of "all 12 months use the template".
  if (draft.surfaceOverrides && Object.keys(draft.surfaceOverrides).length > 0) {
    out.surfaceOverrides = draft.surfaceOverrides;
  }
  return out;
}

// ─── Client-side validation (mirrors api/validators.py) ─────────────────────

export function validateDraft(draft: CalendarLayoutDraft): string | null {
  if (!draft.name.trim()) return 'Layout name is required.';
  if (!/^[a-z0-9_-]+$/i.test(draft.name)) {
    return 'Layout name may contain letters, digits, hyphen, underscore only.';
  }
  if (draft.canvasWidthMm <= 0 || draft.canvasHeightMm <= 0) {
    return 'Canvas dimensions must be positive.';
  }
  if (draft.dpi <= 0) return 'DPI must be positive.';
  if (draft.frames.length === 0) {
    return 'At least one photo frame is required.';
  }
  // Frame bounds (review L1) — mirrors the calendar-primitive checks below
  // so frames-past-edge get caught client-side too, not just at server save.
  for (let i = 0; i < draft.frames.length; i++) {
    const f = draft.frames[i];
    if (f.x < 0 || f.y < 0 || f.width <= 0 || f.height <= 0) {
      return `Frame ${i + 1} must have positive dimensions and non-negative origin.`;
    }
    if (f.x + f.width > 1 + 1e-6) {
      return `Frame ${i + 1} extends past the right canvas edge.`;
    }
    if (f.y + f.height > 1 + 1e-6) {
      return `Frame ${i + 1} extends past the bottom canvas edge.`;
    }
  }
  const { count, calendars } = modeToCounts(draft.mode);
  if (count * calendars !== 12) {
    return `Mode produces ${count * calendars} months — must be exactly 12.`;
  }
  for (const c of draft.calendars) {
    if (c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0) {
      return 'Calendar position must have positive dimensions and non-negative origin.';
    }
    if (c.x + c.width > 1 + 1e-6) return 'Calendar extends past the right canvas edge.';
    if (c.y + c.height > 1 + 1e-6) return 'Calendar extends past the bottom canvas edge.';
  }
  if (!draft.style.themePreset) return 'Theme preset is required.';
  if (!draft.style.calendarType) return 'Calendar-type default is required.';
  if (!draft.style.weekStart) return 'Week start is required.';

  // Per-month override bounds (review fix C / L1). Mirror the template
  // bounds checks so an invalid override doesn't slip through to the
  // server. The server's `validate_calendar_layout` would also reject
  // these but client-side feedback is faster.
  if (draft.surfaceOverrides) {
    for (const [key, ovr] of Object.entries(draft.surfaceOverrides)) {
      if (ovr.frames) {
        for (let i = 0; i < ovr.frames.length; i++) {
          const f = ovr.frames[i];
          if (f.x < 0 || f.y < 0 || f.width <= 0 || f.height <= 0) {
            return `surfaceOverrides['${key}'].frames[${i}] must have positive dimensions and non-negative origin.`;
          }
          if (f.x + f.width > 1 + 1e-6) {
            return `surfaceOverrides['${key}'].frames[${i}] extends past the right canvas edge.`;
          }
          if (f.y + f.height > 1 + 1e-6) {
            return `surfaceOverrides['${key}'].frames[${i}] extends past the bottom canvas edge.`;
          }
        }
      }
      if (ovr.calendars) {
        for (let i = 0; i < ovr.calendars.length; i++) {
          const c = ovr.calendars[i];
          if (c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0) {
            return `surfaceOverrides['${key}'].calendars[${i}] must have positive dimensions and non-negative origin.`;
          }
          if (c.x + c.width > 1 + 1e-6) {
            return `surfaceOverrides['${key}'].calendars[${i}] extends past the right canvas edge.`;
          }
          if (c.y + c.height > 1 + 1e-6) {
            return `surfaceOverrides['${key}'].calendars[${i}] extends past the bottom canvas edge.`;
          }
        }
      }
    }
  }
  return null;
}

// ─── Per-month surface list (P6.2) ──────────────────────────────────────────

/**
 * Compute the 12 month-tile entries for a given draft. Each entry is a
 * `(surfaceIndex, monthOffset, year, month, key, label)` tuple matching
 * what `services/calendar_layout.py::materialize_surfaces` would emit.
 *
 * Used by both the tile pane (for rendering MonthTileThumb previews) and
 * the per-month override modal (to know which (year, month) it's editing).
 *
 * Iteration order matches the Python materialize loop so tile indices are
 * stable across both sides.
 */
export function surfaceMonthList(
  draft: CalendarLayoutDraft,
  now?: Date,
): Array<{
  surfaceIndex: number;
  cellIndex: number;
  year: number;
  month: number;
  key: string;
  label: string;
}> {
  const calendarType = draft.style.calendarType;
  const baseYear = draft.defaultYear === 'current'
    ? resolveBaseYear(calendarType, now)
    : draft.defaultYear;
  const { count, calendars } = modeToCounts(draft.mode);

  const out: Array<{
    surfaceIndex: number;
    cellIndex: number;
    year: number;
    month: number;
    key: string;
    label: string;
  }> = [];
  let cellIndex = 0;
  for (let s = 0; s < count; s++) {
    for (let j = 0; j < calendars; j++) {
      const { year, month } = resolveSurfaceMonth(s, j, calendarType, baseYear);
      out.push({
        surfaceIndex: s,
        cellIndex: cellIndex++,
        year,
        month,
        key: `month_${String(month).padStart(2, '0')}`,
        label: displayLabelFor(year, month),
      });
    }
  }
  return out;
}

// ─── Per-month override modal (P6.2) ────────────────────────────────────────

interface MonthOverrideModalProps {
  /** "month_01"..."month_12" */
  monthKey: string;
  /** Human label, e.g. "January 2026". */
  monthLabel: string;
  /** Resolved (year, month) for the live mini-preview. */
  previewYear: number;
  previewMonth: number;
  /** Multi-surface vs poster — drives which fields are editable (review fix A+B). */
  mode: CalendarMode;
  /** monthOffset of this tile (0 in multi-surface mode; 0..11 in poster). */
  monthOffset: number;
  /** Template values to start from + diff against. */
  templateFrames: Array<{ x: number; y: number; width: number; height: number }>;
  templateCalendars: LayoutCalendar[];
  /** Current override for this month, if any. */
  currentOverride?: SurfaceOverride;
  /** Theme colours + dot cycle for the in-modal live preview (review fix L5). */
  previewColors: import('@/lib/calendar').ResolvedThemeColors;
  previewDotCycle: readonly string[];
  previewHolidays?: HolidayEntry[];
  previewWeekStart: WeekStart;
  /** Save action — pass null to clear (= "Reset to template"). */
  onSave: (override: SurfaceOverride | null) => void;
  onClose: () => void;
}

/**
 * Field-level diff for frame arrays. Replaces the original
 * `JSON.stringify` equality which was order-fragile (review fix L2).
 * Only compares the four numeric coords that matter for layout.
 */
function framesEqual(
  a: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  b: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].x !== b[i].x ||
      a[i].y !== b[i].y ||
      a[i].width !== b[i].width ||
      a[i].height !== b[i].height
    ) return false;
  }
  return true;
}

/**
 * Field-level diff for calendar primitive arrays. monthOffset defaults to
 * 0 when absent so multi-surface mode (no explicit offset) compares OK.
 */
function calendarsEqual(
  a: ReadonlyArray<LayoutCalendar>,
  b: ReadonlyArray<LayoutCalendar>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].x !== b[i].x ||
      a[i].y !== b[i].y ||
      a[i].width !== b[i].width ||
      a[i].height !== b[i].height ||
      (a[i].monthOffset ?? 0) !== (b[i].monthOffset ?? 0)
    ) return false;
  }
  return true;
}

function MonthOverrideModal({
  monthKey,
  monthLabel,
  previewYear,
  previewMonth,
  mode,
  monthOffset,
  templateFrames,
  templateCalendars,
  currentOverride,
  previewColors,
  previewDotCycle,
  previewHolidays,
  previewWeekStart,
  onSave,
  onClose,
}: MonthOverrideModalProps) {
  // ── Poster-mode field gating (review fix A + B) ──────────────────────────
  // Poster mode: frames are physical-page-global, so per-month frames
  // override is conceptually meaningless. Hide the frames editor entirely.
  const showFramesEditor = mode === 'multi-surface';

  // Poster mode: filter the calendars list to just the ONE entry whose
  // monthOffset matches this tile (the others belong to other months).
  // Multi-surface: one calendar shared across all surfaces → show all of
  // them (typically just 1).
  const editableCalendarIndices = useMemo(
    () =>
      mode === 'multi-surface'
        ? templateCalendars.map((_, i) => i)
        : templateCalendars
            .map((c, i) => ((c.monthOffset ?? 0) === monthOffset ? i : -1))
            .filter((i) => i >= 0),
    [mode, templateCalendars, monthOffset],
  );

  // Local draft seeded from the current override or the template.
  const [frames, setFrames] = useState(() =>
    currentOverride?.frames ? [...currentOverride.frames] : [...templateFrames],
  );
  const [calendars, setCalendars] = useState(() =>
    currentOverride?.calendars ? [...currentOverride.calendars] : [...templateCalendars],
  );

  const patchFrame = (i: number, next: Partial<{ x: number; y: number; width: number; height: number }>) =>
    setFrames((arr) => arr.map((f, idx) => idx === i ? { ...f, ...next } : f));
  const patchCalendar = (i: number, next: Partial<LayoutCalendar>) =>
    setCalendars((arr) => arr.map((c, idx) => idx === i ? { ...c, ...next } : c));
  const addFrame = () =>
    setFrames((arr) => [...arr, { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }]);
  const removeFrame = (i: number) =>
    setFrames((arr) => arr.length <= 1 ? arr : arr.filter((_, idx) => idx !== i));

  const handleSave = () => {
    // Poster mode never emits a frames diff (the editor wasn't shown for it).
    const framesDiffer = showFramesEditor && !framesEqual(frames, templateFrames);
    const calendarsDiffer = !calendarsEqual(calendars, templateCalendars);
    if (!framesDiffer && !calendarsDiffer) {
      onSave(null);
      return;
    }
    const override: SurfaceOverride = {};
    if (framesDiffer) override.frames = frames;
    if (calendarsDiffer) {
      // Holistic-audit bug fix: in poster mode each surfaceOverrides[month_NN]
      // key represents exactly ONE calendar (the one with monthOffset matching
      // this tile). Emitting the full 12-element calendars array would make
      // materialize_surfaces deep-copy all 12 onto a single surface entry,
      // breaking the "one calendar per surface" contract the engine relies on.
      // In multi-surface mode there's typically one shared calendar, so all
      // editable indices stay (templateCalendars.length is 1 anyway).
      override.calendars = mode === 'poster'
        ? editableCalendarIndices.map((i) => calendars[i])
        : calendars;
    }
    onSave(override);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="month-override-title"
      data-testid="month-override-modal"
      className="fixed inset-0 z-50 grid place-items-center bg-zinc-900/40 p-4 overflow-y-auto"
    >
      <div className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-xl my-4">
        <header className="flex items-center justify-between mb-4">
          <h2 id="month-override-title" className="text-lg font-semibold text-zinc-900">
            Per-month override: <strong>{monthLabel}</strong>
            <span className="ml-2 text-xs text-zinc-500 font-mono">{monthKey}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close month override modal"
            data-testid="month-override-close"
            className="text-zinc-400 hover:text-zinc-900 text-2xl leading-none"
          >
            ×
          </button>
        </header>

        {/* Active-override banner (review fix L3) — only shows when this
            month is already customised, so ops knows they're editing an
            existing override rather than the template. */}
        {currentOverride && (
          <div
            className="mb-3 px-3 py-2 rounded bg-purple-50 border border-purple-200 text-xs text-purple-900"
            data-testid="month-override-active-banner"
          >
            This month currently has a customisation
            {currentOverride.frames ? ' (frames)' : ''}
            {currentOverride.calendars ? ' (calendar position)' : ''}.
            Use <strong>Reset to template</strong> below to clear it.
          </div>
        )}

        <p className="text-xs text-zinc-500 mb-4">
          Changes here only affect <strong>{monthLabel}</strong>. Untouched
          fields stay inherited from the layout template.
          {mode === 'poster' && (
            <> In <strong>poster mode</strong>, frames are shared across the
            whole page so only the calendar position is editable per-month.</>
          )}
        </p>

        <div className="grid lg:grid-cols-[1fr_180px] gap-5">
          <div>
            {/* Frames override — hidden in poster mode (review fix A) */}
            {showFramesEditor ? (
              <section className="mb-5" data-testid="month-override-frames-section">
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Frames (for this month only)
                  </h3>
                  <button
                    type="button"
                    onClick={addFrame}
                    data-testid="month-override-add-frame"
                    className="text-xs px-2 py-1 rounded border border-zinc-300 hover:border-zinc-900"
                  >
                    + Add
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {frames.map((f, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end"
                      data-testid={`month-override-frame-${i}`}
                    >
                      <NumberField label={`#${i + 1} X`} value={f.x}
                        step={0.01} min={0} max={1}
                        onChange={(n) => patchFrame(i, { x: n })} />
                      <NumberField label="Y" value={f.y}
                        step={0.01} min={0} max={1}
                        onChange={(n) => patchFrame(i, { y: n })} />
                      <NumberField label="W" value={f.width}
                        step={0.01} min={0.01} max={1}
                        onChange={(n) => patchFrame(i, { width: n })} />
                      <NumberField label="H" value={f.height}
                        step={0.01} min={0.01} max={1}
                        onChange={(n) => patchFrame(i, { height: n })} />
                      <button
                        type="button"
                        onClick={() => removeFrame(i)}
                        disabled={frames.length <= 1}
                        aria-label={`Remove frame ${i + 1}`}
                        className="self-end mb-0.5 text-zinc-400 hover:text-red-600 text-lg disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <section
                className="mb-5 text-xs text-zinc-500 italic"
                data-testid="month-override-frames-section-hidden"
              >
                Frames editor is hidden in poster mode — frames are shared
                across the physical print page.
              </section>
            )}

            {/* Calendars override — in poster mode, filter to just the
                calendar whose monthOffset matches this tile (review fix B). */}
            <section className="mb-5" data-testid="month-override-calendars-section">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
                Calendar position (for this month only)
              </h3>
              <div className="flex flex-col gap-2">
                {editableCalendarIndices.map((i) => {
                  const c = calendars[i];
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-4 gap-2 items-end"
                      data-testid={`month-override-cal-${i}`}
                    >
                      <NumberField label={`Cal ${i + 1} X`} value={c.x}
                        step={0.01} min={0} max={1}
                        onChange={(n) => patchCalendar(i, { x: n })} />
                      <NumberField label="Y" value={c.y}
                        step={0.01} min={0} max={1}
                        onChange={(n) => patchCalendar(i, { y: n })} />
                      <NumberField label="W" value={c.width}
                        step={0.01} min={0.01} max={1}
                        onChange={(n) => patchCalendar(i, { width: n })} />
                      <NumberField label="H" value={c.height}
                        step={0.01} min={0.01} max={1}
                        onChange={(n) => patchCalendar(i, { height: n })} />
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* Live preview (review fix L5) — uses the in-progress override
              values so ops can see the effect before saving. */}
          <aside className="flex flex-col gap-1" data-testid="month-override-live-preview">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Live preview
            </h3>
            <div className="aspect-square rounded border border-zinc-200 bg-white p-1">
              <MonthTileThumb
                year={previewYear}
                month={previewMonth}
                weekStart={previewWeekStart}
                cells={{}}
                holidays={previewHolidays}
                colors={previewColors}
                dotCycle={previewDotCycle}
                ariaLabel={`Preview of ${monthLabel} with override`}
              />
            </div>
            <p className="text-[10px] text-zinc-500">
              Reflects the in-progress override colours + grid. Frame /
              calendar position effects are visualised at full render.
            </p>
          </aside>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-zinc-200">
          <button
            type="button"
            onClick={() => onSave(null)}
            data-testid="month-override-reset"
            disabled={!currentOverride}
            className="text-xs text-zinc-600 hover:text-red-700 underline disabled:opacity-30 disabled:cursor-not-allowed disabled:no-underline"
          >
            Reset to template
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              data-testid="month-override-cancel"
              className="px-3 py-1.5 text-sm text-zinc-600 hover:text-zinc-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              data-testid="month-override-save"
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800"
            >
              Save customisation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Small reusable inputs ──────────────────────────────────────────────────

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

// ─── Step indicator ─────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<WizardStep, string> = {
  1: 'Basics',
  2: 'Layout',
  3: 'Style',
  4: 'Review',
};

function StepIndicator({
  step,
  onStep,
}: {
  step: WizardStep;
  onStep: (s: WizardStep) => void;
}) {
  return (
    <nav
      className="flex items-center gap-1 mb-6"
      aria-label="Wizard steps"
      data-testid="step-indicator"
    >
      {([1, 2, 3, 4] as WizardStep[]).map((s) => {
        const active = s === step;
        const done   = s < step;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onStep(s)}
            aria-current={active ? 'step' : undefined}
            data-testid={`step-${s}`}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all',
              active
                ? 'bg-zinc-900 text-white shadow'
                : done
                  ? 'bg-zinc-200 text-zinc-600 hover:bg-zinc-300'
                  : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200',
            ].join(' ')}
          >
            <span
              className={[
                'w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold',
                active ? 'bg-white text-zinc-900' : 'bg-zinc-400 text-white',
              ].join(' ')}
            >
              {done ? '✓' : s}
            </span>
            {STEP_LABELS[s]}
          </button>
        );
      })}
    </nav>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CalendarLayoutEditor({
  initial,
  newLayoutName = 'untitled_calendar',
  genzPalettes,
  previewHolidays = [],
  onSave,
  onCancel,
}: CalendarLayoutEditorProps) {
  const [draft, setDraft] = useState<CalendarLayoutDraft>(() => ({
    ...defaultCalendarLayout(newLayoutName),
    ...initial,
    style: { ...defaultCalendarLayout(newLayoutName).style, ...(initial?.style ?? {}) },
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<WizardStep>(1);
  const [posterCustomLayout, setPosterCustomLayout] = useState(false);
  const [openMonthKey, setOpenMonthKey] = useState<string | null>(null);
  const [yearInputBuffer, setYearInputBuffer] = useState<string>(
    typeof draft.defaultYear === 'number' ? String(draft.defaultYear) : ''
  );

  const patch = (next: Partial<CalendarLayoutDraft>) =>
    setDraft((d) => ({ ...d, ...next }));
  const patchStyle = (next: Partial<LayoutCalendarStyle>) =>
    setDraft((d) => ({ ...d, style: { ...d.style, ...next } }));
  const patchCalendar = (index: number, next: Partial<LayoutCalendar>) =>
    setDraft((d) => {
      const arr = [...d.calendars];
      arr[index] = { ...(arr[index] ?? { x: 0, y: 0, width: 1, height: 1 }), ...next };
      return { ...d, calendars: arr };
    });

  const addFrame = () =>
    setDraft((d) => {
      const offset = (d.frames.length * 0.04) % 0.5;
      return {
        ...d,
        frames: [...d.frames, { x: 0.1 + offset, y: 0.1 + offset, width: 0.3, height: 0.3 }],
      };
    });
  const removeFrame = (index: number) =>
    setDraft((d) =>
      d.frames.length <= 1 ? d : { ...d, frames: d.frames.filter((_, i) => i !== index) }
    );
  const patchFrame = (
    index: number,
    next: Partial<{ x: number; y: number; width: number; height: number }>,
  ) =>
    setDraft((d) => {
      const arr = [...d.frames];
      arr[index] = { ...arr[index], ...next };
      return { ...d, frames: arr };
    });

  const primaryCalendar: LayoutCalendar = draft.calendars[0]
    ?? { x: 0, y: 0, width: 1, height: 1 };

  const previewPalette = useMemo(
    () => draft.style.themePreset === 'modern-genz'
      ? genzPalettes.find((p) => p.name === draft.style.defaultGenzPalette) ?? genzPalettes[0]
      : undefined,
    [draft.style.themePreset, draft.style.defaultGenzPalette, genzPalettes],
  );
  const { colors: previewColors, dotCycle: previewDotCycle } = useMemo(
    () => resolveThemeColors(draft.style.themePreset, previewPalette),
    [draft.style.themePreset, previewPalette],
  );

  const monthTiles = useMemo(
    () => surfaceMonthList(draft),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.mode, draft.style.calendarType, draft.defaultYear],
  );

  const previewYear = draft.defaultYear === 'current'
    ? new Date().getFullYear()
    : draft.defaultYear;

  const handleSave = async () => {
    setError(null);
    const validationError = validateDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    try {
      await onSave(draftToLayoutJson(draft, { posterCustomLayout }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  // ── Poster custom-layout toggle handler (kept as a named fn for clarity) ──
  const handlePosterCustomToggle = (enable: boolean) => {
    setPosterCustomLayout(enable);
    if (enable && draft.calendars.length < 12) {
      const base = primaryCalendar;
      const maxCellW = Math.max(0.01, (1 - base.x) / 4);
      const maxCellH = Math.max(0.01, (1 - base.y) / 3);
      const cellW = Math.min(base.width, maxCellW);
      const cellH = Math.min(base.height, maxCellH);
      const seeded: LayoutCalendar[] = Array.from({ length: 12 }, (_, i) => ({
        x: base.x + (i % 4) * cellW,
        y: base.y + Math.floor(i / 4) * cellH,
        width: cellW,
        height: cellH,
        monthOffset: i,
      }));
      patch({ calendars: seeded });
    } else if (!enable) {
      patch({ calendars: [draft.calendars[0] ?? primaryCalendar] });
    }
  };

  // ── Shared aside: MonthTileThumb for steps 1 / 3 / 4 ───────────────────
  const MonthPreviewAside = (
    <aside
      className="sticky top-6 self-start flex flex-col gap-2"
      data-testid="live-preview"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Preview · January {previewYear}
      </h3>
      <div
        className="rounded border border-zinc-200 p-2 bg-white"
        style={{ aspectRatio: `${draft.canvasWidthMm} / ${draft.canvasHeightMm}` }}
      >
        <MonthTileThumb
          year={previewYear}
          month={1}
          weekStart={draft.style.weekStart}
          cells={{}}
          holidays={previewHolidays}
          colors={previewColors}
          dotCycle={previewDotCycle}
          ariaLabel={`Preview of ${MONTH_NAMES_EN[0]} ${previewYear}`}
        />
      </div>
      <p className="text-xs text-zinc-500">
        Grid math matches the 300 DPI render.
        {previewHolidays.length > 0 && <> {previewHolidays.length} holidays shown.</>}
      </p>
    </aside>
  );

  // ── Nav buttons ──────────────────────────────────────────────────────────
  const NavButtons = (
    <div className="flex items-center justify-between pt-4 border-t border-zinc-200 mt-4">
      <button
        type="button"
        onClick={() => setStep((s) => Math.max(1, s - 1) as WizardStep)}
        disabled={step === 1}
        className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        ← Back
      </button>
      {step < 4 ? (
        <button
          type="button"
          onClick={() => setStep((s) => Math.min(4, s + 1) as WizardStep)}
          className="px-5 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800"
        >
          Next →
        </button>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            data-testid="save-btn"
            className="px-5 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Saving…' : 'Save layout'}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
              data-testid="cancel-btn"
            >
              Cancel
            </button>
          )}
          {error && (
            <span className="text-sm text-red-600" data-testid="save-error">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div
      className={`max-w-5xl mx-auto p-6 ${step === 2 ? '' : 'grid gap-6 lg:grid-cols-[1fr_320px]'}`}
      data-testid="calendar-layout-editor"
    >
      {/* Step indicator spans full width */}
      {step !== 2 && (
        <div className="lg:col-span-2">
          <StepIndicator step={step} onStep={setStep} />
        </div>
      )}

      {/* ── Step 1: Basics ─────────────────────────────────────────────── */}
      {step === 1 && (
        <>
          <div className="flex flex-col gap-6">
            <section>
              <h2 className="text-lg font-semibold text-zinc-900 mb-1">Layout basics</h2>
              <p className="text-xs text-zinc-500 mb-3">Name this layout and choose what kind of calendar product it is.</p>
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-700">Layout name</span>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    data-testid="layout-name"
                    className="rounded border border-zinc-300 px-2 py-1.5 text-sm font-mono"
                  />
                </label>
                <div className="text-xs text-zinc-500">
                  Product type: <strong>Calendar</strong>. For non-calendar layouts use the{' '}
                  <a href="/editor/layouts" className="underline hover:text-zinc-900" data-testid="regular-editor-link">
                    regular layout editor →
                  </a>
                </div>
              </div>
            </section>

            <section data-testid="mode-toggle">
              <h2 className="text-lg font-semibold text-zinc-900 mb-1">Calendar mode</h2>
              <p className="text-xs text-zinc-500 mb-3">Desk/wall calendars get one page per month. Posters print all 12 months on a single page.</p>
              <div className="grid sm:grid-cols-2 gap-3">
                {(['multi-surface', 'poster'] as CalendarMode[]).map((m) => {
                  const active = draft.mode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => patch({ mode: m })}
                      aria-pressed={active}
                      className={[
                        'px-4 py-3 text-sm rounded-lg border text-left transition-all',
                        active
                          ? 'bg-zinc-900 text-white border-zinc-900 shadow'
                          : 'bg-white text-zinc-700 border-zinc-300 hover:border-zinc-500',
                      ].join(' ')}
                    >
                      <span className="font-semibold block">
                        {m === 'multi-surface' ? '12 pages' : '1 page (poster)'}
                      </span>
                      <span className="text-xs opacity-70">
                        {m === 'multi-surface' ? 'Desk / wall — one month per surface' : 'All 12 months on a single sheet'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-zinc-900 mb-1">Canvas size</h2>
              <p className="text-xs text-zinc-500 mb-3">Physical dimensions of the print area. 300 DPI is standard for print.</p>
              <div className="grid grid-cols-3 gap-3">
                <NumberField label="Width (mm)" value={draft.canvasWidthMm} step={1} min={1} suffix="mm"
                  onChange={(n) => patch({ canvasWidthMm: n })} />
                <NumberField label="Height (mm)" value={draft.canvasHeightMm} step={1} min={1} suffix="mm"
                  onChange={(n) => patch({ canvasHeightMm: n })} />
                <NumberField label="DPI" value={draft.dpi} step={1} min={1}
                  onChange={(n) => patch({ dpi: n })} />
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Renders at{' '}
                <strong>
                  {Math.round((draft.canvasWidthMm * draft.dpi) / 25.4)} ×{' '}
                  {Math.round((draft.canvasHeightMm * draft.dpi) / 25.4)} px
                </strong>
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-zinc-900 mb-1">Year anchor</h2>
              <p className="text-xs text-zinc-500 mb-3">Auto-roll updates automatically each year. Fixed year locks the calendar to a specific year.</p>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" checked={draft.defaultYear === 'current'}
                    onChange={() => { patch({ defaultYear: 'current' }); setYearInputBuffer(''); }}
                    data-testid="year-current" />
                  <span>Auto-roll (current year at render time)</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" checked={draft.defaultYear !== 'current'}
                    onChange={() => { const y = new Date().getFullYear(); patch({ defaultYear: y }); setYearInputBuffer(String(y)); }}
                    data-testid="year-fixed-radio" />
                  <span>Fixed year:</span>
                  <input
                    type="number"
                    value={draft.defaultYear === 'current' ? '' : yearInputBuffer}
                    disabled={draft.defaultYear === 'current'}
                    min={2000} max={2100}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setYearInputBuffer(raw);
                      const n = parseInt(raw, 10);
                      if (Number.isFinite(n)) patch({ defaultYear: n });
                    }}
                    data-testid="year-fixed-input"
                    className="w-24 rounded border border-zinc-300 px-2 py-1 text-sm disabled:bg-zinc-50 disabled:text-zinc-400"
                  />
                </label>
              </div>
            </section>

            {NavButtons}
          </div>

          {MonthPreviewAside}
        </>
      )}

      {/* ── Step 2: Layout (full-width with Fabric canvas) ─────────────── */}
      {step === 2 && (
        <div className="flex flex-col gap-4">
          <StepIndicator step={step} onStep={setStep} />

          <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
            {/* Left: controls */}
            <div className="flex flex-col gap-5">
              {/* Photo frames */}
              <section data-testid="frames-section">
                <div className="flex items-baseline justify-between mb-2">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-900">Photo frames</h2>
                    <p className="text-xs text-zinc-500">Drag green blocks on canvas to reposition.</p>
                  </div>
                  <button type="button" onClick={addFrame}
                    data-testid="add-frame-btn"
                    className="text-xs px-2 py-1 rounded border border-zinc-300 hover:border-zinc-900 shrink-0">
                    + Add
                  </button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {draft.frames.map((_, i) => (
                    <div key={i} className="flex items-center justify-between px-2 py-1.5 rounded bg-emerald-50 border border-emerald-200 text-xs">
                      <span className="font-medium text-emerald-800">Frame {i + 1}</span>
                      <button type="button" onClick={() => removeFrame(i)}
                        disabled={draft.frames.length <= 1}
                        aria-label={`Remove frame ${i + 1}`}
                        data-testid={`remove-frame-${i}`}
                        className="text-zinc-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-base leading-none">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              {/* Calendar block controls */}
              <section>
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">Calendar block</h2>
                  <p className="text-xs text-zinc-500 mb-2">
                    {draft.mode === 'multi-surface'
                      ? 'Drag the teal block on the canvas to position the calendar grid.'
                      : 'Poster: 12 mini-calendars in a 4×3 grid. Enable custom layout to position each one.'}
                  </p>
                </div>
                {draft.mode === 'poster' && (
                  <label className="flex items-center gap-2 text-sm" data-testid="poster-custom-layout-section">
                    <input
                      type="checkbox"
                      checked={posterCustomLayout}
                      data-testid="poster-custom-toggle"
                      onChange={(e) => handlePosterCustomToggle(e.target.checked)}
                    />
                    <span>Custom layout (drag each month independently)</span>
                  </label>
                )}
              </section>

              {/* Paper mask */}
              <section data-testid="mask-section">
                <h2 className="text-sm font-semibold text-zinc-900 mb-1">Paper mask <span className="text-zinc-400 font-normal">(optional)</span></h2>
                <input
                  type="text"
                  value={draft.maskUrl ?? ''}
                  placeholder="e.g. desk_calendar_mask.png"
                  onChange={(e) => patch({ maskUrl: e.target.value || null })}
                  data-testid="mask-url"
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs font-mono mb-1.5"
                />
                <label className="flex items-center gap-2 text-xs text-zinc-600">
                  <input type="checkbox" checked={!!draft.maskOnExport} disabled={!draft.maskUrl}
                    onChange={(e) => patch({ maskOnExport: e.target.checked })} data-testid="mask-on-export" />
                  Apply mask on export
                </label>
              </section>

              {/* Precise values disclosure */}
              <details className="text-xs text-zinc-600">
                <summary className="cursor-pointer font-medium text-zinc-700 hover:text-zinc-900 select-none">
                  Precise values (fractions 0..1)
                </summary>
                <div className="mt-3 flex flex-col gap-4">
                  <div data-testid="frames-precise">
                    <p className="font-medium text-zinc-700 mb-2">Frames</p>
                    {draft.frames.map((frame, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1fr_1fr_1fr] gap-2 mb-2" data-testid={`frame-row-${i}`}>
                        <NumberField label={`#${i+1} X`} value={frame.x} step={0.01} min={0} max={1} onChange={(n) => patchFrame(i, { x: n })} />
                        <NumberField label="Y" value={frame.y} step={0.01} min={0} max={1} onChange={(n) => patchFrame(i, { y: n })} />
                        <NumberField label="W" value={frame.width} step={0.01} min={0.01} max={1} onChange={(n) => patchFrame(i, { width: n })} />
                        <NumberField label="H" value={frame.height} step={0.01} min={0.01} max={1} onChange={(n) => patchFrame(i, { height: n })} />
                      </div>
                    ))}
                  </div>
                  <div data-testid="calendar-primitive-fields-wrapper">
                    <p className="font-medium text-zinc-700 mb-2">
                      Calendar {draft.mode === 'poster' ? '(seed position)' : '(position)'}
                    </p>
                    <div className="grid grid-cols-4 gap-2" data-testid="calendar-primitive-fields">
                      <NumberField label="X" value={primaryCalendar.x} step={0.01} min={0} max={1} onChange={(n) => patchCalendar(0, { x: n })} />
                      <NumberField label="Y" value={primaryCalendar.y} step={0.01} min={0} max={1} onChange={(n) => patchCalendar(0, { y: n })} />
                      <NumberField label="W" value={primaryCalendar.width} step={0.01} min={0.01} max={1} onChange={(n) => patchCalendar(0, { width: n })} />
                      <NumberField label="H" value={primaryCalendar.height} step={0.01} min={0.01} max={1} onChange={(n) => patchCalendar(0, { height: n })} />
                    </div>
                    <p className="mt-1 text-zinc-500" data-testid="calendar-primitive-readback">
                      {(primaryCalendar.width * draft.canvasWidthMm).toFixed(1)} ×{' '}
                      {(primaryCalendar.height * draft.canvasHeightMm).toFixed(1)} mm
                    </p>
                    {posterCustomLayout && draft.mode === 'poster' && (
                      <div className="mt-3 flex flex-col gap-2">
                        {draft.calendars.slice(0, 12).map((cal, i) => (
                          <div key={i} className="grid grid-cols-[auto_1fr_1fr_1fr_1fr] gap-2 items-end" data-testid={`poster-cal-row-${i}`}>
                            <span className="text-zinc-500 self-end mb-1 w-8">Cal {i+1}</span>
                            <NumberField label="X" value={cal.x} step={0.01} min={0} max={1} onChange={(n) => patchCalendar(i, { x: n })} />
                            <NumberField label="Y" value={cal.y} step={0.01} min={0} max={1} onChange={(n) => patchCalendar(i, { y: n })} />
                            <NumberField label="W" value={cal.width} step={0.01} min={0.01} max={1} onChange={(n) => patchCalendar(i, { width: n })} />
                            <NumberField label="H" value={cal.height} step={0.01} min={0.01} max={1} onChange={(n) => patchCalendar(i, { height: n })} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </details>
            </div>

            {/* Right: Interactive Fabric canvas */}
            <div className="min-h-[500px]" data-testid="live-preview-canvas">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Canvas layout — drag to reposition
                </h3>
                <span className="text-xs text-zinc-400">
                  <span className="inline-block w-3 h-3 rounded-sm bg-emerald-200 border border-emerald-500 mr-1" />Frame
                  <span className="inline-block w-3 h-3 rounded-sm bg-sky-200 border border-sky-400 ml-3 mr-1" />Calendar
                </span>
              </div>
              <CalendarFabricPreview
                widthMm={draft.canvasWidthMm}
                heightMm={draft.canvasHeightMm}
                frames={draft.frames}
                calendars={draft.calendars}
                mode={draft.mode}
                posterCustomLayout={posterCustomLayout}
                onFramesChange={(f) => patch({ frames: f })}
                onCalendarsChange={(c) => patch({ calendars: c })}
              />
            </div>
          </div>

          {NavButtons}
        </div>
      )}

      {/* ── Step 3: Style ──────────────────────────────────────────────── */}
      {step === 3 && (
        <>
          <div className="flex flex-col gap-6">
            <section>
              <h2 className="text-lg font-semibold text-zinc-900 mb-1">Theme</h2>
              <p className="text-xs text-zinc-500 mb-3">Sets the default visual style. Customers can change it on their end.</p>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-700">Theme preset</span>
                  <select
                    value={draft.style.themePreset}
                    onChange={(e) => patchStyle({ themePreset: e.target.value as CalendarTheme })}
                    data-testid="style-theme"
                    className="rounded border border-zinc-300 px-2 py-1.5 text-sm"
                  >
                    <option value="modern-minimalist">Modern · Minimalist</option>
                    <option value="modern-genz">Modern · Gen-Z</option>
                    <option value="weekday-highlight">Weekday Highlight</option>
                  </select>
                </label>
                {draft.style.themePreset === 'modern-genz' && (
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium text-zinc-700">Default Gen-Z palette</span>
                    <select
                      value={draft.style.defaultGenzPalette ?? genzPalettes[0]?.name ?? ''}
                      onChange={(e) => patchStyle({ defaultGenzPalette: e.target.value })}
                      data-testid="style-genz-palette"
                      className="rounded border border-zinc-300 px-2 py-1.5 text-sm"
                    >
                      {genzPalettes.map((p) => (
                        <option key={p.name} value={p.name}>{p.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-700">Calendar type</span>
                  <select
                    value={draft.style.calendarType}
                    onChange={(e) => patchStyle({ calendarType: e.target.value as CalendarType })}
                    data-testid="style-calendar-type"
                    className="rounded border border-zinc-300 px-2 py-1.5 text-sm"
                  >
                    <option value="english">English · Jan–Dec</option>
                    <option value="financial">Financial · Apr–Mar</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-700">Week start</span>
                  <select
                    value={draft.style.weekStart}
                    onChange={(e) => patchStyle({ weekStart: e.target.value as WeekStart })}
                    data-testid="style-week-start"
                    className="rounded border border-zinc-300 px-2 py-1.5 text-sm"
                  >
                    <option value="sunday">Sunday</option>
                    <option value="monday">Monday</option>
                  </select>
                </label>
              </div>
            </section>

            <section data-testid="holiday-source">
              <h2 className="text-lg font-semibold text-zinc-900 mb-1">Holidays</h2>
              <p className="text-xs text-zinc-500 mb-3">Auto-loaded from storage. Shown as coloured dots on matching dates.</p>
              <div className="flex flex-wrap gap-4 items-center">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.style.holidaySource.enabled}
                    onChange={(e) => patchStyle({ holidaySource: { ...draft.style.holidaySource, enabled: e.target.checked } })}
                    data-testid="holiday-enabled" />
                  <span>Auto-load holidays</span>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-700">Locale</span>
                  <select value={draft.style.holidaySource.locale}
                    onChange={(e) => patchStyle({ holidaySource: { ...draft.style.holidaySource, locale: e.target.value as HolidayLocale } })}
                    data-testid="holiday-locale"
                    className="rounded border border-zinc-300 px-2 py-1.5 text-sm">
                    <option value="en-IN">en-IN (India)</option>
                    <option value="generic">generic (universal)</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.style.holidaySource.showInCells}
                    disabled={!draft.style.holidaySource.enabled}
                    onChange={(e) => patchStyle({ holidaySource: { ...draft.style.holidaySource, showInCells: e.target.checked } })}
                    data-testid="holiday-show-in-cells" />
                  <span>Show holiday pills on cells</span>
                </label>
              </div>
            </section>

            {NavButtons}
          </div>

          {MonthPreviewAside}
        </>
      )}

      {/* ── Step 4: Review & Save ──────────────────────────────────────── */}
      {step === 4 && (
        <>
          <div className="flex flex-col gap-6">
            <section data-testid="month-tile-pane">
              <h2 className="text-lg font-semibold text-zinc-900 mb-1">Per-month review</h2>
              <p className="text-xs text-zinc-500 mb-3">
                Click a month to override its frames or calendar position. Purple border = already customised.
              </p>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {monthTiles.map((tile) => {
                  const isOverridden = Boolean(draft.surfaceOverrides?.[tile.key]);
                  return (
                    <button
                      key={tile.key}
                      type="button"
                      onClick={() => setOpenMonthKey(tile.key)}
                      data-testid={`month-tile-${tile.key}`}
                      data-month-customized={isOverridden ? 'true' : 'false'}
                      className="relative flex flex-col gap-1.5 rounded-lg border bg-white p-2 text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1"
                      style={{ borderColor: isOverridden ? '#A855F7' : '#E5E7EB', borderWidth: isOverridden ? 2 : 1 }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{tile.label}</span>
                        {isOverridden && (
                          <span className="text-[9px] font-semibold uppercase tracking-wide rounded bg-purple-100 text-purple-800 px-1 py-0.5"
                            data-testid={`customized-badge-${tile.key}`}>
                            Customized
                          </span>
                        )}
                      </div>
                      <div className="aspect-square">
                        <MonthTileThumb year={tile.year} month={tile.month} weekStart={draft.style.weekStart}
                          cells={{}} holidays={previewHolidays} colors={previewColors} dotCycle={previewDotCycle}
                          ariaLabel={`${tile.label} thumbnail`} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {NavButtons}
          </div>

          {MonthPreviewAside}
        </>
      )}

      {/* Per-month override modal (P6.2). Mounted at the document level so
          it floats above the tile pane regardless of grid placement. */}
      {openMonthKey && (() => {
        const tile = monthTiles.find(t => t.key === openMonthKey);
        if (!tile) {
          setOpenMonthKey(null);
          return null;
        }
        const currentOverride = draft.surfaceOverrides?.[openMonthKey];
        // In poster mode the modal needs to know which calendar entry
        // corresponds to this tile's monthOffset (review fix B).
        const monthOffset =
          draft.mode === 'poster'
            ? tile.cellIndex   // poster: cellIndex 0..11 maps 1:1 to monthOffset
            : 0;
        return (
          <MonthOverrideModal
            monthKey={openMonthKey}
            monthLabel={tile.label}
            previewYear={tile.year}
            previewMonth={tile.month}
            mode={draft.mode}
            monthOffset={monthOffset}
            templateFrames={draft.frames}
            templateCalendars={draft.calendars}
            currentOverride={currentOverride}
            previewColors={previewColors}
            previewDotCycle={previewDotCycle}
            previewHolidays={previewHolidays.filter((h) =>
              h.date.startsWith(`${tile.year}-${String(tile.month).padStart(2, '0')}-`),
            )}
            previewWeekStart={draft.style.weekStart}
            onSave={(override) => {
              setDraft((d) => {
                const next = { ...(d.surfaceOverrides ?? {}) };
                if (override === null) {
                  delete next[openMonthKey];
                } else {
                  next[openMonthKey] = override;
                }
                return {
                  ...d,
                  surfaceOverrides:
                    Object.keys(next).length === 0 ? undefined : next,
                };
              });
              setOpenMonthKey(null);
            }}
            onClose={() => setOpenMonthKey(null)}
          />
        );
      })()}
    </div>
  );
}
