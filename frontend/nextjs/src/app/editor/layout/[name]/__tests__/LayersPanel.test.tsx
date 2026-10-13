import { render, screen } from '@testing-library/react';
import { LayersPanel } from '../LayersPanel';
import type { CanvasItem, Overlay } from '../types';

describe('LayersPanel', () => {
  it('marks an added image that could not be recovered, and only that one', () => {
    const overlays = [
      { id: 'a', type: 'image', source: 'local', fileId: 'idb-1', src: 'blob:dead', label: 'logo.png' },
      { id: 'b', type: 'image', source: 'local', originalFile: new File(['x'], 'ok.png'), src: 'blob:ok', label: 'ok.png' },
      { id: 'c', type: 'image', source: 'clipart', src: '/clipart/star.svg', label: 'Star' },
    ] as unknown as Overlay[];
    const canvas: CanvasItem = { id: 0, frames: [], overlays, bgColor: '#fff', paperColor: '#fff', dataUrl: null };
    render(
      <LayersPanel editingCanvas={canvas} selected={null} onSelect={jest.fn()} onDeleteOverlay={jest.fn()}
        onReorderOverlays={jest.fn()} onClearFrame={jest.fn()} onMoveFrameToOverlay={jest.fn()} />,
    );
    expect(screen.getByText('logo.png — missing')).toBeInTheDocument();
    expect(screen.getByTitle(/Couldn't be recovered on this device/)).toHaveTextContent('logo.png — missing');
    expect(screen.getByText('ok.png')).toBeInTheDocument();
    expect(screen.getByText('Star')).toBeInTheDocument();
    expect(screen.getAllByText(/— missing/)).toHaveLength(1);
  });
});
