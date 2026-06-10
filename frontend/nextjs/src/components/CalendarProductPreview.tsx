'use client';

/**
 * Customer-facing preview page for a calendar product
 * (CALENDAR_FEATURE_PRD §5 Phase 5 Day 1).
 *
 * Renders the three customer-controllable knobs (§10.3) plus a 12-month
 * thumbnail grid. Tapping a month tile opens the per-month canvas editor
 * for that surface (wired in Day 2).
 *
 * Controlled component: parent owns the state, this component only
 * fires onChange callbacks. The parent persists into
 * `CanvasData.editor_state.canvases[*].calendar` via the existing
 * canvas-state save path.
 *
 * Three controls:
 *   - ThemePresetToggle  — 3-way segmented (Minimalist / Gen-Z / Weekday-Highlight)
 *   - GenZPaletteSwatches — 4 palette swatches, visible ONLY when theme = genz
 *   - CalendarTypeToggle — 2-way segmented (English / Financial)
 *
 * Year is auto-populated, read-only (§10.4):
 *   English   → today.year
 *   Financial → today.month >= 4 ? today.year : today.year − 1
 */

import { useMemo, useState } from 'react';
import {
  MONTH_NAMES_EN,
  resolveBaseYear,
  displayLabelFor,
  resolveSurfaceMonth,
  resolveThemeColors,
} from '@/lib/calendar';
import { MonthTileThumb } from '@/components/MonthTileThumb';
import type {
  CalendarTheme,
  CalendarType,
  CalendarCellOverride,
  GenzPalette,
  HolidayEntry,
  WeekStart,
} from '@/types/calendar';

// ─── Sub-component: ThemePresetToggle ────────────────────────────────────────

const THEME_OPTIONS: readonly { value: CalendarTheme; label: string }[] = [
  { value: 'modern-minimalist',  label: 'Minimalist' },
  { value: 'modern-genz',        label: 'Gen-Z' },
  { value: 'weekday-highlight',  label: 'Weekday Highlight' },
];

interface ThemePresetToggleProps {
  value: CalendarTheme;
  onChange: (next: CalendarTheme) => void;
}

