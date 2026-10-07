'use client';

import type { ComponentProps, Dispatch, RefObject, SetStateAction } from 'react';
import { CalendarProductPreview } from '@/components/CalendarProductPreview';
import { CalendarEditPanel } from '@/components/CalendarEditPanel';
import { IMAGE_AND_PDF_ACCEPT_ATTR } from '@/lib/upload-utils';
import type { CalendarTheme, CalendarType, GenzPalette, HolidayEntry } from '@/types/calendar';

type PreviewProps = ComponentProps<typeof CalendarProductPreview>;
type SelectedCell = { surfaceIndex: number; year: number; month: number; iso: string };

/** Calendar products: the 12-month preview, the per-day editor panel and the
 *  hidden picker for a day's photo. */
export function CalendarSection({
  isCalendarProduct, layout, calendarTheme, setCalendarTheme, genzPalette, genzPalettes, setGenzPalette,
  calendarType, setCalendarType, handleCalendarMonthTileClick, calendarCells, printedHolidays,
  selectedCalendarCell, setSelectedCalendarCell, calendarCellEntries, updateCellEntries,
  calendarCellImagePreviews, setCalendarCellImagePreviews, calendarImageUploading, calendarCellFileInputRef,
  handleCellImageFileSelected,
}: {
  isCalendarProduct: boolean;
  layout: { weekStart?: unknown; calendarDefaultYear?: PreviewProps['defaultYear'] } | null;
  calendarTheme: CalendarTheme;
  setCalendarTheme: Dispatch<SetStateAction<CalendarTheme>>;
  genzPalette: string | undefined;
  genzPalettes: GenzPalette[];
  setGenzPalette: Dispatch<SetStateAction<string | undefined>>;
  calendarType: CalendarType;
  setCalendarType: Dispatch<SetStateAction<CalendarType>>;
  handleCalendarMonthTileClick: (surfaceIndex: number, year: number, month: number) => void;
  calendarCells: Record<string, any[]>;
  printedHolidays: HolidayEntry[];
  selectedCalendarCell: SelectedCell | null;
  setSelectedCalendarCell: Dispatch<SetStateAction<SelectedCell | null>>;
  calendarCellEntries: (iso: string) => any[];
  updateCellEntries: (iso: string, updater: (prev: any[]) => any[]) => void;
  calendarCellImagePreviews: Record<string, string>;
  setCalendarCellImagePreviews: Dispatch<SetStateAction<Record<string, string>>>;
  calendarImageUploading: boolean;
  calendarCellFileInputRef: RefObject<HTMLInputElement | null>;
  handleCellImageFileSelected: (file: File) => void;
}) {
  return (
    <>
      {/* ── Calendar product: 12-month preview + cell editor ─────────── */}
      {isCalendarProduct && (
        <section className="space-y-4 pt-2">
          <CalendarProductPreview
            themePreset={calendarTheme}
            onThemePresetChange={setCalendarTheme}
            genzPalette={genzPalette}
            genzPalettes={genzPalettes}
            onGenzPaletteChange={setGenzPalette}
            calendarType={calendarType}
            onCalendarTypeChange={setCalendarType}
            onMonthTileClick={handleCalendarMonthTileClick}
            cells={calendarCells}
            holidays={printedHolidays}
            weekStart={layout?.weekStart as any || 'sunday'}
            defaultYear={layout?.calendarDefaultYear ?? 'current'}
          />
          {selectedCalendarCell && (
            <div className="fixed inset-y-0 right-0 z-[50000] flex">
              <CalendarEditPanel
                iso={selectedCalendarCell.iso}
                cellEntries={calendarCellEntries(selectedCalendarCell.iso)}
                holidaysForCell={printedHolidays.filter(h => h.date === selectedCalendarCell.iso)}
                imagePreviewUrl={calendarCellImagePreviews[selectedCalendarCell.iso]}
                imageExpired={
                  calendarCellEntries(selectedCalendarCell.iso).some(o => o.type === 'image') &&
                  !calendarCellImagePreviews[selectedCalendarCell.iso]
                }
                isImageUploading={calendarImageUploading}
                onAddTextEntry={text =>
                  updateCellEntries(selectedCalendarCell.iso, prev => [
                    ...prev, { type: 'text', text },
                  ])
                }
                onRemoveTextEntryByIndex={idx =>
                  updateCellEntries(selectedCalendarCell.iso, prev =>
                    prev.filter((_, i) => i !== idx)
                  )
                }
                onRequestImageOverride={() => calendarCellFileInputRef.current?.click()}
                onRemoveImageOverride={() => {
                  const key = selectedCalendarCell.iso;
                  setCalendarCellImagePreviews(prev => {
                    if (prev[key]) URL.revokeObjectURL(prev[key]);
                    const next = { ...prev };
                    delete next[key];
                    return next;
                  });
                  updateCellEntries(selectedCalendarCell.iso, prev =>
                    prev.filter(o => o.type !== 'image')
                  );
                }}
                onToggleHide={() =>
                  updateCellEntries(selectedCalendarCell.iso, prev => {
                    const hasHide = prev.some(o => o.type === 'hide');
                    return hasHide ? prev.filter(o => o.type !== 'hide') : [{ type: 'hide' }];
                  })
                }
                onReset={() => {
                  const key = selectedCalendarCell.iso;
                  setCalendarCellImagePreviews(prev => {
                    if (prev[key]) URL.revokeObjectURL(prev[key]);
                    const next = { ...prev };
                    delete next[key];
                    return next;
                  });
                  updateCellEntries(selectedCalendarCell.iso, () => []);
                }}
                onClose={() => setSelectedCalendarCell(null)}
              />
            </div>
          )}
          {/* Hidden file input for cell image override (Phase 8) */}
          <input
            ref={calendarCellFileInputRef}
            type="file"
            accept={IMAGE_AND_PDF_ACCEPT_ATTR}
            className="hidden"
            aria-hidden
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleCellImageFileSelected(file);
              e.target.value = '';  // reset so same file can be re-picked
            }}
          />
        </section>
      )}
    </>
  );
}
