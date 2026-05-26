/**
 * Shared calendar math used by both the Fabric.js editor renderer
 * (preview side) and any frontend code that needs to reason about
 * months (e.g. customer preview's "Apr 2026" tile, cell-editor panel).
 *
 * The server-side mirror of this lives in
 * `backend/django/services/calendar_layout.py` (year/month resolution)
 * and `backend/django/services/calendar_renderer.py` (grid layout).
 * Both sides MUST produce identical (year, month) and identical
 * grid topology for any (calendarType, baseYear, monthOffset, surfaceIndex)
 * input — otherwise the editor preview drifts from the 300 DPI render.
 *
 * Reference: CALENDAR_FEATURE_PRD.md §10.4 (baseYear), §11.1 (resolution
 * formula), §11.13 (IST timezone, ISO date strings throughout).
 *
 * No dependency on date-fns. Vanilla `Date` + `Intl.DateTimeFormat` cover
 * everything we need without bloating the bundle.
 */

import type {
  CalendarCellOverride,
  CalendarTheme,
  CalendarType,
  GenzPalette,
  WeekStart,
  HolidayEntry,
} from '@/types/calendar';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Hard cap of 3 entries per cell. PRD §11.10. */
export const MAX_ENTRIES_PER_CELL = 3;

// Tiny IST tz constant for the baseYear formula. We never construct a
// Date "in IST" because Date objects don't carry timezones — what we
// actually need is "what date is it in IST right now?", which we get
// by formatting with `timeZone: 'Asia/Kolkata'` and parsing back.
const IST_TIMEZONE = 'Asia/Kolkata';

// ─── Year + month resolution (§10.4 + §11.1) ────────────────────────────────

/** Returns today's date in IST as { year, month (1-12), day }. */
export function todayInIST(now?: Date): { year: number; month: number; day: number } {
  const d = now ?? new Date();
  // toLocaleString with timeZone gives us a string in IST that we then re-parse.
  // sv-SE locale is the trick to get YYYY-MM-DD HH:MM:SS regardless of the
  // user's locale, which we can split predictably.
  const parts = d
    .toLocaleString('sv-SE', { timeZone: IST_TIMEZONE })
    .split(' ')[0]
    .split('-');
  return {
    year: parseInt(parts[0], 10),
    month: parseInt(parts[1], 10),
    day: parseInt(parts[2], 10),
  };
}

/**
 * Resolve the base year for a calendar product per PRD §10.4.
 *
 *   english   → today.year
 *   financial → today.year if today.month >= 4 else today.year − 1
 */
export function resolveBaseYear(calendarType: CalendarType, now?: Date): number {
  const today = todayInIST(now);
  if (calendarType === 'financial') {
    return today.month >= 4 ? today.year : today.year - 1;
  }
  return today.year;
}

/**
 * Resolve a `monthRange.defaultYear` value (`"current"` or an int) into a
 * concrete year using the calendar type's auto-roll rule. Falls back to
 * the auto-rolled year on garbage input — defensive.
 */
export function resolveDefaultYear(
  defaultYear: number | 'current' | null | undefined,
  calendarType: CalendarType,
): number {
  if (defaultYear === 'current' || defaultYear == null) {
    return resolveBaseYear(calendarType);
  }
  if (typeof defaultYear === 'number' && Number.isFinite(defaultYear)) {
    return defaultYear;
  }
  return resolveBaseYear(calendarType);
}

/** 1 for English (January), 4 for Financial (April). */
export function startMonthFor(calendarType: CalendarType): number {
  return calendarType === 'financial' ? 4 : 1;
}

/**
 * §11.1 resolution formula: map a (surfaceIndex, monthOffset) pair to a
 * concrete (year, month) under the active calendarType + baseYear.
 *
 * Mirrors `services/calendar_layout.py::resolve_surface_month`.
 */
export function resolveSurfaceMonth(
  surfaceIndex: number,
  monthOffset: number,
  calendarType: CalendarType,
  baseYear: number,
): { year: number; month: number } {
  const start = startMonthFor(calendarType);
  const total = surfaceIndex + (monthOffset ?? 0);
  const month = ((start - 1 + total) % 12) + 1;
  const year = baseYear + Math.floor((start - 1 + total) / 12);
  return { year, month };
}

