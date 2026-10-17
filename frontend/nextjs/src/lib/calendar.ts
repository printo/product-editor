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
  LayoutCalendar,
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
function todayInIST(now?: Date): { year: number; month: number; day: number } {
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
function resolveBaseYear(calendarType: CalendarType, now?: Date): number {
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
 *
 * This is the base year the PRINT uses (`materialize_surfaces` →
 * `resolve_default_year`). Anything customer- or ops-facing that shows
 * months must go through it, not `resolveBaseYear`, or a year ops pinned
 * in the template shows as today's year in the preview. Pinned by the
 * shared fixture `storage/parity-fixtures/calendar-year.json`.
 */
export function resolveDefaultYear(
  defaultYear: unknown,
  calendarType: CalendarType,
  now?: Date,
): number {
  // Integers only, and never a bool — matches the Python twin exactly.
  if (typeof defaultYear === 'number' && Number.isInteger(defaultYear)) {
    return defaultYear;
  }
  return resolveBaseYear(calendarType, now);
}

/** 1 for English (January), 4 for Financial (April). */
function startMonthFor(calendarType: CalendarType): number {
  return calendarType === 'financial' ? 4 : 1;
}

/**
 * The year `month` (1-12) falls in within a 12-month product starting at
 * `baseYear`. English: always `baseYear`. Financial: Apr–Dec are
 * `baseYear`, Jan–Mar are `baseYear + 1` (FY 2027–28 prints Feb 2028).
 */
export function yearOfMonth(
  month: number,
  calendarType: CalendarType,
  baseYear: number,
): number {
  return month >= startMonthFor(calendarType) ? baseYear : baseYear + 1;
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

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── Month heading ───────────────────────────────────────────────────────────

/** Share of a calendar block's height the month heading takes above the
 *  weekday row. Mirrors MONTH_HEADING_FRACTION in calendar_renderer.py. */
export const MONTH_HEADING_FRACTION = 0.12;

/**
 * Whether each calendar block prints its month name above the grid. On by
 * default; off with `calendar.showMonthName: false`, or when the layout
 * uses the `calendar.monthTitle` overlay (which already prints one).
 * Mirrors `month_heading_enabled` in calendar_renderer.py.
 */
export function monthHeadingEnabled(calendar: unknown): boolean {
  if (!isObjectRecord(calendar)) return true;
  if (calendar.showMonthName === false) return false;
  const title = calendar.monthTitle;
  return !(isObjectRecord(title) && title.enabled);
}

/** "January 2026" — the printed month heading. Mirrors `month_heading_text`. */
export function monthHeadingText(year: number, month: number): string {
  return displayLabelFor(year, month);
}

// ─── Photo pages ─────────────────────────────────────────────────────────────

/**
 * Printed pages of a calendar layout: `monthRange.count` (12 for one month a
 * page, 1 for the whole-year poster, whatever a future 6- or 8-page layout
 * declares); anything unreadable means the classic 12. Mirrors
 * `calendar_page_count` in services/order_qty.py.
 */
export function calendarPageCount(layout: unknown): number {
  const range = isObjectRecord(layout) ? layout.monthRange : undefined;
  const count = isObjectRecord(range) ? range.count : undefined;
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 12;
}

/**
 * Photos a calendar needs for every page to have its own: pages × photo
 * windows per page; null for anything that is not a calendar. The calendar's
 * stand-in for the order quantity in the "X of Y photos" banner, repeat picker
 * and pre-submit notice (the session's qty counts calendars bought). Mirrors
 * `calendar_photo_slots`; pinned by storage/parity-fixtures/calendar-photo-slots.json.
 */
export function calendarPhotoSlots(layout: unknown): number | null {
  if (!isObjectRecord(layout) || layout.productType !== 'calendar') return null;
  const frames = layout.frames;
  const perPage = Array.isArray(frames) && frames.length > 0 ? frames.length : 1;
  return calendarPageCount(layout) * perPage;
}

// ─── Card pages ──────────────────────────────────────────────────────────────

/** One printed month as the editor's cards show it: which photo card it
 *  prints with and where its date grid sits on the page. */
export interface CalendarCardPage {
  surfaceIndex: number;
  year: number;
  month: number;
  /** The photo card this month prints with (`surfaceIndex mod cards`), or -1 with no cards yet. */
  canvasIdx: number;
  block: LayoutCalendar;
}

function isCalendarBlock(v: unknown): v is LayoutCalendar {
  if (!isObjectRecord(v)) return false;
  return (['x', 'y', 'width', 'height'] as const).every(
    k => typeof v[k] === 'number' && Number.isFinite(v[k] as number),
  ) && (v.width as number) > 0 && (v.height as number) > 0;
}

/**
 * The months of a one-month-a-page calendar, each with its date-grid block,
 * so the cards can draw the page as printed. Mirrors `materialize_surfaces`:
 * month i prints photo card (i mod N), and a `surfaceOverrides["month_MM"]`
 * block replaces the template's. Null when the layout isn't one grid per page
 * (the whole-year poster) or has no readable block — the caller falls back to
 * the separate month tiles.
 */
export function calendarCardPages(
  months: readonly { year: number; month: number }[],
  blocks: unknown,
  surfaceOverrides: unknown,
  canvasCount: number,
): CalendarCardPage[] | null {
  if (!Array.isArray(blocks) || blocks.length !== 1 || !isCalendarBlock(blocks[0])) return null;
  const template = blocks[0];
  const overrides = isObjectRecord(surfaceOverrides) ? surfaceOverrides : {};
  return months.map(({ year, month }, i) => {
    const override = overrides[`month_${String(month).padStart(2, '0')}`];
    const custom = isObjectRecord(override) && Array.isArray(override.calendars) ? override.calendars[0] : undefined;
    return {
      surfaceIndex: i,
      year,
      month,
      canvasIdx: canvasCount > 0 ? i % canvasCount : -1,
      block: isCalendarBlock(custom) ? custom : template,
    };
  });
}

// ─── Holidays ────────────────────────────────────────────────────────────────

/**
 * The holiday locale the PRINT loads for a layout's `calendar` block, or
 * null when the print carries no holidays at all. Mirrors the gate in
 * `materialize_surfaces`: holidays load only when `holidaySource` is an
 * object with a truthy `enabled` — an absent block means none — and a
 * missing locale means `"generic"`. Anything customer-facing that shows
 * holidays must gate on this, or it previews dots the print won't have.
 * Pinned by the shared fixture `storage/parity-fixtures/calendar-holidays.json`.
 */
export function printedHolidayLocale(calendar: unknown): string | null {
  const source = isObjectRecord(calendar) ? calendar.holidaySource : undefined;
  if (!isObjectRecord(source) || !source.enabled) return null;
  return typeof source.locale === 'string' && source.locale ? source.locale : 'generic';
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
  /** Month heading ("January 2026") above the grid. */
  monthText: string;
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
  monthText: '#18181B',
  dateText: '#18181B',
  outOfMonthText: '#CCCCCC',
  grid: '#E5E5E5',
  weekdayText: '#71717A',
};

/** storage/calendar_styles/weekday-highlight.json. */
const WEEKDAY_HIGHLIGHT_COLORS: ResolvedThemeColors = {
  bg: '#FFFFFF',
  monthText: '#1A1A1A',
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
        monthText: palette.month,
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