export function ThemePresetToggle({ value, onChange }: ThemePresetToggleProps) {
  return (
    <fieldset
      className="inline-flex rounded-lg bg-zinc-100 p-1 gap-1"
      aria-label="Theme preset"
      data-testid="theme-preset-toggle"
    >
      <legend className="sr-only">Theme preset</legend>
      {THEME_OPTIONS.map(opt => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors ' +
              (active
                ? 'bg-white text-zinc-900 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-900')
            }
          >
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}

// ─── Sub-component: GenZPaletteSwatches ─────────────────────────────────────

interface GenZPaletteSwatchesProps {
  value: string | undefined;
  palettes: GenzPalette[];
  onChange: (paletteName: string) => void;
}

/**
 * Visible only when ThemePresetToggle is `modern-genz`. Per PRD §4.0
 * minimal-controls principle, this is the customer's ONLY Gen-Z
 * customisation — they pick one of 4 coordinated swatches; we never
 * expose the underlying 6 colour roles individually.
 */
export function GenZPaletteSwatches({
  value,
  palettes,
  onChange,
}: GenZPaletteSwatchesProps) {
  if (palettes.length === 0) return null;
  return (
    <fieldset
      className="inline-flex items-center gap-2"
      aria-label="Gen-Z palette"
      data-testid="genz-palette-swatches"
    >
      <legend className="sr-only">Gen-Z palette</legend>
      {palettes.map(p => {
        const selected = value === p.name;
        return (
          <button
            key={p.name}
            type="button"
            onClick={() => onChange(p.name)}
            aria-pressed={selected}
            title={p.label}
            data-palette={p.name}
            className={
              'grid grid-cols-2 grid-rows-2 overflow-hidden rounded-md ' +
              'h-9 w-9 shrink-0 cursor-pointer transition-transform ' +
              'hover:-translate-y-0.5 ' +
              (selected ? 'ring-2 ring-zinc-900 ring-offset-1' : 'ring-1 ring-zinc-200')
            }
          >
            <span style={{ background: p.bg }} className="block" />
            <span style={{ background: p.month }} className="block" />
            <span style={{ background: p.grid }} className="block" />
            <span style={{ background: p.pill }} className="block" />
          </button>
        );
      })}
    </fieldset>
  );
}

// ─── Sub-component: CalendarTypeToggle ──────────────────────────────────────

const CAL_TYPE_OPTIONS: readonly { value: CalendarType; label: string }[] = [
  { value: 'english',   label: 'English · Jan–Dec' },
  { value: 'financial', label: 'Financial · Apr–Mar' },
];

interface CalendarTypeToggleProps {
  value: CalendarType;
  onChange: (next: CalendarType) => void;
}

export function CalendarTypeToggle({ value, onChange }: CalendarTypeToggleProps) {
  return (
    <fieldset
      className="inline-flex rounded-lg bg-zinc-100 p-1 gap-1"
      aria-label="Calendar type"
      data-testid="calendar-type-toggle"
    >
      <legend className="sr-only">Calendar type</legend>
      {CAL_TYPE_OPTIONS.map(opt => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors ' +
              (active
                ? 'bg-white text-zinc-900 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-900')
            }
          >
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}

// ─── Feb 29 leap-year helper (used by the leap-year toast, §11.8) ──────────

/**
 * Returns the number of customer entries pinned to an ISO date of
 * "YYYY-02-29" where the current render year (resolved via
 * `resolveBaseYear` for the active calendarType) is NOT a leap year.
 *
 * PRD §11.8 — when a calendar auto-rolls from 2024 (leap) to 2025
 * (non-leap), Feb 29 entries survive in editor_state.cells but won't
 * render. The customer should see a one-time toast: "1 entry on
 * Feb 29 won't appear in 2025." so they're not surprised.
 *
 * Counts entries (each cell can have up to 3), not cells.
 */
export function countLeapDayOrphans(
  cellsPerCanvas: ReadonlyArray<Record<string, CalendarCellOverride[]>>,
  calendarType: CalendarType,
  now?: Date,
): { count: number; renderYear: number } {
  const renderYear = resolveBaseYear(calendarType, now);
  // Standard Gregorian leap-year rule.
  const isLeap = (renderYear % 4 === 0 && renderYear % 100 !== 0) || renderYear % 400 === 0;
  if (isLeap) return { count: 0, renderYear };
  let count = 0;
  for (const surfaceCells of cellsPerCanvas) {
    for (const iso of Object.keys(surfaceCells)) {
      // ISO ends with "-02-29" (10 chars). Avoid date parsing entirely so
      // a stray "02-29" inside a custom format isn't matched.
      if (iso.endsWith('-02-29') && iso.length === 10) {
        count += surfaceCells[iso]?.length ?? 0;
      }
    }
  }
  return { count, renderYear };
}

// ─── Orphan-count helper (used by the flip warning modal, §11.4) ───────────

/**
 * How many customer entries would stop rendering if the customer toggled
 * calendarType to `next`. Each cell can have up to 3 entries; we count
 * individual entries, not cells.
 *
 * An entry orphans when its ISO date's year+month is NOT in the set of
 * (year, month) tuples that the new range covers. Entries don't move
 * between surfaces — they stay anchored to their original ISO date and
 * either render or don't, depending on which months are visible.
 */
export function countOrphanedEntries(
  cellsPerCanvas: ReadonlyArray<Record<string, CalendarCellOverride[]>>,
  nextCalendarType: CalendarType,
  now?: Date,
): number {
  const nextBaseYear = resolveBaseYear(nextCalendarType, now);
  const visibleMonths = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const { year, month } = resolveSurfaceMonth(i, 0, nextCalendarType, nextBaseYear);
    visibleMonths.add(`${year}-${String(month).padStart(2, '0')}`);
  }
  let orphaned = 0;
  for (const surfaceCells of cellsPerCanvas) {
    for (const iso of Object.keys(surfaceCells)) {
      const yearMonth = iso.slice(0, 7);  // "YYYY-MM"
      if (!visibleMonths.has(yearMonth)) {
        orphaned += surfaceCells[iso]?.length ?? 0;
      }
    }
  }
  return orphaned;
}

// ─── Calendar-type flip warning modal (PRD §11.4) ───────────────────────────

interface FlipWarningModalProps {
  orphanCount: number;
  /** The calendar type the customer is trying to switch TO. */
  nextCalendarType: CalendarType;
  onConfirm: () => void;
  onCancel: () => void;
}

function FlipWarningModal({
  orphanCount,
  nextCalendarType,
  onConfirm,
  onCancel,
}: FlipWarningModalProps) {
  const otherTypeLabel =
    nextCalendarType === 'financial' ? 'English' : 'Financial';
  const nextLabel = nextCalendarType === 'financial' ? 'Financial year' : 'English calendar';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="flip-warning-title"
      data-testid="flip-warning-modal"
      className="fixed inset-0 z-50 grid place-items-center bg-zinc-900/40 p-4"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 id="flip-warning-title" className="text-lg font-semibold text-zinc-900">
          Switch to {nextLabel}?
        </h2>
        <p className="mt-2 text-sm text-zinc-600 leading-relaxed">
          Switching changes the visible month range.{' '}
          <strong className="font-semibold text-zinc-900">
            {orphanCount} {orphanCount === 1 ? 'entry' : 'entries'}
          </strong>{' '}
          outside the new range will be hidden but not deleted. Switch back to{' '}
          <strong>{otherTypeLabel}</strong> to see them again.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-zinc-700 hover:text-zinc-900"
            data-testid="flip-warning-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 rounded-md hover:bg-zinc-800"
            data-testid="flip-warning-confirm"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Year-display helper ─────────────────────────────────────────────────────

/**
 * What the read-only year badge shows next to the controls.
 *   english   → "2026"
 *   financial → "FY 2026–27" (short Indian convention)
 */
export function yearBadgeText(calendarType: CalendarType, baseYear: number): string {
  if (calendarType === 'financial') {
    const end = String(baseYear + 1).slice(-2);
    return `FY ${baseYear}–${end}`;
  }
  return String(baseYear);
}

// ─── Top-level component ────────────────────────────────────────────────────

export interface CalendarProductPreviewProps {
  /** Current theme; controlled by parent. */
  themePreset: CalendarTheme;
  onThemePresetChange: (next: CalendarTheme) => void;

  /** Current Gen-Z palette name (relevant only when theme = genz). */
  genzPalette?: string;
  /** Available Gen-Z palettes, fetched once from `/api/calendar-styles/modern-genz`. */
  genzPalettes: GenzPalette[];
  onGenzPaletteChange: (paletteName: string) => void;

  /** Current calendar type; controlled by parent. */
  calendarType: CalendarType;
  onCalendarTypeChange: (next: CalendarType) => void;

  /** Called when a customer taps a month tile. surfaceIndex is 0..11. */
  onMonthTileClick?: (surfaceIndex: number, year: number, month: number) => void;

  /**
   * Per-canvas customer cell entries, indexed by surface (0..11). Used to
   * compute the orphan count for the calendar-type flip warning modal
   * (§11.4). Optional — if absent, no warning is shown (no entries to
   * orphan).
   */
  cellsPerCanvas?: ReadonlyArray<Record<string, CalendarCellOverride[]>>;

  /**
   * Holidays to draw as dots inside the month tile thumbs. Flat list;
   * `MonthTileThumb` filters per-month internally. Parent typically
   * fetches via `/api/holidays/<locale>/<year>` and passes the combined
   * list across all years in the visible range.
   */
  holidays?: HolidayEntry[];

  /**
   * Week-start preference. Affects both the thumb header order and the
   * grid offset. Defaults to 'sunday' (en-IN convention).
   */
  weekStart?: WeekStart;

  /**
   * Optional override of "today" for deterministic tests. Production
   * passes nothing and `resolveBaseYear` reads `new Date()`.
   */
  now?: Date;
}

export function CalendarProductPreview({
  themePreset,
  onThemePresetChange,
  genzPalette,
  genzPalettes,
  onGenzPaletteChange,
  calendarType,
  onCalendarTypeChange,
  onMonthTileClick,
  cellsPerCanvas,
  holidays,
  weekStart = 'sunday',
  now,
}: CalendarProductPreviewProps) {
  // Resolve theme colours + dot cycle once per render — every tile uses
  // the same scheme. Gen-Z palette flows in when themePreset === modern-genz.
  const activePaletteObj = useMemo(
    () => (themePreset === 'modern-genz'
      ? genzPalettes.find(p => p.name === genzPalette) ?? genzPalettes[0]
      : undefined),
    [themePreset, genzPalette, genzPalettes],
  );
  const { colors: thumbColors, dotCycle } = useMemo(
    () => resolveThemeColors(themePreset, activePaletteObj),
    [themePreset, activePaletteObj],
  );
  const baseYear = useMemo(
    () => resolveBaseYear(calendarType, now),
    [calendarType, now],
  );

  // ── Flip warning modal state (PRD §11.4) ────────────────────────────────
  // When the customer clicks the calendar-type toggle, intercept the
  // change. If any of their existing entries would orphan under the new
  // range, hold the change in `pendingFlip` and pop the modal; commit only
  // after explicit confirmation.
  const [pendingFlip, setPendingFlip] = useState<CalendarType | null>(null);

  const handleCalendarTypeClick = (next: CalendarType) => {
    if (next === calendarType) return;
    const orphans = cellsPerCanvas
      ? countOrphanedEntries(cellsPerCanvas, next, now)
      : 0;
    if (orphans > 0) {
      setPendingFlip(next);
      return;
    }
    onCalendarTypeChange(next);
  };

  const pendingOrphanCount =
    pendingFlip && cellsPerCanvas
      ? countOrphanedEntries(cellsPerCanvas, pendingFlip, now)
      : 0;

  // 12-month tile metadata. Each tile resolves to its real (year, month)
  // so the customer sees "April 2026", "May 2026", …, "March 2027" in
  // Financial mode rather than a jumbled order.
  const tiles = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const { year, month } = resolveSurfaceMonth(i, 0, calendarType, baseYear);
      return {
        surfaceIndex: i,
        year,
        month,
        label: displayLabelFor(year, month),
        monthShort: MONTH_NAMES_EN[month - 1].slice(0, 3),
      };
    });
  }, [calendarType, baseYear]);

  const showGenzPalettes = themePreset === 'modern-genz';

  // ── Feb 29 toast (PRD §11.8) ──────────────────────────────────────────
  // One-time, dismissible. Customer dismisses via the X; we don't persist
  // the dismissal across sessions — re-opening a layout that still has
  // Feb 29 entries on a non-leap year reminds them again, which matches
  // the PRD intent ("Customer can roll back to a leap year to see them").
  const leapDayOrphans = useMemo(
    () => cellsPerCanvas
      ? countLeapDayOrphans(cellsPerCanvas, calendarType, now)
      : { count: 0, renderYear: 0 },
    [cellsPerCanvas, calendarType, now],
  );
  const [leapDayToastDismissed, setLeapDayToastDismissed] = useState(false);
  // Re-arm the toast when the orphan count changes to >0 (e.g. customer adds an
  // entry on Feb 29). Done during render via previous-value tracking rather than
  // in an effect, so it doesn't trigger an extra commit/cascade — React applies
  // the adjustment within the same render. See "You Might Not Need an Effect".
  const [prevLeapOrphanCount, setPrevLeapOrphanCount] = useState(leapDayOrphans.count);
  if (leapDayOrphans.count !== prevLeapOrphanCount) {
    setPrevLeapOrphanCount(leapDayOrphans.count);
    if (leapDayOrphans.count > 0) setLeapDayToastDismissed(false);
  }

  return (
    <div className="w-full max-w-5xl mx-auto p-4 sm:p-6" data-testid="calendar-product-preview">
      {/* ── Controls bar ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 mb-6 pb-4 border-b border-zinc-200">
        <ThemePresetToggle value={themePreset} onChange={onThemePresetChange} />

        {showGenzPalettes && (
          <GenZPaletteSwatches
            value={genzPalette}
            palettes={genzPalettes}
            onChange={onGenzPaletteChange}
          />
        )}

        <CalendarTypeToggle value={calendarType} onChange={handleCalendarTypeClick} />

        <div
          className="ml-auto text-sm font-semibold text-zinc-700"
          data-testid="year-badge"
          aria-label="Calendar year"
        >
          {yearBadgeText(calendarType, baseYear)}
        </div>
      </div>

      {/* ── Feb 29 toast (PRD §11.8) ───────────────────────────────────── */}
      {leapDayOrphans.count > 0 && !leapDayToastDismissed && (
        <div
          role="status"
          data-testid="leap-day-toast"
          className="mb-4 px-4 py-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 flex items-start gap-3"
        >
          <span aria-hidden className="text-base leading-none mt-0.5">⚠️</span>
          <div className="flex-1 text-sm">
            <strong className="font-semibold">
              {leapDayOrphans.count === 1
                ? `1 entry on Feb 29 won't appear in ${leapDayOrphans.renderYear}.`
                : `${leapDayOrphans.count} entries on Feb 29 won't appear in ${leapDayOrphans.renderYear}.`}
            </strong>{' '}
            They&apos;re saved with the original date and will reappear if you switch back to a leap year.
          </div>
          <button
            type="button"
            onClick={() => setLeapDayToastDismissed(true)}
            data-testid="leap-day-toast-dismiss"
            aria-label="Dismiss Feb 29 notification"
            className="text-amber-700 hover:text-amber-900 text-lg leading-none px-1"
          >
            ×
          </button>
        </div>
      )}

      {/* ── 12 month tiles (Day-2 will replace placeholder with real thumbs) ─ */}
      <div
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
        data-testid="month-tiles-grid"
      >
        {tiles.map(t => (
          <button
            key={t.surfaceIndex}
            type="button"
            onClick={() => onMonthTileClick?.(t.surfaceIndex, t.year, t.month)}
            className="
              rounded-lg border border-zinc-200 bg-white
              p-3 text-left transition-shadow
              hover:shadow-md hover:border-zinc-300
              focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1
            "
            data-month-index={t.surfaceIndex}
            data-month-label={t.label}
          >
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
                {t.monthShort}
              </span>
              <span className="text-sm font-semibold text-zinc-900">
                {t.year}
              </span>
            </div>
            {/* Real mini-grid: same `buildMonthGrid` math as the print render,
                so the thumb is a faithful preview of the customer's design. */}
            <div className="aspect-square rounded overflow-hidden">
              <MonthTileThumb
                year={t.year}
                month={t.month}
                weekStart={weekStart}
                cells={cellsPerCanvas?.[t.surfaceIndex]}
                holidays={holidays}
                colors={thumbColors}
                dotCycle={dotCycle}
                ariaLabel={`${t.label} preview`}
              />
            </div>
          </button>
        ))}
      </div>

      {/* Calendar-type flip warning modal (PRD §11.4). Renders only when
          the customer's click would orphan ≥1 entries. */}
      {pendingFlip && (
        <FlipWarningModal
          orphanCount={pendingOrphanCount}
          nextCalendarType={pendingFlip}
          onConfirm={() => {
            const t = pendingFlip;
            setPendingFlip(null);
            onCalendarTypeChange(t);
          }}
          onCancel={() => setPendingFlip(null)}
        />
      )}
    </div>
  );
}
