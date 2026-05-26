'use client';

/**
 * Tiny calendar-grid thumbnail rendered inside each month tile on the
 * customer preview (CALENDAR_FEATURE_PRD §5 Phase 5).
 *
 * Pure HTML+CSS (no Fabric, no SVG, no canvas) so it round-trips through
 * SSR + happy-dom tests cleanly. Same `buildMonthGrid` math as the live
 * editor preview + 300 DPI server render, so the thumb is a faithful
 * mini-preview of what gets printed.
 *
 * What it shows:
 *   - Weekday header (narrow: S M T W T F S)
 *   - Date numbers in a 7×N grid (N = 5 or 6)
 *   - A tiny coloured dot on dates that have entries (user or holiday)
 *   - Out-of-month cells greyed
 *   - Theme colours applied from `colors` prop
 *
 * What it deliberately does NOT show:
 *   - Pill labels (no room — clicking the tile opens the full editor)
 *   - "+N more" overflow (hard cap of 3 already means max 3 dots per cell)
 *   - Image / hide overrides (renders the cell blank — same as the print)
 */

import {
  buildMonthGrid,
  weekdayHeaderLabels,
} from '@/lib/calendar';
import type {
  CalendarCellOverride,
  HolidayEntry,
  WeekStart,
} from '@/types/calendar';

export interface ThumbColors {
  bg: string;
  dateText: string;
  outOfMonthText: string;
  grid: string;
  weekdayText: string;
  sundayBg?: string;
  sundayText?: string;
}

export interface MonthTileThumbProps {
  year: number;
  month: number;             // 1..12
  weekStart: WeekStart;
  /** User entries for THIS surface, keyed by ISO date. */
  cells?: Record<string, CalendarCellOverride[]>;
  /** Holidays in this month (already filtered). */
  holidays?: HolidayEntry[];
  /** Resolved colours from the active theme + palette. */
  colors: ThumbColors;
  /** 3-slot user-entry dot cycle from the active theme/palette. */
  dotCycle: readonly string[];
  /** Optional aria-label override (defaults to "January 2026 preview"). */
  ariaLabel?: string;
}

// ─── Dot lookup per date ────────────────────────────────────────────────────

interface DotInfo {
  dotColors: string[];      // up to 3, in render order
  hasImage: boolean;
  hasHide: boolean;
}

function dotsForDate(
  iso: string,
  cells: Record<string, CalendarCellOverride[]> | undefined,
  holidays: HolidayEntry[],
  dotCycle: readonly string[],
): DotInfo {
  const userEntries = cells?.[iso] ?? [];
  const hasImage = userEntries.some(o => o.type === 'image');
  const hasHide = userEntries.some(o => o.type === 'hide');
  if (hasImage || hasHide) return { dotColors: [], hasImage, hasHide };

  const dotColors: string[] = [];
  // User text entries fill cap first (§11.14).
  let userIdx = 0;
  for (const o of userEntries) {
    if (o.type !== 'text') continue;
    if (dotColors.length >= 3) break;
    dotColors.push(dotCycle[userIdx % Math.max(1, dotCycle.length)] ?? '#9CA3AF');
    userIdx++;
  }
  // Holidays fill remaining slots.
  for (const h of holidays) {
    if (h.date !== iso) continue;
    if (dotColors.length >= 3) break;
    dotColors.push(h.color || '#9CA3AF');
  }
  return { dotColors, hasImage: false, hasHide: false };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function MonthTileThumb({
  year,
  month,
  weekStart,
  cells,
  holidays = [],
  colors,
  dotCycle,
  ariaLabel,
}: MonthTileThumbProps) {
  const grid = buildMonthGrid(year, month, weekStart);
  const weekdayLabels = weekdayHeaderLabels(weekStart, 'narrow');

  // Bucket holidays to this month upfront so the dot helper is O(daysInMonth).
  const holidaysThisMonth = holidays.filter(h =>
    h.date.startsWith(`${year}-${String(month).padStart(2, '0')}-`)
  );

  return (
    <div
      role="img"
      aria-label={ariaLabel ?? `Mini preview of month`}
      className="w-full h-full rounded-sm overflow-hidden"
      style={{ background: colors.bg }}
      data-testid="month-tile-thumb"
    >
      {/* Weekday header row */}
      <div
        className="grid grid-cols-7 gap-0 px-1 pt-1 pb-0.5"
        style={{ borderBottom: `0.5px solid ${colors.grid}` }}
      >
        {weekdayLabels.map((label, col) => {
          const isSun =
            (weekStart === 'sunday' && col === 0) ||
            (weekStart === 'monday' && col === 6);
          return (
            <span
              key={`wd-${col}`}
              className="text-center font-medium leading-none"
              style={{
                fontSize: '6px',
                color: isSun ? (colors.sundayText ?? colors.weekdayText) : colors.weekdayText,
              }}
            >
              {label}
            </span>
          );
        })}
      </div>

      {/* Date cells — 5 or 6 rows depending on month layout */}
      <div className="grid grid-cols-7 gap-0 px-1 pb-1">
        {grid.map((gc, i) => {
          const iso = gc.iso;
          const dotInfo = gc.inMonth
            ? dotsForDate(iso, cells, holidaysThisMonth, dotCycle)
            : { dotColors: [], hasImage: false, hasHide: false };

          // Out-of-month or hidden cells render the number greyed (or blank for hide).
          const showNumber = !dotInfo.hasHide;
          const numColor = !gc.inMonth
            ? colors.outOfMonthText
            : (gc.dayOfWeek === 0 && colors.sundayText) || colors.dateText;

          const sundayFill =
            gc.dayOfWeek === 0 && gc.inMonth && colors.sundayBg ? colors.sundayBg : 'transparent';

          return (
            <div
              key={`c-${i}`}
              className="aspect-square relative flex items-center justify-center"
              style={{ background: sundayFill }}
            >
              {showNumber && (
                <span
                  className="leading-none font-medium"
                  style={{ fontSize: '6px', color: numColor }}
                >
                  {gc.day}
                </span>
              )}
              {/* Tiny dots — bottom-centre, max 3 */}
              {dotInfo.dotColors.length > 0 && (
                <div
                  className="absolute left-0 right-0 flex justify-center gap-[1px]"
                  style={{ bottom: '0.5px' }}
                >
                  {dotInfo.dotColors.map((c, di) => (
                    <span
                      key={di}
                      className="rounded-full"
                      style={{ background: c, width: '2px', height: '2px' }}
                    />
                  ))}
                </div>
              )}
              {/* Image override → tiny camera glyph in the cell centre. */}
              {dotInfo.hasImage && (
                <span
                  className="absolute inset-0 flex items-center justify-center text-[8px]"
                  aria-label="cell has image override"
                  title="Image override"
                >
                  📷
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
