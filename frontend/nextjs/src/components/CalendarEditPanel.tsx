'use client';

/**
 * Per-cell editor panel for the calendar product
 * (CALENDAR_FEATURE_PRD §5 Phase 5 Day 3).
 *
 * Opens when the customer taps a date cell on `CalendarProductPreview`.
 * Lets them:
 *   - Add text entries (up to MAX_ENTRIES_PER_CELL = 3 visible; §11.10)
 *   - Remove their own entries (holidays are auto-loaded + non-removable)
 *   - Replace the entire cell with an uploaded image
 *   - Hide the date (renders an empty cell)
 *   - Reset everything back to plain date number
 *
 * Behaviour rules:
 *   - Holiday entries from `holidaysForCell` show with a "🇮🇳 holiday" badge;
 *     user can't delete them individually — only an image / hide override
 *     suppresses them (PRD §11.10 + §11.14).
 *   - User-first precedence: user entries take the first N slots; holidays
 *     fill any remaining. Anything past 3 is silently suppressed (no
 *     "+N more" badge, per §11.10).
 *   - Image / hide overrides are mutually exclusive with text entries
 *     and with each other. Setting one clears the other.
 *
 * Controlled component: parent owns the per-cell state in
 * editor_state.canvases[i].calendar.cells[iso] and persists via the
 * existing canvas-state save path.
 */

import { useMemo, useState } from 'react';
import {
  MAX_ENTRIES_PER_CELL,
  mergeCellEntries,
} from '@/lib/calendar';
import type {
  CalendarCellOverride,
  HolidayEntry,
} from '@/types/calendar';

export interface CalendarEditPanelProps {
  /** ISO date this cell represents, e.g. "2026-01-07". */
  iso: string;
  /** Current per-cell user overrides (text/image/hide). May be undefined → []. */
  cellEntries?: CalendarCellOverride[];
  /** Auto-loaded holidays whose date matches `iso`. Read-only to the customer. */
  holidaysForCell?: HolidayEntry[];

  /** Dot-cycle colours from the active theme/palette — for visual parity with the cell render. */
  dotCycle?: readonly string[];

