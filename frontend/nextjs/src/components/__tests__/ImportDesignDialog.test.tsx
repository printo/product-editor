/**
 * The Templates page's Import dialog: what it asks the server for, what it
 * shows before anything is created, what Confirm sends, and how it finishes
 * once the layout editor has saved the layout. The server is a
 * stand-in; the reading itself is covered in lib/__tests__/online-canvas-import.test.ts.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDesignDialog } from '@/components/ImportDesignDialog';
import { ARTWORK_LABEL, clearImportDraft, readImportDraft } from '@/app/editor/layout/[name]/template-authoring';
import { clearImportSession, readImportSession, writeImportSession } from '@/lib/import-session';

const mockRouter = { push: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/lib/icon-raster', () => ({
  rasterizeSvgUrl: jest.fn(async (_url: string, _w: number, _h: number, name: string) => new File(['png'], name, { type: 'image/png' })),
}));

type Obj = Record<string, unknown>;
const MARGIN = 12.7;
const at = (x: number, y: number) => ({ left: x + MARGIN, top: y + MARGIN });
const HEART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0h100v50z"/></svg>';
const FRAME = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 468 612"><rect width="54" height="612"/></svg>';

const WINDOW: Obj = { type: 'mask', element: 'rectangle', width: 50, height: 40, scaleX: 1, scaleY: 1, angle: 0, ...at(10, 20) };
const BLOCK: Obj = {
  type: 'image', objType: 'vectorImage', fill: '#FFFFFF', width: 56, height: 46, scaleX: 1, scaleY: 1, angle: 0, opacity: 1, ...at(7, 17),
  src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect data-custom-shape="rect" width="10" height="10" fill="#FFFFFF"/></svg>',
};
const HEART_ART: Obj = { type: 'image', objType: 'vectorImage', src: 'https://files.example/site/20200730_113904593323_4a09c4_Asset_9.svg', width: 30, height: 15, scaleX: 1, scaleY: 1, angle: 0, opacity: 1, locked: true, ...at(100, 150) };
const DATE: Obj = { type: 'textbox', text: 'November 17, Saturday', fontFamily: 'Marck Script', fontSize: 8, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'left', fill: '#302a18', width: 100, height: 10, scaleX: 1, scaleY: 1, angle: 0, ...at(15, 2) };

function exportOf(objects: Obj[]): string {
  return JSON.stringify([
    { design_mode: 'online_canvas', customized_locations_map: { '40': { customization_data: JSON.stringify({ clockwise_rotation_degree: 0, widthPixels: 177.8, heightPixels: 228.6, objects, printableAreaFill: '#f599a6' }), design_canvas_id: 565 } } },
    { '565': { measuring_unit: 'inch', canvas_width: 7, canvas_height: 9, name: 'Photo Frame | 6 x 8 in', overlay_image_url: 'https://files.example/site/frame.svg', objects: [{ behavior_type: 'printable_area', shape: 'rectangle', width: 6, height: 8, left_margin: 0.5, top_margin: 0.5 }] } },
  ]);
}

interface Call { method: string; path: string; json?: Obj; form?: FormData }
let calls: Call[];
let server: { font: { listed: boolean; available: boolean }; layoutStatus: number; failSticker: number; fetchOff: boolean; saved: Obj };

/** The layout as the layout editor saved it: the print area moved 2 mm right and down, and made smaller. */
const SAVED: Obj = {
  name: 'photo_frame_6x8_1_photo', canvas: { width: 1800, height: 2400, widthMm: 152.4, heightMm: 203.2, dpi: 300 },
  frames: [{ x: 12 / 152.4, y: 22 / 203.2, width: 46 / 152.4, height: 36 / 203.2 }],
};

const answer = (status: number, body: unknown, bytes?: Uint8Array) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  arrayBuffer: async () => (bytes ?? new Uint8Array()).buffer,
});

