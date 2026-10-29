import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { CanvasGrid } from '../CanvasGrid';
import { CanvasCard, SurfaceCard, type CardProps } from '../CanvasCard';
import type { CanvasItem, FrameState, Overlay, SurfaceState } from '../types';

const frame = (over: Partial<FrameState> = {}) => ({ id: 0, originalFile: new File(['x'], 'a.jpg'), ...over }) as FrameState;
const canvas = (over: Partial<CanvasItem> = {}, frames = [frame()]): CanvasItem =>
  ({ id: 0, frames, overlays: [], bgColor: '#fff', paperColor: '#fff', dataUrl: 'data:image/png;base64,AA', ...over });
const surface = (key: string, label: string, c = canvas()): SurfaceState =>
  ({ key, label, def: { canvas: { width: 1200, height: 1800, widthMm: 102, heightMm: 152 } }, files: [], canvases: [c], globalFitMode: 'cover' }) as unknown as SurfaceState;

function cardProps(over: Partial<CardProps> = {}): CardProps {
  return {
    layout: { canvas: { width: 1200, height: 1800 }, frames: [{}] },
    dragOverIdx: null, setDragOverIdx: jest.fn(), repositionMode: false,
    handleDragStart: jest.fn(), handleDragOver: jest.fn(), handleDrop: jest.fn(),
    openEditor: jest.fn(), handleCardClick: jest.fn(),
    handlePanStart: jest.fn(), handlePanMove: jest.fn(), handlePanEnd: jest.fn(),
    requestReplacePhoto: jest.fn(), lowDpiByCard: new Map(),
    handleQuickRotate: jest.fn(), handleQuickToggleFit: jest.fn(), handleQuickToggleBlur: jest.fn(),
    swapSource: null, setSwapSource: jest.fn(), handleQuickDelete: jest.fn(),
    ...over,
  };
}
const applied = <T,>(arg: SetStateAction<T>, prev: T): T =>
  (typeof arg === 'function' ? (arg as (p: T) => T)(prev) : arg);

