'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CalendarTheme, CalendarType, GenzPalette, HolidayEntry } from '@/types/calendar';
import { resolveDefaultYear } from '@/lib/calendar';
import { uploadCalendarCellImage, CalendarCellUploadError } from '@/lib/calendar-cell-upload';
import { isHeicFile } from '@/lib/heic-convert';
import type { NormalizedLayout } from '@/lib/layout-utils';
import { isAllowedImageFile, unsupportedFilesMessage } from '@/lib/upload-utils';
import { NO_HOLIDAYS } from './editor-utils';

type Setter<T> = Dispatch<SetStateAction<T>>;
type CalendarLayout = { productType?: string | null; id?: string; holidayLocale: string | null; calendarDefaultYear?: Parameters<typeof resolveDefaultYear>[0] } | null;

/** Calendar products: the customer's theme, type, palette and per-day
 *  entries, the day being edited, and the day-photo upload. */
export function useCalendarEditor({
  layout, orderId, apiBase, getAuthHeaders, expandPdfPages, setUnsupportedWarning, setPersistDegraded, setError,
}: {
  layout: CalendarLayout;
  orderId: string;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  expandPdfPages: (files: File[], opts: { maxSelectable: number | null }) => Promise<File[]>;
  setUnsupportedWarning: Setter<string | null>;
  setPersistDegraded: Setter<boolean>;
  setError: Setter<string | null>;
}) {
  // ── Calendar product state (PRD §10.3 / audit fix #1) ────────────────────
  // These only matter when layout.productType === 'calendar'. Initialised
  // with the layout-level defaults; customer overrides are tracked here.
  const isCalendarProduct = layout?.productType === 'calendar';
  const [calendarTheme, setCalendarTheme] = useState<CalendarTheme>('modern-minimalist');
  const [calendarType, setCalendarType] = useState<CalendarType>('english');
  const [genzPalette, setGenzPalette] = useState<string | undefined>(undefined);
  const [genzPalettes, setGenzPalettes] = useState<GenzPalette[]>([]);
  const [calendarHolidays, setCalendarHolidays] = useState<HolidayEntry[]>([]);
  // The print carries holidays only when the layout opts in; gated here as
  // well as at fetch time so a previous layout's holidays can never show.
  const printedHolidays = layout?.holidayLocale ? calendarHolidays : NO_HOLIDAYS;

  // Product-wide per-day entries, keyed by ISO date (flat map — Phase 2).
  // Entries belong to dates, not tile positions: the old 12-slot positional
  // array lost entries whenever photo-canvas count ≠ 12 and hid in-range
  // entries after an English↔Financial flip remapped slot→month.
  const [calendarCells, setCalendarCells] = useState<Record<string, any[]>>({});
  const [selectedCalendarCell, setSelectedCalendarCell] = useState<{
    surfaceIndex: number; year: number; month: number; iso: string;
  } | null>(null);
  // Phase 8 — cell image upload (calendar-cell-upload.ts orchestrator).
  // Hidden file input ref; result stored as blobUrl for instant preview.
  const calendarCellFileInputRef = useRef<HTMLInputElement | null>(null);
  const [calendarImageUploading, setCalendarImageUploading] = useState(false);
  // Key: iso date, value: blobUrl for preview thumbnail.
  // Blob URLs are revoked when the override is cleared or the page unmounts.
  const [calendarCellImagePreviews, setCalendarCellImagePreviews] = useState<Record<string, string>>({});

  // ── Calendar cell editing helpers (PRD §10.3 / audit fix #1) ─────────────

  const calendarCellEntries = (iso: string): any[] => calendarCells[iso] || [];

  const updateCellEntries = useCallback((iso: string, updater: (prev: any[]) => any[]) => {
    setCalendarCells(prev => {
      const next = { ...prev };
      const updated = updater(next[iso] || []);
      if (updated.length === 0) {
        delete next[iso];
      } else {
        next[iso] = updated;
      }
      return next;
    });
  }, []);

  // Phase 8 — cell image override upload
  const handleCellImageFileSelected = useCallback(async (file: File) => {
    if (!selectedCalendarCell || !orderId) return;
    // A calendar cell can only ever take one photo — single-select picker.
    const [expandedFile] = await expandPdfPages([file], { maxSelectable: 1 });
    if (!expandedFile) return; // PDF picker was cancelled
    file = expandedFile;
    // HEIC/HEIF pass this gate too — uploadCalendarCellImage converts them to
    // JPEG as its first step (see calendar-cell-upload.ts).
    if (!isAllowedImageFile(file) && !isHeicFile(file)) {
      setUnsupportedWarning(unsupportedFilesMessage([file]));
      return;
    }
    const { iso } = selectedCalendarCell;
    setCalendarImageUploading(true);
    try {
      const result = await uploadCalendarCellImage(file, {
        apiBase,
        orderId,
        getAuthHeaders,
      });
      // Replace any existing entries on this cell with the image override.
      updateCellEntries(iso, () => [{ type: 'image', uploadId: result.uploadId }]);
      if (result.persistDegraded) setPersistDegraded(true);
      // Cache the blob URL for the panel preview (keyed by ISO — dates are
      // globally unique, so the key survives calendar-type flips).
      setCalendarCellImagePreviews(prev => {
        if (prev[iso]) URL.revokeObjectURL(prev[iso]);
        return { ...prev, [iso]: result.blobUrl };
      });
    } catch (err) {
      if (err instanceof CalendarCellUploadError) {
        setError(err.message);
      } else {
        setError('Failed to upload image for this date. Please try again.');
      }
    } finally {
      setCalendarImageUploading(false);
    }
  }, [selectedCalendarCell, orderId, apiBase, getAuthHeaders, updateCellEntries, expandPdfPages, setUnsupportedWarning, setPersistDegraded, setError]);

  const handleCalendarMonthTileClick = (surfaceIndex: number, year: number, month: number) => {
    // Open the first day of the month by default — customer can tap a specific cell after.
    const firstIso = `${year}-${String(month).padStart(2, '0')}-01`;
    setSelectedCalendarCell({ surfaceIndex, year, month, iso: firstIso });
  };

  return {
    isCalendarProduct, calendarTheme, setCalendarTheme, calendarType, setCalendarType, genzPalette, setGenzPalette,
    genzPalettes, setGenzPalettes, setCalendarHolidays, printedHolidays, calendarCells, setCalendarCells,
    selectedCalendarCell, setSelectedCalendarCell, calendarCellFileInputRef, calendarImageUploading,
    calendarCellImagePreviews, setCalendarCellImagePreviews,
    calendarCellEntries, updateCellEntries, handleCellImageFileSelected, handleCalendarMonthTileClick,
  };
}

