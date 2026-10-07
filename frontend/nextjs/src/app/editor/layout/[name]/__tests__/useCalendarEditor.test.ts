import { act, renderHook, waitFor } from '@testing-library/react';
import { useCalendarDefaults, useCalendarEditor } from '../useCalendarEditor';
import { uploadCalendarCellImage, CalendarCellUploadError } from '@/lib/calendar-cell-upload';
import { resolveDefaultYear } from '@/lib/calendar';

jest.mock('@/lib/calendar-cell-upload', () => ({
  ...jest.requireActual('@/lib/calendar-cell-upload'),
  uploadCalendarCellImage: jest.fn(),
}));
const upload = jest.mocked(uploadCalendarCellImage);

const CAL = { productType: 'calendar', id: 'cal', holidayLocale: 'en-IN', calendarDefaultYear: 2027 as const };
type EditorProps = Parameters<typeof useCalendarEditor>[0];
const editorProps = (over: Partial<EditorProps> = {}): EditorProps => ({
  layout: CAL, orderId: 'EXT-1', apiBase: '/api/embed/proxy', getAuthHeaders: () => ({ 'X-Embed-Token': 't' }),
  expandPdfPages: jest.fn(async (files: File[]) => files), setUnsupportedWarning: jest.fn(), setPersistDegraded: jest.fn(),
  setError: jest.fn(), ...over,
});
const jpg = new File(['x'], 'day.jpg', { type: 'image/jpeg' });

beforeEach(() => upload.mockReset());

describe('useCalendarEditor', () => {
  it('knows a calendar, and shows holidays only when the print carries them', () => {
    const { result, rerender } = renderHook((p: EditorProps) => useCalendarEditor(p), { initialProps: editorProps() });
    expect(result.current.isCalendarProduct).toBe(true);
    act(() => result.current.setCalendarHolidays([{ date: '2027-01-26', name: 'Republic Day' } as never]));
    expect(result.current.printedHolidays).toHaveLength(1);
    rerender(editorProps({ layout: { ...CAL, holidayLocale: null } }));
    expect(result.current.printedHolidays).toEqual([]);
    rerender(editorProps({ layout: { ...CAL, productType: 'photo' } }));
    expect(result.current.isCalendarProduct).toBe(false);
  });

  it('starts on the default theme and type, with nothing selected', () => {
    const { result } = renderHook(() => useCalendarEditor(editorProps()));
    expect(result.current).toMatchObject({
      calendarTheme: 'modern-minimalist', calendarType: 'english', genzPalette: undefined, genzPalettes: [],
      calendarCells: {}, selectedCalendarCell: null, calendarImageUploading: false, calendarCellImagePreviews: {},
    });
  });

  it('edits a day’s entries, and an emptied day is dropped', () => {
    const { result } = renderHook(() => useCalendarEditor(editorProps()));
    act(() => result.current.updateCellEntries('2027-03-08', prev => [...prev, { type: 'text', text: 'A' }]));
    act(() => result.current.updateCellEntries('2027-03-08', prev => [...prev, { type: 'text', text: 'B' }]));
    expect(result.current.calendarCellEntries('2027-03-08')).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]);
    expect(result.current.calendarCellEntries('2027-03-09')).toEqual([]);
    act(() => result.current.updateCellEntries('2027-03-08', () => []));
    expect(result.current.calendarCells).toEqual({});
  });

  it('a month tile opens its first day', () => {
    const { result } = renderHook(() => useCalendarEditor(editorProps()));
    act(() => result.current.handleCalendarMonthTileClick(2, 2027, 3));
    expect(result.current.selectedCalendarCell).toEqual({ surfaceIndex: 2, year: 2027, month: 3, iso: '2027-03-01' });
  });

  it('a day photo replaces the day’s entries and shows a preview', async () => {
    upload.mockResolvedValue({ uploadId: 'u-1', blobUrl: 'blob:1', persistDegraded: false } as never);
    const p = editorProps();
    const { result } = renderHook(() => useCalendarEditor(p));
    act(() => result.current.handleCalendarMonthTileClick(0, 2027, 3));
    act(() => result.current.updateCellEntries('2027-03-01', () => [{ type: 'text', text: 'old' }]));
    await act(async () => { await result.current.handleCellImageFileSelected(jpg); });
    expect(p.expandPdfPages).toHaveBeenCalledWith([jpg], { maxSelectable: 1 });
    expect(upload).toHaveBeenCalledWith(jpg, { apiBase: '/api/embed/proxy', orderId: 'EXT-1', getAuthHeaders: p.getAuthHeaders });
    expect(result.current.calendarCells).toEqual({ '2027-03-01': [{ type: 'image', uploadId: 'u-1' }] });
    expect(result.current.calendarCellImagePreviews).toEqual({ '2027-03-01': 'blob:1' });
    expect(result.current.calendarImageUploading).toBe(false);
    expect(p.setPersistDegraded).not.toHaveBeenCalled();
  });

  it('a second photo frees the first preview, and storage trouble is reported', async () => {
    const revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    upload.mockResolvedValueOnce({ uploadId: 'u-1', blobUrl: 'blob:1' } as never)
      .mockResolvedValueOnce({ uploadId: 'u-2', blobUrl: 'blob:2', persistDegraded: true } as never);
    const p = editorProps();
    const { result } = renderHook(() => useCalendarEditor(p));
    act(() => result.current.handleCalendarMonthTileClick(0, 2027, 3));
    await act(async () => { await result.current.handleCellImageFileSelected(jpg); });
    await act(async () => { await result.current.handleCellImageFileSelected(jpg); });
    expect(revoke).toHaveBeenCalledWith('blob:1');
    expect(result.current.calendarCellImagePreviews).toEqual({ '2027-03-01': 'blob:2' });
    expect(p.setPersistDegraded).toHaveBeenCalledWith(true);
    revoke.mockRestore();
  });

  it('does nothing without a selected day, or when the PDF picker is cancelled', async () => {
    const p = editorProps({ expandPdfPages: jest.fn(async () => []) });
    const { result } = renderHook(() => useCalendarEditor(p));
    await act(async () => { await result.current.handleCellImageFileSelected(jpg); });
    expect(p.expandPdfPages).not.toHaveBeenCalled();
    act(() => result.current.handleCalendarMonthTileClick(0, 2027, 3));
    await act(async () => { await result.current.handleCellImageFileSelected(jpg); });
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses a file it cannot print, naming it', async () => {
    const p = editorProps();
    const { result } = renderHook(() => useCalendarEditor(p));
    act(() => result.current.handleCalendarMonthTileClick(0, 2027, 3));
    await act(async () => { await result.current.handleCellImageFileSelected(new File(['x'], 'logo.svg', { type: 'image/svg+xml' })); });
    expect(p.setUnsupportedWarning).toHaveBeenCalledWith(expect.stringContaining('logo.svg'));
    expect(upload).not.toHaveBeenCalled();
  });

  it('a failed upload says why, and stops showing the upload as busy', async () => {
    upload.mockRejectedValueOnce(new CalendarCellUploadError('too_large', 'That photo is too large.')).mockRejectedValueOnce(new Error('network'));
    const p = editorProps();
    const { result } = renderHook(() => useCalendarEditor(p));
    act(() => result.current.handleCalendarMonthTileClick(0, 2027, 3));
    await act(async () => { await result.current.handleCellImageFileSelected(jpg); });
    await act(async () => { await result.current.handleCellImageFileSelected(jpg); });
    expect((p.setError as jest.Mock).mock.calls).toEqual([['That photo is too large.'], ['Failed to upload image for this date. Please try again.']]);
    expect(result.current.calendarImageUploading).toBe(false);
    expect(result.current.calendarCells).toEqual({});
  });
});

