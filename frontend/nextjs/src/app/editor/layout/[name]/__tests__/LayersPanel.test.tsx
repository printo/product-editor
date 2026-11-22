import { render, screen } from '@testing-library/react';
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
        onReorderOverlays={jest.fn()} onClearFrame={jest.fn()} />,
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
        onReorderOverlays={jest.fn()} onClearFrame={jest.fn()} />,
    );
    expect(screen.getByText('Main photo')).toBeInTheDocument();
    expect(screen.queryByText('f0.jpg')).toBeNull();
    const two: CanvasItem = { ...one, frames: [frame(0), frame(1)] };
    rerender(
      <LayersPanel editingCanvas={two} selected={null} onSelect={jest.fn()} onDeleteOverlay={jest.fn()}
        onReorderOverlays={jest.fn()} onClearFrame={jest.fn()} />,
    );
    expect(screen.getByText('Main photo 1')).toBeInTheDocument();
    expect(screen.getByText('Main photo 2')).toBeInTheDocument();
  });

  it('the Main photo row has no up-arrow: it only resets, and the extra images keep theirs', () => {
    const frame = { id: 0, originalFile: new File(['x'], 'f.jpg'), offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover' as const };
    const extra = { id: 'a', type: 'image', source: 'local', originalFile: new File(['x'], 'a.png'), src: 'blob:a', label: 'a.png' } as unknown as Overlay;
    const canvas: CanvasItem = { id: 0, frames: [frame], overlays: [extra, { ...extra, id: 'b' } as Overlay], bgColor: '#fff', paperColor: '#fff', dataUrl: null };
    render(
      <LayersPanel editingCanvas={canvas} selected={null} onSelect={jest.fn()} onDeleteOverlay={jest.fn()}
        onReorderOverlays={jest.fn()} onClearFrame={jest.fn()} />,
    );
    expect(screen.queryByTitle('Make an extra image')).toBeNull();
    expect(screen.queryByTitle('Bring to Top')).toBeNull();
    expect(screen.getByTitle('Clear')).toBeInTheDocument();
    expect(screen.getAllByTitle('Move Up').length).toBeGreaterThan(0);
  });
});
