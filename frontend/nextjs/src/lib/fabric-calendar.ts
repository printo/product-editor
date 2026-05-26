/**
 * Build a Fabric.js Group representing one calendar primitive (one month
 * grid) for the editor preview. Mirrors the server-side
 * `backend/django/services/calendar_renderer.py` 1:1 so the editor
 * preview matches the printed 300 DPI output.
 *
 * Reference: CALENDAR_FEATURE_PRD.md §5 Phase 4. Shared math lives in
 * `src/lib/calendar.ts`; this module focuses on rendering the math
 * onto a Fabric Group.
 *
 * Usage from the editor (FabricEditor.tsx) or the off-screen renderer
 * (fabric-renderer.ts):
 *
 *     const group = buildCalendarFabricGroup({ ... });
 *     fabricCanvas.add(group);
 *
 * The group's bounding box matches the calendar primitive's pixel
 * rectangle so caller code can move/scale the whole thing as a unit.
 * Individual cells inside are NOT independently selectable — the
 * calendar is read-only for the customer (PRD §10.3).
 */
import { Group, Rect, Textbox, FabricText } from 'fabric';

import {
  buildMonthGrid,
  mergeCellEntries,
  weekdayHeaderLabels,
} from '@/lib/calendar';
import type {
  CalendarCellOverride,
  CalendarTheme,
  HolidayEntry,
  WeekStart,
  GenzPalette,
} from '@/types/calendar';


// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface CalendarColorScheme {
  background: string;
  monthText: string;
  weekdayText: string;
  weekdaySunday: string;
  dateNumber: string;
  dateNumberSunday: string;
  outOfMonth: string;
  grid: string;
  pillBackground: string;
  pillText: string;
}

const DEFAULT_COLORS: CalendarColorScheme = {
  background:       '#FFFFFF',
  monthText:        '#18181B',
  weekdayText:      '#71717A',
  weekdaySunday:    '#71717A',
  dateNumber:       '#18181B',
  dateNumberSunday: '#18181B',
  outOfMonth:       '#CCCCCC',
  grid:             '#E5E5E5',
  pillBackground:   '#F7F7F7',
  pillText:         '#1A1A1A',
};

const DEFAULT_DOT_CYCLE = ['#F59E0B', '#EC4899', '#3B82F6'] as const;

export interface BuildCalendarGroupOptions {
  /** Top-left X in canvas-pixel space. */
  x: number;
  /** Top-left Y in canvas-pixel space. */
  y: number;
  /** Calendar primitive width in pixels. */
  width: number;
  /** Calendar primitive height in pixels. */
  height: number;

  /** Resolved year (e.g. 2026). */
  year: number;
  /** Resolved month (1..12). */
  month: number;

  /** Layout's calendar theme. Drives colour defaults. */
  themePreset?: CalendarTheme;
  /** Sunday or Monday start. */
  weekStart?: WeekStart;
  /** Active Gen-Z palette (only meaningful when themePreset === 'modern-genz'). */
  palette?: GenzPalette | null;
  /** Locale for weekday labels (Intl.DateTimeFormat). */
  locale?: string;

  /** Customer's per-cell entries, keyed by ISO date. */
  userCells?: Record<string, CalendarCellOverride[]>;
  /** Auto-loaded holidays. Already filtered or unfiltered — we re-filter to month. */
  holidays?: HolidayEntry[];

  /**
   * When true, the calendar's children render as a single non-selectable
   * group (editor convention for read-only artwork). Defaults to true.
   */
  selectable?: boolean;
}


// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Construct a Fabric.js Group containing the entire calendar grid.
 *
 * The returned Group is positioned at (x, y) and sized (width, height)
 * — drop it onto a fabric canvas and it'll render in place. Children
 * are NOT independently selectable; the whole group is read-only.
 */
