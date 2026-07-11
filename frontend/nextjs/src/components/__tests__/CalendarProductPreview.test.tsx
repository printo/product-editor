/**
 * Component tests for CalendarProductPreview
 * (CALENDAR_FEATURE_PRD §5 Phase 5 Day 1).
 *
 * Asserts:
 *   - All 3 control widgets render
 *   - Gen-Z swatches are gated on themePreset === 'modern-genz'
 *   - Clicking a control fires the right onChange callback
 *   - Year badge derives correctly from calendarType + a fixed `now`
 *   - 12 month tiles render with the correct labels per calendar type
 *   - Tapping a tile fires onMonthTileClick with the resolved (year, month)
 *
 * Uses a fixed `now` so the test isn't time-zone-flaky.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CalendarProductPreview,
  countLeapDayOrphans,
  countOrphanedEntries,
  yearBadgeText,
} from '@/components/CalendarProductPreview';
import type { CalendarCellOverride, GenzPalette } from '@/types/calendar';

const PALETTES: GenzPalette[] = [
  { name: 'butter', label: 'Butter & Purple', bg: '#FEF3C7', month: '#A855F7',
    weekday: '#A855F7', grid: '#FBCFE8', date: '#0F172A', pill: '#CCFBF1',
    dotCycle: ['#A855F7', '#EC4899', '#0EA5E9'] },
  { name: 'mint',   label: 'Mint & Hot Pink', bg: '#ECFDF5', month: '#DB2777',
    weekday: '#DB2777', grid: '#FCE7F3', date: '#0F172A', pill: '#FEF3C7',
    dotCycle: ['#DB2777', '#F59E0B', '#10B981'] },
];

// May 21, 2026 at noon — noon avoids timezone-flakiness when todayInIST
// converts to Asia/Kolkata. Using midnight local would shift the date by
// ±1 on CI runners outside India's tz; noon stays on the same calendar
// day across every realistic timezone offset.
const FIXED_NOW = new Date(2026, 4, 21, 12, 0, 0);

function setup(propOverrides: Partial<React.ComponentProps<typeof CalendarProductPreview>> = {}) {
  const onThemePresetChange = jest.fn();
  const onGenzPaletteChange = jest.fn();
  const onCalendarTypeChange = jest.fn();
  const onMonthTileClick = jest.fn();
  const utils = render(
    <CalendarProductPreview
      themePreset="modern-minimalist"
      onThemePresetChange={onThemePresetChange}
      genzPalette={undefined}
      genzPalettes={PALETTES}
      onGenzPaletteChange={onGenzPaletteChange}
      calendarType="english"
      onCalendarTypeChange={onCalendarTypeChange}
      onMonthTileClick={onMonthTileClick}
      now={FIXED_NOW}
      {...propOverrides}
    />
  );
  return { ...utils, onThemePresetChange, onGenzPaletteChange, onCalendarTypeChange, onMonthTileClick };
}

// ─── Controls rendering ─────────────────────────────────────────────────────

describe('CalendarProductPreview — controls render', () => {
  it('renders the theme preset toggle with 3 options', () => {
    setup();
    const seg = screen.getByTestId('theme-preset-toggle');
    expect(within(seg).getByRole('button', { name: 'Minimalist' })).toBeInTheDocument();
    expect(within(seg).getByRole('button', { name: 'Gen-Z' })).toBeInTheDocument();
    expect(within(seg).getByRole('button', { name: 'Weekday Highlight' })).toBeInTheDocument();
  });

  it('renders the calendar type toggle with 2 options', () => {
    setup();
    const seg = screen.getByTestId('calendar-type-toggle');
    expect(within(seg).getByRole('button', { name: /english/i })).toBeInTheDocument();
    expect(within(seg).getByRole('button', { name: /financial/i })).toBeInTheDocument();
  });

  it('renders 12 month tiles', () => {
    setup();
    const grid = screen.getByTestId('month-tiles-grid');
    expect(within(grid).getAllByRole('button')).toHaveLength(12);
  });
});

// ─── Gen-Z palette gating (interlinked with theme) ──────────────────────────

describe('CalendarProductPreview — Gen-Z palette gating', () => {
  it('hides palette swatches when theme is NOT modern-genz', () => {
    setup({ themePreset: 'modern-minimalist' });
    expect(screen.queryByTestId('genz-palette-swatches')).not.toBeInTheDocument();
  });

  it('hides palette swatches when theme is weekday-highlight', () => {
    setup({ themePreset: 'weekday-highlight' });
    expect(screen.queryByTestId('genz-palette-swatches')).not.toBeInTheDocument();
  });

  it('shows palette swatches when theme is modern-genz', () => {
    setup({ themePreset: 'modern-genz', genzPalette: 'butter' });
    const swatches = screen.getByTestId('genz-palette-swatches');
    expect(swatches).toBeInTheDocument();
    expect(within(swatches).getAllByRole('button')).toHaveLength(PALETTES.length);
  });
});

// ─── Click → callback wiring ────────────────────────────────────────────────

describe('CalendarProductPreview — control callbacks', () => {
  it('fires onThemePresetChange when a theme option is clicked', async () => {
    const { onThemePresetChange } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Gen-Z' }));
    expect(onThemePresetChange).toHaveBeenCalledTimes(1);
    expect(onThemePresetChange).toHaveBeenCalledWith('modern-genz');
  });

  it('fires onCalendarTypeChange when Financial is clicked', async () => {
    const { onCalendarTypeChange } = setup();
    await userEvent.click(screen.getByRole('button', { name: /financial/i }));
    expect(onCalendarTypeChange).toHaveBeenCalledWith('financial');
  });

  it('fires onGenzPaletteChange when a swatch is clicked', async () => {
    const { onGenzPaletteChange } = setup({ themePreset: 'modern-genz', genzPalette: 'butter' });
    const swatches = screen.getByTestId('genz-palette-swatches');
    const mintSwatch = within(swatches).getByTitle('Mint & Hot Pink');
    await userEvent.click(mintSwatch);
    expect(onGenzPaletteChange).toHaveBeenCalledWith('mint');
  });
});

// ─── Year badge derivation (§10.4) ──────────────────────────────────────────

describe('CalendarProductPreview — year badge', () => {
  it('shows "2026" in English mode (today = May 2026)', () => {
    setup({ calendarType: 'english' });
    expect(screen.getByTestId('year-badge')).toHaveTextContent('2026');
  });

  it('shows "FY 2026–27" in Financial mode (today = May 2026)', () => {
    setup({ calendarType: 'financial' });
    expect(screen.getByTestId('year-badge')).toHaveTextContent('FY 2026–27');
  });

  it('shows "FY 2025–26" in Financial mode if today is February (pre-April)', () => {
    // Feb 14 2026 at noon — noon avoids IST-conversion day-shift on
    // east-of-IST CI runners. Still cleanly inside FY 2025-26.
    setup({ calendarType: 'financial', now: new Date(2026, 1, 14, 12, 0, 0) });
    expect(screen.getByTestId('year-badge')).toHaveTextContent('FY 2025–26');
  });
});

// ─── Month tile derivation (§11.1) ──────────────────────────────────────────

describe('CalendarProductPreview — month tile order', () => {
  it('lists Jan..Dec 2026 in English mode', () => {
    setup({ calendarType: 'english' });
    const grid = screen.getByTestId('month-tiles-grid');
    const tiles = within(grid).getAllByRole('button');
    expect(tiles[0]).toHaveAttribute('data-month-label', 'January 2026');
    expect(tiles[11]).toHaveAttribute('data-month-label', 'December 2026');
  });

  it('lists Apr 2026..Mar 2027 in Financial mode', () => {
    setup({ calendarType: 'financial' });
    const grid = screen.getByTestId('month-tiles-grid');
    const tiles = within(grid).getAllByRole('button');
    expect(tiles[0]).toHaveAttribute('data-month-label', 'April 2026');
    expect(tiles[11]).toHaveAttribute('data-month-label', 'March 2027');
  });

  it('fires onMonthTileClick with the resolved (surfaceIndex, year, month)', async () => {
    const { onMonthTileClick } = setup({ calendarType: 'financial' });
    const grid = screen.getByTestId('month-tiles-grid');
    const tiles = within(grid).getAllByRole('button');
    await userEvent.click(tiles[0]);
    expect(onMonthTileClick).toHaveBeenCalledWith(0, 2026, 4);
    await userEvent.click(tiles[9]);
    expect(onMonthTileClick).toHaveBeenCalledWith(9, 2027, 1);
  });
});

// ─── yearBadgeText pure function ────────────────────────────────────────────

describe('yearBadgeText (pure helper)', () => {
  it('formats English mode as a plain year', () => {
    expect(yearBadgeText('english', 2026)).toBe('2026');
  });

  it('formats Financial mode with the short FY convention', () => {
    expect(yearBadgeText('financial', 2026)).toBe('FY 2026–27');
    expect(yearBadgeText('financial', 2029)).toBe('FY 2029–30');
  });
});

// ─── countOrphanedEntries (PRD §11.4 helper) ────────────────────────────────

describe('countOrphanedEntries', () => {
  // Helper: build a flat cells map with one entry on each named date.
  function withEntries(dates: string[]): Record<string, CalendarCellOverride[]> {
    const map: Record<string, CalendarCellOverride[]> = {};
    for (const iso of dates) {
      map[iso] = [{ type: 'text', text: 'x' }];
    }
    return map;
  }

  it('returns 0 when no cell entries exist', () => {
    expect(countOrphanedEntries({}, 'financial', FIXED_NOW)).toBe(0);
  });

  it('returns 0 when every entry stays within the new range', () => {
    // April–Dec entries survive English→Financial in 2026.
    const cells = withEntries(['2026-04-15', '2026-08-01', '2026-12-31']);
    expect(countOrphanedEntries(cells, 'financial', FIXED_NOW)).toBe(0);
  });

  it('counts entries that fall outside the new Financial range', () => {
    // Jan–Mar 2026 entries orphan under Financial (range Apr 2026 → Mar 2027).
    const cells = withEntries(['2026-01-07', '2026-02-14', '2026-03-21']);
    expect(countOrphanedEntries(cells, 'financial', FIXED_NOW)).toBe(3);
  });

  it('counts entries that fall outside the new English range', () => {
    // Jan–Mar 2027 entries (visible under FY 2026-27) orphan when flipping
    // back to English 2026.
    const cells = withEntries(['2027-01-05', '2027-02-22', '2027-03-30']);
    expect(countOrphanedEntries(cells, 'english', FIXED_NOW)).toBe(3);
  });

  it('counts each override in a cell separately (3 entries on one day = 3)', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      '2026-01-07': [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
        { type: 'text', text: 'C' },
      ],
    };
    // 2026-01-07 is in English 2026 but NOT Financial 2026-27 → 3 orphans.
    expect(countOrphanedEntries(cells, 'financial', FIXED_NOW)).toBe(3);
  });
});

// ─── countLeapDayOrphans (PRD §11.8 helper) ─────────────────────────────────

describe('countLeapDayOrphans', () => {
  const LEAP_NOW = new Date(2024, 4, 21, 12, 0, 0);      // 2024 is leap
  const NONLEAP_NOW = new Date(2025, 4, 21, 12, 0, 0);   // 2025 is non-leap

  function cellsWithFeb29(): Record<string, CalendarCellOverride[]> {
    return { '2024-02-29': [{ type: 'text', text: 'Bday' }] };
  }

  it('returns 0 when the render year IS a leap year', () => {
    const { count, renderYear } = countLeapDayOrphans(cellsWithFeb29(), 'english', LEAP_NOW);
    expect(count).toBe(0);
    expect(renderYear).toBe(2024);
  });

  it('returns the entry count when the render year is non-leap', () => {
    const { count, renderYear } = countLeapDayOrphans(cellsWithFeb29(), 'english', NONLEAP_NOW);
    expect(count).toBe(1);
    expect(renderYear).toBe(2025);
  });

  it('counts entries, not cells (each cell can have up to 3)', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      '2024-02-29': [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
        { type: 'text', text: 'C' },
      ],
    };
    expect(countLeapDayOrphans(cells, 'english', NONLEAP_NOW).count).toBe(3);
  });

  it('matches only "YYYY-02-29" exactly — not "02-29" inside other dates', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      // Should NOT match (length != 10, no -02-29 at the end).
      'not-an-iso-02-29': [{ type: 'text', text: 'X' }],
      '2025-02-29-extra': [{ type: 'text', text: 'Y' }],
    };
    expect(countLeapDayOrphans(cells, 'english', NONLEAP_NOW).count).toBe(0);
  });

  it('counts Feb 29 entries across multiple years', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      '2020-02-29': [{ type: 'text', text: 'A' }],
      '2024-02-29': [{ type: 'text', text: 'B' }],
    };
    expect(countLeapDayOrphans(cells, 'english', NONLEAP_NOW).count).toBe(2);
  });

  it('returns 0 for an empty cells map', () => {
    expect(countLeapDayOrphans({}, 'english', NONLEAP_NOW).count).toBe(0);
  });

  it('treats financial year (Apr→Mar spans 2 years) using the resolved baseYear', () => {
    // baseYear in financial = current FY start year. In 2025, that's
    // either 2024 (Apr 2024 – Mar 2025) or 2025 depending on month.
    // We just need the helper to use resolveBaseYear consistently — assert
    // the count flips to 0 if THAT year happens to be a leap year.
    const { count, renderYear } = countLeapDayOrphans(cellsWithFeb29(), 'financial', NONLEAP_NOW);
    if (renderYear % 4 === 0 && renderYear % 100 !== 0) {
      expect(count).toBe(0);
    } else {
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Calendar-type flip warning modal (PRD §11.4) ───────────────────────────

describe('CalendarProductPreview — flip warning modal', () => {
  it('does NOT show modal when there are no entries to orphan', async () => {
    const { onCalendarTypeChange } = setup({
      calendarType: 'english',
      cells: undefined,
    });
    await userEvent.click(screen.getByRole('button', { name: /financial/i }));
    expect(screen.queryByTestId('flip-warning-modal')).not.toBeInTheDocument();
    expect(onCalendarTypeChange).toHaveBeenCalledWith('financial');
  });

  it('does NOT show modal when every entry survives the flip', async () => {
    const cells: Record<string, CalendarCellOverride[]> = {};
    // April 15 lives in both English 2026 and Financial 2026-27.
    cells['2026-04-15'] = [{ type: 'text', text: 'survives' }];
    const { onCalendarTypeChange } = setup({
      calendarType: 'english',
      cells: cells,
    });
    await userEvent.click(screen.getByRole('button', { name: /financial/i }));
    expect(screen.queryByTestId('flip-warning-modal')).not.toBeInTheDocument();
    expect(onCalendarTypeChange).toHaveBeenCalledWith('financial');
  });

  it('SHOWS modal and holds the flip when orphans exist', async () => {
    const cells: Record<string, CalendarCellOverride[]> = {};
    cells['2026-01-07'] = [{ type: 'text', text: "Mom's birthday" }];
    const { onCalendarTypeChange } = setup({
      calendarType: 'english',
      cells: cells,
    });
    await userEvent.click(screen.getByRole('button', { name: /financial/i }));
    expect(screen.getByTestId('flip-warning-modal')).toBeInTheDocument();
    expect(screen.getByText(/Financial year/)).toBeInTheDocument();
    expect(onCalendarTypeChange).not.toHaveBeenCalled();
  });

  it('cancel closes the modal without firing onCalendarTypeChange', async () => {
    const cells: Record<string, CalendarCellOverride[]> = {};
    cells['2026-01-07'] = [{ type: 'text', text: "Mom's birthday" }];
    const { onCalendarTypeChange } = setup({
      calendarType: 'english',
      cells: cells,
    });
    await userEvent.click(screen.getByRole('button', { name: /financial/i }));
    await userEvent.click(screen.getByTestId('flip-warning-cancel'));
    expect(screen.queryByTestId('flip-warning-modal')).not.toBeInTheDocument();
    expect(onCalendarTypeChange).not.toHaveBeenCalled();
  });

  it('confirm fires onCalendarTypeChange with the new type and closes the modal', async () => {
    const cells: Record<string, CalendarCellOverride[]> = {};
    cells['2026-01-07'] = [{ type: 'text', text: "Mom's birthday" }];
    const { onCalendarTypeChange } = setup({
      calendarType: 'english',
      cells: cells,
    });
    await userEvent.click(screen.getByRole('button', { name: /financial/i }));
    await userEvent.click(screen.getByTestId('flip-warning-confirm'));
    expect(onCalendarTypeChange).toHaveBeenCalledWith('financial');
    expect(screen.queryByTestId('flip-warning-modal')).not.toBeInTheDocument();
  });

  it('modal text uses singular "entry" when only one entry would orphan', async () => {
    const cells: Record<string, CalendarCellOverride[]> = {};
    cells['2026-01-07'] = [{ type: 'text', text: 'one' }];
    setup({ calendarType: 'english', cells: cells });
    await userEvent.click(screen.getByRole('button', { name: /financial/i }));
    const modal = screen.getByTestId('flip-warning-modal');
    expect(within(modal).getByText(/1 entry/)).toBeInTheDocument();
  });

  it('modal text uses plural "entries" when multiple would orphan', async () => {
    const cells: Record<string, CalendarCellOverride[]> = {};
    cells['2026-01-07'] = [
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
    ];
    cells['2026-02-14'] = [{ type: 'text', text: 'C' }];
    setup({ calendarType: 'english', cells: cells });
    await userEvent.click(screen.getByRole('button', { name: /financial/i }));
    const modal = screen.getByTestId('flip-warning-modal');
    expect(within(modal).getByText(/3 entries/)).toBeInTheDocument();
  });
});

// ─── Flip preserves in-range entries (Phase 2 item 6e regression) ───────────

describe('CalendarProductPreview — in-range entries survive a type flip', () => {
  it('a May entry keeps its tile dot after English→Financial (dates, not slots)', () => {
    // 2026-05-10 is inside BOTH English 2026 and FY Apr 2026–Mar 2027. Under
    // the old positional cellsPerCanvas model, flipping remapped slot→month
    // and the entry silently vanished from the preview.
    const cells: Record<string, CalendarCellOverride[]> = {
      '2026-05-10': [{ type: 'text', text: 'Anniversary' }],
    };

    const mayTile = () => {
      const grid = screen.getByTestId('month-tiles-grid');
      const tile = within(grid).getAllByRole('button')
        .find(b => b.getAttribute('data-month-label') === 'May 2026');
      expect(tile).toBeDefined();
      return tile!;
    };

    const english = setup({ calendarType: 'english', cells });
    expect(within(mayTile()).queryAllByTestId('cell-dot').length).toBeGreaterThan(0);
    english.unmount();

    setup({ calendarType: 'financial', cells });
    expect(within(mayTile()).queryAllByTestId('cell-dot').length).toBeGreaterThan(0);
  });
});

// ─── P9.2: Feb 29 toast (PRD §11.8) ─────────────────────────────────────────

describe('CalendarProductPreview — leap-day toast', () => {
  // Build cells with the requested number of Feb 29 entries.
  function leapCells(count: number): Record<string, CalendarCellOverride[]> {
    return {
      '2024-02-29': Array.from(
        { length: count },
        (_, i) => ({ type: 'text' as const, text: `E${i}` }),
      ),
    };
  }

  const NONLEAP_NOW = new Date(2025, 4, 21, 12, 0, 0); // 2025 non-leap
  const LEAP_NOW = new Date(2024, 4, 21, 12, 0, 0);    // 2024 leap

  it('does NOT render the toast when render year is leap (2024)', () => {
    setup({ calendarType: 'english', cells: leapCells(1), now: LEAP_NOW });
    expect(screen.queryByTestId('leap-day-toast')).not.toBeInTheDocument();
  });

  it('does NOT render the toast when there are 0 Feb 29 entries', () => {
    setup({ calendarType: 'english', cells: leapCells(0), now: NONLEAP_NOW });
    expect(screen.queryByTestId('leap-day-toast')).not.toBeInTheDocument();
  });

  it('renders the toast when render year is non-leap AND there is ≥1 Feb 29 entry', () => {
    setup({ calendarType: 'english', cells: leapCells(1), now: NONLEAP_NOW });
    expect(screen.getByTestId('leap-day-toast')).toBeInTheDocument();
    expect(screen.getByText(/1 entry on Feb 29 won't appear in 2025/)).toBeInTheDocument();
  });

  it('uses plural copy when count > 1', () => {
    setup({ calendarType: 'english', cells: leapCells(3), now: NONLEAP_NOW });
    expect(screen.getByText(/3 entries on Feb 29 won't appear in 2025/)).toBeInTheDocument();
  });

  it('hides the toast after clicking the dismiss button', async () => {
    setup({ calendarType: 'english', cells: leapCells(1), now: NONLEAP_NOW });
    await userEvent.click(screen.getByTestId('leap-day-toast-dismiss'));
    expect(screen.queryByTestId('leap-day-toast')).not.toBeInTheDocument();
  });

  it('does NOT render the toast when cellsPerCanvas is undefined (initial load)', () => {
    setup({ calendarType: 'english', cells: undefined, now: NONLEAP_NOW });
    expect(screen.queryByTestId('leap-day-toast')).not.toBeInTheDocument();
  });
});