/** ZIP-filename-friendly "January 2026"-style label (§11.6). */
export function displayLabelFor(year: number, month: number): string {
  return `${MONTH_NAMES_EN[month - 1]} ${year}`;
}

// ─── Month grid construction ────────────────────────────────────────────────

/** A single date cell in the rendered grid. */
export interface GridCell {
  /** ISO date string "YYYY-MM-DD". */
  iso: string;
  /** Real Gregorian year of this cell. */
  year: number;
  /** Real Gregorian month (1..12) of this cell. */
  month: number;
  /** Day-of-month (1..31). */
  day: number;
  /** Day-of-week, 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number;
  /** True when this cell belongs to the displayed month; false for filler. */
  inMonth: boolean;
}

/**
 * Build the 35- or 42-cell grid for a given (year, month) and weekStart.
 *
 * Grid is row-major: index 0 is the top-left cell. Length is always a
 * multiple of 7 (either 35 = 5 weeks or 42 = 6 weeks, depending on
 * where the month's first day lands).
 *
 * Out-of-month "filler" cells at the start and end of the grid get
 * `inMonth: false`. The renderer uses this to grey them per PRD §11.12.
 */
export function buildMonthGrid(
  year: number,
  month: number,            // 1..12
  weekStart: WeekStart,
): GridCell[] {
  // JS Date: month is 0-indexed.
  const firstOfMonth = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = firstOfMonth.getDay();          // 0=Sun..6=Sat
  const weekStartIdx = weekStart === 'monday' ? 1 : 0;
  const leadingBlanks = (firstDow - weekStartIdx + 7) % 7;
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;

  const cells: GridCell[] = [];
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - leadingBlanks + 1;
    const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
    // Use Date arithmetic for the actual (year, month, day) of out-of-month cells.
    const d = new Date(year, month - 1, dayNum);
    cells.push({
      iso: isoFromDate(d),
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      dayOfWeek: d.getDay(),
      inMonth,
    });
  }
  return cells;
}

/** Format a Date as "YYYY-MM-DD" in local time (no UTC shift). */
export function isoFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "YYYY-MM-DD" → Date at local midnight. Returns null on parse error. */
export function isoToDate(iso: string): Date | null {
  const parts = iso.split('-');
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) return null;
  return new Date(y, m - 1, day);
}

// ─── Weekday header labels ──────────────────────────────────────────────────

/**
 * Returns 7 weekday labels in display order (respecting weekStart).
 *
 *   format = 'short' → "Mon", "Tue", ...
 *   format = 'narrow' → "M", "T", ...
 */
export function weekdayHeaderLabels(
  weekStart: WeekStart,
  format: 'short' | 'narrow' = 'short',
  locale = 'en-IN',
): string[] {
  // Sun..Sat baseline via Intl. The week-of 2026-01-04 starts on Sunday,
  // so we can iterate 7 days from there to get Sun, Mon, ..., Sat.
  const base = new Date(2026, 0, 4);
  const fmt = new Intl.DateTimeFormat(locale, { weekday: format });
  const sunFirst: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    sunFirst.push(fmt.format(d));
  }
  if (weekStart === 'monday') {
    return [...sunFirst.slice(1), sunFirst[0]];
  }
  return sunFirst;
}

// ─── Cell entry merging (§11.14 user-first + §11.10 hard cap) ───────────────

/** Entry visible in a cell — either from the customer or auto-loaded. */
export interface CellEntry {
  source: 'user' | 'holiday';
  text: string;
  dotColor?: string;
  /** For user entries: original index in `cells[iso]` so deletes wire up cleanly. */
  userIdx?: number;
}

/**
 * Merge customer entries + auto-loaded holidays for one cell, applying:
 *   - User-first precedence (§11.14)
 *   - Hard cap of MAX_ENTRIES_PER_CELL = 3 (§11.10)
 *   - Anything past the cap is silently suppressed (no "+N more" badge)
 *
 * Returns the (up to 3) visible entries in render order.
 */