beforeEach(() => {
  calls = [];
  server = { font: { listed: false, available: true }, layoutStatus: 200, failSticker: 0, fetchOff: false, saved: SAVED };
  mockRouter.push.mockClear();
  URL.createObjectURL = jest.fn(() => 'blob:preview');
  URL.revokeObjectURL = jest.fn();
  let stickers = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('/api/internal/proxy', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { method, path };
    if (typeof init?.body === 'string') call.json = JSON.parse(init.body);
    else if (init?.body) call.form = init.body as FormData;
    calls.push(call);
    if (path === '/ops/import/artwork') {
      if (server.fetchOff) return answer(403, { detail: 'Fetching artwork is off for this API key. An administrator can switch it on.' });
      const url = String(call.json?.url);
      if (url.endsWith('Asset_9.svg')) return answer(200, null, new TextEncoder().encode(HEART));
      if (url.endsWith('frame.svg')) return answer(200, null, new TextEncoder().encode(FRAME));
      return answer(502, { detail: "'files.example' answered 404 for this artwork." });
    }
    if (path === '/ops/import/font') return answer(200, { family: call.json?.family, ...server.font });
    if (path === '/fonts') return answer(200, { fonts: method === 'PUT' ? call.json?.fonts : ['Inter', 'Lobster'] });
    if (path.startsWith('/ops/layouts/') && method === 'GET') return answer(200, server.saved);
    if (path.startsWith('/ops/layouts/')) {
      return server.layoutStatus === 200 ? answer(200, { status: 'success' }) : answer(server.layoutStatus, { detail: "A layout named 'x' already exists. Choose another name." });
    }
    if (path === '/ops/templates/assets') {
      stickers += 1;
      if (stickers === server.failSticker) return answer(502, { detail: 'Could not store the sticker' });
      return answer(201, { url: `/api/templates/assets/sticker_${stickers}.svg` });
    }
    return answer(404, { detail: 'not stubbed' });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  clearImportSession();
  clearImportDraft('photo_frame_6x8_1_photo');
  clearImportDraft('photo_frame_6x8_1_photo_2');
});

function open(taken: string[] = [], templateIds: string[] = []) {
  const onClose = jest.fn();
  render(<ImportDesignDialog takenNames={taken} takenTemplateIds={templateIds} onClose={onClose} />);
  return { onClose };
}

/** The dialog as the Templates page opens it once the layout editor has saved the layout. */
function resume(raw: string) {
  writeImportSession({ layout: 'photo_frame_6x8_1_photo', raw, templateName: 'Love you', guideSvg: null, guideMm: { width: 152.4, height: 203.2 } });
  render(<ImportDesignDialog takenNames={['photo_frame_6x8_1_photo']} takenTemplateIds={[]} resume onClose={jest.fn()} />);
}

async function read(text: string) {
  fireEvent.change(screen.getByLabelText('Design JSON'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Read the design' }));
}

const sent = (method: string, path: string) => calls.filter(c => c.method === method && c.path === path);

it('says plainly when the text is not an export, and asks the server for nothing', async () => {
  open();
  await read('hello');
  expect(await screen.findByRole('alert')).toHaveTextContent('This is not valid JSON');
  expect(calls).toHaveLength(0);
});

it('shows what the design becomes before anything is created', async () => {
  open(['photo_frame_6x8_1_photo']);
  await read(exportOf([BLOCK, WINDOW, HEART_ART, DATE]));
  const confirm = await screen.findByRole('button', { name: 'Create the layout and adjust it' });
  // The artwork and the old frame are fetched through the server, each once; the font is checked.
  expect(sent('POST', '/ops/import/artwork').map(c => c.json?.url)).toEqual([
    'https://files.example/site/20200730_113904593323_4a09c4_Asset_9.svg', 'https://files.example/site/frame.svg',
  ]);
  expect(sent('POST', '/ops/import/font').map(c => c.json?.family)).toEqual(['Marck Script']);
  // Names that are free: the suggested layout id is taken, so both names move on together.
  expect(screen.getByLabelText(/Layout id/)).toHaveValue('photo_frame_6x8_1_photo_2');
  expect(screen.getByLabelText('Layout name')).toHaveValue('Photo Frame 6 x 8 in, 1 photo (2)');
  expect(screen.getByLabelText('Template name')).toHaveValue('Photo Frame 6 x 8 in, 1 photo (2)');
  expect(screen.getByText(/2 pictures become the page artwork/)).toBeInTheDocument();
  expect(screen.getByText(/in Marck Script/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Add the font “Marck Script” to the font list/)).toBeChecked();
  expect(screen.getByLabelText(/Use the old tool’s frame/)).toBeChecked();
  expect(confirm).toBeEnabled();
  // Nothing has been written yet.
  expect(calls.some(c => c.path.startsWith('/ops/layouts') || c.path === '/ops/templates/assets' || c.method === 'PUT')).toBe(false);
});

it('on confirm adds the font, creates the layout without ever replacing one and opens it in the layout editor', async () => {
  open();
  const raw = exportOf([BLOCK, WINDOW, HEART_ART, DATE]);
  await read(raw);
  fireEvent.click(await screen.findByRole('button', { name: 'Create the layout and adjust it' }));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/editor/layouts?edit=photo_frame_6x8_1_photo&import=1'));

  expect(sent('PUT', '/fonts')[0].json).toEqual({ fonts: ['Inter', 'Lobster', 'Marck Script'] });

  const layout = sent('POST', '/ops/layouts/photo_frame_6x8_1_photo')[0].form as FormData;
  expect(layout.get('create_only')).toBe('1');
  expect(layout.get('display_name')).toBe('Photo Frame 6 x 8 in, 1 photo');
  const definition = JSON.parse(String(layout.get('layout_data')));
  expect(definition.canvas).toEqual({ width: 1800, height: 2400, widthMm: 152.4, heightMm: 203.2, dpi: 300 });
  expect(definition.frames).toHaveLength(1);
  expect(definition.frames[0]).toMatchObject({ xMm: 10, yMm: 20, widthMm: 50, heightMm: 40, bleedMm: 0 });
  expect((layout.get('frame_mask') as File).name).toBe('frame.png');

  // No artwork is stored yet: it is cut only once the print areas are settled.
  expect(sent('POST', '/ops/templates/assets')).toHaveLength(0);
  expect(readImportDraft('photo_frame_6x8_1_photo')).toBeNull();
  // What the layout editor is handed: the export, and every picture whole to place the print areas against.
  const session = readImportSession('photo_frame_6x8_1_photo');
  expect(session).toMatchObject({ raw, templateName: 'Photo Frame 6 x 8 in, 1 photo', guideMm: { width: 152.4, height: 203.2 } });
  expect(session?.guideSvg).toContain('data-custom-shape="rect"');
  expect(session?.guideSvg).toContain('<path d="M0 0h100v50z"/>');
  expect(session?.guideSvg).not.toContain('clipPath');
});

it('once the layout is saved, cuts one artwork to its print areas and opens the template editor on the draft', async () => {
  resume(exportOf([BLOCK, WINDOW, HEART_ART, DATE]));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/editor/layouts/templates/photo_frame_6x8_1_photo/new?import=1'));

  expect(sent('GET', '/ops/layouts/photo_frame_6x8_1_photo')).toHaveLength(1);
  expect(sent('POST', '/ops/layouts/photo_frame_6x8_1_photo')).toHaveLength(0);
  const stored = sent('POST', '/ops/templates/assets').map(c => (c.form as FormData).get('file') as File);
  expect(stored.map(f => [f.name, f.type])).toEqual([['artwork.svg', 'image/svg+xml']]);
  // One sheet: the white block with its hole where the print area now is, and the heart over the photo with none.
  const sheet = await stored[0].text();
  expect(sheet).toContain('<clipPath id="pe-holes-0">');
  expect(sheet).toContain(`M${Math.round(((12 + 0.3) / 25.4) * 300 * 1000) / 1000} `);
  expect(sheet).toContain('<path d="M0 0h100v50z"/>');
  expect((sheet.match(/<clipPath /g) ?? []).length).toBe(1);

  const draft = readImportDraft('photo_frame_6x8_1_photo');
  expect(draft?.displayName).toBe('Love you');
  const side = draft?.decoration.surfaces.default;
  expect(side?.paperColor).toBe('#f599a6');
  expect(side?.overlays.map(o => o.type)).toEqual(['image', 'text']);
  expect(side?.overlays[0]).toMatchObject({ label: ARTWORK_LABEL, src: '/api/templates/assets/sticker_1.svg', x: 0, y: 0, width: 100, height: 100 });
  expect(side?.overlays[1]).toMatchObject({ text: 'November 17, Saturday', fontFamily: 'Marck Script', textAlign: 'left' });
  expect(readImportSession()).toBeNull();
});

it('says so when there is no import to carry on', async () => {
  render(<ImportDesignDialog takenNames={[]} takenTemplateIds={[]} resume onClose={jest.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('There is no import under way in this tab');
  expect(calls).toHaveLength(0);
});

it('will not cut artwork to a layout left with no print area', async () => {
  server.saved = { ...SAVED, frames: [] };
  resume(exportOf([BLOCK, WINDOW]));
  expect(await screen.findByRole('alert')).toHaveTextContent('The layout has no print area');
  expect(sent('POST', '/ops/templates/assets')).toHaveLength(0);
});

it('suggests a template name whose id no template has, even when the layout id is free', async () => {
  open([], ['photo-frame-6-x-8-in-1-photo', 'photo-frame-6-x-8-in-1-photo-2']);
  await read(exportOf([WINDOW, DATE]));
  await screen.findByRole('button', { name: 'Create the layout and adjust it' });
  expect(screen.getByLabelText(/Layout id/)).toHaveValue('photo_frame_6x8_1_photo_3');
  expect(screen.getByLabelText('Template name')).toHaveValue('Photo Frame 6 x 8 in, 1 photo (3)');
});

it('leaves the font list alone when the box is unticked, and the frame out when that one is', async () => {
  open();
  await read(exportOf([WINDOW, DATE]));
  await screen.findByRole('button', { name: 'Create the layout and adjust it' });
  fireEvent.click(screen.getByLabelText(/Add the font “Marck Script”/));
  fireEvent.click(screen.getByLabelText(/Use the old tool’s frame/));
  fireEvent.click(screen.getByRole('button', { name: 'Create the layout and adjust it' }));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalled());
  expect(sent('PUT', '/fonts')).toHaveLength(0);
  expect((sent('POST', '/ops/layouts/photo_frame_6x8_1_photo')[0].form as FormData).get('frame_mask')).toBeNull();
});

it('warns instead of offering a font Google does not have', async () => {
  server.font = { listed: false, available: false };
  open();
  await read(exportOf([WINDOW, DATE]));
  await screen.findByRole('button', { name: 'Create the layout and adjust it' });
  expect(screen.queryByLabelText(/Add the font/)).toBeNull();
  expect(screen.getByText(/Google Fonts does not have it, so its text prints in Inter/)).toBeInTheDocument();
});

it('says which artwork could not be fetched and leaves it out', async () => {
  open();
  await read(exportOf([WINDOW, { ...HEART_ART, src: 'https://files.example/site/gone.png', objType: 'rasterImage' }]));
  await screen.findByRole('button', { name: 'Create the layout and adjust it' });
  expect(screen.getByText(/gone\.png could not be fetched \('files\.example' answered 404 for this artwork\.\) and is left out of the page artwork\./)).toBeInTheDocument();
});

it('says once that fetching is switched off, before any review, when the server refuses every file', async () => {
  server.fetchOff = true;
  open();
  await read(exportOf([BLOCK, WINDOW, HEART_ART]));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fetching artwork is off for this API key. An administrator can switch it on.');
  expect(screen.getByRole('button', { name: 'Read the design' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Create the layout and adjust it' })).toBeNull();
});

it('will not confirm a design it cannot place', async () => {
  open();
  await read(exportOf([{ ...WINDOW, element: 'circle' }]));
  expect(await screen.findByText('This design cannot be imported')).toBeInTheDocument();
  expect(screen.getByText(/circle-shaped/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create the layout and adjust it' })).toBeDisabled();
});

it('stays on the review when the name turns out to be taken, with nothing stored', async () => {
  server.layoutStatus = 409;
  open();
  await read(exportOf([BLOCK, WINDOW]));
  fireEvent.click(await screen.findByRole('button', { name: 'Create the layout and adjust it' }));
  expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  expect(sent('POST', '/ops/templates/assets')).toHaveLength(0);
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(screen.getByLabelText(/Layout id/)).toBeEnabled();
});

it('keeps the import to try again when storing the artwork fails', async () => {
  server.failSticker = 1;
  resume(exportOf([BLOCK, WINDOW]));
  expect(await screen.findByText('Could not store the sticker')).toBeInTheDocument();
  expect(mockRouter.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/editor/layouts/templates/photo_frame_6x8_1_photo/new?import=1'));
});

it('makes only the layout when the design is nothing but windows on white', async () => {
  const plain = JSON.parse(exportOf([WINDOW]));
  const design = JSON.parse(plain[0].customized_locations_map['40'].customization_data);
  delete design.printableAreaFill;
  plain[0].customized_locations_map['40'].customization_data = JSON.stringify(design);
  resume(JSON.stringify(plain));
  expect(await screen.findByText(/is created with 1 print area/)).toBeInTheDocument();
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(readImportDraft('photo_frame_6x8_1_photo')).toBeNull();
});
