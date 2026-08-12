'use client';

/**
 * Dev-only integration target for the calendar feature
 * (CALENDAR_FEATURE_PRD §5 Phase 5 onwards).
 *
 * Mounts the calendar components with stubbed state + mock palettes /
 * holidays so engineers can click through the UI in a real browser and
 * catch runtime issues that happy-dom / RTL miss (CSS layout collapse,
 * hydration mismatches, real focus handling, browser-paint differences).
 *
 * LIFECYCLE (decision May 22, 2026):
 *   - Keep through the rest of calendar feature dev (Phases 6–10).
 *   - As each phase adds real data sources (ops layout editor, file
 *     uploads, persistence, embed flow), replace the stubs here with
 *     real wiring so this page tracks the integration surface.
 *   - DELETE after one real calendar layout is in prod and customer-side
 *     QA has signed off — the real customer route then takes over.
 *
 * Note for future maintainers: the in-page yellow banner reminds anyone
 * who hits this URL that it's not a customer-facing flow. Production
 * builds still ship this route (it lives under `src/app/`), so the
 * banner is the only signal it's a dev tool.
 */

import { useEffect, useRef, useState } from 'react';
import { CalendarProductPreview } from '@/components/CalendarProductPreview';
import { CalendarEditPanel } from '@/components/CalendarEditPanel';
import { usePdfPageImport } from '@/components/use-pdf-page-import';
import { IMAGE_AND_PDF_ACCEPT_ATTR } from '@/lib/upload-utils';
import {
  CalendarCellUploadError,
  uploadCalendarCellImage,
} from '@/lib/calendar-cell-upload';
import type {
  CalendarCellOverride,
  CalendarTheme,
  CalendarType,
  GenzPalette,
  HolidayEntry,
} from '@/types/calendar';

// Hard-coded palette list — production fetches from /api/calendar-styles/modern-genz.
const STUB_PALETTES: GenzPalette[] = [
  { name: 'butter', label: 'Butter & Purple', bg: '#FEF3C7', month: '#A855F7',
    weekday: '#A855F7', grid: '#FBCFE8', date: '#0F172A', pill: '#CCFBF1',
    dotCycle: ['#A855F7', '#EC4899', '#0EA5E9'] },
  { name: 'mint',   label: 'Mint & Hot Pink', bg: '#ECFDF5', month: '#DB2777',
    weekday: '#DB2777', grid: '#FCE7F3', date: '#0F172A', pill: '#FEF3C7',
    dotCycle: ['#DB2777', '#F59E0B', '#10B981'] },
  { name: 'lilac',  label: 'Lilac & Coral', bg: '#FAF5FF', month: '#F97316',
    weekday: '#F97316', grid: '#E9D5FF', date: '#1E1B4B', pill: '#FED7AA',
    dotCycle: ['#F97316', '#A855F7', '#0EA5E9'] },
  { name: 'sky',    label: 'Sky & Lemon', bg: '#F0F9FF', month: '#0284C7',
    weekday: '#0284C7', grid: '#BAE6FD', date: '#0C4A6E', pill: '#FEF08A',
    dotCycle: ['#0284C7', '#EAB308', '#EC4899'] },
];

// Pre-seeded customer state for clicking around with — Jan/Feb/Mar entries
// to demonstrate the calendar-type flip warning modal.
const SEED_CELLS: Record<string, CalendarCellOverride[]> = {
  '2026-01-07': [{ type: 'text', text: "Mom's birthday" }],
  '2026-01-22': [{ type: 'text', text: 'Dentist' }],
  '2026-01-12': [{ type: 'hide' }],
  '2026-02-14': [{ type: 'text', text: 'Valentine plans' }],
};

// Stub holidays for the demo — production fetches /api/holidays/en-IN/<year>.
const HOLIDAYS_2026: HolidayEntry[] = [
  { date: '2026-01-01', name: 'New Year', color: '#3B82F6' },
  { date: '2026-01-14', name: 'Pongal', color: '#F59E0B' },
  { date: '2026-01-26', name: 'Republic Day', color: '#DC2626' },
];

// Stable order-id for the dev page so refreshes restore IDB blob persistence
// the same way the customer-facing route will (one orderId per session).
const DEV_ORDER_ID = 'dev-calendar-preview';