export function mergeCellEntries(
  userEntries: CalendarCellOverride[] | undefined,
  holidays: HolidayEntry[] | undefined,
  dotCycle: readonly string[] = [],
): CellEntry[] {
  const out: CellEntry[] = [];

  // User text entries fill slots first.
  let userIdx = 0;
  for (const ov of userEntries ?? []) {
    if (ov.type !== 'text') continue;
    const dot = dotCycle[userIdx % Math.max(1, dotCycle.length)];
    out.push({ source: 'user', text: ov.text, dotColor: dot, userIdx });
    userIdx++;
    if (out.length >= MAX_ENTRIES_PER_CELL) return out;
  }

  // Holidays fill any remaining slots.
  for (const h of holidays ?? []) {
    out.push({ source: 'holiday', text: h.name, dotColor: h.color });
    if (out.length >= MAX_ENTRIES_PER_CELL) return out;
  }

  return out;
}

/**
 * Does this cell have an image override that should blank everything?
 * Image override is mutually exclusive with text entries.
 */
export function cellHasImageOverride(
  overrides: CalendarCellOverride[] | undefined,
): boolean {
  return Boolean(overrides?.some(o => o.type === 'image'));
}

// ─── Theme + palette colour resolution (parity with calendar_renderer.py) ───
//
// Mirrors `services/calendar_renderer.py::_resolve_colors`. We don't fetch
// the style preset JSONs from /api/calendar-styles/ for thumb rendering —
// that adds a round-trip per tile. Instead we hardcode the same color
// values that ship in `storage/calendar_styles/*.json`. If anyone tunes
// those JSONs without updating here, the editor preview will drift from
// the print. Future cleanup: fetch once + pass down, but for v1 the small
// duplication is the right trade-off.

export interface ResolvedThemeColors {
  bg: string;
  dateText: string;
  outOfMonthText: string;
  grid: string;
  weekdayText: string;
  /** Sunday-only fill (weekday-highlight theme); undefined elsewhere. */
  sundayBg?: string;
  /** Sunday-only text (weekday-highlight theme); undefined elsewhere. */
  sundayText?: string;
}

/** Hardcoded defaults — match storage/calendar_styles/modern-minimalist.json. */
const MINIMALIST_COLORS: ResolvedThemeColors = {
  bg: '#FFFFFF',
  dateText: '#18181B',
  outOfMonthText: '#CCCCCC',
  grid: '#E5E5E5',
  weekdayText: '#71717A',
};

/** storage/calendar_styles/weekday-highlight.json. */
const WEEKDAY_HIGHLIGHT_COLORS: ResolvedThemeColors = {
  bg: '#FFFFFF',
  dateText: '#1A1A1A',
  outOfMonthText: '#D4D4D8',
  grid: '#D4D4D8',
  weekdayText: '#1A1A1A',
  sundayBg: '#FEE2E2',
  sundayText: '#DC2626',
};

/**
 * Resolve the final colour scheme + dot cycle for a given (theme, palette).
 * Returns both so callers can stamp them on the thumb in one go.
 */
export function resolveThemeColors(
  theme: CalendarTheme,
  palette?: GenzPalette,
): { colors: ResolvedThemeColors; dotCycle: readonly string[] } {
  if (theme === 'modern-genz' && palette) {
    return {
      colors: {
        bg: palette.bg,
        dateText: palette.date,
        // 35% of the date colour so out-of-month cells fade gracefully on
        // whatever palette is active.
        outOfMonthText: palette.date + '59',
        grid: palette.grid,
        weekdayText: palette.weekday,
      },
      dotCycle: palette.dotCycle,
    };
  }
  if (theme === 'weekday-highlight') {
    return {
      colors: WEEKDAY_HIGHLIGHT_COLORS,
      dotCycle: ['#1F2937', '#475569', '#71717A'],
    };
  }
  // modern-minimalist (default)
  return {
    colors: MINIMALIST_COLORS,
    dotCycle: ['#F59E0B', '#EC4899', '#3B82F6'],
  };
}