/** On a calendar layout: apply the ops defaults (theme, type), fetch the Gen-Z
 *  palettes, and fetch the holidays the print will carry. */
export function useCalendarDefaults({
  isCalendarProduct, layout, normalizedLayoutState, apiBase, getAuthHeaders,
  setCalendarTheme, setCalendarType, setGenzPalettes, setCalendarHolidays,
}: {
  isCalendarProduct: boolean;
  layout: CalendarLayout;
  normalizedLayoutState: NormalizedLayout | null;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  setCalendarTheme: Setter<CalendarTheme>;
  setCalendarType: Setter<CalendarType>;
  setGenzPalettes: Setter<GenzPalette[]>;
  setCalendarHolidays: Setter<HolidayEntry[]>;
}) {
  // ── Calendar: fetch Gen-Z palettes + holidays on layout mount ────────────
  // Only runs for productType='calendar' layouts. Gen-Z palettes are needed
  // for the palette swatch picker. Holidays are fetched only when the print
  // will carry them (`holidayLocale` is null otherwise), for every year the
  // print could cover: the layout's defaultYear resolved like the print, for
  // either calendar type (the customer can flip it), plus the following year
  // for FY ranges straddling two calendar years.
  useEffect(() => {
    if (!isCalendarProduct || !layout) return;

    // Apply layout-level ops defaults for customer-controllable fields.
    const rawCalendar = (normalizedLayoutState as any)?._raw?.calendar;
    if (rawCalendar?.themePreset) setCalendarTheme(rawCalendar.themePreset as CalendarTheme);
    if (rawCalendar?.calendarType) setCalendarType(rawCalendar.calendarType as CalendarType);

    // Fetch Gen-Z palettes if theme default is modern-genz.
    fetch(`${apiBase}/calendar-styles/modern-genz`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.palettes?.length) setGenzPalettes(d.palettes); })
      .catch(() => {});

    const locale: string | null = layout.holidayLocale;
    if (!locale) return;
    const holidayYears = Array.from(new Set(
      (['english', 'financial'] as const)
        .map(t => resolveDefaultYear(layout.calendarDefaultYear, t))
        .flatMap(y => [y, y + 1]),
    ));
    let cancelled = false;
    Promise.all(holidayYears.map(yr =>
      fetch(`${apiBase}/holidays/${encodeURIComponent(locale)}/${yr}`, { headers: getAuthHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then(d => (d?.events as HolidayEntry[]) || [])
        .catch(() => [] as HolidayEntry[])
    )).then(perYear => { if (!cancelled) setCalendarHolidays(perYear.flat()); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCalendarProduct, layout?.id]);
}