export function buildCalendarFabricGroup(opts: BuildCalendarGroupOptions): Group {
  const {
    x, y, width: w, height: h,
    year, month,
    themePreset = 'modern-minimalist',
    weekStart = 'sunday',
    palette = null,
    locale = 'en-IN',
    userCells = {},
    holidays = [],
    selectable = false,
  } = opts;

  const colors = resolveColors(themePreset, palette);
  const dotCycle = resolvePaletteDotCycle(palette);

  // Layout: header band on top + grid below. Same proportions as the
  // Python renderer so preview ≈ print.
  const headerH = Math.max(20, Math.round(h * 0.10));
  const gridTop = headerH;
  const gridH = h - headerH;

  const grid = buildMonthGrid(year, month, weekStart);
  const rows = Math.max(1, Math.floor(grid.length / 7));
  const cellW = w / 7;
  const cellH = gridH / rows;

  const children: Array<Rect | Textbox | FabricText> = [];

  // Bucket holidays by ISO for O(1) lookup, filtered to this calendar's month.
  const holidaysByIso: Record<string, HolidayEntry[]> = {};
  for (const h0 of holidays) {
    if (!h0?.date) continue;
    (holidaysByIso[h0.date] ??= []).push(h0);
  }

  // ── Weekday header ─────────────────────────────────────────────────────
  const headerFontSize = Math.max(8, Math.round(headerH * 0.45));
  const labels = weekdayHeaderLabels(weekStart, 'short', locale);
  for (let col = 0; col < 7; col++) {
    const isSunday =
      (weekStart === 'sunday' && col === 0) ||
      (weekStart === 'monday' && col === 6);
    const fillColor = isSunday ? colors.weekdaySunday : colors.weekdayText;
    children.push(new FabricText(labels[col], {
      left: col * cellW + cellW / 2,
      top: gridTop / 2,
      originX: 'center',
      originY: 'center',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: headerFontSize,
      fontWeight: 600,
      fill: fillColor,
      selectable: false,
      evented: false,
    }));
  }

  // Header underline
  children.push(new Rect({
    left: 0,
    top: gridTop - 1,
    width: w,
    height: 1,
    fill: colors.grid,
    selectable: false,
    evented: false,
  }));

  // ── Date cells ─────────────────────────────────────────────────────────
  const dateFontSize = Math.max(8, Math.round(Math.min(cellW, cellH) * 0.22));
  const pillFontSize = Math.max(6, Math.round(Math.min(cellW, cellH) * 0.13));
  const datePad = Math.max(2, Math.round(Math.min(cellW, cellH) * 0.05));
  const pillH = Math.max(12, Math.round(Math.min(cellW, cellH) * 0.20));
  const pillGap = Math.max(1, Math.round(pillH * 0.15));

  for (let i = 0; i < grid.length; i++) {
    const gc = grid[i];
    const col = i % 7;
    const row = Math.floor(i / 7);
    const cx0 = col * cellW;
    const cy0 = gridTop + row * cellH;
    const cx1 = (col + 1) * cellW;
    const cy1 = gridTop + (row + 1) * cellH;

    // Grid lines (right + bottom of each cell)
    if (col < 6) {
      children.push(new Rect({
        left: cx1, top: cy0, width: 1, height: cellH,
        fill: colors.grid, selectable: false, evented: false,
      }));
    }
    if (row < rows - 1) {
      children.push(new Rect({
        left: cx0, top: cy1, width: cellW, height: 1,
        fill: colors.grid, selectable: false, evented: false,
      }));
    }

    const isSunday = gc.dayOfWeek === 0;

    // ── Customer override check FIRST ──────────────────────────────────────
    // Image / hide overrides blank the cell entirely (§4.2.2). Checking
    // before the date-number push prevents the leak-bug where the date
    // number rendered on top of an override.
    const overrides = gc.inMonth ? (userCells[gc.iso] ?? []) : [];
    const hasHideOverride = overrides.some(o => o.type === 'hide');
    const imageOverride = overrides.find(o => o.type === 'image');

    if (hasHideOverride) {
      // type='hide' → render nothing in this cell (grid lines already drawn).
      continue;
    }

    if (imageOverride && imageOverride.type === 'image') {
      // Image override placeholder — the editor preview shows a grey rect
      // tagged with the upload_id. The actual image is composited by the
      // existing Fabric image-overlay path (calendar.cells image overrides
      // get hydrated into FabricImage objects elsewhere). This rect makes
      // the cell visibly different from "empty" until the image loads.
      children.push(new Rect({
        left: cx0 + datePad,
        top: cy0 + datePad,
        width: cellW - 2 * datePad,
        height: cellH - 2 * datePad,
        fill: '#E5E7EB',
        stroke: '#9CA3AF',
        strokeWidth: 1,
        selectable: false,
        evented: false,
      }));
      continue;
    }

    // ── Normal cell: date number + (optional) entry pills ──────────────────
    const dateColor = !gc.inMonth
      ? colors.outOfMonth
      : (isSunday ? colors.dateNumberSunday : colors.dateNumber);

    // Date number, anchored top-right
    children.push(new FabricText(String(gc.day), {
      left: cx1 - datePad,
      top: cy0 + datePad,
      originX: 'right',
      originY: 'top',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: dateFontSize,
      fontWeight: 600,
      fill: dateColor,
      selectable: false,
      evented: false,
    }));

    // Out-of-month cells render no entries / no holiday pills (§11.12).
    if (!gc.inMonth) continue;

    // Merge user entries + holidays (user-first, hard cap of 3).
    const entries = mergeCellEntries(overrides, holidaysByIso[gc.iso], dotCycle);

    // Pills stack below the date number
    let pillY = cy0 + Math.round(cellH * 0.35);
    for (const entry of entries) {
      const pillW = cellW - 2 * datePad;
      if (pillY + pillH > cy1) break;
      appendPill(children, {
        x: cx0 + datePad,
        y: pillY,
        w: pillW,
        h: pillH,
        text: entry.text,
        dotColor: entry.dotColor ?? dotCycle[0],
        bg: colors.pillBackground,
        textColor: colors.pillText,
        fontSize: pillFontSize,
      });
      pillY += pillH + pillGap;
    }
  }

  return new Group(children, {
    left: x,
    top: y,
    width: w,
    height: h,
    selectable,
    evented: selectable,
    // Children should never be picked individually — the calendar is read-only
    // artwork from the customer's perspective. Locking the group's interactions
    // makes the editor's hit-test ignore it during drag/select.
    subTargetCheck: false,
    interactive: false,
    hasControls: false,
    hasBorders: false,
  });
}


// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveColors(theme: CalendarTheme, palette: GenzPalette | null): CalendarColorScheme {
  const out = { ...DEFAULT_COLORS };

  if (theme === 'weekday-highlight') {
    out.weekdaySunday = '#DC2626';
    out.dateNumberSunday = '#DC2626';
  }

  if (theme === 'modern-genz' && palette) {
    out.background = palette.bg;
    out.monthText = palette.month;
    out.weekdayText = palette.weekday;
    out.weekdaySunday = palette.weekday;
    out.grid = palette.grid;
    out.dateNumber = palette.date;
    out.dateNumberSunday = palette.date;
    out.pillBackground = palette.pill;
  }

  return out;
}

function resolvePaletteDotCycle(palette: GenzPalette | null): readonly string[] {
  if (palette?.dotCycle && palette.dotCycle.length >= 3) {
    return palette.dotCycle;
  }
  return DEFAULT_DOT_CYCLE;
}

function appendPill(
  children: Array<Rect | Textbox | FabricText>,
  opts: {
    x: number; y: number; w: number; h: number;
    text: string;
    dotColor: string;
    bg: string;
    textColor: string;
    fontSize: number;
  },
) {
  const { x, y, w, h, text, dotColor, bg, textColor, fontSize } = opts;
  const radius = Math.max(2, Math.round(h / 4));

  // Pill background — rounded rect. Fabric Rect supports `rx`, `ry`.
  children.push(new Rect({
    left: x, top: y, width: w, height: h,
    fill: bg, rx: radius, ry: radius,
    selectable: false, evented: false,
  }));

  // Dot at the left edge
  const dotD = Math.max(3, h - 6);
  const dotX = x + 4;
  const dotY = y + (h - dotD) / 2;
  children.push(new Rect({
    left: dotX, top: dotY, width: dotD, height: dotD,
    fill: dotColor, rx: dotD / 2, ry: dotD / 2,
    selectable: false, evented: false,
  }));

  // Pill text — Fabric clips text to its own width, no manual auto-fit needed
  // for the preview (server-side uses binary-search clipping for fidelity).
  const textX = dotX + dotD + 4;
  children.push(new Textbox(text, {
    left: textX,
    top: y + h / 2,
    originY: 'center',
    width: Math.max(1, x + w - textX - 4),
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize,
    fontWeight: 500,
    fill: textColor,
    textAlign: 'left',
    selectable: false,
    evented: false,
    splitByGrapheme: false,
    editable: false,
  }));
}
