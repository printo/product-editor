/**
 * Calendar product type — shared types across editor, ops authoring,
 * customer preview, and the server-side renderer.
 *
 * Reference: CALENDAR_FEATURE_PRD.md §4.2, §10, §11.
 *
 * Design principle: every shape in this file maps 1:1 to a JSON shape
 * that's either stored on disk (layout JSON, calendar_styles JSON,
 * holidays JSON) or persisted in CanvasData.editor_state. There are no
 * runtime-only types here. Anything that doesn't round-trip cleanly to
 * JSON should NOT live in this file.
 */

// ─── Calendar primitive (lives inside a layout) ──────────────────────────────

/**
 * Three style presets (PRD §10.3). Customer picks one on the preview page.
 * Locked at layout creation as the ops default; customer can override.
 */
export type CalendarTheme = 'modern-minimalist' | 'modern-genz' | 'weekday-highlight';

/**
 * English (Jan–Dec) vs Financial (Apr–Mar, India FY). Drives the
 * surface-index → (year, month) resolution formula in §11.1.
 *
 * Customer-controllable on the preview page (PRD §10.3). Defaults to
 * the layout's ops-set value.
 */
export type CalendarType = 'english' | 'financial';

/** Cultural convention. Locked at layout creation by ops (PRD §10.3). */
export type WeekStart = 'sunday' | 'monday';

/**
 * Locale of the holiday list to auto-load. `en-IN` seeded for India;
 * `generic` is a universal-observances fallback (PRD §11.11). Custom
 * locales can be added by ops via `PUT /api/ops/holidays/<locale>/<year>`.
 */
export type HolidayLocale = 'en-IN' | 'generic' | string;

/**
 * One calendar primitive on the canvas. A layout has 1+ of these.
 *
 * Two valid configurations in v1 (PRD §11.1):
 *   - Multi-surface mode: `calendars.length === 1`, surface index drives month
 *   - Multi-calendar single-page mode: `calendars.length === 12`, each entry has
 *     an explicit `monthOffset`. Used for year-on-one-poster layouts.
 *
 * Constraint: `monthRange.count * calendars.length === 12`.
 */
export interface LayoutCalendar {
  /** Top-left X as a fraction of canvas width (0..1). */
  x: number;
  /** Top-left Y as a fraction of canvas height (0..1). */
  y: number;
  /** Width as a fraction of canvas width (0..1). */
  width: number;
  /** Height as a fraction of canvas height (0..1). */
  height: number;
  /**
   * For multi-calendar single-page mode: the offset (0..11) of which month
   * this primitive renders, relative to the first month of the resolved
   * range. Omitted/0 in multi-surface mode (surface index drives the month).
   */
  monthOffset?: number;
}

/**
 * Holiday auto-load configuration per layout (PRD §11.11).
 * Customer can never override these — ops sets at layout creation.
 */
export interface HolidaySource {
  enabled: boolean;
  locale: HolidayLocale;
  /** When true, holidays appear as auto-loaded entries in cells. */
  showInCells: boolean;
}

/**
 * The calendar-style block on a layout JSON. Stores ops defaults
 * (themePreset, calendarType) and ops-locked fields (weekStart).
 *
 * Customer can override themePreset + calendarType on the preview page
 * (§10.3); the customer's choice lives in CalendarState (editor_state),
 * not in this layout-level field.
 */
export interface LayoutCalendarStyle {
  /** Ops default; customer-overridable on preview page. */
  themePreset: CalendarTheme;
  /** Ops default; customer-overridable on preview page. */
  calendarType: CalendarType;
  /** Ops-locked per PRD §10.3 / §11.15. */
  weekStart: WeekStart;
  /** Auto-load holidays for the layout's locale. */
  holidaySource: HolidaySource;
  /**
   * Maximum entries (user + holidays) rendered per cell. Cap is hard;
   * overflow is silently suppressed (PRD §11.10). Default 3.
   */
  maxEntriesPerCell?: number;
  /**
   * Gen-Z palette to default to when themePreset === 'modern-genz'.
   * Customer can switch on the preview page via the palette swatches.
   */
  defaultGenzPalette?: string;
}

/**
 * Range of months the calendar product covers. v1 always 12-month
 * annual; non-12 counts are rejected by validators per §11.1.
 */
export interface MonthRange {
  /** Number of months covered. v1 must be 12. */
  count: number;
  /**
   * Year anchor. Use the string literal `"current"` to auto-roll
   * (PRD §10.4 — resolves at editor mount via today's date), or a
   * concrete year (e.g. `2026`) to freeze the layout to one year.
   */
  defaultYear: number | 'current';
}

