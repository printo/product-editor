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

function setup(
  overlays: Overlay[],
  selectedLayer: LayerSelection = { type: 'image', index: 0 },
  canvas: CanvasItem = canvasWith(overlays),
  overrides: Partial<CanvasEditorSidebarProps> = {},
) {
  const props: CanvasEditorSidebarProps = {
    editingCanvas: canvas,
    layout: { canvas: { width: 1200, height: 1800 }, frames: [{ x: 0, y: 0, width: 1, height: 1 }] },
    selectedLayer, setSelectedLayer: jest.fn(),
    handleAlign: jest.fn(), handleOverlayAlign: jest.fn(), handleUpdateTransform: jest.fn(), handleSaveChanges: jest.fn(),
    getFileUrl: jest.fn((f: File) => `blob:${f.name}`), debouncedRender: jest.fn(), pushUndo: jest.fn(),
    loadGoogleFont: jest.fn(), selectedFonts: [], getImageMetadata: jest.fn(), calculateSmartCropOffsets: jest.fn(),
    expandPdfPages: jest.fn(async (files: File[]) => files),
    ...overrides,
  };
  render(<CanvasEditorSidebar {...props} />);
  return props;
}

describe('CanvasEditorSidebar — an added image that could not be loaded', () => {
  it('opens on its Image settings and says it won’t print', () => {
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

  const added = { ...lost, originalFile: new File(['x'], 'logo.png') } as Overlay;

  it('an added image is controlled with the photos in the print areas, not on the Uploads tab', () => {
    setup([added]);
    expect(screen.getByText('Image Overlay')).toBeInTheDocument();
    expect(screen.getByLabelText('Opacity')).toBeInTheDocument();
    expect(screen.getByLabelText('Rotation in degrees')).toBeInTheDocument();
    expect(screen.queryByText('Fit Mode')).toBeNull();
  });

  it('the Uploads tab only adds: it offers Add Image and none of the selected image’s settings', () => {
    setup([added]);
    fireEvent.click(screen.getByRole('button', { name: 'Uploads' }));
    expect(screen.getByText('Add Image')).toBeInTheDocument();
    expect(screen.queryByText('Add Photo')).toBeNull();
    const uploads = screen.getByText('Add Image').closest('div[class*="space-y-4"]');
    expect(uploads?.textContent).not.toMatch(/Image Overlay|Opacity/);
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

  it('opens on the image’s controls, Zoom included, with every tab in one row and no Save of its own', () => {
    setup([], { type: 'frame', index: 0 });
    for (const name of ['Image', 'BG', 'Text', 'Icons', 'Uploads', 'Layers']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Image' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Zoom')).toBeInTheDocument();
    expect(screen.getByText('Image Alignment')).toBeInTheDocument();
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

  it('an added image opens on the Image tab with its own settings, not on Uploads', () => {
    setup([{ ...lost, originalFile: new File(['x'], 'logo.png') } as Overlay]);
    expect(screen.getByRole('button', { name: 'Image' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Uploads' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Image Overlay')).toBeInTheDocument();
    expect(screen.getByLabelText('Opacity')).toBeInTheDocument();
    expect(screen.queryByText('Fit Mode')).toBeNull();
  });

  it('tapping Image while an added image is selected keeps that image', () => {
    const props = setup([{ ...lost, originalFile: new File(['x'], 'logo.png') } as Overlay]);
    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    expect(screen.getByText('Image Overlay')).toBeInTheDocument();
    expect(props.setSelectedLayer).not.toHaveBeenCalled();
  });

  it('with a text box selected, the Image tab selects the photo in the print area', () => {
    const text = { id: 't1', type: 'text', text: 'Hi', x: 50, y: 50, fontSize: 40, color: '#000', fontFamily: 'Inter', rotation: 0 } as Overlay;
    const props = setup([text], { type: 'text', index: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    expect(props.setSelectedLayer).toHaveBeenCalledWith({ type: 'frame', index: 0 });
  });
});

describe('CanvasEditorSidebar — replacing the photo in a print area', () => {
  const file = new File(['x'], 'new.jpg', { type: 'image/jpeg' });
  const added = {
    id: 'o1', type: 'image', source: 'local', fileId: 'idb-9', src: 'blob:new', originalFile: file, label: 'new.jpg',
    x: 10, y: 20, width: 30, height: 15, rotation: 45, opacity: 0.5,
  } as Overlay;
  const oldPhoto = new File(['old'], 'old.jpg', { type: 'image/jpeg' });
  const frame = (over: Partial<CanvasItem['frames'][number]> = {}) => ({
    id: 0, originalFile: oldPhoto, offset: { x: 40, y: -30 }, scale: 1.8, rotation: 90, fitMode: 'cover' as const, ...over,
  });
  const canvas = (frames: CanvasItem['frames'], overlays: Overlay[] = [added]): CanvasItem => ({
    id: 0, overlays, bgColor: '#fff', paperColor: '#fff', dataUrl: null, frames,
  });
  const makeMetadata = () => ({
    getImageMetadata: jest.fn(async () => ({ width: 100, height: 200, orientation: 1, element: {} as HTMLImageElement })),
    calculateSmartCropOffsets: jest.fn(async () => ({ x: 7, y: 9 })),
  });
  let metadata = makeMetadata();
  beforeEach(() => { metadata = makeMetadata(); });

  it('"Use as print-area photo" puts the image in the area at the default fit and takes the overlay off', async () => {
    const props = setup([added], { type: 'image', index: 0 }, canvas([frame({ fillStyle: 'blur' })]), metadata);
    fireEvent.click(screen.getByRole('button', { name: /Use as print-area photo/ }));
    await waitFor(() => expect(props.debouncedRender).toHaveBeenCalled());
    const next = (props.debouncedRender as jest.Mock).mock.calls[0][0] as CanvasItem;
    expect(next.overlays).toHaveLength(0);
    expect(next.frames[0]).toMatchObject({
      originalFile: file, fileId: 'idb-9', fileName: 'new.jpg', fileSize: file.size,
      scale: 1, rotation: 0, offset: { x: 7, y: 9 }, fitMode: 'cover', fillStyle: 'blur',
    });
    expect(props.setSelectedLayer).toHaveBeenCalledWith({ type: 'frame', index: 0 });
  });

  it('in Fit the new photo starts centred, with no smart crop', async () => {
    const props = setup([added], { type: 'image', index: 0 }, canvas([frame({ fitMode: 'contain' })]), metadata);
    fireEvent.click(screen.getByRole('button', { name: /Use as print-area photo/ }));
    await waitFor(() => expect(props.debouncedRender).toHaveBeenCalled());
    const next = (props.debouncedRender as jest.Mock).mock.calls[0][0] as CanvasItem;
    expect(next.frames[0]).toMatchObject({ fitMode: 'contain', offset: { x: 0, y: 0 }, scale: 1, rotation: 0 });
    expect(metadata.calculateSmartCropOffsets).not.toHaveBeenCalled();
  });

  it('a layout with several print areas offers one button per slot', () => {
    setup([added], { type: 'image', index: 0 }, canvas([frame(), frame({ id: 1, originalFile: null })]), metadata);
    expect(screen.getByRole('button', { name: /Use as photo in slot 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Use as photo in slot 2/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Use as print-area photo/ })).toBeNull();
  });

  it('an image that could not be loaded cannot be put in a print area', () => {
    const lostImage = { ...added, originalFile: undefined } as Overlay;
    setup([lostImage], { type: 'image', index: 0 }, canvas([frame()], [lostImage]), metadata);
    expect(screen.queryByRole('button', { name: /Use as print-area photo/ })).toBeNull();
  });

  it('an empty print area offers Add photo, and a photo from it lands in the area at the default fit', async () => {
    const props = setup([], { type: 'frame', index: 0 }, canvas([frame({ originalFile: null })], []), metadata);
    const input = screen.getByText('Add photo').closest('label')?.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(props.debouncedRender).toHaveBeenCalled());
    const next = (props.debouncedRender as jest.Mock).mock.calls[0][0] as CanvasItem;
    expect(next.frames[0]).toMatchObject({ originalFile: file, scale: 1, rotation: 0, offset: { x: 7, y: 9 } });
  });

  it('a print area that already has a photo shows no Add photo', () => {
    setup([], { type: 'frame', index: 0 }, canvas([frame()], []), metadata);
    expect(screen.queryByText('Add photo')).toBeNull();
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
