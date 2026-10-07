import { act, fireEvent, render } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { CalendarSection } from '../CalendarSection';

// The two calendar components have their own suites; here they only record what they are handed.
const preview = jest.fn();
const panel = jest.fn();
jest.mock('@/components/CalendarProductPreview', () => ({
  CalendarProductPreview: (p: Record<string, unknown>) => { preview(p); return <div data-testid="preview" />; },
}));
jest.mock('@/components/CalendarEditPanel', () => ({
  CalendarEditPanel: (p: Record<string, unknown>) => { panel(p); return <div data-testid="panel" />; },
}));

const ISO = '2027-03-08';
const HOLIDAYS = [{ date: ISO, name: "Women's Day" }, { date: '2027-01-26', name: 'Republic Day' }];
type Props = Parameters<typeof CalendarSection>[0];

function setup(over: Partial<Props> = {}) {
  const cells: Record<string, unknown[]> = { [ISO]: [{ type: 'text', text: 'Birthday' }, { type: 'image', uploadId: 'u1' }] };
  const props: Props = {
    isCalendarProduct: true, layout: { weekStart: 'monday', calendarDefaultYear: 2027 },
    calendarTheme: 'modern-minimalist', setCalendarTheme: jest.fn(), genzPalette: undefined, genzPalettes: [],
    setGenzPalette: jest.fn(), calendarType: 'english', setCalendarType: jest.fn(),
    handleCalendarMonthTileClick: jest.fn(), calendarCells: cells as Props['calendarCells'], printedHolidays: HOLIDAYS as Props['printedHolidays'],
    selectedCalendarCell: { surfaceIndex: 2, year: 2027, month: 2, iso: ISO }, setSelectedCalendarCell: jest.fn(),
    calendarCellEntries: (iso: string) => (cells[iso] || []) as never[], updateCellEntries: jest.fn(),
    calendarCellImagePreviews: { [ISO]: 'blob:preview' }, setCalendarCellImagePreviews: jest.fn(),
    calendarImageUploading: false, calendarCellFileInputRef: { current: null }, handleCellImageFileSelected: jest.fn(),
    ...over,
  };
  preview.mockClear(); panel.mockClear();
  const utils = render(<CalendarSection {...props} />);
  return { ...utils, props, previewProps: () => preview.mock.calls.at(-1)[0], panelProps: () => panel.mock.calls.at(-1)?.[0] };
}
const updater = (props: Props, call = 0) => {
  const [iso, fn] = (props.updateCellEntries as jest.Mock).mock.calls[call];
  return { iso, fn: fn as (prev: unknown[]) => unknown[] };
};
const applied = <T,>(arg: SetStateAction<T>, prev: T): T =>
  (typeof arg === 'function' ? (arg as (p: T) => T)(prev) : arg);

describe('CalendarSection', () => {
  it('shows nothing for a product that is not a calendar', () => {
    expect(setup({ isCalendarProduct: false }).container).toBeEmptyDOMElement();
  });

  it('hands the preview the customer’s choices, the cells and the printed holidays', () => {
    const { props, previewProps } = setup();
    expect(previewProps()).toMatchObject({
      themePreset: 'modern-minimalist', onThemePresetChange: props.setCalendarTheme, calendarType: 'english',
      onCalendarTypeChange: props.setCalendarType, onMonthTileClick: props.handleCalendarMonthTileClick,
      cells: props.calendarCells, holidays: HOLIDAYS, weekStart: 'monday', defaultYear: 2027,
    });
  });

  it('falls back to Sunday weeks and the current year', () => {
    const { previewProps } = setup({ layout: {} });
    expect(previewProps()).toMatchObject({ weekStart: 'sunday', defaultYear: 'current' });
  });

  it('opens the day editor only for a selected day, with that day’s entries, holidays and photo', () => {
    expect(setup({ selectedCalendarCell: null }).panelProps()).toBeUndefined();
    const { panelProps, props } = setup();
    expect(panelProps()).toMatchObject({
      iso: ISO, cellEntries: props.calendarCells[ISO], holidaysForCell: [HOLIDAYS[0]],
      imagePreviewUrl: 'blob:preview', imageExpired: false, isImageUploading: false,
    });
    act(() => panelProps().onClose());
    expect(props.setSelectedCalendarCell).toHaveBeenCalledWith(null);
  });

  it('calls a day photo expired when the entry is there but its preview is not', () => {
    expect(setup({ calendarCellImagePreviews: {} }).panelProps().imageExpired).toBe(true);
  });

  it('adds and removes text entries on the selected day', () => {
    const { panelProps, props } = setup();
    act(() => panelProps().onAddTextEntry('Anniversary'));
    act(() => panelProps().onRemoveTextEntryByIndex(0));
    const add = updater(props, 0), remove = updater(props, 1);
    expect(add.iso).toBe(ISO);
    expect(add.fn([{ type: 'text', text: 'A' }])).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'Anniversary' }]);
    expect(remove.fn([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }])).toEqual([{ type: 'text', text: 'B' }]);
  });

  it('hide replaces the day’s entries, and a second hide brings back an empty day', () => {
    const { panelProps, props } = setup();
    act(() => panelProps().onToggleHide());
    const { fn } = updater(props);
    expect(fn([{ type: 'text', text: 'A' }])).toEqual([{ type: 'hide' }]);
    expect(fn([{ type: 'hide' }])).toEqual([]);
  });

  it('removing the photo, or resetting the day, frees its preview', () => {
    const revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { panelProps, props } = setup();
    act(() => panelProps().onRemoveImageOverride());
    const drop = (props.setCalendarCellImagePreviews as jest.Mock).mock.calls[0][0];
    expect(applied(drop, { [ISO]: 'blob:preview', other: 'blob:keep' })).toEqual({ other: 'blob:keep' });
    expect(revoke).toHaveBeenCalledWith('blob:preview');
    expect(updater(props, 0).fn([{ type: 'text', text: 'A' }, { type: 'image' }])).toEqual([{ type: 'text', text: 'A' }]);
    act(() => panelProps().onReset());
    expect(updater(props, 1).fn([{ type: 'text', text: 'A' }])).toEqual([]);
    revoke.mockRestore();
  });

  it('asks for a day photo through the hidden picker and hands over the file', () => {
    const { panelProps, props, container } = setup();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = jest.spyOn(input, 'click').mockImplementation(() => {});
    props.calendarCellFileInputRef.current = input;
    act(() => panelProps().onRequestImageOverride());
    expect(click).toHaveBeenCalled();
    const file = new File(['x'], 'day.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(props.handleCellImageFileSelected).toHaveBeenCalledWith(file);
  });
});
