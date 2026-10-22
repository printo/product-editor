'use client';

import { CalendarDays, ImagePlus } from 'lucide-react';
import { LazyImg } from '@/components/LazyImg';
import { MonthTileThumb, type ThumbColors } from '@/components/MonthTileThumb';
import { MONTH_NAMES_EN, displayLabelFor, type CalendarCardPage } from '@/lib/calendar';
import type { CalendarCellOverride, HolidayEntry, WeekStart } from '@/types/calendar';
import { canvasCardStyle, canvasCardWidthClass } from './editor-utils';

/** What the cards need to draw a calendar page: the months, the customer's
 *  theme and entries, and where a tap on each zone goes. */
export type CalendarCardsConfig = {
  pages: CalendarCardPage[];
  weekStart: WeekStart;
  cells: Record<string, CalendarCellOverride[]>;
  holidays: HolidayEntry[];
  colors: ThumbColors;
  dotCycle: readonly string[];
  showMonthName: boolean;
  onOpenMonth: (surfaceIndex: number, year: number, month: number) => void;
  onAddPhotos: () => void;
};

/** The month's date grid drawn where the print puts it. Its own tap target:
 *  it opens the day editor on this month, while the rest of the card keeps
 *  opening the photo editor. */
export function CalendarGridZone({ page, calendar }: { page: CalendarCardPage; calendar: CalendarCardsConfig }) {
  const label = displayLabelFor(page.year, page.month);
  const { block } = page;
  return (
    <button
      type="button"
      className="absolute z-10 group/grid cursor-pointer outline-none transition-shadow hover:ring-2 hover:ring-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-600"
      style={{
        left: `${block.x * 100}%`,
        top: `${block.y * 100}%`,
        width: `${block.width * 100}%`,
        height: `${block.height * 100}%`,
      }}
      onClick={(e) => { e.stopPropagation(); calendar.onOpenMonth(page.surfaceIndex, page.year, page.month); }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      aria-label={`Add dates to ${label}`}
      title="Add a birthday, event or photo to a date"
      data-testid="calendar-grid-zone"
    >
      <MonthTileThumb
        year={page.year}
        month={page.month}
        weekStart={calendar.weekStart}
        cells={calendar.cells}
        holidays={calendar.holidays}
        colors={calendar.colors}
        dotCycle={calendar.dotCycle}
        showMonthName={calendar.showMonthName}
        ariaLabel={`${label} dates`}
        fill
      />
      {/* An icon on the corner, so it never covers the month heading; the
          words show on hover and keyboard focus. */}
      <span className="pointer-events-none absolute top-1 right-1 flex items-center gap-1 rounded-full border border-indigo-100 bg-white/95 p-1 text-[9px] font-bold uppercase tracking-wide text-indigo-600 shadow-sm">
        <CalendarDays className="w-3 h-3" aria-hidden />
        <span className="hidden pr-0.5 group-hover/grid:inline group-focus-visible/grid:inline">Add dates</span>
      </span>
    </button>
  );
}

function aspectParts(aspectRatio: string): [number, number] {
  const [w, h] = aspectRatio.split('/').map(Number);
  return [w || 1200, h || 1800];
}

/** A month that prints with an earlier card's photo because there are fewer
 *  photos than months. Shown so every printed page is visible; its date grid
 *  edits as usual, and it offers a photo of its own instead of the repeat. */
export function CalendarRepeatCard({ page, sourceDataUrl, aspectRatio, calendar, cardCount }: {
  page: CalendarCardPage;
  sourceDataUrl: string | undefined;
  aspectRatio: string;
  calendar: CalendarCardsConfig;
  cardCount: number;
}) {
  const label = displayLabelFor(page.year, page.month);
  const monthName = MONTH_NAMES_EN[page.month - 1];
  return (
    <div className={canvasCardWidthClass(cardCount)} style={canvasCardStyle(...aspectParts(aspectRatio))} data-testid="calendar-repeat-card">
      <div className="px-1 py-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight truncate">{label}</h3>
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-slate-400">
          Repeats image {page.canvasIdx + 1}
        </span>
      </div>
      <div className="bg-white border-2 border-dashed border-slate-300 relative">
        <div className="relative overflow-hidden bg-slate-100" style={{ aspectRatio }}>
          {sourceDataUrl && (
            <LazyImg src={sourceDataUrl} className="absolute inset-0 w-full h-full object-fill opacity-60" alt={`${label} (repeats image ${page.canvasIdx + 1})`} />
          )}
          <button
            type="button"
            onClick={calendar.onAddPhotos}
            className={`absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 whitespace-nowrap rounded-full border border-indigo-200 bg-white/95 px-3 py-1.5 text-[11px] font-bold text-indigo-700 shadow hover:bg-indigo-50 transition-colors ${page.block.y >= 0.25 ? 'top-3' : 'bottom-3'}`}
          >
            <ImagePlus className="w-3.5 h-3.5" aria-hidden />
            Add a photo for {monthName}
          </button>
          <CalendarGridZone page={page} calendar={calendar} />
        </div>
      </div>
    </div>
  );
}
