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
import { buildMonthGrid } from '@/lib/calendar';
import type { WeekStart } from '@/types/calendar';

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
