/**
 * @jest-environment node
 *
 * TS↔Python parity test for the book/booklet layout math
 * (BOOK_LAYOUT_PRD.md §5.3).
 *
 * Pure-function test (no React, no DOM) — runs in Jest's node env. Loads
 * the same fixtures file that
 * backend/django/services/tests/test_book_layout_parity.py asserts
 * against. If either side drifts from the shared ground truth, exactly
 * one of the two suites fails and we know which.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  displayLabelFor,
  gutterShiftFraction,
  gutterSideFor,
  resolvePageCount,
  spineWidthMm,
  type BookLayoutLike,
} from '@/lib/book-layout';

interface PageCountCase {
  name: string;
  min: number;
  max: number;
  step: number;
  default: number;
  requested: number | null;
  expected: number;
}

interface GutterSideCase {
  pageIndex: number;
  expected: 'left' | 'right';
}

interface GutterShiftCase {
  name: string;
  frames: Array<{ x: number; width: number }>;
  overlays: Array<{ x: number; width: number }>;
  gutterMm: number;
  canvasWidthMm: number | null;
  gutterSide: 'left' | 'right';
  expectedShift: number;
}

interface SpineWidthCase {
  name: string;
  pageCount: number;
  paperThicknessMm: number;
  coverThicknessMm: number;
  expected: number;
}

interface DisplayLabelCase {
  role: 'cover' | 'inner' | 'backCover';
  pageIndex: number | null;
  ordinal: number;
  total: number;
  expected: string;
}

interface FixtureFile {
  _meta: unknown;
  pageCountCases: PageCountCase[];
  gutterSideCases: GutterSideCase[];
  gutterShiftCases: GutterShiftCase[];
  spineWidthCases: SpineWidthCase[];
  displayLabelCases: DisplayLabelCase[];
}

// This file: frontend/nextjs/src/lib/__tests__/ → repo root is five levels
// up, then into storage/parity-fixtures/ — same resolution scheme as
// calendar.parity.test.ts.
const FIXTURES_PATH = path.resolve(
  __dirname, '..', '..', '..', '..', '..',
  'storage', 'parity-fixtures', 'book-layout.json'
);

let fixtures: FixtureFile;

beforeAll(() => {
  if (!fs.existsSync(FIXTURES_PATH)) {
    throw new Error(
      `Parity fixtures missing at ${FIXTURES_PATH}. Both this test and ` +
      `backend/django/services/tests/test_book_layout_parity.py load from ` +
      `this path — re-add the file before running.`
    );
  }
  fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf-8')) as FixtureFile;
});

function layoutFor(c: PageCountCase): BookLayoutLike {
  return {
    productType: 'book',
    book: {
      pageCount: { min: c.min, max: c.max, step: c.step, default: c.default },
      cover: {},
      innerPage: {},
    },
  };
}

describe('resolvePageCount (TS) vs services/book_layout.py::resolve_page_count', () => {
  it('loads the shared fixtures file', () => {
    expect(fixtures.pageCountCases.length).toBeGreaterThan(0);
  });

  it('every fixture case matches', () => {
    for (const c of fixtures.pageCountCases) {
      const got = resolvePageCount(layoutFor(c), c.requested);
      expect(got).toBe(c.expected);
    }
  });
});

describe('gutterSideFor (TS) vs services/book_layout.py::gutter_side_for', () => {
  it('every fixture case matches', () => {
    for (const c of fixtures.gutterSideCases) {
      expect(gutterSideFor(c.pageIndex)).toBe(c.expected);
    }
  });
});

describe('gutterShiftFraction (TS) vs services/book_layout.py::gutter_shift_fraction', () => {
  it('every fixture case matches within floating-point tolerance', () => {
    for (const c of fixtures.gutterShiftCases) {
      const got = gutterShiftFraction(c.frames, c.overlays, c.gutterMm, c.canvasWidthMm, c.gutterSide);
      expect(Math.abs(got - c.expectedShift)).toBeLessThan(1e-9);
    }
  });
});

describe('spineWidthMm (TS) vs services/book_layout.py::spine_width_mm', () => {
  it('every fixture case matches within floating-point tolerance', () => {
    for (const c of fixtures.spineWidthCases) {
      const got = spineWidthMm(c.pageCount, c.paperThicknessMm, c.coverThicknessMm);
      expect(Math.abs(got - c.expected)).toBeLessThan(1e-9);
    }
  });
});

describe('displayLabelFor (TS) vs services/book_layout.py::display_label_for', () => {
  it('every fixture case matches', () => {
    for (const c of fixtures.displayLabelCases) {
      expect(displayLabelFor(c.role, c.pageIndex, c.ordinal, c.total)).toBe(c.expected);
    }
  });
});