  /** Add a new text entry. Parent appends to cellEntries. */
  onAddTextEntry: (text: string) => void;
  /** Remove a text entry by its index within cellEntries. */
  onRemoveTextEntryByIndex: (index: number) => void;
  /** Set or replace the image override. Parent typically opens a file picker + uploads via existing chunked-upload API, then calls back with the upload_id. */
  onRequestImageOverride: () => void;
  /** Clear the image override (back to date-number + text entries). */
  onRemoveImageOverride: () => void;
  /** Toggle the hide override (blank cell). */
  onToggleHide: () => void;
  /** Clear ALL user overrides on this cell. */
  onReset: () => void;
  /** Close the panel without changing anything. */
  onClose: () => void;
  /**
   * True when the host page detected that this cell's image override
   * points to an upload_id the server can no longer resolve (GC'd, the
   * embed session lapsed, or the file was manually purged). The panel
   * surfaces an inline "Image expired — please re-upload" prompt so the
   * customer can recover with one tap. PRD §11.3 (Phase 8).
   */
  imageExpired?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatLongDate(iso: string): string {
  // "January 7, 2026" — uses Intl.DateTimeFormat so locale is consistent
  // with the editor preview's weekday header.
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CalendarEditPanel({
  iso,
  cellEntries = [],
  holidaysForCell = [],
  dotCycle = ['#F59E0B', '#EC4899', '#3B82F6'],
  onAddTextEntry,
  onRemoveTextEntryByIndex,
  onRequestImageOverride,
  onRemoveImageOverride,
  onToggleHide,
  onReset,
  onClose,
  imageExpired = false,
}: CalendarEditPanelProps) {
  const [inputText, setInputText] = useState('');

  // Classify the customer's existing overrides into the 3 mutually-exclusive
  // modes plus the user-text entries that share the "default" mode.
  const imageOverride = cellEntries.find(o => o.type === 'image');
  const hasHideOverride = cellEntries.some(o => o.type === 'hide');
  const userTextEntries = cellEntries.filter(o => o.type === 'text');

  // Maintain a stable mapping from "visible index in the merged list" to
  // the original cellEntries index so the remove button can target the
  // right slot. Holidays are not removable so they get no userIdx.
  const mergedForDisplay = useMemo(() => {
    if (imageOverride || hasHideOverride) return [];
    return mergeCellEntries(cellEntries, holidaysForCell, dotCycle);
  }, [cellEntries, holidaysForCell, dotCycle, imageOverride, hasHideOverride]);

  const totalVisibleCount = mergedForDisplay.length;
  const canAddMore =
    !imageOverride &&
    !hasHideOverride &&
    totalVisibleCount < MAX_ENTRIES_PER_CELL;

  // Index of each user text entry within the ORIGINAL cellEntries[], so the
  // remove callback can address it. Holidays don't get one (un-removable).
  // We track userIdx using the index of each text entry in cellEntries.
  const userTextEntryOrigIndices: number[] = [];
  cellEntries.forEach((o, i) => {
    if (o.type === 'text') userTextEntryOrigIndices.push(i);
  });

  const handleAddClick = () => {
    const text = inputText.trim();
    if (!text || !canAddMore) return;
    onAddTextEntry(text);
    setInputText('');
  };

  const handleInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddClick();
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  //
  // Responsive layout (PRD §6.1 risk #7 + Phase 9):
  //   - md+ (≥ 768px): side rail — `max-w-sm`, border-left, in-flow inside
  //     the parent's flex row. No backdrop.
  //   - < md  (mobile / portrait tablet): bottom sheet — fixed to the
  //     bottom of the viewport, full width, rounded top corners, scrollable
  //     up to 80vh, sitting above an inert backdrop that closes the panel
  //     on tap. The 42 tiny cell tap targets on a phone are painful enough
  //     that the cell-editor flow has to be a generous, thumb-reachable
  //     sheet rather than a cramped side rail.
  return (
    <>
      {/* Backdrop — only paints on small viewports, dismisses on tap. */}
      <div
        aria-hidden
        onClick={onClose}
        data-testid="calendar-edit-panel-backdrop"
        className="md:hidden fixed inset-0 z-40 bg-zinc-900/40"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="cell-editor-title"
        data-testid="calendar-edit-panel"
        data-cell-iso={iso}
        className="
          /* Mobile (default): bottom sheet */
          fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto
          rounded-t-2xl shadow-2xl
          /* md+: revert to in-flow side rail */
          md:relative md:inset-auto md:bottom-auto md:max-h-none md:overflow-visible
          md:rounded-none md:shadow-none
          w-full md:max-w-sm bg-white border-zinc-200 md:border-l
          p-5 flex flex-col gap-5
        "
      >
      {/* Header */}
      <header className="flex items-start justify-between gap-2">
        <h2 id="cell-editor-title" className="text-lg font-semibold text-zinc-900">
          {formatLongDate(iso)}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close cell editor"
          data-testid="cell-editor-close"
          className="text-zinc-400 hover:text-zinc-900 leading-none text-2xl"
        >
          ×
        </button>
      </header>

      {/* Entries list */}
      <section data-testid="cell-editor-entries">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
          Entries{' '}
          {!imageOverride && !hasHideOverride && (
            <span className="text-zinc-400 font-normal">
              {totalVisibleCount}/{MAX_ENTRIES_PER_CELL}
            </span>
          )}
        </h3>

        {imageOverride && (
          <div className="rounded-md bg-zinc-50 border border-zinc-200 p-3 text-sm text-zinc-600">
            Cell is replaced by an uploaded image.
          </div>
        )}

        {hasHideOverride && (
          <div className="rounded-md bg-zinc-50 border border-zinc-200 p-3 text-sm text-zinc-600">
            Date is hidden — cell renders blank.
          </div>
        )}

        {!imageOverride && !hasHideOverride && mergedForDisplay.length === 0 && (
          <div className="rounded-md bg-zinc-50 border border-zinc-200 p-3 text-sm text-zinc-500">
            No entries yet. Add an event below.
          </div>
        )}

        {!imageOverride && !hasHideOverride && mergedForDisplay.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {mergedForDisplay.map((e, displayIdx) => {
              const isHoliday = e.source === 'holiday';
              // Map back to the original cellEntries index for the remove button.
              let origIdx: number | null = null;
              if (!isHoliday) {
                // The Nth user entry in the merged list is the Nth user text entry
                // in cellEntries (text entries don't share slots with holidays in
                // mergeCellEntries — user texts always come first).
                const userOrdinal = mergedForDisplay
                  .slice(0, displayIdx + 1)
                  .filter(x => x.source === 'user').length - 1;
                origIdx = userTextEntryOrigIndices[userOrdinal] ?? null;
              }
              return (
                <li
                  key={`${e.source}-${displayIdx}-${e.text}`}
                  className="flex items-center gap-2 rounded-md bg-zinc-50 px-3 py-2 text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: e.dotColor ?? '#9CA3AF' }}
                  />
                  <span className="flex-1 truncate">{e.text}</span>
                  {isHoliday ? (
                    <span
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700 shrink-0"
                      title="Auto-loaded holiday — can't be removed individually"
                    >
                      🇮🇳 holiday
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        origIdx !== null && onRemoveTextEntryByIndex(origIdx)
                      }
                      aria-label={`Remove "${e.text}"`}
                      data-testid={`remove-entry-${displayIdx}`}
                      className="text-zinc-400 hover:text-red-600 text-lg leading-none shrink-0"
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Add an event */}
      {!imageOverride && !hasHideOverride && (
        <section data-testid="cell-editor-add">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
            Add an event
          </h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleInputKey}
              maxLength={40}
              disabled={!canAddMore}
              placeholder={canAddMore ? "e.g. Mom's birthday" : 'Max reached'}
              aria-label="New event text"
              data-testid="cell-editor-input"
              className="
                flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm
                focus:outline-none focus:ring-2 focus:ring-zinc-900
                disabled:bg-zinc-50 disabled:text-zinc-400
              "
            />
            <button
              type="button"
              onClick={handleAddClick}
              disabled={!canAddMore || !inputText.trim()}
              data-testid="cell-editor-add-btn"
              className="
                px-3 py-1.5 text-sm font-medium rounded-md
                bg-zinc-900 text-white hover:bg-zinc-800
                disabled:bg-zinc-300 disabled:cursor-not-allowed
              "
            >
              Add
            </button>
          </div>
          <p className="mt-1.5 text-xs text-zinc-500">
            {canAddMore
              ? `${MAX_ENTRIES_PER_CELL - totalVisibleCount} slot${
                  MAX_ENTRIES_PER_CELL - totalVisibleCount === 1 ? '' : 's'
                } remaining`
              : 'Remove an entry or override to free up a slot.'}
          </p>
        </section>
      )}

      {/* Override section */}
      <section data-testid="cell-editor-overrides">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
          Override
        </h3>
        <div className="flex flex-col gap-2">
          {/* Image override — three visual states:
              1) expired (override exists but server can't resolve uploadId)
                 → amber re-upload prompt, hide the "remove" affordance so
                   the customer's natural action ("re-upload") is the only
                   visible CTA.
              2) active                → indigo "click to remove" pill.
              3) absent                → dashed-border "Replace with image" CTA. */}
          {imageOverride && imageExpired ? (
            <div
              data-testid="cell-editor-image-expired"
              className="rounded-md border border-amber-300 bg-amber-50 p-3"
            >
              <p className="text-sm text-amber-900 font-medium">
                Image expired — please re-upload
              </p>
              <p className="text-xs text-amber-800 mt-1">
                The image you previously added is no longer available on the
                server. Pick a fresh copy to restore this cell.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={onRequestImageOverride}
                  data-testid="cell-editor-reupload-image"
                  className="
                    px-3 py-1.5 text-xs font-semibold rounded
                    bg-amber-600 text-white hover:bg-amber-700
                  "
                >
                  Re-upload
                </button>
                <button
                  type="button"
                  onClick={onRemoveImageOverride}
                  data-testid="cell-editor-remove-expired-image"
                  className="
                    px-3 py-1.5 text-xs font-medium rounded
                    text-amber-800 hover:bg-amber-100
                  "
                >
                  Clear override
                </button>
              </div>
            </div>
          ) : imageOverride ? (
            <button
              type="button"
              onClick={onRemoveImageOverride}
              data-testid="cell-editor-remove-image"
              className="
                w-full px-3 py-2 text-sm font-medium rounded-md
                bg-indigo-50 text-indigo-700 hover:bg-indigo-100
                border border-indigo-200
              "
            >
              ✓ Image override active — click to remove
            </button>
          ) : (
            <button
              type="button"
              onClick={onRequestImageOverride}
              disabled={hasHideOverride}
              data-testid="cell-editor-replace-image"
              className="
                w-full px-3 py-2 text-sm font-medium rounded-md
                border-2 border-dashed border-zinc-300 text-zinc-600
                hover:border-zinc-900 hover:text-zinc-900
                disabled:opacity-40 disabled:cursor-not-allowed
              "
            >
              📷 Replace with image
            </button>
          )}

          {/* Hide override toggle */}
          <button
            type="button"
            onClick={onToggleHide}
            disabled={!!imageOverride}
            data-testid="cell-editor-toggle-hide"
            className={
              'w-full px-3 py-2 text-sm font-medium rounded-md border ' +
              (hasHideOverride
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'border-zinc-300 text-zinc-600 hover:border-zinc-900 hover:text-zinc-900 ') +
              ' disabled:opacity-40 disabled:cursor-not-allowed'
            }
          >
            {hasHideOverride ? '✓ Date hidden — click to show' : '🚫 Hide this date'}
          </button>
        </div>
      </section>

      {/* Reset */}
      {(imageOverride || hasHideOverride || userTextEntries.length > 0) && (
        <button
          type="button"
          onClick={onReset}
          data-testid="cell-editor-reset"
          className="
            self-start text-xs text-zinc-500 hover:text-zinc-900 underline
          "
        >
          Reset everything on this date
        </button>
      )}
    </aside>
    </>
  );
}