describe('useCalendarDefaults', () => {
  type Props = Parameters<typeof useCalendarDefaults>[0];
  const props = (over: Partial<Props> = {}): Props => ({
    isCalendarProduct: true, layout: CAL, normalizedLayoutState: { _raw: { calendar: { themePreset: 'modern-genz', calendarType: 'financial' } } } as never,
    apiBase: '/api/internal/proxy', getAuthHeaders: () => ({}), setCalendarTheme: jest.fn(), setCalendarType: jest.fn(),
    setGenzPalettes: jest.fn(), setCalendarHolidays: jest.fn(), ...over,
  });
  const urls = () => (global.fetch as jest.Mock).mock.calls.map(c => c[0]);
  beforeEach(() => {
    global.fetch = jest.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('calendar-styles') ? { palettes: [{ name: 'neon' }] } : { events: [{ date: url.slice(-4) + '-01-01', name: 'NY' }] },
    })) as unknown as typeof fetch;
  });

  it('applies the layout’s theme and type, and loads the Gen-Z palettes', async () => {
    const p = props();
    renderHook(() => useCalendarDefaults(p));
    expect(p.setCalendarTheme).toHaveBeenCalledWith('modern-genz');
    expect(p.setCalendarType).toHaveBeenCalledWith('financial');
    await waitFor(() => expect(p.setGenzPalettes).toHaveBeenCalledWith([{ name: 'neon' }]));
    expect(urls()[0]).toBe('/api/internal/proxy/calendar-styles/modern-genz');
  });

  it('loads holidays for every year the print could cover, either calendar type, plus the next year', async () => {
    const p = props();
    renderHook(() => useCalendarDefaults(p));
    const years = [...new Set((['english', 'financial'] as const).map(t => resolveDefaultYear(2027, t)).flatMap(y => [y, y + 1]))];
    await waitFor(() => expect(p.setCalendarHolidays).toHaveBeenCalled());
    expect(urls().slice(1)).toEqual(years.map(y => `/api/internal/proxy/holidays/en-IN/${y}`));
    expect((p.setCalendarHolidays as jest.Mock).mock.calls[0][0].map((h: { date: string }) => h.date))
      .toEqual(years.map(y => `${y}-01-01`));
  });

  it('loads no holidays when the print carries none', async () => {
    const p = props({ layout: { ...CAL, holidayLocale: null } });
    renderHook(() => useCalendarDefaults(p));
    await waitFor(() => expect(p.setGenzPalettes).toHaveBeenCalled());
    expect(urls()).toEqual(['/api/internal/proxy/calendar-styles/modern-genz']);
    expect(p.setCalendarHolidays).not.toHaveBeenCalled();
  });

  it('does nothing for other products, and drops holidays that arrive after the layout changed', async () => {
    const other = props({ isCalendarProduct: false });
    renderHook(() => useCalendarDefaults(other));
    expect(global.fetch).not.toHaveBeenCalled();
    const p = props();
    const { rerender } = renderHook((q: Props) => useCalendarDefaults(q), { initialProps: p });
    rerender({ ...p, layout: { ...CAL, id: 'other', holidayLocale: null } });
    await new Promise(r => setTimeout(r, 0));
    expect(p.setCalendarHolidays).not.toHaveBeenCalled();
  });

  it('a failed holiday year counts as none, not as an error', async () => {
    global.fetch = jest.fn(async (url: string) => (url.includes('holidays') ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    const p = props();
    renderHook(() => useCalendarDefaults(p));
    await waitFor(() => expect(p.setCalendarHolidays).toHaveBeenCalledWith([]));
    expect(p.setGenzPalettes).not.toHaveBeenCalled();
  });
});
