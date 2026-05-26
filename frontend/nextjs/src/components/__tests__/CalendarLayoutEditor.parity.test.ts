/**
 * Generates the actual `draftToLayoutJson` output for 4 representative
 * drafts and writes it to /tmp so a Python sidecar can run it through
 * the live `validate_calendar_layout` validator.
 *
 * P6.1 review fix #1 + #9 — cross-validator parity check. Catches drift
 * between the client-side `validateDraft` and the server-side
 * `validate_calendar_layout` rules.
 *
 * The companion Python sidecar lives at /tmp/validate-calendar-layouts.py
 * (created by the verification script, not checked in).
 *
 * @jest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  draftToLayoutJson,
  type CalendarLayoutDraft,
} from '@/components/CalendarLayoutEditor';

interface ParityCase {
  name: string;
  draft: CalendarLayoutDraft;
  posterCustomLayout?: boolean;
  expectedValidatorResult: 'pass' | 'fail';
  expectedErrorFragment?: string;
}

const CASES: ParityCase[] = [
  {
    name: 'case1_multi_surface_minimalist',
    expectedValidatorResult: 'pass',
    draft: {
      name: 'family_calendar_5x7',
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
    },
  },
  {
    name: 'case2_poster_auto_tile',
    expectedValidatorResult: 'pass',
    draft: {
      name: 'year_poster_a3',
      productType: 'calendar',
      mode: 'poster',
      canvasWidthMm: 297,
      canvasHeightMm: 420,
      dpi: 300,
      frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.4 }],
      // One base cell sized for a 4×3 grid leaving 5% gutters.
      calendars: [{ x: 0.05, y: 0.5, width: 0.225, height: 0.16 }],
      style: {
        themePreset: 'modern-genz',
        calendarType: 'english',
        weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
        defaultGenzPalette: 'mint',
      },
      defaultYear: 2026,
    },
  },
  {
    name: 'case3_with_mask',
    expectedValidatorResult: 'pass',
    draft: {
      name: 'desk_calendar_with_mask',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 127,
      canvasHeightMm: 177.8,
      dpi: 300,
      frames: [
        { x: 0.05, y: 0.05, width: 0.42, height: 0.42 },
        { x: 0.53, y: 0.05, width: 0.42, height: 0.42 },
      ],
      calendars: [{ x: 0.05, y: 0.55, width: 0.9, height: 0.42 }],
      style: {
        themePreset: 'weekday-highlight',
        calendarType: 'financial',
        weekStart: 'monday',
        holidaySource: { enabled: false, locale: 'generic', showInCells: false },
      },
      defaultYear: 2026,
      maskUrl: 'desk_calendar_mask.png',
      maskOnExport: true,
    },
  },
  {
    name: 'case4_invalid_extends_past_canvas',
    expectedValidatorResult: 'fail',
    expectedErrorFragment: 'right canvas edge',
    draft: {
      name: 'bad_layout',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 127,
      canvasHeightMm: 177.8,
      dpi: 300,
      frames: [{ x: 0, y: 0, width: 1, height: 1 }],
      calendars: [{ x: 0.8, y: 0.5, width: 0.5, height: 0.4 }],
      style: {
        themePreset: 'modern-minimalist',
        calendarType: 'english',
        weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 2026,
    },
  },
  // Review L3 — additional cases for broader Python-validator coverage.
  {
    name: 'case5_financial_weekday_highlight',
    expectedValidatorResult: 'pass',
    draft: {
      name: 'fy_calendar_weekday',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 152.4,
      canvasHeightMm: 152.4,
      dpi: 300,
      frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.4 }],
      calendars: [{ x: 0.05, y: 0.5, width: 0.9, height: 0.45 }],
      style: {
        themePreset: 'weekday-highlight',
        calendarType: 'financial',
        weekStart: 'monday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 'current',
    },
  },
  {
    name: 'case6_zero_year_invalid',
    expectedValidatorResult: 'fail',
    expectedErrorFragment: 'defaultYear',
    draft: {
      name: 'bad_year',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 100,
      canvasHeightMm: 100,
      dpi: 300,
      frames: [{ x: 0, y: 0, width: 1, height: 1 }],
      calendars: [{ x: 0.1, y: 0.5, width: 0.5, height: 0.4 }],
      style: {
        themePreset: 'modern-minimalist',
        calendarType: 'english',
        weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 1800, // outside 2000..2100
    },
  },
  {
    name: 'case8_with_surface_overrides',
    expectedValidatorResult: 'pass',
    draft: {
      name: 'family_with_dec_override',
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
      },
      defaultYear: 'current',
      // December gets a custom frame layout (split into 2 frames).
      surfaceOverrides: {
        month_12: {
          frames: [
            { x: 0.05, y: 0.05, width: 0.42, height: 0.42 },
            { x: 0.53, y: 0.05, width: 0.42, height: 0.42 },
          ],
        },
      },
    },
  },
  {
    name: 'case9_surface_override_with_banned_field',
    expectedValidatorResult: 'fail',
    expectedErrorFragment: 'themePreset',
    draft: {
      name: 'bad_override',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 127,
      canvasHeightMm: 177.8,
      dpi: 300,
      frames: [{ x: 0, y: 0, width: 1, height: 1 }],
      calendars: [{ x: 0.1, y: 0.5, width: 0.5, height: 0.4 }],
      style: {
        themePreset: 'modern-minimalist',
        calendarType: 'english',
        weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 2026,
      // themePreset isn't a valid per-surface override per PRD §10.2.1.
      surfaceOverrides: { month_03: { themePreset: 'modern-genz' } as any },
    },
  },
  {
    // P6.2 review fix C/L1 — surface-override bounds must be enforced in
    // BOTH validators. Frame in month_05 extends past the right canvas edge.
    name: 'case10_override_bounds_violation',
    expectedValidatorResult: 'fail',
    expectedErrorFragment: 'right canvas edge',
    draft: {
      name: 'bad_override_bounds',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 127,
      canvasHeightMm: 177.8,
      dpi: 300,
      frames: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
      calendars: [{ x: 0.1, y: 0.5, width: 0.5, height: 0.4 }],
      style: {
        themePreset: 'modern-minimalist',
        calendarType: 'english',
        weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 2026,
      surfaceOverrides: {
        month_05: { frames: [{ x: 0.8, y: 0.1, width: 0.5, height: 0.3 }] },
      },
    },
  },
  {
    name: 'case7_missing_themepreset',
    expectedValidatorResult: 'fail',
    expectedErrorFragment: 'themePreset',
    draft: {
      name: 'bad_style',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 100,
      canvasHeightMm: 100,
      dpi: 300,
      frames: [{ x: 0, y: 0, width: 1, height: 1 }],
      calendars: [{ x: 0.1, y: 0.5, width: 0.5, height: 0.4 }],
      style: {
        themePreset: undefined as any,
        calendarType: 'english',
        weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 2026,
    },
  },
];

it('writes serialised JSON for all parity cases to /tmp for the Python sidecar', () => {
  const out = CASES.map(c => ({
    name: c.name,
    layout: draftToLayoutJson(c.draft, { posterCustomLayout: c.posterCustomLayout ?? false }),
    expectedValidatorResult: c.expectedValidatorResult,
    expectedErrorFragment: c.expectedErrorFragment ?? null,
  }));
  const outPath = path.join('/tmp', 'p6-real-serializer-output.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  expect(fs.existsSync(outPath)).toBe(true);
  expect(out).toHaveLength(CASES.length);
});
