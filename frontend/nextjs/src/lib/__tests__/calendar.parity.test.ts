/**
 * @jest-environment node
 *
 * TS↔Python parity test for the calendar grid math
 * (CALENDAR_FEATURE_PRD §5 Phase 5 Day 0).
 *
 * Pure-function test (no React, no DOM) — runs in Jest's node env so we
 * don't pull jsdom + canvas. Loads the same fixtures file that
 * backend/django/services/tests/test_calendar_renderer.py asserts against.
 * If either side drifts from the shared ground truth, exactly one of the
 * two test suites fails and we know which.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMonthGrid,
  calendarPageCount,
  calendarCellAspect,
  calendarPhotoSlots,
  cellImageBox,
  cellImageOverflow,
  cellImagePlacement,
  displayLabelFor,
  monthHeadingEnabled,
  monthHeadingText,
  printedHolidayLocale,
  resolveDefaultYear,
  resolveSurfaceMonth,
  withCellImagePlacement,
  yearOfMonth,
} from '@/lib/calendar';
import type { CalendarType, WeekStart } from '@/types/calendar';

// ── Load shared fixtures ────────────────────────────────────────────────────

interface FixtureCase {
  name: string;
  year: number;
  month: number;
  weekStart: WeekStart;
  expectedGridSize?: number;
  firstRowIso?: string[];
  lastInMonthIso?: string;
  lastInMonthDayOfWeek?: number;
  expectedFirstInMonthIso?: string;
  expectedFirstInMonthDayOfWeek?: number;
  expectedInMonthDayCount?: number;
}

interface FixtureFile {
  _meta: unknown;
  cases: FixtureCase[];
}

// Fixtures live under storage/ so the Docker backend (which mounts
// ./storage:/app/storage) can also read them. Resolve from this file's
// own location (not process.cwd, which depends on where Jest was invoked)
// so the path stays correct whether tests run from package root or any
// subdirectory. This file: frontend/nextjs/src/lib/__tests__/ → repo root
// is four levels up, then into storage/parity-fixtures/.
const FIXTURES_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'storage',
  'parity-fixtures',
  'calendar-grid.json'
);

let fixtures: FixtureFile;

beforeAll(() => {
  if (!fs.existsSync(FIXTURES_PATH)) {
    throw new Error(
      `Parity fixtures missing at ${FIXTURES_PATH}. ` +
      `Both this test and backend/django/services/tests/test_calendar_renderer.py ` +
      `load from this path — re-add the file before running.`
    );
  }
  fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf-8')) as FixtureFile;
});

// ── Parametric parity assertions ────────────────────────────────────────────

describe('buildMonthGrid (TS) vs services/calendar_renderer.py::build_month_grid', () => {
  it('loads the shared fixtures file', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
  });

  it.each(['january_2026_sunday_first', 'january_2026_monday_first'])(
    '%s: first row ISO matches Python',
    (caseName) => {
      const c = fixtures.cases.find(x => x.name === caseName)!;
      const grid = buildMonthGrid(c.year, c.month, c.weekStart);
      const firstRow = grid.slice(0, 7).map(g => g.iso);
      expect(firstRow).toEqual(c.firstRowIso);
    }
  );

  it('january_2026_sunday_first: 35-cell grid, last in-month is Jan 31 Saturday', () => {
    const c = fixtures.cases.find(x => x.name === 'january_2026_sunday_first')!;
    const grid = buildMonthGrid(c.year, c.month, c.weekStart);
    expect(grid.length).toBe(c.expectedGridSize);
    const lastInMonth = [...grid].reverse().find(g => g.inMonth)!;
    expect(lastInMonth.iso).toBe(c.lastInMonthIso);
    expect(lastInMonth.dayOfWeek).toBe(c.lastInMonthDayOfWeek);
  });

  it.each(['april_2026_financial_year_start', 'march_2027_financial_year_end'])(
    '%s: first-in-month ISO + day-of-week match Python',
    (caseName) => {
      const c = fixtures.cases.find(x => x.name === caseName)!;
      const grid = buildMonthGrid(c.year, c.month, c.weekStart);
      const firstInMonth = grid.find(g => g.inMonth)!;
      expect(firstInMonth.iso).toBe(c.expectedFirstInMonthIso);
      expect(firstInMonth.dayOfWeek).toBe(c.expectedFirstInMonthDayOfWeek);
    }
  );

  it('february_2024 has 29 in-month days (leap year)', () => {
    const c = fixtures.cases.find(x => x.name === 'february_2024_leap_year')!;
    const grid = buildMonthGrid(c.year, c.month, c.weekStart);
    expect(grid.filter(g => g.inMonth).length).toBe(c.expectedInMonthDayCount);
  });

  it('february_2025 has 28 in-month days (non-leap)', () => {
    const c = fixtures.cases.find(x => x.name === 'february_2025_non_leap_year')!;
    const grid = buildMonthGrid(c.year, c.month, c.weekStart);
    expect(grid.filter(g => g.inMonth).length).toBe(c.expectedInMonthDayCount);
  });

  it('may_2026 spans 6 weeks (42-cell grid)', () => {
    const c = fixtures.cases.find(x => x.name === 'may_2026_six_row_month')!;
    const grid = buildMonthGrid(c.year, c.month, c.weekStart);
    expect(grid.length).toBe(c.expectedGridSize);
  });
});

// ── Year resolution: monthRange.defaultYear → months covered ────────────────
// Shared with backend/django/services/tests/test_calendar_year_parity.py,
// which asserts the same cases through materialize_surfaces (the print).

interface YearCase {
  name: string;
  defaultYear: unknown;
  calendarType: CalendarType;
  /** A date in IST, "YYYY-MM-DD". */
  today: string;
  expectedBaseYear: number;
  expectedFirstLabel: string;
  expectedLastLabel: string;
  expectedFebruaryLabel: string;
}