export default function CalendarPreviewClient() {
  const [themePreset, setThemePreset] = useState<CalendarTheme>('modern-minimalist');
  const [calendarType, setCalendarType] = useState<CalendarType>('english');
  const [genzPalette, setGenzPalette] = useState<string>('butter');
  const [calendarCells, setCalendarCells] = useState(SEED_CELLS);
  const [activeCell, setActiveCell] = useState<{
    surfaceIndex: number;
    iso: string;
  } | null>(null);
  // P8.3 — upload state surfaced to the edit panel.
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Holds blob: URLs from in-session uploads so we can revoke them on unmount.
  const cellBlobUrlsRef = useRef<Map<string, string>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { expandPdfPages, pdfPickerElement } = usePdfPageImport();

  // P8.3 — real file-picker → chunked-upload → IDB persistence. The dev page
  // hits the backend through the internal proxy (Bearer-key path); in the
  // customer-facing route this becomes the embed proxy. Errors surface inline
  // via setUploadError so the integration smoke is informative when the
  // backend's unavailable (the dev page often runs without docker compose).
  const handleCellImageSelected = async (file: File) => {
    setUploadError(null);
    // A calendar cell can only ever take one photo — single-select picker.
    const [expandedFile] = await expandPdfPages([file], { maxSelectable: 1 });
    if (!expandedFile) return; // PDF picker was cancelled
    file = expandedFile;
    setUploading(true);
    try {
      const result = await uploadCalendarCellImage(file, {
        apiBase: '/api/internal/proxy',
        orderId: DEV_ORDER_ID,
        getAuthHeaders: () => ({}),
      });
      updateActiveCellEntries(c => {
        const kept: CalendarCellOverride[] = c.filter(o => o.type !== 'image');
        const next: CalendarCellOverride = { type: 'image', uploadId: result.uploadId };
        return [...kept, next];
      });
      // Track the cell's blob URL so the renderer (Phase 9 work) can show an
      // immediate preview without re-fetching.
      cellBlobUrlsRef.current.set(result.uploadId, result.blobUrl);
    } catch (err) {
      setUploadError(
        err instanceof CalendarCellUploadError
          ? err.message
          : err instanceof Error
            ? `Upload failed: ${err.message}`
            : 'Upload failed for an unknown reason.',
      );
    } finally {
      setUploading(false);
    }
  };
  useEffect(
    () => () => {
      cellBlobUrlsRef.current.forEach(u => URL.revokeObjectURL(u));
      cellBlobUrlsRef.current.clear();
    },
    [],
  );

  // The active cell's entries + holidays for the side panel.
  const activeEntries = activeCell ? calendarCells[activeCell.iso] ?? [] : [];
  const activeHolidays = activeCell
    ? HOLIDAYS_2026.filter(h => h.date === activeCell.iso)
    : [];

  function updateActiveCellEntries(
    transform: (current: CalendarCellOverride[]) => CalendarCellOverride[]
  ) {
    if (!activeCell) return;
    setCalendarCells(prev => {
      const next = { ...prev };
      const updated = transform(next[activeCell.iso] ?? []);
      if (updated.length === 0) {
        delete next[activeCell.iso];
      } else {
        next[activeCell.iso] = updated;
      }
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex">
      {pdfPickerElement}
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_AND_PDF_ACCEPT_ATTR}
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          // Reset so picking the same file twice still fires onChange.
          e.target.value = '';
          if (file) void handleCellImageSelected(file);
        }}
      />
      <div className="flex-1">
        <div className="px-6 py-4 bg-amber-50 border-b border-amber-200 text-xs text-amber-900">
          <strong>Dev-only route</strong> — calendar feature integration target.
          Kept through Phases 6–10; delete <code>src/app/dev/calendar-preview/</code>{' '}
          after the first real calendar layout ships to prod.
        </div>
        <CalendarProductPreview
          themePreset={themePreset}
          onThemePresetChange={setThemePreset}
          genzPalette={genzPalette}
          genzPalettes={STUB_PALETTES}
          onGenzPaletteChange={setGenzPalette}
          calendarType={calendarType}
          onCalendarTypeChange={setCalendarType}
          cells={calendarCells}
          holidays={HOLIDAYS_2026}
          weekStart="sunday"
          onMonthTileClick={(surfaceIndex, year, month) => {
            // For the dev route, "open editor" = jump to the first day of
            // the month, then the side panel handles per-cell edits.
            const iso = `${year}-${String(month).padStart(2, '0')}-07`;
            setActiveCell({ surfaceIndex, iso });
          }}
        />
      </div>
      {activeCell && (
        <div className="flex flex-col">
          {uploading && (
            <div
              data-testid="dev-upload-progress"
              className="px-4 py-2 bg-indigo-50 border-l border-indigo-100 text-xs text-indigo-900"
            >
              Uploading cell image…
            </div>
          )}
          {uploadError && (
            <div
              data-testid="dev-upload-error"
              className="px-4 py-2 bg-rose-50 border-l border-rose-200 text-xs text-rose-900"
            >
              {uploadError}{' '}
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="underline ml-1"
              >
                Dismiss
              </button>
            </div>
          )}
        <CalendarEditPanel
          iso={activeCell.iso}
          cellEntries={activeEntries}
          holidaysForCell={activeHolidays}
          onAddTextEntry={(text) =>
            updateActiveCellEntries(c => [...c, { type: 'text', text }])
          }
          onRemoveTextEntryByIndex={(idx) =>
            updateActiveCellEntries(c => c.filter((_, i) => i !== idx))
          }
          onRequestImageOverride={() => {
            if (!activeCell) return;
            fileInputRef.current?.click();
          }}
          onRemoveImageOverride={() =>
            updateActiveCellEntries(c => c.filter(o => o.type !== 'image'))
          }
          onToggleHide={() =>
            updateActiveCellEntries(c => {
              const wasHidden = c.some(o => o.type === 'hide');
              if (wasHidden) return c.filter(o => o.type !== 'hide');
              const keptText: CalendarCellOverride[] = c.filter(o => o.type === 'text');
              const next: CalendarCellOverride = { type: 'hide' };
              return [...keptText, next];
            })
          }
          onReset={() => updateActiveCellEntries(() => [])}
          onClose={() => setActiveCell(null)}
        />
        </div>
      )}
    </div>
  );
}
