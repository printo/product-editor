import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { CanvasGrid } from '../CanvasGrid';
import { CanvasCard, SurfaceCard, type CardProps } from '../CanvasCard';
import type { CanvasItem, FrameState, SurfaceState } from '../types';

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

describe('CanvasCard', () => {
  const setup = (over: Partial<CardProps> = {}, c = canvas(), idx = 2) => {
    const props = cardProps(over);
    render(<CanvasCard canvas={c} idx={idx} {...props} />);
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
    render(<SurfaceCard surface={surface('back', 'Back')} {...props} />);
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

  it('drags as its side', () => {
    const props = cardProps();
    const { container } = render(<SurfaceCard surface={surface('back', 'Back')} {...props} />);
    const draggable = container.querySelector('[draggable="true"]')!;
    fireEvent.dragStart(draggable);
    fireEvent.drop(draggable);
    expect(props.handleDragStart).toHaveBeenCalledWith(expect.anything(), 0, 'back');
    expect(props.handleDrop).toHaveBeenCalledWith(expect.anything(), 0, 'back');
  });
});