describe('CanvasGrid', () => {
  it('shows nothing before the first canvas', () => {
    const { container } = render(<CanvasGrid canvases={[]} surfaceStates={[]} {...cardProps()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a single-surface product gets one card per canvas', () => {
    render(<CanvasGrid canvases={[canvas(), canvas(), canvas()]} surfaceStates={[]} {...cardProps()} />);
    expect(screen.getAllByRole('button', { name: /^Edit canvas \d+$/ }).map(b => b.getAttribute('aria-label')))
      .toEqual(['Edit canvas 1', 'Edit canvas 2', 'Edit canvas 3']);
  });

  it('a multi-surface product gets one card per side', () => {
    const sides = [surface('front', 'Front'), surface('back', 'Back')];
    render(<CanvasGrid canvases={[canvas()]} surfaceStates={sides} {...cardProps()} />);
    expect(screen.getByRole('button', { name: 'Edit Front' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Back' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit canvas/ })).toBeNull();
  });
});

describe('CanvasGrid — one-month-a-page calendar', () => {
  const BLOCK = { x: 0.05, y: 0.5, width: 0.9, height: 0.4 };
  const calendarConfig = (canvasCount: number) => ({
    pages: Array.from({ length: 12 }, (_, i) => ({
      surfaceIndex: i, year: 2027, month: i + 1, canvasIdx: i % canvasCount, block: BLOCK,
    })),
    weekStart: 'sunday' as const, cells: {}, holidays: [], dotCycle: ['#000'], showMonthName: true,
    colors: { bg: '#fff', dateText: '#000', outOfMonthText: '#999', grid: '#eee', weekdayText: '#333' },
    onOpenMonth: jest.fn(), onAddPhotos: jest.fn(),
  });

  it('heads each card with its month and draws that month’s grid where the print puts it', () => {
    render(<CanvasGrid canvases={[canvas(), canvas()]} surfaceStates={[]} {...cardProps()} calendar={calendarConfig(2)} />);
    const first = screen.getByRole('button', { name: 'Edit canvas 1' });
    expect(within(first.parentElement!).getByRole('heading')).toHaveTextContent('January 2027');
    const zone = within(first).getByRole('button', { name: 'Add dates to January 2027' });
    expect(zone).toHaveStyle({ left: '5%', top: '50%', width: '90%', height: '40%' });
  });

  it('the edit hint covers the photo window only, not the grid or the blank paper', () => {
    const props = cardProps({ layout: { canvas: { width: 1200, height: 1800 }, frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.4 }] } });
    render(<CanvasGrid canvases={[canvas(), canvas()]} surfaceStates={[]} {...props} calendar={calendarConfig(2)} />);
    const first = screen.getByRole('button', { name: 'Edit canvas 1' });
    const photo = within(first).getByTestId('calendar-photo-zone');
    expect(photo).toHaveStyle({ left: '5%', top: '5%', width: '90%', height: '40%' });
    expect(photo).toHaveTextContent('Edit photo');
    expect(first.className).not.toMatch(/hover:border-indigo/);
  });

  it('a tap on the grid opens the day editor on that month, not the photo editor', () => {
    const props = cardProps();
    const cal = calendarConfig(2);
    render(<CanvasGrid canvases={[canvas(), canvas()]} surfaceStates={[]} {...props} calendar={cal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add dates to February 2027' }));
    expect(cal.onOpenMonth).toHaveBeenCalledWith(1, 2027, 2);
    expect(props.handleCardClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit canvas 2' }));
    expect(props.handleCardClick).toHaveBeenCalledWith(1);
  });

  it('shows the months past the last photo as repeats that offer a photo of their own', () => {
    const cal = calendarConfig(10);
    render(<CanvasGrid canvases={Array.from({ length: 10 }, () => canvas())} surfaceStates={[]} {...cardProps()} calendar={cal} />);
    const repeats = screen.getAllByTestId('calendar-repeat-card');
    expect(repeats).toHaveLength(2);
    expect(repeats[0]).toHaveTextContent('November 2027');
    expect(repeats[0]).toHaveTextContent('Repeats image 1');
    fireEvent.click(within(repeats[1]).getByRole('button', { name: /Add a photo for December/ }));
    expect(cal.onAddPhotos).toHaveBeenCalled();
    fireEvent.click(within(repeats[1]).getByRole('button', { name: 'Add dates to December 2027' }));
    expect(cal.onOpenMonth).toHaveBeenCalledWith(11, 2027, 12);
  });

  it('with twelve photos there are no repeats', () => {
    render(<CanvasGrid canvases={Array.from({ length: 12 }, () => canvas())} surfaceStates={[]} {...cardProps()} calendar={calendarConfig(12)} />);
    expect(screen.queryByTestId('calendar-repeat-card')).toBeNull();
    expect(screen.getAllByTestId('calendar-grid-zone')).toHaveLength(12);
  });
});

describe('CanvasCard', () => {
  const setup = (over: Partial<CardProps> = {}, c = canvas(), idx = 2) => {
    const props = cardProps(over);
    render(<CanvasCard canvas={c} idx={idx} cardCount={1} {...props} />);
    return { props, card: screen.getByRole('button', { name: `Edit canvas ${idx + 1}` }) };
  };

  it('is labelled by its number and opens the editor by click or Enter', () => {
    const { props, card } = setup();
    expect(screen.getByRole('heading')).toHaveTextContent('Image 3');
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(props.handleCardClick).toHaveBeenCalledTimes(2);
    expect(props.handleCardClick).toHaveBeenCalledWith(2);
  });

  it('each quick action acts on this card only, without opening the editor', () => {
    const { props, card } = setup();
    const rail = within(card);
    fireEvent.click(rail.getByTitle('Rotate 90°'));
    fireEvent.click(rail.getByTitle('Switch to Fit'));
    fireEvent.click(rail.getByTitle('Add Blur'));
    fireEvent.click(rail.getByTitle('Replace Photo'));
    fireEvent.click(rail.getByTitle('Remove Photo'));
    expect(props.handleQuickRotate).toHaveBeenCalledWith(2);
    expect(props.handleQuickToggleFit).toHaveBeenCalledWith(2);
    expect(props.handleQuickToggleBlur).toHaveBeenCalledWith(2);
    expect(props.requestReplacePhoto).toHaveBeenCalledWith(2, 0);
    expect(props.handleQuickDelete).toHaveBeenCalledWith(2);
    expect(props.handleCardClick).not.toHaveBeenCalled();
  });

  it('the rail reflects the card: Switch to Cover when fitted, Remove Blur when blurred, no Replace for a collage', () => {
    setup({ layout: { canvas: { width: 1200, height: 1800 }, frames: [{}, {}] } },
      canvas({}, [frame({ fitMode: 'contain', fillStyle: 'blur' } as Partial<FrameState>), frame()]));
    expect(screen.getByTitle('Switch to Cover')).toBeInTheDocument();
    expect(screen.getByTitle('Remove Blur')).toBeInTheDocument();
    expect(screen.queryByTitle('Replace Photo')).toBeNull();
  });

  it('tap-to-swap picks this card, and a second tap puts it down', () => {
    const { props } = setup();
    fireEvent.click(screen.getByTitle('Swap Photo'));
    const arg = (props.setSwapSource as jest.Mock).mock.calls[0][0];
    expect(applied(arg, null)).toEqual({ idx: 2, surfaceKey: null });
    expect(applied(arg, { idx: 2, surfaceKey: null })).toBeNull();
    expect(applied(arg, { idx: 0, surfaceKey: null })).toEqual({ idx: 2, surfaceKey: null });
  });

  it('a photo lost on this device asks to be re-uploaded, at the frame that lost it', () => {
    const { props } = setup({}, canvas({}, [frame(), frame({ originalFile: null, fileName: 'b.jpg' } as Partial<FrameState>)]));
    fireEvent.click(screen.getByRole('button', { name: /Photo missing/ }));
    expect(props.requestReplacePhoto).toHaveBeenCalledWith(2, 1);
  });

  it('an added image lost on this device opens the editor to fix it', () => {
    const lostImage = { type: 'image', source: 'local', fileId: 'idb-1', src: 'blob:dead', label: 'logo.png' } as unknown as Overlay;
    const recovered = { type: 'image', source: 'local', originalFile: new File(['x'], 'ok.png'), src: 'blob:ok', label: 'ok.png' } as unknown as Overlay;
    const { props } = setup({}, canvas({ overlays: [recovered, lostImage] }));
    fireEvent.click(screen.getByRole('button', { name: /Added image missing/ }));
    expect(props.openEditor).toHaveBeenCalledWith(2);
    expect(props.handleCardClick).not.toHaveBeenCalled();
  });

  it('a lost photo takes the badge over a lost added image', () => {
    const lostImage = { type: 'image', source: 'local', fileId: 'idb-1', src: 'blob:dead', label: 'logo.png' } as unknown as Overlay;
    setup({}, canvas({ overlays: [lostImage] }, [frame({ originalFile: null, fileId: 'idb-a' } as Partial<FrameState>)]));
    expect(screen.getByRole('button', { name: /Photo missing/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Added image missing/ })).toBeNull();
  });

  it('a recovered added image, or clipart, shows no badge', () => {
    const recovered = { type: 'image', source: 'local', originalFile: new File(['x'], 'ok.png'), src: 'blob:ok', label: 'ok.png' } as unknown as Overlay;
    const clipart = { type: 'image', source: 'clipart', src: '/clipart/star.svg', label: 'Star' } as unknown as Overlay;
    setup({}, canvas({ overlays: [recovered, clipart] }));
    expect(screen.queryByRole('button', { name: /missing/ })).toBeNull();
  });

  it('a low-resolution photo shows its DPI', () => {
    setup({ lowDpiByCard: new Map([[':2', { canvasIdx: 2, frameIdx: 0, surfaceKey: null, dpi: 92.4, severity: 'critical' as const }]]) });
    expect(screen.getByText(/Low res ~92 DPI/)).toBeInTheDocument();
  });

  it('drags and drops as itself', () => {
    const { props, card } = setup();
    expect(card).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(card);
    fireEvent.dragOver(card);
    fireEvent.drop(card);
    fireEvent.dragLeave(card);
    expect(props.handleDragStart).toHaveBeenCalledWith(expect.anything(), 2);
    expect(props.handleDragOver).toHaveBeenCalledWith(expect.anything(), 2);
    expect(props.handleDrop).toHaveBeenCalledWith(expect.anything(), 2);
    expect(props.setDragOverIdx).toHaveBeenCalledWith(null);
  });

  it('cannot be dragged while photos are unlocked for repositioning', () => {
    const { card } = setup({ repositionMode: true });
    expect(card).toHaveAttribute('draggable', 'false');
  });

  it('highlights while something is dragged over it', () => {
    const { card } = setup({ dragOverIdx: { idx: 2, surfaceKey: null } });
    expect(card.className).toMatch(/border-indigo-500/);
  });
});

describe('SurfaceCard', () => {
  it('names its side, and every action carries the side', () => {
    const props = cardProps();
    render(<SurfaceCard sideCount={2} surface={surface('back', 'Back')} {...props} />);
    expect(screen.getByRole('heading')).toHaveTextContent('Back');
    expect(screen.getByText('102×152mm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(props.openEditor).toHaveBeenCalledWith(0, 'back');
    const card = screen.getByRole('button', { name: 'Edit Back' });
    fireEvent.click(card);
    expect(props.handleCardClick).toHaveBeenCalledWith(0, 'back');
    fireEvent.click(within(card).getByTitle('Rotate 90°'));
    fireEvent.click(within(card).getByTitle('Remove Photo'));
    expect(props.handleQuickRotate).toHaveBeenCalledWith(0, 'back');
    expect(props.handleQuickDelete).toHaveBeenCalledWith(0, 'back');
    fireEvent.click(within(card).getByTitle('Swap Photo'));
    expect(applied((props.setSwapSource as jest.Mock).mock.calls[0][0], null)).toEqual({ idx: 0, surfaceKey: 'back' });
  });

  it('a side with a lost added image opens the editor on that side', () => {
    const props = cardProps();
    const lostImage = { type: 'image', source: 'local', fileId: 'idb-1', src: 'blob:dead', label: 'logo.png' } as unknown as Overlay;
    render(<SurfaceCard sideCount={2} surface={surface('back', 'Back', canvas({ overlays: [lostImage] }))} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Added image missing/ }));
    expect(props.openEditor).toHaveBeenCalledWith(0, 'back');
    expect(props.handleCardClick).not.toHaveBeenCalled();
  });

  it('drags as its side', () => {
    const props = cardProps();
    const { container } = render(<SurfaceCard sideCount={2} surface={surface('back', 'Back')} {...props} />);
    const draggable = container.querySelector('[draggable="true"]')!;
    fireEvent.dragStart(draggable);
    fireEvent.drop(draggable);
    expect(props.handleDragStart).toHaveBeenCalledWith(expect.anything(), 0, 'back');
    expect(props.handleDrop).toHaveBeenCalledWith(expect.anything(), 0, 'back');
  });
});
