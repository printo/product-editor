'use client';

/**
 * Compact month day-picker shown at the top of `CalendarEditPanel`, so the
 * customer can move the day editor to ANY date the calendar prints — not
 * just the 1st of the month tile they tapped.
 *
 * Controlled: the selected ISO date comes in, `onSelectDate` goes out. The
 * picker never steps outside `months` (the 12 (year, month) pairs the print
 * covers, resolved by the parent through `resolveDefaultYear`), so an
 * English calendar can't reach the April after it and a Financial one can't
 * reach the January before it.
 *
 * Keyboard (roving tabindex — only the selected day is a tab stop):
 *   ←/→ one day, ↑/↓ one week, PageUp/PageDown one month, Home/End the
 *   first/last day of the month. Moves that would leave the range do nothing.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  MONTH_NAMES_EN,
  buildMonthGrid,
  displayLabelFor,
  isoFromDate,
  weekdayHeaderLabels,
} from '@/lib/calendar';
import type { CalendarCellOverride, HolidayEntry, WeekStart } from '@/types/calendar';

export interface CalendarDayPickerProps {
  /** Selected ISO date, e.g. "2027-03-08". */
  iso: string;
  /** The months the calendar prints, in order. */
  months: readonly { year: number; month: number }[];
  weekStart: WeekStart;
  cells?: Readonly<Record<string, CalendarCellOverride[]>>;
  holidays?: readonly HolidayEntry[];
  onSelectDate: (iso: string) => void;
}

const daysIn = (year: number, month: number) => new Date(year, month, 0).getDate();

function parseIso(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { year: y, month: m, day: d };
}

/** Same day-of-month in the month `delta` away, clamped to its length. */
function shiftMonth(iso: string, delta: number): string {
  const { year, month, day } = parseIso(iso);
  const first = new Date(year, month - 1 + delta, 1);
  const y = first.getFullYear();
  const m = first.getMonth() + 1;
  return isoFromDate(new Date(y, m - 1, Math.min(day, daysIn(y, m))));
}

function shiftDays(iso: string, delta: number): string {
  const { year, month, day } = parseIso(iso);
  return isoFromDate(new Date(year, month - 1, day + delta));
}

function longLabel(year: number, month: number, day: number): string {
  return `${day} ${MONTH_NAMES_EN[month - 1]} ${year}`;
}