const yearCases = (JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(FIXTURES_PATH), 'calendar-year.json'), 'utf-8'),
) as { cases: YearCase[] }).cases;

describe('resolveDefaultYear (TS) vs services/calendar_layout.py::resolve_default_year', () => {
  it('loads the shared year fixtures', () => {
    expect(yearCases.length).toBeGreaterThan(0);
  });

  it.each(yearCases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    // Noon IST pins the IST calendar date whatever the runner's timezone.
    const now = new Date(`${c.today}T12:00:00+05:30`);
    const baseYear = resolveDefaultYear(c.defaultYear, c.calendarType, now);
    expect(baseYear).toBe(c.expectedBaseYear);

    const labels = Array.from({ length: 12 }, (_, i) => {
      const { year, month } = resolveSurfaceMonth(i, 0, c.calendarType, baseYear);
      return displayLabelFor(year, month);
    });
    expect(labels[0]).toBe(c.expectedFirstLabel);
    expect(labels[11]).toBe(c.expectedLastLabel);
    expect(displayLabelFor(yearOfMonth(2, c.calendarType, baseYear), 2)).toBe(c.expectedFebruaryLabel);
  });
});

interface HolidayCase {
  name: string;
  /** The layout's `calendar` block; null when the layout has none. */
  calendar: unknown;
  /** The locale the print loads holidays for; null when it loads none. */
  expectedLocale: string | null;
}

const holidayCases = (JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(FIXTURES_PATH), 'calendar-holidays.json'), 'utf-8'),
) as { cases: HolidayCase[] }).cases;

describe('printedHolidayLocale (TS) vs the holidaySource gate in services/calendar_layout.py::materialize_surfaces', () => {
  it('loads the shared holiday fixtures', () => {
    expect(holidayCases.length).toBeGreaterThan(0);
  });

  it.each(holidayCases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(printedHolidayLocale(c.calendar)).toBe(c.expectedLocale);
  });

  it('treats an undefined calendar block like a missing one', () => {
    expect(printedHolidayLocale(undefined)).toBeNull();
  });
});

// ── Month heading ("January 2026" above the grid) ─────────────────────────

const monthHeading = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(FIXTURES_PATH), 'calendar-month-heading.json'), 'utf-8'),
) as {
  cases: { name: string; calendar: unknown; expected: boolean }[];
  labels: { year: number; month: number; text: string }[];
};

describe('monthHeadingEnabled / monthHeadingText (TS) vs services/calendar_renderer.py', () => {
  it.each(monthHeading.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(monthHeadingEnabled(c.calendar)).toBe(c.expected);
  });

  it.each(monthHeading.labels.map(l => [l.text, l] as const))('labels %s', (_text, l) => {
    expect(monthHeadingText(l.year, l.month)).toBe(l.text);
  });
});