/**
 * Per-surface field-level overrides (PRD §10.2.1, §11.15).
 * Sparse: only months ops customized hold an entry; others inherit
 * from the layout template.
 *
 * Keys: surface keys ("month_01"..."month_12"). Values: a partial
 * surface config; missing fields inherit from the template.
 *
 * Banned fields (validator rejects): canvas, monthRange, themePreset,
 * calendarType, weekStart.
 */
export interface SurfaceOverride {
  /** Replace the template's frame layout for this month. */
  frames?: import('@/lib/layout-utils').FrameSpec[];
  /** Reposition the calendar primitive(s) for this month. */
  calendars?: LayoutCalendar[];
  /** Add decorative overlays for this month (e.g. snowflakes on Dec). */
  overlays?: Array<Record<string, unknown>>;
}

export type SurfaceOverrideMap = Record<string, SurfaceOverride>;

// ─── Per-canvas customer state (lives in CanvasData.editor_state) ────────────

/**
 * Customer-controlled cell-level entry. Mutually exclusive per cell:
 * either text entries (up to 3, see §11.14) OR an image override that
 * blanks the whole cell.
 *
 * Keyed by ISO date string ("2026-01-15") so leap-year / calendar-type
 * flips preserve entries naturally (§11.4, §11.8).
 */
export type CalendarCellOverride =
  | { type: 'text'; text: string }
  | { type: 'image'; uploadId: string; opacity?: number }
  | { type: 'hide' /* hide the date number, leave cell empty */ };

/**
 * Customer's per-canvas state for a calendar product. Stored under
 * CanvasItem.calendar in editor_state. Only present when the layout
 * has productType === 'calendar'.
 */
export interface CalendarState {
  /** Resolved at mount from today + calendarType (§10.4); never edited by customer. */
  year: number;
  /** 1..12 of the visible month for this canvas's surface. */
  month: number;
  /**
   * Customer's theme override; falls back to layout's themePreset.
   * Optional so a customer who never touches the picker has no state.
   */
  themePreset?: CalendarTheme;
  /**
   * Customer's calendar type override; flips Jan–Dec ↔ Apr–Mar.
   * Falls back to layout's calendarType.
   */
  calendarType?: CalendarType;
  /**
   * Gen-Z palette pick. Only relevant when the active theme is
   * `modern-genz` (interlinked UI — §10.3).
   */
  genzPalette?: string;
  /**
   * Per-cell entries keyed by ISO date ("2026-01-15").
   * Entries on dates outside the visible range survive but don't
   * render — they re-appear if the customer flips year/type (§11.4).
   */
  cells: Record<string, CalendarCellOverride[]>;
}

// ─── Style preset JSON (storage/calendar_styles/*.json) ──────────────────────

/**
 * 3-slot dot-colour cycle used to auto-assign user-entry dot colours
 * by entry index. Keeps multi-entry cells visually distinguishable
 * without exposing a per-entry colour picker.
 */
export type DotCycle = [string, string, string];

/**
 * One Gen-Z palette. The customer picks among these on the preview
 * page when the active theme is `modern-genz` (§10.3, §6.3).
 */
export interface GenzPalette {
  /** File-safe identifier (e.g. `butter`). */
  name: string;
  /** Human label (e.g. "Butter & Purple"). */
  label: string;
  /** Page background. */
  bg: string;
  /** Month name text colour. */
  month: string;
  /** Weekday header text colour. */
  weekday: string;
  /** Grid line colour. */
  grid: string;
  /** Date-number text colour. */
  date: string;
  /** Entry pill background — uniform across all entries in this palette. */
  pill: string;
  /** 3-slot user-dot cycle. */
  dotCycle: DotCycle;
}

/**
 * Shape of `storage/calendar_styles/<name>.json`. Static config; ops
 * tweaks via `PUT /api/ops/calendar-styles/<name>`.
 */
export interface CalendarStylePresetFile {
  name: string;
  label: string;
  /** Colour roles consumed by the renderer. Concrete keys per theme. */
  colors: Record<string, string>;
  /** 3-slot user-dot cycle for themes other than Gen-Z. */
  dotCycle: DotCycle;
  /** Gen-Z-specific: list of available palette swatches. */
  palettes?: GenzPalette[];
}

// ─── Holiday data (storage/holidays/<locale>/<year>.json) ────────────────────

export interface HolidayEntry {
  /** ISO date string, e.g. `"2026-01-26"`. */
  date: string;
  /** Display name, e.g. `"Republic Day"`. */
  name: string;
  /** Free-form classifier — `"national"`, `"regional"`, `"festival"`, etc. */
  type?: string;
  /** Dot colour for the cell pill. Falls back to a theme default if absent. */
  color?: string;
}

export interface HolidayYearFile {
  year: number;
  locale: HolidayLocale;
  events: HolidayEntry[];
}
