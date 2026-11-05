import { act, renderHook } from '@testing-library/react';
import { useUnprintableText } from '../useUnprintableText';
import { fetchUnprintable } from '@/lib/print-coverage';
import type { CanvasItem, Overlay, SurfaceState } from '../types';

jest.mock('@/lib/print-coverage', () => ({
  ...jest.requireActual('@/lib/print-coverage'),
  fetchUnprintable: jest.fn(),
}));
const ask = jest.mocked(fetchUnprintable);

const MAN_DANCING = '\u{1F57A}';
const NOTES = '\u{1F3B6}';

const text = (value: string, fontFamily = 'Pacifico'): Overlay =>
  ({ type: 'text', id: value, text: value, fontFamily, x: 50, y: 50, fontSize: 40, color: '#000', textAlign: 'center', rotation: 0 }) as Overlay;
const card = (...overlays: Overlay[]): CanvasItem =>
  ({ id: 0, frames: [], overlays, bgColor: '#fff', paperColor: '#fff', dataUrl: null }) as unknown as CanvasItem;
const side = (key: string, label: string, ...canvases: CanvasItem[]): SurfaceState =>
  ({ key, label, def: {}, files: [], canvases, globalFitMode: 'cover' }) as unknown as SurfaceState;

type Props = Parameters<typeof useUnprintableText>[0];
const getAuthHeaders = () => ({ 'X-Embed-Token': 't' });
const setEditingCanvas = jest.fn();
const base: Props = { surfaceStates: [], canvases: [], editingCanvas: null, setEditingCanvas, apiBase: '/api/embed/proxy', getAuthHeaders };

const settle = async () => { await act(async () => { jest.advanceTimersByTime(350); }); };

beforeEach(() => { jest.useFakeTimers(); ask.mockReset(); setEditingCanvas.mockReset(); });
afterEach(() => jest.useRealTimers());

