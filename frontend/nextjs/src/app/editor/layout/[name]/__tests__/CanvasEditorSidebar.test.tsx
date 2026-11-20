import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasEditorSidebar, addedPhotoBox, type CanvasEditorSidebarProps } from '../CanvasEditorSidebar';
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

describe('CanvasEditorSidebar — an added image that could not be loaded', () => {
  it('opens on its Uploads panel and says it won’t print', () => {
    setup([lost]);
    expect(screen.getByText(/couldn.t be loaded on this device, so it won.t print/)).toBeInTheDocument();
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
    expect(screen.queryByText(/couldn.t be loaded/)).toBeNull();
    expect(screen.queryByLabelText(/Re-upload image/)).toBeNull();
  });
});

describe('CanvasEditorSidebar — the add controls stay with an image selected', () => {
  const icon = {
    id: 'i1', type: 'image', source: 'icon', src: 'https://api.iconify.design/mdi/cake.svg', label: 'mdi:cake',
    x: 10, y: 20, width: 20, height: 20, rotation: 0, opacity: 1,
  } as Overlay;

  it('the Uploads tab shows the selected image’s settings and still offers Add Photo', () => {
    setup([{ ...lost, originalFile: new File(['x'], 'logo.png') } as Overlay]);
    expect(screen.getByText('Image Overlay')).toBeInTheDocument();
    expect(screen.getByText('Add Photo')).toBeInTheDocument();
  });

  it('the Icons tab shows the selected icon’s settings and still offers Add New Icon', () => {
    setup([icon]);
    fireEvent.click(screen.getByRole('button', { name: 'Icons' }));
    expect(screen.getByText('Icon Overlay')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add New Icon' })).toBeInTheDocument();
  });
});

describe('CanvasEditorSidebar — the phone sheet', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width: 767px'), media: query,
      addEventListener: jest.fn(), removeEventListener: jest.fn(),
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { window.matchMedia = realMatchMedia; });

  it('opens on the photo’s controls, Zoom included, with every tab in one row and no Save of its own', () => {
    setup([], { type: 'frame', index: 0 });
    for (const name of ['Photo', 'BG', 'Text', 'Icons', 'Uploads', 'Layers']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Photo' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Zoom')).toBeInTheDocument();
    expect(screen.getByText('Photo Alignment')).toBeInTheDocument();
    expect(screen.queryByText('Save Changes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add New Text' })).toBeNull();
  });

  it('shows one section at a time', () => {
    setup([], { type: 'frame', index: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.getByRole('button', { name: 'Add New Text' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Zoom')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Layers' }));
    expect(screen.getByText('Base Layer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add New Text' })).toBeNull();
  });

  it('the Photo tab selects the photo when something else was selected', () => {
    const props = setup([{ ...lost, originalFile: new File(['x'], 'logo.png') } as Overlay]);
    expect(screen.getByRole('button', { name: 'Uploads' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Photo' }));
    expect(props.setSelectedLayer).toHaveBeenCalledWith({ type: 'frame', index: 0 });
    expect(screen.getByLabelText('Zoom')).toBeInTheDocument();
  });
});

describe('addedPhotoBox — a photo added on top keeps its own shape', () => {
  // Percent of the canvas on each axis, so the shape on screen is
  // (width% x canvasW) : (height% x canvasH).
  const shape = (box: { width: number; height: number }, cw: number, ch: number) => (box.width * cw) / (box.height * ch);

  it('a landscape photo on a portrait canvas is not squeezed into the canvas’s shape', () => {
    const box = addedPhotoBox(1600, 1200, 1200, 1800);
    expect(box.width).toBe(30);
    expect(shape(box, 1200, 1800)).toBeCloseTo(1600 / 1200, 2);
  });

  it('a tall photo is made smaller, not cut, when it would pass 60% of the height', () => {
    const box = addedPhotoBox(500, 3000, 1800, 1200);
    expect(box.height).toBe(60);
    expect(shape(box, 1800, 1200)).toBeCloseTo(500 / 3000, 2);
  });

  it('falls back to the old box when a size is unknown', () => {
    expect(addedPhotoBox(0, 0, 1200, 1800)).toEqual({ width: 30, height: 30 });
  });
});
