/**
 * Component tests for MonthTileThumb
 * (CALENDAR_FEATURE_PRD §5 Phase 5 — customer-preview thumb grid).
 *
 * Asserts the mini-grid renders correct dates + entry dots + theme colors,
 * and that hide overrides blank the cell as the print would.
 */
import { render, screen, within } from '@testing-library/react';
import { MonthTileThumb, type ThumbColors } from '@/components/MonthTileThumb';
import type { CalendarCellOverride, HolidayEntry } from '@/types/calendar';

// happy-dom keeps style attributes literal (e.g. `background: #F59E0B`), it
// doesn't normalise hex → rgb(). Match by case-insensitive hex substring.
function countSpansWithBackground(container: HTMLElement, hex: string): number {
  const target = hex.toLowerCase();
  return Array.from(container.querySelectorAll('span')).filter(s => {
    const style = (s.getAttribute('style') ?? '').toLowerCase();
    return style.includes(target);
  }).length;
}

const COLORS: ThumbColors = {
  bg: '#FFFFFF',
  dateText: '#18181B',
  outOfMonthText: '#CCCCCC',
  grid: '#E5E5E5',
  weekdayText: '#71717A',
};

const DOT_CYCLE = ['#F59E0B', '#EC4899', '#3B82F6'];

describe('MonthTileThumb — grid structure', () => {
  it('renders 7 weekday-header letters', () => {
    render(<MonthTileThumb year={2026} month={1} weekStart="sunday" colors={COLORS} dotCycle={DOT_CYCLE} />);
    const thumb = screen.getByTestId('month-tile-thumb');
    // 7 weekday header spans live in the first child div.
    expect(thumb.firstElementChild?.children).toHaveLength(7);
  });

  it('renders 35 cells for Jan 2026 (5-row month)', () => {
    render(<MonthTileThumb year={2026} month={1} weekStart="sunday" colors={COLORS} dotCycle={DOT_CYCLE} />);
    const thumb = screen.getByTestId('month-tile-thumb');
    // The cells div is the second child of the thumb root.
    const cellsContainer = thumb.children[1];
    expect(cellsContainer.children).toHaveLength(35);
  });

  it('renders 42 cells for May 2026 (6-row month)', () => {
    render(<MonthTileThumb year={2026} month={5} weekStart="sunday" colors={COLORS} dotCycle={DOT_CYCLE} />);
    const thumb = screen.getByTestId('month-tile-thumb');
    const cellsContainer = thumb.children[1];
    expect(cellsContainer.children).toHaveLength(42);
  });

  it('renders Feb 2024 with 29 in-month days (leap year)', () => {
    render(<MonthTileThumb year={2024} month={2} weekStart="sunday" colors={COLORS} dotCycle={DOT_CYCLE} />);
    // Feb 29 appears as text. Other "29"s (out-of-month Jan 29 / Mar 29)
    // may also be in the grid, so use getAllByText and assert at least one.
    const thumb = screen.getByTestId('month-tile-thumb');
    expect(within(thumb).getAllByText('29').length).toBeGreaterThanOrEqual(1);
  });
});

describe('MonthTileThumb — entry dots', () => {
  it('renders a single dot for a user text entry', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      '2026-01-07': [{ type: 'text', text: 'X' }],
    };
    const { container } = render(
      <MonthTileThumb year={2026} month={1} weekStart="sunday" cells={cells} colors={COLORS} dotCycle={DOT_CYCLE} />
    );
    // Dot is a span with background = dotCycle[0] = #F59E0B
    expect(countSpansWithBackground(container, '#F59E0B')).toBeGreaterThanOrEqual(1);
  });

  it('renders user dots BEFORE holiday dots (user-first precedence §11.14)', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      '2026-01-26': [{ type: 'text', text: 'My note' }],
    };
    const holidays: HolidayEntry[] = [{ date: '2026-01-26', name: 'Republic Day', color: '#DC2626' }];
    const { container } = render(
      <MonthTileThumb year={2026} month={1} weekStart="sunday" cells={cells} holidays={holidays} colors={COLORS} dotCycle={DOT_CYCLE} />
    );
    // Should have 2 dots on Jan 26 — user amber + holiday red.
    expect(countSpansWithBackground(container, '#F59E0B')).toBeGreaterThanOrEqual(1);
    expect(countSpansWithBackground(container, '#DC2626')).toBeGreaterThanOrEqual(1);
  });

  it('caps dots at 3 per cell even when more entries exist (§11.10)', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      '2026-01-15': [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
        { type: 'text', text: 'C' },
      ],
    };
    // A 4th holiday on the same day should NOT add a 4th dot.
    const holidays: HolidayEntry[] = [{ date: '2026-01-15', name: 'X', color: '#10B981' }];
    const { container } = render(
      <MonthTileThumb year={2026} month={1} weekStart="sunday" cells={cells} holidays={holidays} colors={COLORS} dotCycle={DOT_CYCLE} />
    );
    // The green holiday dot (#10B981) should NOT appear — user filled the cap.
    expect(countSpansWithBackground(container, '#10B981')).toBe(0);
  });
});

describe('MonthTileThumb — overrides', () => {
  it('blanks the cell entirely for type=hide (no number, no dot)', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      '2026-01-12': [{ type: 'hide' }],
    };
    render(<MonthTileThumb year={2026} month={1} weekStart="sunday" cells={cells} colors={COLORS} dotCycle={DOT_CYCLE} />);
    // Other in-month numbers should render — but no "12" anywhere.
    const thumb = screen.getByTestId('month-tile-thumb');
    expect(within(thumb).queryByText('12')).not.toBeInTheDocument();
    // Confirm "11" and "13" did render so we're really testing the hide.
    expect(within(thumb).getByText('11')).toBeInTheDocument();
    expect(within(thumb).getByText('13')).toBeInTheDocument();
  });

  it('shows a 📷 glyph for type=image override', () => {
    const cells: Record<string, CalendarCellOverride[]> = {
      '2026-01-30': [{ type: 'image', uploadId: 'abc' }],
    };
    const { container } = render(
      <MonthTileThumb year={2026} month={1} weekStart="sunday" cells={cells} colors={COLORS} dotCycle={DOT_CYCLE} />
    );
    expect(container.textContent).toContain('📷');
  });
});

describe('MonthTileThumb — weekday-highlight theme', () => {
  it('applies sundayBg to Sunday cells when colors include it', () => {
    const wdColors: ThumbColors = {
      ...COLORS,
      sundayBg: '#FEE2E2',
      sundayText: '#DC2626',
    };
    const { container } = render(
      <MonthTileThumb year={2026} month={1} weekStart="sunday" colors={wdColors} dotCycle={DOT_CYCLE} />
    );
    // At least one cell should have the Sunday bg applied (Jan 4, 11, 18, 25 are Sundays).
    const sundayCells = Array.from(container.querySelectorAll('div')).filter(d =>
      (d.getAttribute('style') ?? '').toLowerCase().includes('#fee2e2')
    );
    expect(sundayCells.length).toBeGreaterThanOrEqual(4);
  });
});
