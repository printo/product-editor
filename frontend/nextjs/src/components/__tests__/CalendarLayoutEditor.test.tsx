/**
 * Component + serializer tests for CalendarLayoutEditor
 * (CALENDAR_FEATURE_PRD §5 Phase 6 Day 1).
 *
 * Covers:
 *   - Field rendering + edit → state updates
 *   - Mode toggle: multi-surface (12×1) vs poster (1×12) JSON shape
 *   - Style controls (theme, palette gating, calendarType default, weekStart)
 *   - Holiday source toggle + locale
 *   - Year anchor — current vs fixed
 *   - draftToLayoutJson serialization → shape matches validate_calendar_layout
 *   - validateDraft catches bounds-out-of-range
 *   - Save button gates on validation + fires onSave with serialized JSON
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CalendarLayoutEditor,
  draftToLayoutJson,
  validateDraft,
  type CalendarLayoutDraft,
} from '@/components/CalendarLayoutEditor';
import type { GenzPalette, HolidayEntry } from '@/types/calendar';

const PALETTES: GenzPalette[] = [
  { name: 'butter', label: 'Butter & Purple', bg: '#FEF3C7', month: '#A855F7',
    weekday: '#A855F7', grid: '#FBCFE8', date: '#0F172A', pill: '#CCFBF1',
    dotCycle: ['#A855F7', '#EC4899', '#0EA5E9'] },
  { name: 'mint', label: 'Mint & Hot Pink', bg: '#ECFDF5', month: '#DB2777',
    weekday: '#DB2777', grid: '#FCE7F3', date: '#0F172A', pill: '#FEF3C7',
    dotCycle: ['#DB2777', '#F59E0B', '#10B981'] },
];

const HOLIDAYS: HolidayEntry[] = [
  { date: '2026-01-01', name: 'New Year', color: '#3B82F6' },
];

function setup(propOverrides: Partial<React.ComponentProps<typeof CalendarLayoutEditor>> = {}) {
  const onSave = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();
  const utils = render(
    <CalendarLayoutEditor
      genzPalettes={PALETTES}
      previewHolidays={HOLIDAYS}
      onSave={onSave}
      onCancel={onCancel}
      {...propOverrides}
    />
  );
  return { ...utils, onSave, onCancel };
}

// ─── Initial render ─────────────────────────────────────────────────────────

describe('CalendarLayoutEditor — initial render', () => {
  it('mounts with all primary sections present', () => {
    setup();
    expect(screen.getByTestId('calendar-layout-editor')).toBeInTheDocument();
    expect(screen.getByTestId('layout-name')).toBeInTheDocument();
    expect(screen.getByTestId('mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('calendar-primitive-fields')).toBeInTheDocument();
    expect(screen.getByTestId('style-theme')).toBeInTheDocument();
    expect(screen.getByTestId('style-calendar-type')).toBeInTheDocument();
    expect(screen.getByTestId('style-week-start')).toBeInTheDocument();
    expect(screen.getByTestId('holiday-source')).toBeInTheDocument();
    expect(screen.getByTestId('live-preview')).toBeInTheDocument();
    expect(screen.getByTestId('save-btn')).toBeInTheDocument();
  });

  it('defaults to multi-surface mode', () => {
    setup();
    const toggle = screen.getByTestId('mode-toggle');
    const active = within(toggle).getByRole('button', { pressed: true });
    expect(active).toHaveTextContent(/12 pages/);
  });

  it('hides Gen-Z palette picker when theme is NOT modern-genz', () => {
    setup();
    expect(screen.queryByTestId('style-genz-palette')).not.toBeInTheDocument();
  });

  it('shows Gen-Z palette picker when theme is modern-genz', async () => {
    setup({ initial: { style: {
      themePreset: 'modern-genz', calendarType: 'english', weekStart: 'sunday',
      holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      defaultGenzPalette: 'butter',
    } } });
    expect(screen.getByTestId('style-genz-palette')).toBeInTheDocument();
  });
});

// ─── Mode toggle behaviour ──────────────────────────────────────────────────

describe('CalendarLayoutEditor — mode toggle', () => {
  it('switches to poster mode on click', async () => {
    setup();
    const toggle = screen.getByTestId('mode-toggle');
    await userEvent.click(within(toggle).getByText(/1 page/));
    const active = within(toggle).getByRole('button', { pressed: true });
    expect(active).toHaveTextContent(/1 page/);
  });

  it('produces correct monthRange.count + calendars.length for each mode (via serializer)', () => {
    // Test the pure serializer rather than relying on UI state.
    const baseDraft: CalendarLayoutDraft = {
      name: 'test',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 127, canvasHeightMm: 177.8, dpi: 300,
      frames: [{ x: 0, y: 0, width: 1, height: 0.5 }],
      calendars: [{ x: 0, y: 0.55, width: 1, height: 0.4 }],
      style: {
        themePreset: 'modern-minimalist',
        calendarType: 'english', weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 2026,
    };
    const multiSurface = draftToLayoutJson(baseDraft);
    expect((multiSurface.monthRange as Record<string, unknown>).count).toBe(12);
    expect((multiSurface.calendars as unknown[]).length).toBe(1);

    const poster = draftToLayoutJson({ ...baseDraft, mode: 'poster' });
    expect((poster.monthRange as Record<string, unknown>).count).toBe(1);
    expect((poster.calendars as unknown[]).length).toBe(12);
  });

  it('auto-distributes 12 poster calendars in a 4×3 grid', () => {
    const poster = draftToLayoutJson({
      name: 'p',
      productType: 'calendar',
      mode: 'poster',
      canvasWidthMm: 300, canvasHeightMm: 420, dpi: 300,
      frames: [{ x: 0, y: 0, width: 1, height: 0.4 }],
      // Each cell 25% wide × 20% tall starting at (0, 0.4)
      calendars: [{ x: 0, y: 0.4, width: 0.25, height: 0.2 }],
      style: {
        themePreset: 'modern-minimalist',
        calendarType: 'english', weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 2026,
    });
    const cals = poster.calendars as Array<{ x: number; y: number; monthOffset: number }>;
    expect(cals).toHaveLength(12);
    // Float arithmetic — assert closeness, not equality (0.4+0.2 === 0.6000…01).
    const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
    // First three in row 0:
    close(cals[0].x, 0);     close(cals[0].y, 0.4); expect(cals[0].monthOffset).toBe(0);
    close(cals[1].x, 0.25);  close(cals[1].y, 0.4); expect(cals[1].monthOffset).toBe(1);
    close(cals[2].x, 0.5);   close(cals[2].y, 0.4); expect(cals[2].monthOffset).toBe(2);
    // First entry of row 1:
    close(cals[4].x, 0);     close(cals[4].y, 0.6); expect(cals[4].monthOffset).toBe(4);
    // Last entry — row 2 column 3:
    close(cals[11].x, 0.75); close(cals[11].y, 0.8); expect(cals[11].monthOffset).toBe(11);
  });
});

// ─── Style controls ────────────────────────────────────────────────────────

describe('CalendarLayoutEditor — style controls', () => {
  it('switches calendarType default via the dropdown', async () => {
    const { onSave } = setup();
    const sel = screen.getByTestId('style-calendar-type');
    await userEvent.selectOptions(sel, 'financial');
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect((json.calendar as Record<string, unknown>).calendarType).toBe('financial');
  });

  it('switches weekStart via the dropdown', async () => {
    const { onSave } = setup();
    await userEvent.selectOptions(screen.getByTestId('style-week-start'), 'monday');
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect((json.calendar as Record<string, unknown>).weekStart).toBe('monday');
  });

  it('switches theme to Gen-Z and reveals palette picker', async () => {
    setup();
    await userEvent.selectOptions(screen.getByTestId('style-theme'), 'modern-genz');
    expect(screen.getByTestId('style-genz-palette')).toBeInTheDocument();
  });
});

// ─── Holiday source ─────────────────────────────────────────────────────────

describe('CalendarLayoutEditor — holiday source', () => {
  it('toggles auto-load on/off', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByTestId('holiday-enabled'));
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect(((json.calendar as Record<string, unknown>).holidaySource as Record<string, unknown>).enabled).toBe(false);
  });

  it('switches locale via the dropdown', async () => {
    const { onSave } = setup();
    await userEvent.selectOptions(screen.getByTestId('holiday-locale'), 'generic');
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect(((json.calendar as Record<string, unknown>).holidaySource as Record<string, unknown>).locale).toBe('generic');
  });
});

// ─── Year anchor ────────────────────────────────────────────────────────────

describe('CalendarLayoutEditor — year anchor', () => {
  it('defaults to current (auto-roll)', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect((json.monthRange as Record<string, unknown>).defaultYear).toBe('current');
  });

  it('switches to a fixed year', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByTestId('year-fixed-radio'));
    const input = screen.getByTestId('year-fixed-input') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '2027');
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect((json.monthRange as Record<string, unknown>).defaultYear).toBe(2027);
  });
});

// ─── validateDraft helper ───────────────────────────────────────────────────

describe('validateDraft', () => {
  const baseValid: CalendarLayoutDraft = {
    name: 'family_calendar',
    productType: 'calendar',
    mode: 'multi-surface',
    canvasWidthMm: 127, canvasHeightMm: 177.8, dpi: 300,
    frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.4 }],
    calendars: [{ x: 0.05, y: 0.5, width: 0.9, height: 0.45 }],
    style: {
      themePreset: 'modern-minimalist',
      calendarType: 'english', weekStart: 'sunday',
      holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
    },
    defaultYear: 'current',
  };

  it('passes a valid draft', () => {
    expect(validateDraft(baseValid)).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateDraft({ ...baseValid, name: '' })).toMatch(/name is required/);
  });

  it('rejects name with spaces or other forbidden chars', () => {
    expect(validateDraft({ ...baseValid, name: 'family calendar' })).toMatch(/letters, digits/);
  });

  it('rejects calendar primitive extending past canvas', () => {
    const bad = { ...baseValid, calendars: [{ x: 0.8, y: 0.5, width: 0.5, height: 0.4 }] };
    expect(validateDraft(bad)).toMatch(/right canvas edge/);
  });

  it('rejects calendar primitive with zero height', () => {
    const bad = { ...baseValid, calendars: [{ x: 0, y: 0, width: 0.5, height: 0 }] };
    expect(validateDraft(bad)).toMatch(/positive dimensions/);
  });

  it('rejects zero frames', () => {
    expect(validateDraft({ ...baseValid, frames: [] })).toMatch(/photo frame/);
  });
});

// ─── P6.1-review fixes — additional coverage ────────────────────────────────

describe('CalendarLayoutEditor — review fix #2 (frame editing UI)', () => {
  it('renders the frames section with one default frame', () => {
    setup();
    expect(screen.getByTestId('frames-section')).toBeInTheDocument();
    expect(screen.getByTestId('frame-row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('frame-row-1')).not.toBeInTheDocument();
  });

  it('adds a second frame when the Add button is clicked', async () => {
    setup();
    await userEvent.click(screen.getByTestId('add-frame-btn'));
    expect(screen.getByTestId('frame-row-1')).toBeInTheDocument();
  });

  it('removes a non-last frame', async () => {
    setup();
    await userEvent.click(screen.getByTestId('add-frame-btn'));
    expect(screen.getByTestId('frame-row-1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('remove-frame-1'));
    expect(screen.queryByTestId('frame-row-1')).not.toBeInTheDocument();
  });

  it('disables remove on the LAST remaining frame', () => {
    setup();
    const removeBtn = screen.getByTestId('remove-frame-0');
    expect(removeBtn).toBeDisabled();
  });

  it('serialises multiple frames into the layout JSON', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByTestId('add-frame-btn'));
    await userEvent.click(screen.getByTestId('add-frame-btn'));
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect((json.frames as unknown[]).length).toBe(3);
  });
});

describe('CalendarLayoutEditor — review fix #3 (poster per-calendar positioning)', () => {
  it('poster custom layout toggle only renders in poster mode', async () => {
    setup();
    expect(screen.queryByTestId('poster-custom-toggle')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('mode-toggle')).getByText(/1 page/));
    expect(screen.getByTestId('poster-custom-toggle')).toBeInTheDocument();
  });

  it('expands to 12 per-calendar rows when custom layout is enabled', async () => {
    setup();
    await userEvent.click(within(screen.getByTestId('mode-toggle')).getByText(/1 page/));
    expect(screen.queryByTestId('poster-cal-row-0')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('poster-custom-toggle'));
    expect(screen.getByTestId('poster-cal-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('poster-cal-row-11')).toBeInTheDocument();
    expect(screen.queryByTestId('poster-cal-row-12')).not.toBeInTheDocument();
  });

  it('passes through custom positions verbatim in the serialised JSON', async () => {
    const { onSave } = setup();
    await userEvent.click(within(screen.getByTestId('mode-toggle')).getByText(/1 page/));
    await userEvent.click(screen.getByTestId('poster-custom-toggle'));
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    const cals = json.calendars as Array<Record<string, unknown>>;
    expect(cals).toHaveLength(12);
    cals.forEach((c, i) => expect(c.monthOffset).toBe(i));
  });
});

describe('CalendarLayoutEditor — review fix #4 (defensive calendars[0])', () => {
  it('does not crash when initial.calendars is an empty array', () => {
    setup({ initial: { calendars: [] } });
    expect(screen.getByTestId('calendar-layout-editor')).toBeInTheDocument();
    // Fields should still render (with their defensive defaults).
    expect(screen.getByTestId('calendar-primitive-fields')).toBeInTheDocument();
  });
});

describe('CalendarLayoutEditor — review fix #6 (showInCells toggle)', () => {
  it('renders the toggle, defaulting to checked', () => {
    setup();
    const cb = screen.getByTestId('holiday-show-in-cells') as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('serialises showInCells: false when toggled off', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByTestId('holiday-show-in-cells'));
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    const src = (json.calendar as Record<string, unknown>).holidaySource as Record<string, unknown>;
    expect(src.showInCells).toBe(false);
  });

  it('disables the toggle when holiday auto-load is disabled', async () => {
    setup();
    await userEvent.click(screen.getByTestId('holiday-enabled'));
    expect(screen.getByTestId('holiday-show-in-cells')).toBeDisabled();
  });
});

describe('CalendarLayoutEditor — review fix #12 (mm/px readback)', () => {
  it('renders a readback line showing mm origin/size + px dimensions', () => {
    setup({ initial: {
      canvasWidthMm: 100, canvasHeightMm: 200, dpi: 300,
      calendars: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }],
    } });
    const readback = screen.getByTestId('calendar-primitive-readback');
    // 0.1 × 100 mm = 10 mm origin x; 0.2 × 200 = 40 mm origin y
    expect(readback).toHaveTextContent(/10\.0 \/ 40\.0/);
    // 0.5 × 100 = 50 mm; 0.4 × 200 = 80 mm
    expect(readback).toHaveTextContent(/50\.0 × 80\.0 mm/);
    // px: 50 mm × 300 / 25.4 ≈ 591
    expect(readback).toHaveTextContent(/591 ×/);
  });
});

describe('CalendarLayoutEditor — review fix #5 (mask UI) [Gap A]', () => {
  it('renders the mask section with empty URL by default', () => {
    setup();
    expect(screen.getByTestId('mask-section')).toBeInTheDocument();
    const urlField = screen.getByTestId('mask-url') as HTMLInputElement;
    expect(urlField.value).toBe('');
  });

  it('disables maskOnExport when maskUrl is empty', () => {
    setup();
    expect(screen.getByTestId('mask-on-export')).toBeDisabled();
  });

  it('enables maskOnExport once a mask URL is typed', async () => {
    setup();
    await userEvent.type(screen.getByTestId('mask-url'), 'desk_mask.png');
    expect(screen.getByTestId('mask-on-export')).not.toBeDisabled();
  });

  it('serialises maskUrl + maskOnExport when set', async () => {
    const { onSave } = setup();
    await userEvent.type(screen.getByTestId('mask-url'), 'my_mask.png');
    await userEvent.click(screen.getByTestId('mask-on-export'));
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect(json.maskUrl).toBe('my_mask.png');
    expect(json.maskOnExport).toBe(true);
  });

  it('omits maskUrl + maskOnExport when no mask is set', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect(json).not.toHaveProperty('maskUrl');
    expect(json).not.toHaveProperty('maskOnExport');
  });
});

describe('CalendarLayoutEditor — review L1 (frame bounds validation)', () => {
  function withInitialFrames(frames: Array<{x:number;y:number;width:number;height:number}>) {
    return validateDraft({
      name: 'test_layout',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 100, canvasHeightMm: 100, dpi: 300,
      frames,
      calendars: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
      style: {
        themePreset: 'modern-minimalist',
        calendarType: 'english', weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 'current',
    });
  }

  it('passes when frames are inside the canvas', () => {
    expect(withInitialFrames([{ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }])).toBeNull();
  });

  it('rejects frame extending past the right edge', () => {
    expect(withInitialFrames([{ x: 0.6, y: 0.1, width: 0.5, height: 0.5 }]))
      .toMatch(/right canvas edge/);
  });

  it('rejects frame extending past the bottom edge', () => {
    expect(withInitialFrames([{ x: 0.1, y: 0.7, width: 0.4, height: 0.5 }]))
      .toMatch(/bottom canvas edge/);
  });

  it('rejects frame with zero width', () => {
    expect(withInitialFrames([{ x: 0, y: 0, width: 0, height: 0.5 }]))
      .toMatch(/positive dimensions/);
  });

  it('rejects frame with negative origin', () => {
    expect(withInitialFrames([{ x: -0.1, y: 0, width: 0.5, height: 0.5 }]))
      .toMatch(/non-negative origin|positive dimensions/);
  });

  it('names the offending frame in the error', () => {
    const err = withInitialFrames([
      { x: 0.05, y: 0.05, width: 0.4, height: 0.4 },
      { x: 0.6, y: 0.6, width: 0.6, height: 0.6 },  // index 1 (Frame 2) overflows
    ]);
    expect(err).toMatch(/Frame 2/);
  });
});

describe('CalendarLayoutEditor — review fix #13 (regular-editor link)', () => {
  it('renders the "regular layout editor" link with the right href', () => {
    setup();
    const link = screen.getByTestId('regular-editor-link') as HTMLAnchorElement;
    expect(link).toHaveAttribute('href', '/editor/layouts');
  });
});

// ─── P6.2 — Per-month tile pane + override modal ────────────────────────────

describe('CalendarLayoutEditor — P6.2 tile pane', () => {
  it('renders exactly 12 month tiles', () => {
    setup();
    const pane = screen.getByTestId('month-tile-pane');
    const tiles = within(pane).getAllByRole('button');
    expect(tiles).toHaveLength(12);
  });

  it('labels tiles in English-mode order (January..December)', () => {
    setup();
    expect(screen.getByTestId('month-tile-month_01')).toBeInTheDocument();
    expect(screen.getByTestId('month-tile-month_12')).toBeInTheDocument();
  });

  it('marks all tiles as not-customized by default', () => {
    setup();
    for (let m = 1; m <= 12; m++) {
      const key = `month_${String(m).padStart(2, '0')}`;
      const tile = screen.getByTestId(`month-tile-${key}`);
      expect(tile).toHaveAttribute('data-month-customized', 'false');
      expect(screen.queryByTestId(`customized-badge-${key}`)).not.toBeInTheDocument();
    }
  });

  it('opens the override modal when a tile is clicked', async () => {
    setup();
    await userEvent.click(screen.getByTestId('month-tile-month_03'));
    expect(screen.getByTestId('month-override-modal')).toBeInTheDocument();
    expect(screen.getByText(/Per-month override/)).toBeInTheDocument();
    expect(screen.getByText(/month_03/i)).toBeInTheDocument();
  });

  it('closes the modal on Cancel without setting an override', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByTestId('month-tile-month_06'));
    await userEvent.click(screen.getByTestId('month-override-cancel'));
    expect(screen.queryByTestId('month-override-modal')).not.toBeInTheDocument();
    // Save the layout and confirm no surfaceOverrides was emitted.
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect(json).not.toHaveProperty('surfaceOverrides');
  });

  it('closes the modal on × close button', async () => {
    setup();
    await userEvent.click(screen.getByTestId('month-tile-month_07'));
    await userEvent.click(screen.getByTestId('month-override-close'));
    expect(screen.queryByTestId('month-override-modal')).not.toBeInTheDocument();
  });
});

describe('CalendarLayoutEditor — P6.2 override modal & badge', () => {
  it('shows "Customized" badge after saving an override that differs from template', async () => {
    setup();
    await userEvent.click(screen.getByTestId('month-tile-month_12'));
    // Add a second frame inside the modal so the override differs from template.
    await userEvent.click(screen.getByTestId('month-override-add-frame'));
    await userEvent.click(screen.getByTestId('month-override-save'));
    // Modal closes + tile shows customised badge.
    expect(screen.queryByTestId('month-override-modal')).not.toBeInTheDocument();
    expect(screen.getByTestId('month-tile-month_12'))
      .toHaveAttribute('data-month-customized', 'true');
    expect(screen.getByTestId('customized-badge-month_12')).toBeInTheDocument();
  });

  it('does NOT customise the tile when the modal saves with no diffs', async () => {
    setup();
    await userEvent.click(screen.getByTestId('month-tile-month_04'));
    // Save without changes — modal computes diff vs template, finds nothing.
    await userEvent.click(screen.getByTestId('month-override-save'));
    expect(screen.getByTestId('month-tile-month_04'))
      .toHaveAttribute('data-month-customized', 'false');
  });

  it('Reset-to-template clears an existing override', async () => {
    setup();
    // First customise.
    await userEvent.click(screen.getByTestId('month-tile-month_02'));
    await userEvent.click(screen.getByTestId('month-override-add-frame'));
    await userEvent.click(screen.getByTestId('month-override-save'));
    expect(screen.getByTestId('customized-badge-month_02')).toBeInTheDocument();

    // Re-open + reset.
    await userEvent.click(screen.getByTestId('month-tile-month_02'));
    await userEvent.click(screen.getByTestId('month-override-reset'));
    expect(screen.queryByTestId('month-override-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('customized-badge-month_02')).not.toBeInTheDocument();
  });

  it('Reset button is disabled when there is no current override', async () => {
    setup();
    await userEvent.click(screen.getByTestId('month-tile-month_09'));
    expect(screen.getByTestId('month-override-reset')).toBeDisabled();
  });

  it('serialises surfaceOverrides into the layout JSON only when at least one is set', async () => {
    const { onSave } = setup();
    // Customise one month
    await userEvent.click(screen.getByTestId('month-tile-month_05'));
    await userEvent.click(screen.getByTestId('month-override-add-frame'));
    await userEvent.click(screen.getByTestId('month-override-save'));
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect(json.surfaceOverrides).toBeDefined();
    const overrides = json.surfaceOverrides as Record<string, unknown>;
    expect(Object.keys(overrides)).toEqual(['month_05']);
  });
});

// ─── P6.2 remediation: poster-mode UI gating + active banner + preview ──────
// Covers review fixes A (frames hidden in poster), B (single-calendar filter),
// L3 (active-override banner), L5 (live-preview pane in modal).

describe('CalendarLayoutEditor — P6.2 remediation: poster-mode modal gating', () => {
  it('hides the frames editor in the modal when in poster mode (review fix A)', async () => {
    setup();
    // Switch to poster mode.
    const toggle = screen.getByTestId('mode-toggle');
    await userEvent.click(within(toggle).getByText(/1 page/));
    // Open any month tile's modal.
    await userEvent.click(screen.getByTestId('month-tile-month_03'));
    // Frames editor should be HIDDEN; the placeholder section should be shown.
    expect(screen.queryByTestId('month-override-frames-section')).not.toBeInTheDocument();
    expect(screen.getByTestId('month-override-frames-section-hidden')).toBeInTheDocument();
  });

  it('shows the frames editor in the modal when in multi-surface mode', async () => {
    setup();
    // Multi-surface is default. Open a tile.
    await userEvent.click(screen.getByTestId('month-tile-month_04'));
    expect(screen.getByTestId('month-override-frames-section')).toBeInTheDocument();
    expect(screen.queryByTestId('month-override-frames-section-hidden')).not.toBeInTheDocument();
  });

  it('filters calendars to just the matching monthOffset in poster custom layout (review fix B)', async () => {
    setup();
    // Poster + custom layout → 12 calendars each with monthOffset 0..11.
    const toggle = screen.getByTestId('mode-toggle');
    await userEvent.click(within(toggle).getByText(/1 page/));
    await userEvent.click(screen.getByTestId('poster-custom-toggle'));
    // Open the modal for month_03 (i.e. cellIndex 2 → monthOffset=2).
    await userEvent.click(screen.getByTestId('month-tile-month_03'));
    // Only the calendar with monthOffset=2 (index 2 in the calendars array)
    // should be editable — all others should be hidden from the modal.
    expect(screen.getByTestId('month-override-cal-2')).toBeInTheDocument();
    expect(screen.queryByTestId('month-override-cal-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('month-override-cal-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('month-override-cal-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('month-override-cal-11')).not.toBeInTheDocument();
  });
});

describe('CalendarLayoutEditor — P6.2 remediation: active-override banner (review fix L3)', () => {
  it('does NOT show the active-override banner on a fresh month tile', async () => {
    setup();
    await userEvent.click(screen.getByTestId('month-tile-month_08'));
    expect(screen.queryByTestId('month-override-active-banner')).not.toBeInTheDocument();
  });

  it('shows the active-override banner when re-opening a customised tile', async () => {
    setup();
    // Customise month_07 first.
    await userEvent.click(screen.getByTestId('month-tile-month_07'));
    await userEvent.click(screen.getByTestId('month-override-add-frame'));
    await userEvent.click(screen.getByTestId('month-override-save'));
    // Re-open the same tile — banner should now be visible.
    await userEvent.click(screen.getByTestId('month-tile-month_07'));
    expect(screen.getByTestId('month-override-active-banner')).toBeInTheDocument();
  });
});

describe('CalendarLayoutEditor — P6.2 remediation: live preview pane (review fix L5)', () => {
  it('renders the live-preview pane inside the modal', async () => {
    setup();
    await userEvent.click(screen.getByTestId('month-tile-month_11'));
    expect(screen.getByTestId('month-override-live-preview')).toBeInTheDocument();
  });
});

describe('CalendarLayoutEditor — P6.2 remediation: override-bounds validation (review fix C / L1)', () => {
  function makeDraftWithOverride(
    overrides: import('@/components/CalendarLayoutEditor').CalendarLayoutDraft['surfaceOverrides'],
  ): CalendarLayoutDraft {
    return {
      name: 'override_test',
      productType: 'calendar',
      mode: 'multi-surface',
      canvasWidthMm: 100, canvasHeightMm: 100, dpi: 300,
      frames: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
      calendars: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
      style: {
        themePreset: 'modern-minimalist',
        calendarType: 'english', weekStart: 'sunday',
        holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
      },
      defaultYear: 'current',
      surfaceOverrides: overrides,
    };
  }

  it('rejects an override frame extending past the right edge', () => {
    const err = validateDraft(makeDraftWithOverride({
      month_03: { frames: [{ x: 0.8, y: 0.1, width: 0.5, height: 0.2 }] },
    }));
    expect(err).toMatch(/surfaceOverrides\['month_03'\].frames\[0\] extends past the right canvas edge/);
  });

  it('rejects an override frame extending past the bottom edge', () => {
    const err = validateDraft(makeDraftWithOverride({
      month_06: { frames: [{ x: 0.1, y: 0.8, width: 0.2, height: 0.5 }] },
    }));
    expect(err).toMatch(/surfaceOverrides\['month_06'\].frames\[0\] extends past the bottom canvas edge/);
  });

  it('rejects an override frame with zero width', () => {
    const err = validateDraft(makeDraftWithOverride({
      month_01: { frames: [{ x: 0.1, y: 0.1, width: 0, height: 0.5 }] },
    }));
    expect(err).toMatch(/must have positive dimensions/);
  });

  it('rejects an override calendar extending past the right edge', () => {
    const err = validateDraft(makeDraftWithOverride({
      month_09: { calendars: [{ x: 0.8, y: 0.1, width: 0.5, height: 0.2 }] },
    }));
    expect(err).toMatch(/surfaceOverrides\['month_09'\].calendars\[0\] extends past the right canvas edge/);
  });

  it('rejects an override calendar extending past the bottom edge', () => {
    const err = validateDraft(makeDraftWithOverride({
      month_02: { calendars: [{ x: 0.1, y: 0.8, width: 0.2, height: 0.5 }] },
    }));
    expect(err).toMatch(/surfaceOverrides\['month_02'\].calendars\[0\] extends past the bottom canvas edge/);
  });

  it('rejects an override calendar with negative origin', () => {
    const err = validateDraft(makeDraftWithOverride({
      month_05: { calendars: [{ x: -0.1, y: 0.1, width: 0.2, height: 0.2 }] },
    }));
    expect(err).toMatch(/must have positive dimensions and non-negative origin/);
  });

  it('passes when overrides are inside the canvas', () => {
    expect(validateDraft(makeDraftWithOverride({
      month_03: {
        frames: [{ x: 0.05, y: 0.05, width: 0.4, height: 0.4 }],
        calendars: [{ x: 0.05, y: 0.5, width: 0.9, height: 0.4 }],
      },
    }))).toBeNull();
  });
});

describe('CalendarLayoutEditor — P6.2 remediation: multi-month override save', () => {
  it('serialises ALL customised months when 3 months are customised', async () => {
    const { onSave } = setup();
    // Customise three different months — each gets one extra frame.
    for (const m of ['month_01', 'month_05', 'month_12']) {
      await userEvent.click(screen.getByTestId(`month-tile-${m}`));
      await userEvent.click(screen.getByTestId('month-override-add-frame'));
      await userEvent.click(screen.getByTestId('month-override-save'));
    }
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect(json.surfaceOverrides).toBeDefined();
    const overrides = json.surfaceOverrides as Record<string, unknown>;
    expect(Object.keys(overrides).sort()).toEqual(['month_01', 'month_05', 'month_12']);
    // Each customised tile shows a "Customized" badge.
    expect(screen.getByTestId('customized-badge-month_01')).toBeInTheDocument();
    expect(screen.getByTestId('customized-badge-month_05')).toBeInTheDocument();
    expect(screen.getByTestId('customized-badge-month_12')).toBeInTheDocument();
  });
});

// ─── P6 holistic-audit fixes (May 24, 2026) ─────────────────────────────────
// Audit revealed two real bugs in poster-mode override semantics + wrapper-
// page round-trip. Tests below pin the fixes.

describe('CalendarLayoutEditor — P6 holistic audit: poster override single-calendar emit', () => {
  it('emits only the calendar with matching monthOffset in poster mode (not all 12)', async () => {
    const { onSave } = setup();
    // Switch to poster + enable custom layout (so calendars[] has all 12).
    const toggle = screen.getByTestId('mode-toggle');
    await userEvent.click(within(toggle).getByText(/1 page/));
    await userEvent.click(screen.getByTestId('poster-custom-toggle'));
    // Open month_03 (cellIndex=2 → monthOffset=2).
    await userEvent.click(screen.getByTestId('month-tile-month_03'));
    // Edit the calendar visible to the user (the one with monthOffset=2).
    const calRow = screen.getByTestId('month-override-cal-2');
    const xInput = within(calRow).getAllByRole('spinbutton')[0];
    await userEvent.clear(xInput);
    await userEvent.type(xInput, '0.1');
    await userEvent.click(screen.getByTestId('month-override-save'));
    // Serialise + inspect the override shape.
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    const overrides = json.surfaceOverrides as Record<string, { calendars?: unknown[] }>;
    expect(overrides.month_03).toBeDefined();
    expect(Array.isArray(overrides.month_03.calendars)).toBe(true);
    // BUG #1 FIX: must be exactly 1 element (not 12) — the single edited calendar.
    expect(overrides.month_03.calendars).toHaveLength(1);
  });

  it('still emits all calendars in multi-surface mode (single template calendar)', async () => {
    const { onSave } = setup();
    // Multi-surface is default. Open month_03, change calendar 0's x.
    await userEvent.click(screen.getByTestId('month-tile-month_03'));
    const calRow = screen.getByTestId('month-override-cal-0');
    const xInput = within(calRow).getAllByRole('spinbutton')[0];
    await userEvent.clear(xInput);
    await userEvent.type(xInput, '0.1');
    await userEvent.click(screen.getByTestId('month-override-save'));
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    const overrides = json.surfaceOverrides as Record<string, { calendars?: unknown[] }>;
    expect(overrides.month_03.calendars).toHaveLength(1);
  });
});

describe('CalendarLayoutEditor — P6 holistic audit: surfaceOverrides round-trip via initial prop', () => {
  it('preserves surfaceOverrides passed via the initial prop on save', async () => {
    const seedOverrides = {
      month_06: {
        frames: [{ x: 0.05, y: 0.05, width: 0.4, height: 0.4 }],
      },
    };
    const { onSave } = setup({
      initial: {
        surfaceOverrides: seedOverrides,
      },
    });
    // No further edits — just save.
    await userEvent.click(screen.getByTestId('save-btn'));
    const json = onSave.mock.calls[0][0];
    expect(json.surfaceOverrides).toEqual(seedOverrides);
    // The pre-existing override should also light up the tile badge so ops
    // sees a visible "Customized" indicator on the existing customisation.
    expect(screen.getByTestId('customized-badge-month_06')).toBeInTheDocument();
  });
});

// ─── Save button + validation gate ──────────────────────────────────────────

describe('CalendarLayoutEditor — save flow', () => {
  it('fires onSave with the serialised JSON when the draft is valid', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByTestId('save-btn'));
    expect(onSave).toHaveBeenCalledTimes(1);
    const json = onSave.mock.calls[0][0];
    expect(json.productType).toBe('calendar');
    expect(json.canvas).toHaveProperty('width');
    expect(json.canvas).toHaveProperty('height');
    expect((json.canvas as Record<string, unknown>).widthMm).toBeGreaterThan(0);
  });

  it('blocks Save and shows error when validation fails', async () => {
    const { onSave } = setup({
      initial: { name: '' },          // empty name fails validation
    });
    await userEvent.click(screen.getByTestId('save-btn'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('save-error')).toHaveTextContent(/name is required/);
  });

  it('fires onCancel when Cancel clicked', async () => {
    const { onCancel } = setup();
    await userEvent.click(screen.getByTestId('cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
