/**
 * Component tests for CalendarEditPanel
 * (CALENDAR_FEATURE_PRD §5 Phase 5 Day 3).
 *
 * Asserts:
 *   - Renders header with the localised long-form date
 *   - User text entries render + can be removed
 *   - Holiday entries render with the "holiday" badge and have NO remove button
 *   - Add input/button disable at MAX_ENTRIES_PER_CELL = 3
 *   - Enter key submits the add
 *   - Image override + hide override toggles fire the right callbacks
 *   - Image + hide are mutually exclusive (each disables the other)
 *   - Image override hides the entries section + add form
 *   - Reset visible only when something to reset
 *   - User-first precedence respected (user text entries fill slots first)
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarEditPanel } from '@/components/CalendarEditPanel';
import type { CalendarCellOverride, HolidayEntry } from '@/types/calendar';

const ISO = '2026-01-07';

function setup(propOverrides: Partial<React.ComponentProps<typeof CalendarEditPanel>> = {}) {
  const onAddTextEntry = jest.fn();
  const onRemoveTextEntryByIndex = jest.fn();
  const onRequestImageOverride = jest.fn();
  const onRemoveImageOverride = jest.fn();
  const onToggleHide = jest.fn();
  const onReset = jest.fn();
  const onClose = jest.fn();
  const utils = render(
    <CalendarEditPanel
      iso={ISO}
      cellEntries={[]}
      holidaysForCell={[]}
      onAddTextEntry={onAddTextEntry}
      onRemoveTextEntryByIndex={onRemoveTextEntryByIndex}
      onRequestImageOverride={onRequestImageOverride}
      onRemoveImageOverride={onRemoveImageOverride}
      onToggleHide={onToggleHide}
      onReset={onReset}
      onClose={onClose}
      {...propOverrides}
    />
  );
  return {
    ...utils,
    onAddTextEntry,
    onRemoveTextEntryByIndex,
    onRequestImageOverride,
    onRemoveImageOverride,
    onToggleHide,
    onReset,
    onClose,
  };
}

// ─── Header ─────────────────────────────────────────────────────────────────

describe('CalendarEditPanel — header', () => {
  it('renders a long-form date that includes month, day, and year', () => {
    setup();
    expect(screen.getByText(/January/)).toBeInTheDocument();
    expect(screen.getByText(/7/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it('fires onClose when the close button is clicked', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByTestId('cell-editor-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── Empty state ────────────────────────────────────────────────────────────

describe('CalendarEditPanel — empty state', () => {
  it('shows "No entries yet" when there are no overrides and no holidays', () => {
    setup();
    expect(screen.getByText(/No entries yet/i)).toBeInTheDocument();
  });

  it('shows the add input + button enabled when cap is not reached', () => {
    setup();
    expect(screen.getByTestId('cell-editor-input')).not.toBeDisabled();
    expect(screen.getByText(/3 slots remaining/)).toBeInTheDocument();
  });

  it('hides the Reset button when nothing has been overridden', () => {
    setup();
    expect(screen.queryByTestId('cell-editor-reset')).not.toBeInTheDocument();
  });
});

// ─── Holidays render + non-removable ────────────────────────────────────────

describe('CalendarEditPanel — holidays', () => {
  const holiday: HolidayEntry = { date: ISO, name: 'Republic Day', color: '#DC2626' };

  it('renders holiday entries with the "holiday" badge', () => {
    setup({ holidaysForCell: [holiday] });
    expect(screen.getByText('Republic Day')).toBeInTheDocument();
    expect(screen.getByText(/holiday/i)).toBeInTheDocument();
  });

  it('does NOT render a remove button on holiday entries', () => {
    setup({ holidaysForCell: [holiday] });
    expect(screen.queryByLabelText(/Remove "Republic Day"/)).not.toBeInTheDocument();
  });

  it('renders 1/3 slot remaining when a holiday is auto-loaded', () => {
    setup({ holidaysForCell: [holiday] });
    expect(screen.getByText(/2 slots remaining/)).toBeInTheDocument();
  });
});

// ─── User-first precedence + adding entries ─────────────────────────────────

describe('CalendarEditPanel — adding text entries', () => {
  it('fires onAddTextEntry when Add button is clicked', async () => {
    const { onAddTextEntry } = setup();
    await userEvent.type(screen.getByTestId('cell-editor-input'), "Mom's birthday");
    await userEvent.click(screen.getByTestId('cell-editor-add-btn'));
    expect(onAddTextEntry).toHaveBeenCalledWith("Mom's birthday");
  });

  it('fires onAddTextEntry when Enter is pressed in the input', async () => {
    const { onAddTextEntry } = setup();
    const input = screen.getByTestId('cell-editor-input');
    await userEvent.type(input, 'Deadline{Enter}');
    expect(onAddTextEntry).toHaveBeenCalledWith('Deadline');
  });

  it('trims whitespace from added entries', async () => {
    const { onAddTextEntry } = setup();
    await userEvent.type(screen.getByTestId('cell-editor-input'), '   Dentist   ');
    await userEvent.click(screen.getByTestId('cell-editor-add-btn'));
    expect(onAddTextEntry).toHaveBeenCalledWith('Dentist');
  });

  it('disables Add button when input is empty', async () => {
    setup();
    expect(screen.getByTestId('cell-editor-add-btn')).toBeDisabled();
  });

  it('disables Add input + button at MAX_ENTRIES_PER_CELL cap', () => {
    const entries: CalendarCellOverride[] = [
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'text', text: 'C' },
    ];
    setup({ cellEntries: entries });
    expect(screen.getByTestId('cell-editor-input')).toBeDisabled();
    expect(screen.getByTestId('cell-editor-add-btn')).toBeDisabled();
    expect(screen.getByText(/Remove an entry/)).toBeInTheDocument();
  });

  it('counts user-first against the cap: 2 user + 1 holiday fills 3 slots', () => {
    const entries: CalendarCellOverride[] = [
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
    ];
    setup({
      cellEntries: entries,
      holidaysForCell: [{ date: ISO, name: 'Republic Day', color: '#DC2626' }],
    });
    expect(screen.getByTestId('cell-editor-input')).toBeDisabled();
  });
});

// ─── Removing user text entries ─────────────────────────────────────────────

describe('CalendarEditPanel — removing user entries', () => {
  it('fires onRemoveTextEntryByIndex with the index in cellEntries', async () => {
    const entries: CalendarCellOverride[] = [
      { type: 'text', text: 'First' },
      { type: 'text', text: 'Second' },
    ];
    const { onRemoveTextEntryByIndex } = setup({ cellEntries: entries });
    await userEvent.click(screen.getByLabelText('Remove "Second"'));
    // Second was at cellEntries[1].
    expect(onRemoveTextEntryByIndex).toHaveBeenCalledWith(1);
  });
});

// ─── Image override ─────────────────────────────────────────────────────────

describe('CalendarEditPanel — image override', () => {
  it('shows "Replace with image" button when no override is active', () => {
    setup();
    expect(screen.getByTestId('cell-editor-replace-image')).toBeInTheDocument();
  });

  it('fires onRequestImageOverride when Replace is clicked', async () => {
    const { onRequestImageOverride } = setup();
    await userEvent.click(screen.getByTestId('cell-editor-replace-image'));
    expect(onRequestImageOverride).toHaveBeenCalledTimes(1);
  });

  it('shows "Image override active" when image is set; clicking removes it', async () => {
    const entries: CalendarCellOverride[] = [{ type: 'image', uploadId: 'abc-123' }];
    const { onRemoveImageOverride } = setup({ cellEntries: entries });
    const btn = screen.getByTestId('cell-editor-remove-image');
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onRemoveImageOverride).toHaveBeenCalledTimes(1);
  });

  it('hides the entries list + add form when image override is active', () => {
    const entries: CalendarCellOverride[] = [{ type: 'image', uploadId: 'abc' }];
    setup({ cellEntries: entries });
    expect(screen.queryByTestId('cell-editor-add')).not.toBeInTheDocument();
    expect(screen.getByText(/replaced by an uploaded image/i)).toBeInTheDocument();
  });

  it('disables the hide-override button when image override is active (mutually exclusive)', () => {
    const entries: CalendarCellOverride[] = [{ type: 'image', uploadId: 'abc' }];
    setup({ cellEntries: entries });
    expect(screen.getByTestId('cell-editor-toggle-hide')).toBeDisabled();
  });
});

// ─── P8.2: Image expiry — "please re-upload" prompt ─────────────────────────

describe('CalendarEditPanel — image expired (PRD §11.3)', () => {
  it('does not render the expired banner when image is healthy', () => {
    const entries: CalendarCellOverride[] = [{ type: 'image', uploadId: 'abc' }];
    setup({ cellEntries: entries });
    expect(screen.queryByTestId('cell-editor-image-expired')).not.toBeInTheDocument();
  });

  it('renders the amber "Image expired" banner when imageExpired=true', () => {
    const entries: CalendarCellOverride[] = [{ type: 'image', uploadId: 'abc' }];
    setup({ cellEntries: entries, imageExpired: true });
    expect(screen.getByTestId('cell-editor-image-expired')).toBeInTheDocument();
    expect(screen.getByText(/Image expired/i)).toBeInTheDocument();
    // The normal "Image override active" pill is suppressed in expired state.
    expect(screen.queryByTestId('cell-editor-remove-image')).not.toBeInTheDocument();
  });

  it('fires onRequestImageOverride when Re-upload is clicked', async () => {
    const entries: CalendarCellOverride[] = [{ type: 'image', uploadId: 'abc' }];
    const { onRequestImageOverride } = setup({ cellEntries: entries, imageExpired: true });
    await userEvent.click(screen.getByTestId('cell-editor-reupload-image'));
    expect(onRequestImageOverride).toHaveBeenCalledTimes(1);
  });

  it('fires onRemoveImageOverride when Clear override is clicked', async () => {
    const entries: CalendarCellOverride[] = [{ type: 'image', uploadId: 'abc' }];
    const { onRemoveImageOverride } = setup({ cellEntries: entries, imageExpired: true });
    await userEvent.click(screen.getByTestId('cell-editor-remove-expired-image'));
    expect(onRemoveImageOverride).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the expired banner when there is no image override at all', () => {
    // imageExpired without an image override is logically a host-page bug.
    // The panel doesn't render the banner — it only triggers on imageOverride
    // && imageExpired so a stray flag can't surface a phantom message.
    setup({ cellEntries: [], imageExpired: true });
    expect(screen.queryByTestId('cell-editor-image-expired')).not.toBeInTheDocument();
    // The normal "Replace with image" CTA is still shown.
    expect(screen.getByTestId('cell-editor-replace-image')).toBeInTheDocument();
  });
});

// ─── Hide override ──────────────────────────────────────────────────────────

describe('CalendarEditPanel — hide override', () => {
  it('shows "Hide this date" toggle when nothing is hidden', () => {
    setup();
    const btn = screen.getByTestId('cell-editor-toggle-hide');
    expect(btn).toHaveTextContent(/Hide this date/);
  });

  it('fires onToggleHide when the hide button is clicked', async () => {
    const { onToggleHide } = setup();
    await userEvent.click(screen.getByTestId('cell-editor-toggle-hide'));
    expect(onToggleHide).toHaveBeenCalledTimes(1);
  });

  it('shows "Date hidden" state when hide override is active', () => {
    const entries: CalendarCellOverride[] = [{ type: 'hide' }];
    setup({ cellEntries: entries });
    expect(screen.getByText(/Date is hidden/i)).toBeInTheDocument();
    expect(screen.getByTestId('cell-editor-toggle-hide')).toHaveTextContent(/click to show/);
  });

  it('disables the image override button when hide is active (mutually exclusive)', () => {
    const entries: CalendarCellOverride[] = [{ type: 'hide' }];
    setup({ cellEntries: entries });
    expect(screen.getByTestId('cell-editor-replace-image')).toBeDisabled();
  });

  it('hides the entries list + add form when hide override is active', () => {
    const entries: CalendarCellOverride[] = [{ type: 'hide' }];
    setup({ cellEntries: entries });
    expect(screen.queryByTestId('cell-editor-add')).not.toBeInTheDocument();
  });
});

// ─── Reset ──────────────────────────────────────────────────────────────────

describe('CalendarEditPanel — reset', () => {
  it('reset button appears when there are user entries', () => {
    setup({ cellEntries: [{ type: 'text', text: 'X' }] });
    expect(screen.getByTestId('cell-editor-reset')).toBeInTheDocument();
  });

  it('reset button fires onReset when clicked', async () => {
    const { onReset } = setup({ cellEntries: [{ type: 'hide' }] });
    await userEvent.click(screen.getByTestId('cell-editor-reset'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('reset button does not appear when cell is pristine', () => {
    setup({ holidaysForCell: [{ date: ISO, name: 'X' }] });
    // Holidays alone (no user override) → no reset, since there's nothing
    // the customer can reset (holidays auto-load).
    expect(screen.queryByTestId('cell-editor-reset')).not.toBeInTheDocument();
  });
});

// ─── P9.3: Mobile bottom-sheet UX ───────────────────────────────────────────

describe('CalendarEditPanel — mobile bottom-sheet', () => {
  it('renders a backdrop element alongside the panel', () => {
    setup();
    expect(screen.getByTestId('calendar-edit-panel-backdrop')).toBeInTheDocument();
  });

  it('backdrop click fires onClose so tapping outside the sheet dismisses it', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByTestId('calendar-edit-panel-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop carries md:hidden so it doesnt obscure the side-rail layout on desktop', () => {
    setup();
    const backdrop = screen.getByTestId('calendar-edit-panel-backdrop');
    // We can't trigger a media-query change in happy-dom; pin the class
    // list so an accidental refactor that drops md:hidden surfaces here.
    expect(backdrop.className).toMatch(/md:hidden/);
  });

  it('panel is keyed with role=dialog and aria-modal for screen-reader trapping', () => {
    setup();
    const panel = screen.getByTestId('calendar-edit-panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
  });
});