// ── A photo on a date (fill or fit, turns, blurred sides) ────────────────

const cellImage = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(FIXTURES_PATH), 'calendar-cell-image.json'), 'utf-8'),
) as {
  placements: { name: string; entry: unknown; expected: { fit: string; rotation: number; blur: boolean; panX: number; panY: number } }[];
  boxes: { name: string; width: number; height: number; rows: number; heading: boolean; expected: [number, number] }[];
};

describe('cellImagePlacement / cellImageBox (TS) vs services/calendar_renderer.py', () => {
  it.each(cellImage.placements.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(cellImagePlacement(c.entry)).toEqual(c.expected);
  });

  it.each(cellImage.boxes.map(c => [c.name, c] as const))('box: %s', (_name, c) => {
    const [w, h] = cellImageBox(c.width, c.height, c.rows, c.heading);
    expect(w).toBeCloseTo(c.expected[0], 9);
    expect(h).toBeCloseTo(c.expected[1], 9);
  });

  it('a change keeps the rest of the entry and remembers blur while the photo fills', () => {
    const entry = { type: 'image', uploadId: 'u', fit: 'contain', blur: true } as const;
    const filled = withCellImagePlacement(entry, { fit: 'cover' });
    expect(filled).toEqual({ type: 'image', uploadId: 'u', fit: 'cover', rotation: 0, blur: true, panX: 0, panY: 0 });
    expect(cellImagePlacement(filled).blur).toBe(false);
    expect(cellImagePlacement(withCellImagePlacement(filled, { fit: 'contain' })).blur).toBe(true);
    expect(withCellImagePlacement({ type: 'image', uploadId: 'u' }, { rotation: 90 }).rotation).toBe(90);
  });

  it('a move is remembered while the photo is shown whole', () => {
    const moved = withCellImagePlacement({ type: 'image', uploadId: 'u' }, { panX: 0.5 });
    const whole = withCellImagePlacement(moved, { fit: 'contain' });
    expect(cellImagePlacement(whole)).toMatchObject({ panX: 0, panY: 0 });
    expect(cellImagePlacement(withCellImagePlacement(whole, { fit: 'cover' }))).toMatchObject({ panX: 0.5, panY: 0 });
  });

  it('the room to move a filling photo is how far it hangs over the box, after the turn', () => {
    expect(cellImageOverflow(1200, 400, 0, 300, 200)).toEqual([300, 0]);
    expect(cellImageOverflow(400, 1200, 0, 300, 200)).toEqual([0, 700]);
    expect(cellImageOverflow(1200, 400, 90, 300, 200)).toEqual([0, 700]);
    expect(cellImageOverflow(300, 200, 0, 300, 200)).toEqual([0, 0]);
    expect(cellImageOverflow(0, 0, 0, 300, 200)).toEqual([0, 0]);
  });

  it('the preview shape comes from the block, the canvas and the month', () => {
    const base = {
      block: { x: 0, y: 0.5, width: 1, height: 0.5 }, canvasWidthPx: 2400, canvasHeightPx: 3000,
      weekStart: 'sunday' as const, heading: true,
    };
    // 2400 x 1500 block: the "wall calendar block" cases of the fixture.
    const five = cellImage.boxes[0].expected, six = cellImage.boxes[1].expected;
    expect(calendarCellAspect({ ...base, year: 2026, month: 1 })).toBeCloseTo(five[0] / five[1], 9);
    expect(calendarCellAspect({ ...base, year: 2026, month: 5 })).toBeCloseTo(six[0] / six[1], 9);
    expect(calendarCellAspect({ ...base, block: undefined, year: 2026, month: 1 })).toBe(1);
    expect(calendarCellAspect({ ...base, canvasWidthPx: undefined, year: 2026, month: 1 })).toBe(1);
  });
});

// ── Photo pages (the calendar's "X of Y photos" count) ───────────────────

const photoSlots = (JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(FIXTURES_PATH), 'calendar-photo-slots.json'), 'utf-8'),
) as { cases: { name: string; layout: unknown; pages: number; slots: number | null }[] }).cases;

describe('calendarPageCount / calendarPhotoSlots (TS) vs services/order_qty.py', () => {
  it.each(photoSlots.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(calendarPageCount(c.layout)).toBe(c.pages);
    expect(calendarPhotoSlots(c.layout)).toBe(c.slots);
  });
});