describe('useUnprintableText', () => {
  it('never asks about plain English', async () => {
    renderHook(() => useUnprintableText({ ...base, canvases: [card(text('Won the argument, still love her!'))] }));
    await settle();
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks once typing pauses, sending only the special characters, and flags the card', async () => {
    ask.mockResolvedValue([[MAN_DANCING, NOTES]]);
    const caption = text(`Won the argument ${MAN_DANCING} ${NOTES}`);
    const { result } = renderHook(() => useUnprintableText({ ...base, canvases: [card(), card(caption)] }));
    await act(async () => { jest.advanceTimersByTime(349); });
    expect(ask).not.toHaveBeenCalled();
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe('/api/embed/proxy');
    expect(ask.mock.calls[0][1]).toEqual({ 'X-Embed-Token': 't' });
    expect(ask.mock.calls[0][2]).toEqual([{ text: [NOTES, MAN_DANCING].sort().join(''), fontFamily: 'Pacifico' }]);
    expect(result.current.unprintableFor(caption)).toEqual([MAN_DANCING, NOTES]);
    expect([...result.current.unprintableByCard]).toEqual([[':1', [MAN_DANCING, NOTES]]]);
    expect(result.current.unprintableTexts).toEqual([{ where: 'Canvas 2', chars: [MAN_DANCING, NOTES] }]);
  });

  it('answers the text being typed in the canvas editor before it is saved to a card', async () => {
    ask.mockResolvedValue([[MAN_DANCING]]);
    const typing = text(`Hi ${MAN_DANCING}`);
    const editing = card(typing);
    const { result } = renderHook(() => useUnprintableText({ ...base, canvases: [card()], editingCanvas: editing }));
    await settle();
    expect(result.current.unprintableFor(typing)).toEqual([MAN_DANCING]);
    expect(result.current.unprintableByCard.size).toBe(0);
  });

  it('takes the unsupported characters out of the text box being edited, and counts it', async () => {
    ask.mockResolvedValue([[MAN_DANCING, NOTES]]);
    const editing = card(text('plain'), text(`Won the argument ${MAN_DANCING}\n${MAN_DANCING} ${NOTES}`));
    const { result } = renderHook(() => useUnprintableText({ ...base, canvases: [card()], editingCanvas: editing }));
    expect(result.current.removals).toBe(0);
    await settle();
    expect(setEditingCanvas).toHaveBeenCalledTimes(1);
    const next = setEditingCanvas.mock.calls[0][0] as CanvasItem;
    expect(next.overlays.map(o => (o.type === 'text' ? o.text : null))).toEqual(['plain', 'Won the argument \n ']);
    expect(next.overlays[0]).toBe(editing.overlays[0]);
    expect(result.current.removals).toBe(1);
  });

  it('removes a character it already knows about straight away, without asking again', async () => {
    ask.mockResolvedValue([[MAN_DANCING]]);
    const { result, rerender } = renderHook((p: Props) => useUnprintableText(p), {
      initialProps: { ...base, editingCanvas: card(text(`a ${MAN_DANCING}`)) },
    });
    await settle();
    rerender({ ...base, editingCanvas: card(text('a ')) });
    rerender({ ...base, editingCanvas: card(text(`a b ${MAN_DANCING}`)) });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(setEditingCanvas).toHaveBeenCalledTimes(2);
    expect((setEditingCanvas.mock.calls[1][0] as CanvasItem).overlays[0]).toMatchObject({ text: 'a b ' });
    expect(result.current.removals).toBe(2);
  });

  it('leaves the text box alone when everything prints, or the server is unsure', async () => {
    ask.mockResolvedValueOnce([[]]).mockResolvedValueOnce([null]);
    const { result, rerender } = renderHook((p: Props) => useUnprintableText(p), {
      initialProps: { ...base, editingCanvas: card(text('Café ₹500')) },
    });
    await settle();
    rerender({ ...base, editingCanvas: card(text(`Hi ${NOTES}`)) });
    await settle();
    expect(setEditingCanvas).not.toHaveBeenCalled();
    expect(result.current.removals).toBe(0);
  });

  it('does not rewrite the saved cards: they get the badge instead', async () => {
    ask.mockResolvedValue([[MAN_DANCING]]);
    const { result } = renderHook(() => useUnprintableText({ ...base, canvases: [card(text(`Hi ${MAN_DANCING}`))] }));
    await settle();
    expect(setEditingCanvas).not.toHaveBeenCalled();
    expect(result.current.unprintableByCard.size).toBe(1);
  });

  it('reuses one answer for every card with the same font and characters', async () => {
    ask.mockResolvedValue([[MAN_DANCING]]);
    const cards = [card(text(`one ${MAN_DANCING}`)), card(text(`two ${MAN_DANCING}`)), card(text(`three ${MAN_DANCING}`))];
    const { result, rerender } = renderHook((p: Props) => useUnprintableText(p), { initialProps: { ...base, canvases: cards } });
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][2]).toHaveLength(1);
    expect(result.current.unprintableByCard.size).toBe(3);
    rerender({ ...base, canvases: [...cards, card(text(`four ${MAN_DANCING}`))] });
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.current.unprintableByCard.size).toBe(4);
  });

  it('asks again for another font', async () => {
    ask.mockResolvedValueOnce([[MAN_DANCING]]).mockResolvedValueOnce([[]]);
    const { result, rerender } = renderHook((p: Props) => useUnprintableText(p), {
      initialProps: { ...base, canvases: [card(text(`Hi ${MAN_DANCING}`, 'Pacifico'))] },
    });
    await settle();
    const inEmojiFont = text(`Hi ${MAN_DANCING}`, 'Noto Color Emoji');
    rerender({ ...base, canvases: [card(inEmojiFont)] });
    await settle();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.current.unprintableFor(inEmojiFont)).toEqual([]);
    expect(result.current.unprintableByCard.size).toBe(0);
  });

  it('names the side on a two-sided product', async () => {
    ask.mockResolvedValue([[NOTES]]);
    const sides = [side('front', 'Front', card()), side('back', 'Back', card(text(`la ${NOTES}`)))];
    const { result } = renderHook(() => useUnprintableText({ ...base, surfaceStates: sides, canvases: sides[0].canvases }));
    await settle();
    expect([...result.current.unprintableByCard.keys()]).toEqual(['back:0']);
    expect(result.current.unprintableTexts).toEqual([{ where: 'Back', chars: [NOTES] }]);
  });

  it('shows nothing when the server is unsure or the request fails, and asks again on the next change', async () => {
    ask.mockResolvedValueOnce([null]).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([[MAN_DANCING]]);
    const first = text(`a ${MAN_DANCING}`);
    const { result, rerender } = renderHook((p: Props) => useUnprintableText(p), { initialProps: { ...base, canvases: [card(first)] } });
    await settle();
    expect(result.current.unprintableFor(first)).toEqual([]);
    rerender({ ...base, canvases: [card(text(`ab ${MAN_DANCING}`))] });
    await settle();
    expect(result.current.unprintableByCard.size).toBe(0);
    const third = text(`abc ${MAN_DANCING}`);
    rerender({ ...base, canvases: [card(third)] });
    await settle();
    expect(ask).toHaveBeenCalledTimes(3);
    expect(result.current.unprintableFor(third)).toEqual([MAN_DANCING]);
  });
});
