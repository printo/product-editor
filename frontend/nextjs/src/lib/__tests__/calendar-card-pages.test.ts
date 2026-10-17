import { calendarCardPages } from '../calendar';

const MONTHS = Array.from({ length: 12 }, (_, i) => ({ year: 2027, month: i + 1 }));
const BLOCK = { x: 0.05, y: 0.55, width: 0.9, height: 0.4 };

describe('calendarCardPages', () => {
  it('gives every month the template block, printing with photo card i mod N', () => {
    const pages = calendarCardPages(MONTHS, [BLOCK], undefined, 5)!;
    expect(pages).toHaveLength(12);
    expect(pages.map(p => p.canvasIdx)).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1]);
    expect(pages[7]).toEqual({ surfaceIndex: 7, year: 2027, month: 8, canvasIdx: 2, block: BLOCK });
  });

  it('marks every month -1 before the first photo', () => {
    expect(calendarCardPages(MONTHS, [BLOCK], {}, 0)!.every(p => p.canvasIdx === -1)).toBe(true);
  });

  it('uses a month override keyed by the calendar month, as materialize_surfaces does', () => {
    const moved = { x: 0.1, y: 0.1, width: 0.8, height: 0.3 };
    const fy = [...MONTHS.slice(3), ...MONTHS.slice(0, 3).map(m => ({ ...m, year: 2028 }))];
    const pages = calendarCardPages(fy, [BLOCK], { month_04: { calendars: [moved] }, month_05: { calendars: [{ x: 'bad' }] } }, 12)!;
    expect(pages[0].block).toEqual(moved);   // April is the first FY page
    expect(pages[1].block).toEqual(BLOCK);   // an unreadable override falls back
  });

  it('is null for the whole-year poster or an unreadable block', () => {
    expect(calendarCardPages(MONTHS, Array(12).fill(BLOCK), {}, 1)).toBeNull();
    expect(calendarCardPages(MONTHS, [], {}, 1)).toBeNull();
    expect(calendarCardPages(MONTHS, [{ ...BLOCK, width: 0 }], {}, 1)).toBeNull();
    expect(calendarCardPages(MONTHS, undefined, {}, 1)).toBeNull();
  });
});