export function CalendarDayPicker({
  iso,
  months,
  weekStart,
  cells,
  holidays = [],
  onSelectDate,
}: CalendarDayPickerProps) {
  const { year, month } = parseIso(iso);
  const inRange = useMemo(() => {
    const keys = new Set(months.map(m => `${m.year}-${m.month}`));
    return (target: string) => {
      const t = parseIso(target);
      return keys.has(`${t.year}-${t.month}`);
    };
  }, [months]);

  const grid = useMemo(() => buildMonthGrid(year, month, weekStart), [year, month, weekStart]);
  const weekdays = useMemo(() => weekdayHeaderLabels(weekStart, 'short'), [weekStart]);
  const holidaysByIso = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const h of holidays) map.set(h.date, [...(map.get(h.date) ?? []), h.name]);
    return map;
  }, [holidays]);

  const prevIso = shiftMonth(iso, -1);
  const nextIso = shiftMonth(iso, 1);
  const hasPrev = inRange(prevIso);
  const hasNext = inRange(nextIso);

  // Keyboard moves keep focus on the newly selected day; clicks and the
  // month buttons leave focus where it is.
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusSelectedRef = useRef(false);
  useEffect(() => {
    if (!focusSelectedRef.current) return;
    focusSelectedRef.current = false;
    dayRefs.current.get(iso)?.focus();
  }, [iso]);

  const moveTo = (target: string) => {
    if (target === iso || !inRange(target)) return;
    focusSelectedRef.current = true;
    onSelectDate(target);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const { day } = parseIso(iso);
    const targets: Record<string, string> = {
      ArrowLeft: shiftDays(iso, -1),
      ArrowRight: shiftDays(iso, 1),
      ArrowUp: shiftDays(iso, -7),
      ArrowDown: shiftDays(iso, 7),
      PageUp: prevIso,
      PageDown: nextIso,
      Home: shiftDays(iso, 1 - day),
      End: shiftDays(iso, daysIn(year, month) - day),
    };
    const target = targets[e.key];
    if (!target) return;
    e.preventDefault();
    moveTo(target);
  };

  const monthLabel = displayLabelFor(year, month);

  return (
    <section data-testid="calendar-day-picker" aria-label="Choose a date">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => onSelectDate(prevIso)}
          disabled={!hasPrev}
          aria-label="Previous month"
          data-testid="day-picker-prev-month"
          className="h-8 w-8 rounded-md text-lg leading-none text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ‹
        </button>
        <span className="text-sm font-semibold text-zinc-900" aria-live="polite" data-testid="day-picker-month">
          {monthLabel}
        </span>
        <button
          type="button"
          onClick={() => onSelectDate(nextIso)}
          disabled={!hasNext}
          aria-label="Next month"
          data-testid="day-picker-next-month"
          className="h-8 w-8 rounded-md text-lg leading-none text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 text-center" aria-hidden="true">
        {weekdays.map((w, i) => (
          <span key={i} className="text-[10px] font-medium uppercase text-zinc-400 py-0.5">{w.slice(0, 2)}</span>
        ))}
      </div>
      <div
        role="group"
        aria-label={`Days in ${monthLabel}`}
        className="grid grid-cols-7 gap-0.5"
        onKeyDown={handleKeyDown}
      >
        {grid.map(cell => {
          if (!cell.inMonth) return <span key={cell.iso} aria-hidden="true" />;
          const selected = cell.iso === iso;
          const entries = cells?.[cell.iso] ?? [];
          const holidayNames = holidaysByIso.get(cell.iso) ?? [];
          const details: string[] = [];
          if (entries.some(o => o.type === 'image')) details.push('photo');
          else if (entries.some(o => o.type === 'hide')) details.push('hidden');
          else {
            const texts = entries.filter(o => o.type === 'text').length;
            if (texts) details.push(`${texts} ${texts === 1 ? 'entry' : 'entries'}`);
          }
          if (holidayNames.length) details.push(`holiday: ${holidayNames.join(', ')}`);
          const label = longLabel(cell.year, cell.month, cell.day) + (details.length ? `, ${details.join(', ')}` : '');
          return (
            <button
              key={cell.iso}
              ref={el => {
                if (el) dayRefs.current.set(cell.iso, el);
                else dayRefs.current.delete(cell.iso);
              }}
              type="button"
              tabIndex={selected ? 0 : -1}
              aria-pressed={selected}
              aria-label={label}
              data-iso={cell.iso}
              data-has-entries={entries.length > 0 || undefined}
              data-has-holiday={holidayNames.length > 0 || undefined}
              onClick={() => { if (!selected) onSelectDate(cell.iso); }}
              className={
                'relative h-8 rounded-md text-xs tabular-nums transition-colors ' +
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1 ' +
                (selected
                  ? 'bg-zinc-900 text-white font-semibold'
                  : holidayNames.length
                    ? 'text-red-700 hover:bg-zinc-100'
                    : 'text-zinc-700 hover:bg-zinc-100')
              }
            >
              {cell.day}
              {(entries.length > 0 || holidayNames.length > 0) && (
                <span aria-hidden="true" className="absolute bottom-0.5 left-1/2 -translate-x-1/2 flex gap-0.5">
                  {entries.length > 0 && (
                    <span className={'block h-1 w-1 rounded-full ' + (selected ? 'bg-white' : 'bg-indigo-600')} />
                  )}
                  {holidayNames.length > 0 && (
                    <span className={'block h-1 w-1 rounded-full ' + (selected ? 'bg-red-300' : 'bg-red-500')} />
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 flex items-center gap-3 text-[11px] text-zinc-500">
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-indigo-600" />Your entries</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-red-500" />Holiday</span>
      </p>
    </section>
  );
}
