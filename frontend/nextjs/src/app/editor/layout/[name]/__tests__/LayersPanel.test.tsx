import { fireEvent, render, screen } from '@testing-library/react';
import { LayersPanel } from '../LayersPanel';
import type { CanvasItem, Overlay } from '../types';

describe('LayersPanel', () => {
  it('marks an added image that could not be loaded, and only that one', () => {
    const overlays = [
      { id: 'a', type: 'image', source: 'local', fileId: 'idb-1', src: 'blob:dead', label: 'logo.png' },
      { id: 'b', type: 'image', source: 'local', originalFile: new File(['x'], 'ok.png'), src: 'blob:ok', label: 'ok.png' },
      { id: 'c', type: 'image', source: 'clipart', src: '/clipart/star.svg', label: 'Star' },
    ] as unknown as Overlay[];
    const canvas: CanvasItem = { id: 0, frames: [], overlays, bgColor: '#fff', paperColor: '#fff', dataUrl: null };
    render(
      <LayersPanel editingCanvas={canvas} selected={null} onSelect={jest.fn()} onDeleteOverlay={jest.fn()}
        onReorderOverlays={jest.fn()} />,
    );
    // Added images are named by number; a sticker keeps its own name.
    expect(screen.getByText('Extra image 1 — missing')).toBeInTheDocument();
    expect(screen.getByTitle(/Couldn't be loaded on this device/)).toHaveTextContent('Extra image 1 — missing');
    expect(screen.getByText('Extra image 2')).toBeInTheDocument();
    expect(screen.getByText('Star')).toBeInTheDocument();
    expect(screen.getAllByText(/— missing/)).toHaveLength(1);
  });

  it('names the photo in a print area Main photo, numbered when there are several', () => {
    const frame = (id: number) => ({ id, originalFile: new File(['x'], `f${id}.jpg`), offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover' as const });
    const one: CanvasItem = { id: 0, frames: [frame(0)], overlays: [], bgColor: '#fff', paperColor: '#fff', dataUrl: null };
    const { rerender } = render(
      <LayersPanel editingCanvas={one} selected={null} onSelect={jest.fn()} onDeleteOverlay={jest.fn()}
        onReorderOverlays={jest.fn()} />,
    );
    expect(screen.getByText('Main photo')).toBeInTheDocument();
    expect(screen.queryByText('f0.jpg')).toBeNull();
    const two: CanvasItem = { ...one, frames: [frame(0), frame(1)] };
    rerender(
      <LayersPanel editingCanvas={two} selected={null} onSelect={jest.fn()} onDeleteOverlay={jest.fn()}
        onReorderOverlays={jest.fn()} />,
    );
    expect(screen.getByText('Main photo 1')).toBeInTheDocument();
    expect(screen.getByText('Main photo 2')).toBeInTheDocument();
  });

  const frame = { id: 0, originalFile: new File(['x'], 'f.jpg'), offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover' as const };
  const local = (id: string) => ({ id, type: 'image', source: 'local', originalFile: new File(['x'], `${id}.png`), src: `blob:${id}`, label: `${id}.png` }) as unknown as Overlay;
  const panel = (canvas: Partial<CanvasItem>, onMakeMainPhoto?: (i: number) => void) => render(
    <LayersPanel editingCanvas={{ id: 0, frames: [frame], overlays: [], bgColor: '#fff', paperColor: '#fff', dataUrl: null, ...canvas }}
      selected={null} onSelect={jest.fn()} onDeleteOverlay={jest.fn()} onReorderOverlays={jest.fn()} onMakeMainPhoto={onMakeMainPhoto} />,
  );

  it('the Main photo row has no buttons of its own: no up-arrow, no trash', () => {
    panel({ overlays: [local('a'), local('b')] }, jest.fn());
    expect(screen.queryByTitle('Make an extra image')).toBeNull();
    expect(screen.queryByTitle('Bring to Top')).toBeNull();
    expect(screen.queryByTitle('Clear')).toBeNull();
    const mainRow = screen.getByText('Main photo').closest('div[class*="group"]') as HTMLElement;
    expect(mainRow.querySelectorAll('button')).toHaveLength(0);
  });

  it('each extra image row offers Make main photo, and it names that image', () => {
    const onMake = jest.fn();
    panel({ overlays: [local('a'), local('b')] }, onMake);
    const buttons = screen.getAllByRole('button', { name: 'Make main photo' });
    expect(buttons).toHaveLength(2);
    // Rows run top-most first, so the first button is Extra image 2 (index 1).
    fireEvent.click(buttons[0]);
    expect(onMake).toHaveBeenCalledWith(1);
    fireEvent.click(buttons[1]);
    expect(onMake).toHaveBeenCalledWith(0);
  });

  it('it is not offered on icons, stickers, a lost image, or when the handler is not given', () => {
    const lost = { id: 'l', type: 'image', source: 'local', fileId: 'idb-1', src: 'blob:dead', label: 'lost.png' } as unknown as Overlay;
    const sticker = { id: 's', type: 'image', source: 'clipart', src: '/s.svg', label: 'Star' } as unknown as Overlay;
    panel({ overlays: [lost, sticker] }, jest.fn());
    expect(screen.queryByRole('button', { name: 'Make main photo' })).toBeNull();
  });

  it('without the handler (several print areas) no row offers it', () => {
    panel({ overlays: [local('a')] });
    expect(screen.queryByRole('button', { name: 'Make main photo' })).toBeNull();
  });
});
