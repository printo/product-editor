import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasEditorSidebar, type CanvasEditorSidebarProps } from '../CanvasEditorSidebar';
import type { LayerSelection } from '../LayersPanel';
import type { CanvasItem, Overlay } from '../types';

const lost = {
  id: 'o1', type: 'image', source: 'local', fileId: 'idb-1', src: 'blob:dead', label: 'logo.png',
  x: 10, y: 20, width: 30, height: 15, rotation: 45, opacity: 0.8,
} as Overlay;
const canvasWith = (overlays: Overlay[]): CanvasItem => ({
  id: 0, overlays, bgColor: '#fff', paperColor: '#fff', dataUrl: null,
  frames: [{ id: 0, originalFile: null, offset: { x: 0, y: 0 }, scale: 1, rotation: 0, fitMode: 'cover' }],
});

function setup(overlays: Overlay[], selectedLayer: LayerSelection = { type: 'image', index: 0 }) {
  const props: CanvasEditorSidebarProps = {
    editingCanvas: canvasWith(overlays),
    layout: { canvas: { width: 1200, height: 1800 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] },
    selectedLayer, setSelectedLayer: jest.fn(),
    handleAlign: jest.fn(), handleOverlayAlign: jest.fn(), handleUpdateTransform: jest.fn(), handleSaveChanges: jest.fn(),
    getFileUrl: jest.fn((f: File) => `blob:${f.name}`), debouncedRender: jest.fn(), pushUndo: jest.fn(),
    loadGoogleFont: jest.fn(), selectedFonts: [], getImageMetadata: jest.fn(), calculateSmartCropOffsets: jest.fn(),
    expandPdfPages: jest.fn(async (files: File[]) => files),
  };
  render(<CanvasEditorSidebar {...props} />);
  return props;
}

describe('CanvasEditorSidebar — an added image that could not be recovered', () => {
  it('opens on its Uploads panel and says it won’t print', () => {
    setup([lost]);
    expect(screen.getByText(/couldn.t be recovered on this device, so it won.t print/)).toBeInTheDocument();
    expect(screen.getByText('Image Overlay')).toBeInTheDocument();
  });

  it('re-uploads in place: same position, size, rotation and opacity, and a fresh store', async () => {
    const props = setup([lost]);
    const file = new File(['x'], 'logo-again.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(/Re-upload image/), { target: { files: [file] } });
    await waitFor(() => expect(props.debouncedRender).toHaveBeenCalled());
    expect(props.expandPdfPages).toHaveBeenCalledWith([file], { maxSelectable: 1 });
    expect(props.pushUndo).toHaveBeenCalledWith(props.editingCanvas, true);
    expect((props.debouncedRender as jest.Mock).mock.calls[0][0].overlays).toEqual([
      { ...lost, src: 'blob:logo-again.png', originalFile: file, fileId: undefined, label: 'logo-again.png' },
    ]);
  });

  it('a file that can’t print changes nothing', async () => {
    const props = setup([lost]);
    fireEvent.change(screen.getByLabelText(/Re-upload image/), { target: { files: [new File(['x'], 'logo.svg', { type: 'image/svg+xml' })] } });
    await waitFor(() => expect(props.expandPdfPages).toHaveBeenCalled());
    expect(props.debouncedRender).not.toHaveBeenCalled();
  });

  it('a recovered added image shows no notice', () => {
    setup([{ ...lost, originalFile: new File(['x'], 'logo.png') } as Overlay]);
    expect(screen.queryByText(/couldn.t be recovered/)).toBeNull();
    expect(screen.queryByLabelText(/Re-upload image/)).toBeNull();
  });
});
