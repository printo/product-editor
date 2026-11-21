/**
 * Characterization tests for the ops layouts page (editor/layouts/page.tsx).
 *
 * They pin what the page does today: the requests it sends, in what order and
 * with what bodies, and what ops see. The page is to be split into hooks and
 * components (docs/LAYOUTS_PAGE_SPLIT_PLAN.md) with this suite passing
 * UNCHANGED after every step. A case marked "pinned as is" pins behaviour
 * that looks wrong: it is for a later, separate fix, not for the split.
 *
 * Stubbed: the Fabric preview (happy-dom has no canvas; the stub records the
 * props it is given), the mask transparency check, auth and routing.
 * Everything else, state, effects, the multipart save, runs for real against
 * FakeLayoutsBackend.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CLASSIC, FakeLayoutsBackend, layoutsPageTree, MUG, PreviewStub, previewPropsRef, renderLayoutsPage, setPageUrl,
} from './layouts-page-harness';
import { hasTransparentPixels } from '@/lib/image-utils';
import { readImportSession } from '@/lib/import-session';

jest.setTimeout(30000);

const mockPush = jest.fn();
const mockRouter = { push: mockPush, replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));

let mockSession: { data: unknown; status: string } = { data: null, status: 'loading' };
jest.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signOut: jest.fn(),
  SessionProvider: ({ children }: { children: unknown }) => children,
}));

// The page has one dynamic import: the Fabric preview.
jest.mock('next/dynamic', () => () => function DynamicPreview(props: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PreviewStub: Stub } = require('./layouts-page-harness');
  return <Stub {...props} />;
});
jest.mock('@/components/GoogleFontLinks', () => ({
  GoogleFontLinks: () => null,
  useGoogleFonts: () => ({ fontsLoaded: new Set<string>(), loadGoogleFont: jest.fn() }),
}));
jest.mock('@/lib/image-utils', () => ({ hasTransparentPixels: jest.fn(async () => true) }));
jest.mock('@/lib/import-session', () => ({ readImportSession: jest.fn(() => null) }));

void PreviewStub;

const OPS = { accessToken: 'x', is_ops_team: true, is_staff: false, registration_status: 'ACTIVE', user: { name: 'Ops' } };
const EDITOR = { accessToken: 'x', is_ops_team: false, is_staff: false, registration_status: 'ACTIVE', user: { name: 'Editor' } };

let backend: FakeLayoutsBackend;
let randomSeq = 0;

beforeEach(() => {
  backend = new FakeLayoutsBackend();
  global.fetch = jest.fn(backend.fetch) as unknown as typeof fetch;
  mockSession = { data: OPS, status: 'authenticated' };
  mockPush.mockReset();
  previewPropsRef.current = null;
  localStorage.clear();
  setPageUrl();
  // Frame ids come from Math.random; make them repeatable.
  randomSeq = 0;
  jest.spyOn(Math, 'random').mockImplementation(() => ((randomSeq++ % 997) + 1) / 1000);
  jest.mocked(hasTransparentPixels).mockResolvedValue(true);
  jest.mocked(readImportSession).mockReturnValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  expect(backend.unexpected).toEqual([]);
});

const card = (name: string) => screen.getByTestId(`layout-card-${name}`);
const header = () => screen.getByTestId('header');
const headerTitle = () => screen.getByTestId('header-title').textContent;
const page = () => screen.getByRole('main');
const editorOpen = () => screen.queryByRole('button', { name: /^(Create|Update) Layout$/ }) !== null;

async function loadPage() {
  renderLayoutsPage();
  await waitFor(() => expect(card('classic_4x6')).toBeTruthy());
}

async function openEdit(name: string) {
  const user = userEvent.setup();
  await user.click(within(card(name)).getByTitle('Edit Layout'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Update Layout' })).toBeTruthy());
  return user;
}

/**
 * The Create/Update button sits outside the form and names it with form="layout-form".
 * happy-dom does not submit a form from such a button, so this checks the button
 * is enabled and wired to the form, then submits the form itself. A real browser
 * check covers the click (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, Risks).
 */
async function clickSave(_user: ReturnType<typeof userEvent.setup>) {
  const button = screen.getByRole('button', { name: /^(Create|Update) Layout$/ }) as HTMLButtonElement;
  expect(button.getAttribute('form')).toBe('layout-form');
  expect(button.type).toBe('submit');
  if (button.disabled) return;
  const form = button.ownerDocument.getElementById('layout-form') as HTMLFormElement;
  await act(async () => { fireEvent.submit(form); });
}

async function saveEditor(user = userEvent.setup()) {
  const before = backend.saves().length;
  await clickSave(user);
  await waitFor(() => expect(backend.saves()).toHaveLength(before + 1));
  return backend.saves()[before];
}

/** Frame ids are random and opaque; the snapshots pin everything else. */
function withoutFrameIds(layout: Record<string, any>): Record<string, any> {
  const strip = (frames?: Array<Record<string, unknown>>) => frames?.map(({ id: _id, ...rest }) => rest);
  return {
    ...layout,
    ...(layout.frames ? { frames: strip(layout.frames) } : {}),
    ...(layout.surfaces ? { surfaces: layout.surfaces.map((sf: Record<string, any>) => ({ ...sf, frames: strip(sf.frames) })) } : {}),
  };
}

const displayNameInput = () => screen.getByPlaceholderText('e.g. Classic Print 4x6') as HTMLInputElement;
const identifierInput = () => screen.getByPlaceholderText('e.g. classic_print_4x6') as HTMLInputElement;

describe('loading and access', () => {
  it('loads the list once, uncached, then the tags and fonts; cards show display names and retired layouts stay hidden', async () => {
    await loadPage();
    const list = backend.callsTo('ops/layouts', 'GET');
    expect(list).toHaveLength(1);
    expect(list[0].init.cache).toBe('no-store');
    expect(backend.callsTo('layout-tags', 'GET')).toHaveLength(1);
    expect(backend.callsTo('fonts', 'GET')).toHaveLength(1);
    expect(within(card('classic_4x6')).getByRole('heading').textContent).toBe('Classic 4x6');
    expect(within(card('old_grid')).getByRole('heading').textContent).toBe('old grid');
    expect(screen.queryByTestId('layout-card-retired_print')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: /Show deleted \(1\)/ }));
    expect(within(card('retired_print')).getByTestId('deleted-badge-retired_print')).toBeTruthy();
    expect((within(card('retired_print')).getByTitle('Already deleted') as HTMLButtonElement).disabled).toBe(true);
    expect(within(card('retired_print')).queryByTitle('Edit Layout')).toBeNull();
  });

  it('signed out: goes to /login and asks for nothing', async () => {
    mockSession = { data: null, status: 'unauthenticated' };
    renderLayoutsPage();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login'));
    expect(backend.calls).toEqual([]);
  });

  it('an expired session (RefreshAccessTokenError) goes to /login', async () => {
    mockSession = { data: { ...OPS, error: 'RefreshAccessTokenError' }, status: 'authenticated' };
    renderLayoutsPage();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login'));
  });

  it('Ops tier sees the Holidays, Tags and Templates links, in the header and on the page', async () => {
    await loadPage();
    for (const name of ['Holidays', 'Tags', 'Templates']) {
      expect(within(header()).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(page()).getByRole('link', { name: /Holidays/ }).getAttribute('href')).toBe('/editor/layouts/holidays');
  });

  it('Editor tier: no ops links, the editor still opens', async () => {
    mockSession = { data: EDITOR, status: 'authenticated' };
    await loadPage();
    for (const name of ['Holidays', 'Tags', 'Templates']) {
      expect(within(header()).queryByRole('link', { name })).toBeNull();
    }
    await openEdit('classic_4x6');
  });

  it('a session that turns Ops after the first render gets the links (the header is re-drawn)', async () => {
    mockSession = { data: EDITOR, status: 'authenticated' };
    const { rerender } = renderLayoutsPage();
    await waitFor(() => expect(card('classic_4x6')).toBeTruthy());
    expect(within(header()).queryByRole('link', { name: 'Holidays' })).toBeNull();
    mockSession = { data: OPS, status: 'authenticated' };
    rerender(layoutsPageTree());
    await waitFor(() => expect(within(header()).getByRole('link', { name: 'Holidays' })).toBeTruthy());
  });

  it('search narrows by name or tag name, the tag filter by tag key; nothing is fetched again', async () => {
    await loadPage();
    const user = userEvent.setup();
    const search = within(header()).getByRole('textbox');
    await user.type(search, 'mug');
    expect(screen.queryByTestId('layout-card-classic_4x6')).toBeNull();
    expect(card('mug_wrap')).toBeTruthy();
    await user.clear(search);
    await user.type(search, 'photo prints');
    expect(card('classic_4x6')).toBeTruthy();
    expect(screen.queryByTestId('layout-card-mug_wrap')).toBeNull();
    await user.clear(search);

    await user.click(within(page()).getByTestId('tag-filter'));
    await user.click(within(page()).getByRole('option', { name: 'Gifts' }));
    expect(card('mug_wrap')).toBeTruthy();
    expect(screen.queryByTestId('layout-card-classic_4x6')).toBeNull();
    expect(backend.callsTo('ops/layouts', 'GET')).toHaveLength(1);
  });

  it('cards route calendars and books to their own editors; a book cannot be duplicated', async () => {
    await loadPage();
    expect(within(card('wall_calendar')).getByTestId('edit-calendar-wall_calendar').getAttribute('href')).toBe('/editor/layouts/calendar/wall_calendar');
    expect(within(card('photo_book')).getByTestId('edit-book-photo_book').getAttribute('href')).toBe('/editor/layouts/book/photo_book');
    expect(within(card('classic_4x6')).getByRole('link', { name: 'Templates for classic_4x6' }).getAttribute('href')).toBe('/editor/layouts/templates/classic_4x6');
    expect(within(card('wall_calendar')).queryByRole('link', { name: /Templates for/ })).toBeNull();
    const dup = within(card('photo_book')).getByTitle("Duplicating book layouts isn't supported yet") as HTMLButtonElement;
    expect(dup.disabled).toBe(true);
    await userEvent.setup().click(dup);
    expect(backend.callsTo('ops/layouts/photo_book')).toHaveLength(0);
  });
});

const radio = (group: string, name: string) => within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });

describe('create', () => {
  it('opens on blank defaults; Create stays disabled until a display name is typed', async () => {
    await loadPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-generic-layout-btn'));
    expect(headerTitle()).toBe('Create Layout');
    expect(identifierInput().value).toBe('untitled_layout');
    expect(identifierInput().disabled).toBe(false);
    expect(displayNameInput().value).toBe('');
    expect((screen.getByRole('button', { name: 'Create Layout' }) as HTMLButtonElement).disabled).toBe(true);
    expect(previewPropsRef.current).toMatchObject({ widthMm: 101.6, heightMm: 152.4, dpi: 300, frames: [], frameMask: { url: null, file: null }, printSheet: { mode: 'canvas' }, guide: null });
    expect(radio('Print file', 'Whole canvas').getAttribute('aria-checked')).toBe('true');
  });

  it('an identifier with a space is refused before anything is sent', async () => {
    await loadPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-generic-layout-btn'));
    await user.type(displayNameInput(), 'New Print');
    await user.clear(identifierInput());
    await user.type(identifierInput(), 'new print');
    await clickSave(user);
    expect(await screen.findByText(/may contain letters, digits, hyphen, underscore only/)).toBeTruthy();
    expect(backend.saves()).toHaveLength(0);
  });

  it('grid generator then save: one multipart POST with the exact layout, then a list refetch, the editor closes and a toast', async () => {
    await loadPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-generic-layout-btn'));
    await user.type(displayNameInput(), '  Grid Print  ');
    await user.clear(identifierInput());
    await user.type(identifierInput(), 'grid_print');
    await user.click(screen.getByRole('button', { name: 'Grid Gen' }));
    await user.click(screen.getByRole('button', { name: 'Replace & Generate' }));
    expect(previewPropsRef.current?.frames).toHaveLength(4);
    const save = await saveEditor(user);
    expect(save.fields.name).toBe('grid_print');
    expect(save.fields.display_name).toBe('Grid Print');
    expect(save.files).toEqual([]);
    expect(withoutFrameIds(save.layout)).toMatchSnapshot();
    await waitFor(() => expect(backend.callsTo('ops/layouts', 'GET')).toHaveLength(2));
    expect(editorOpen()).toBe(false);
    // The toast echoes the name as typed, spaces and all.
    expect(await screen.findByText('Layout "  Grid Print  " saved successfully!', { normalizer: (t) => t })).toBeTruthy();
  });

  it('a print area outside the canvas asks first: Cancel sends nothing, OK sends the save', async () => {
    await loadPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-generic-layout-btn'));
    await user.type(displayNameInput(), 'Wide');
    await user.clear(identifierInput());
    await user.type(identifierInput(), 'wide');
    await user.click(screen.getByRole('button', { name: /Add Area/ }));
    const [area] = previewPropsRef.current!.frames;
    act(() => previewPropsRef.current!.onFramesChange([{ ...area, xMm: 90 }]));
    const confirm = jest.fn().mockReturnValueOnce(false);
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true });
    await clickSave(user);
    expect(confirm).toHaveBeenCalledWith('Some Print Areas are out of the canvas bounds. Save anyway?');
    expect(backend.saves()).toHaveLength(0);
    confirm.mockReturnValueOnce(true);
    const save = await saveEditor(user);
    expect(save.layout.frames[0].xMm).toBe(90);
  });

  it('a refused save shows the server message and keeps the editor open', async () => {
    backend.saveResponse = { status: 403, body: { detail: 'Ops tier required.' } };
    await loadPage();
    const user = await openEdit('classic_4x6');
    await saveEditor(user);
    expect(await screen.findByText('Ops tier required.')).toBeTruthy();
    expect(editorOpen()).toBe(true);
    expect((screen.getByRole('button', { name: 'Update Layout' }) as HTMLButtonElement).disabled).toBe(false);
    expect(backend.callsTo('ops/layouts', 'GET')).toHaveLength(1);
  });

  it('Create after editing a layout starts from a blank form: new identifier, default size, Can rotate on', async () => {
    await loadPage();
    const user = await openEdit('mug_wrap');
    await user.click(within(header()).getByRole('button', { name: 'Close Editor' }));
    await user.click(screen.getByTestId('create-generic-layout-btn'));
    expect(identifierInput().value).toBe('untitled_layout');
    expect(identifierInput().disabled).toBe(false);
    expect(displayNameInput().value).toBe('');
    expect((screen.getByRole('checkbox', { name: 'Can rotate' }) as HTMLInputElement).checked).toBe(true);
    expect(previewPropsRef.current).toMatchObject({
      frames: [], widthMm: 101.6, heightMm: 152.4, dpi: 300,
      frameMask: { url: null, file: null }, printSheet: { mode: 'canvas' },
    });
  });

  it('saving a layout created right after an edit never sends the edited layout\'s identifier', async () => {
    await loadPage();
    const user = await openEdit('old_grid');
    await user.click(within(header()).getByRole('button', { name: 'Close Editor' }));
    await user.click(screen.getByTestId('create-generic-layout-btn'));
    await user.type(displayNameInput(), 'Brand New');
    const save = await saveEditor(user);
    expect(save.fields.name).toBe('untitled_layout');
    expect(save.layout.name).toBe('untitled_layout');
  });
});

describe('edit', () => {
  it('fills the form from the layout and saves it back under the same identifier', async () => {
    await loadPage();
    const user = await openEdit('classic_4x6');
    expect(backend.callsTo('ops/layouts/classic_4x6', 'GET')).toHaveLength(1);
    expect(headerTitle()).toBe('Edit Layout');
    expect(displayNameInput().value).toBe('Classic 4x6');
    expect(identifierInput().value).toBe('classic_4x6');
    expect(identifierInput().disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Can rotate' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('classic_4x6_mask_abc1234567.png')).toBeTruthy();
    expect(previewPropsRef.current).toMatchObject({
      widthMm: 101.6, heightMm: 152.4, dpi: 300,
      frameMask: { url: CLASSIC.frameMaskUrl, file: null }, printSheet: { mode: 'canvas' },
    });
    expect(previewPropsRef.current?.frames.map((f: { xMm: number; bleedMm: number }) => [f.xMm, f.bleedMm])).toEqual([[8, 3], [8, 3]]);
    const save = await saveEditor(user);
    expect(save.fields).toMatchObject({ name: 'classic_4x6', display_name: 'Classic 4x6' });
    expect(withoutFrameIds(save.layout)).toMatchSnapshot();
  });

  it('a layout with no display name is shown with its identifier tidied', async () => {
    await loadPage();
    await openEdit('old_grid');
    expect(displayNameInput().value).toBe('Old Grid');
  });

  it('an old grid-only layout gets its print areas from the grid', async () => {
    await loadPage();
    await openEdit('old_grid');
    expect(previewPropsRef.current?.frames.map((f: Record<string, number>) => [f.xMm, f.yMm, f.widthMm, f.heightMm])).toEqual([
      [2.03, 2.03, 97.54, 73.16],
      [2.03, 77.22, 97.54, 73.16],
    ]);
  });

  it('a two-sided product: one tab per side, the preview follows the tab, the save sends both sides', async () => {
    await loadPage();
    const user = await openEdit('mug_wrap');
    expect(previewPropsRef.current).toMatchObject({ widthMm: 203.2, heightMm: 101.6, printSheet: { mode: 'canvas' }, frameMask: { url: null } });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(previewPropsRef.current).toMatchObject({
      widthMm: 101.6, heightMm: 101.6, printSheet: { mode: 'bleed' },
      frameMask: { url: MUG.surfaces[1].frameMaskUrl },
    });
    expect(radio('Print file', 'Bleed area').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('checkbox', { name: 'Can rotate' }) as HTMLInputElement).checked).toBe(false);
    const save = await saveEditor(user);
    expect(save.files).toEqual([]);
    expect(withoutFrameIds(save.layout)).toMatchSnapshot();
  });

  it('a side added and renamed is saved with a key made from its label, and its new frame picture under frame_mask_<key>', async () => {
    await loadPage();
    const user = await openEdit('mug_wrap');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const label = screen.getByPlaceholderText('e.g. Front');
    await user.clear(label);
    await user.type(label, 'Inside Lid');
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept^="image/png"]')!;
    await user.upload(input, new File(['png'], 'lid.png', { type: 'image/png' }));
    const save = await saveEditor(user);
    expect(save.layout.surfaces.map((s: { key: string; label: string }) => [s.key, s.label])).toEqual([
      ['front', 'Front'], ['back', 'Back'], ['inside-lid', 'Inside Lid'],
    ]);
    expect(save.files).toEqual([{ field: 'frame_mask_inside-lid', name: 'lid.png', type: 'image/png' }]);
  });
});

describe('duplicate, delete, view', () => {
  it('Duplicate opens a new layout seeded from the original, with a fresh identifier', async () => {
    await loadPage();
    const user = userEvent.setup();
    await user.click(within(card('classic_4x6')).getByTitle('Duplicate Layout'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Layout' })).toBeTruthy());
    expect(identifierInput().value).toBe('untitled_layout');
    expect(displayNameInput().value).toBe('copy Classic 4x6');
    await user.clear(identifierInput());
    await user.type(identifierInput(), 'classic_copy');
    const save = await saveEditor(user);
    expect(save.fields).toMatchObject({ name: 'classic_copy', display_name: 'copy Classic 4x6' });
    expect(save.layout).toMatchObject({
      name: 'classic_copy', tagKeys: ['photo_prints', 'old_tag'], frameMaskUrl: CLASSIC.frameMaskUrl,
      printSheet: { mode: 'canvas' }, orientationRotatable: true,
    });
    expect(save.layout.frames).toHaveLength(2);
  });

  it('Delete asks first: Cancel sends nothing; Delete sends DELETE then reloads the list', async () => {
    await loadPage();
    const user = userEvent.setup();
    await user.click(within(card('classic_4x6')).getByTitle('Delete Layout'));
    expect(screen.getByText('Delete Layout?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(backend.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    await user.click(within(card('classic_4x6')).getByTitle('Delete Layout'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(backend.callsTo('ops/layouts', 'GET')).toHaveLength(2));
    expect(backend.callsTo('ops/layouts/classic_4x6', 'DELETE')).toHaveLength(1);
    expect(await screen.findByText('Layout classic_4x6 deleted.')).toBeTruthy();
  });

  it('a refused delete shows the server message, or a plain one when the answer is not JSON', async () => {
    await loadPage();
    const user = userEvent.setup();
    backend.deleteResponse = { status: 409, body: { detail: 'Layout is in use.' } };
    await user.click(within(card('classic_4x6')).getByTitle('Delete Layout'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Layout is in use.')).toBeTruthy();
    backend.deleteResponse = { status: 500, body: 'Bad Gateway' };
    await user.click(within(card('mug_wrap')).getByTitle('Delete Layout'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Failed to delete layout')).toBeTruthy();
    expect(backend.callsTo('ops/layouts', 'GET')).toHaveLength(1);
  });

  it('View Raw JSON fetches the layout and shows it; Copy puts it on the clipboard', async () => {
    const writeText = jest.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await loadPage();
    const user = userEvent.setup();
    await user.click(within(card('classic_4x6')).getByRole('button', { name: 'View Raw JSON' }));
    expect(await screen.findByText('JSON Specification')).toBeTruthy();
    expect(backend.callsTo('ops/layouts/classic_4x6', 'GET')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Copy JSON to clipboard' }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(CLASSIC, null, 2));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });
});

describe('masks, print file, Can rotate, tags', () => {
  it('a picked frame picture is sent as frame_mask; one with no see-through part draws a warning', async () => {
    jest.mocked(hasTransparentPixels).mockResolvedValue(false);
    await loadPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-generic-layout-btn'));
    await user.type(displayNameInput(), 'Framed');
    await user.clear(identifierInput());
    await user.type(identifierInput(), 'framed');
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept^="image/png"]')!;
    await user.upload(input, new File(['png'], 'wood.png', { type: 'image/png' }));
    expect(await screen.findByText(/This mask has no transparent pixels/)).toBeTruthy();
    expect(screen.getByText('Not saved yet — saves with the layout')).toBeTruthy();
    expect(previewPropsRef.current?.frameMask.file.name).toBe('wood.png');
    const save = await saveEditor(user);
    expect(save.files).toEqual([{ field: 'frame_mask', name: 'wood.png', type: 'image/png' }]);
    expect(save.layout.frameMaskUrl).toBeNull();
  });

  it('removing the frame picture asks first; once removed the save sends none', async () => {
    await loadPage();
    const user = await openEdit('classic_4x6');
    await user.click(screen.getByRole('button', { name: 'Remove frame picture' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove frame picture' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(previewPropsRef.current?.frameMask.url).toBe(CLASSIC.frameMaskUrl);
    await user.click(screen.getByRole('button', { name: 'Remove frame picture' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(previewPropsRef.current?.frameMask).toEqual({ url: null, file: null });
    const save = await saveEditor(user);
    expect(save.layout.frameMaskUrl).toBeNull();
    expect(save.files).toEqual([]);
  });

  it('Print file: Bleed area reaches the preview at once and the save', async () => {
    await loadPage();
    const user = await openEdit('classic_4x6');
    await user.click(radio('Print file', 'Bleed area'));
    expect(previewPropsRef.current?.printSheet).toEqual({ mode: 'bleed' });
    const save = await saveEditor(user);
    expect(save.layout.printSheet).toEqual({ mode: 'bleed' });
  });

  it('Print file on a product is per side', async () => {
    await loadPage();
    const user = await openEdit('mug_wrap');
    await user.click(radio('Print file', 'Bleed area'));
    const save = await saveEditor(user);
    expect(save.layout.surfaces.map((s: { printSheet: unknown }) => s.printSheet)).toEqual([{ mode: 'bleed' }, { mode: 'bleed' }]);
    expect(save.layout.printSheet).toBeUndefined();
  });

  it('Can rotate off is saved as orientationRotatable: false', async () => {
    await loadPage();
    const user = await openEdit('classic_4x6');
    await user.click(screen.getByRole('checkbox', { name: 'Can rotate' }));
    const save = await saveEditor(user);
    expect(save.layout.orientationRotatable).toBe(false);
  });

  it('tags: a switched-off tag already on the layout stays; added and removed tags are sent as keys, in order', async () => {
    await loadPage();
    const user = await openEdit('classic_4x6');
    await user.click(screen.getByRole('button', { name: 'Add another tag…' }));
    expect(screen.queryByRole('option', { name: 'Old Tag' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Gifts' }));
    await user.click(screen.getByRole('button', { name: 'Remove tag Photo Prints' }));
    const save = await saveEditor(user);
    expect(save.layout.tagKeys).toEqual(['old_tag', 'gifts']);
  });
});

describe('the address: ?edit= and the design import', () => {
  it('?edit=<name> opens that layout once signed in, then clears the address', async () => {
    setPageUrl('?edit=classic_4x6');
    renderLayoutsPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Layout' })).toBeTruthy());
    expect(identifierInput().value).toBe('classic_4x6');
    expect(window.location.pathname + window.location.search).toBe('/editor/layouts');
    expect(readImportSession).not.toHaveBeenCalled();
    expect(previewPropsRef.current?.guide).toBeNull();
    expect(backend.callsTo('ops/layouts/classic_4x6', 'GET')).toHaveLength(1);
  });

  it('?edit= waits for the session, and a name with a space is ignored', async () => {
    mockSession = { data: null, status: 'loading' };
    setPageUrl('?edit=bad%20name');
    const { rerender } = renderLayoutsPage();
    expect(window.location.search).toBe('?edit=bad%20name');
    mockSession = { data: OPS, status: 'authenticated' };
    rerender(layoutsPageTree());
    await waitFor(() => expect(card('classic_4x6')).toBeTruthy());
    expect(editorOpen()).toBe(false);
    expect(backend.calls.filter((c) => c.path.startsWith('ops/layouts/'))).toHaveLength(0);
  });

  it('?edit=<name>&import=1 shows the design behind the print areas, and Update Layout goes back to the import', async () => {
    jest.mocked(readImportSession).mockReturnValue({
      layout: 'classic_4x6', raw: '{}', templateName: 'Imported', guideSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>', guideMm: { width: 100, height: 150 },
    });
    const createObjectURL = jest.fn(() => 'blob:guide');
    const revokeObjectURL = jest.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    setPageUrl('?edit=classic_4x6&import=1');
    const { unmount } = renderLayoutsPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Layout' })).toBeTruthy());
    expect(readImportSession).toHaveBeenCalledWith('classic_4x6');
    expect(previewPropsRef.current?.guide).toEqual({ url: 'blob:guide', widthMm: 100, heightMm: 150 });
    await saveEditor();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/editor/layouts/templates?import=continue'));
    expect(backend.callsTo('ops/layouts', 'GET')).toHaveLength(1);
    expect(editorOpen()).toBe(true);
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:guide');
  });

  it('?import=1 with no import stored for that layout is a plain ?edit=', async () => {
    setPageUrl('?edit=classic_4x6&import=1');
    renderLayoutsPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Layout' })).toBeTruthy());
    expect(previewPropsRef.current?.guide).toBeNull();
    await saveEditor();
    await waitFor(() => expect(backend.callsTo('ops/layouts', 'GET')).toHaveLength(2));
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('the full-screen editor and the page behind it', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'scrollY', { value: 640, configurable: true, writable: true });
  });

  it('closing the editor (Close Editor, Cancel, or a save) puts the page back where it was scrolled', async () => {
    const scrollTo = jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    await loadPage();
    expect(scrollTo).not.toHaveBeenCalled();
    let user = await openEdit('classic_4x6');
    await user.click(within(header()).getByRole('button', { name: 'Close Editor' }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
    user = await openEdit('classic_4x6');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(scrollTo).toHaveBeenCalledTimes(2);
    user = await openEdit('classic_4x6');
    await saveEditor(user);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(3));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
  });

  it('while open the header shows Close Editor and no search; closing brings the search back as it was', async () => {
    await loadPage();
    const user = userEvent.setup();
    await user.type(within(header()).getByRole('textbox'), 'classic');
    await openEdit('classic_4x6');
    expect(within(header()).queryByRole('textbox')).toBeNull();
    expect(within(header()).getByRole('button', { name: 'Close Editor' })).toBeTruthy();
    await user.click(within(header()).getByRole('button', { name: 'Close Editor' }));
    expect((within(header()).getByRole('textbox') as HTMLInputElement).value).toBe('classic');
    expect(headerTitle()).toBe('');
  });
});

describe('fonts, units and the preview', () => {
  it('ticking a font saves the whole list once and the header count follows', async () => {
    await loadPage();
    const user = userEvent.setup();
    await waitFor(() => expect(within(header()).getByTitle('Fonts (2)')).toBeTruthy());
    await user.click(within(header()).getByRole('button', { name: 'Fonts' }));
    await user.click(screen.getByRole('checkbox', { name: /^Roboto/ }));
    await waitFor(() => expect(backend.callsTo('fonts', 'PUT')).toHaveLength(1));
    expect(backend.callsTo('fonts', 'PUT')[0].body).toEqual({ fonts: ['Inter', 'Lato', 'Roboto'] });
    expect(within(header()).getByTitle('Fonts (3)')).toBeTruthy();
  });

  it('inches: sizes typed in inches are saved in millimetres, and the choice is remembered', async () => {
    await loadPage();
    const user = await openEdit('classic_4x6');
    await user.click(radio('Measurement unit', 'in'));
    expect(localStorage.getItem('pe:layout-editor:unit')).toBe('in');
    const width = screen.getByDisplayValue('4');
    fireEvent.change(width, { target: { value: '5' } });
    expect(previewPropsRef.current?.widthMm).toBe(127);
    const save = await saveEditor(user);
    expect(save.layout.canvas).toEqual({ width: 1500, height: 1800, widthMm: 127, heightMm: 152.4, dpi: 300 });
  });

  it('starts in inches when remembered, and in millimetres when storage is blocked', async () => {
    localStorage.setItem('pe:layout-editor:unit', 'in');
    const first = renderLayoutsPage();
    await waitFor(() => expect(card('classic_4x6')).toBeTruthy());
    await openEdit('classic_4x6');
    expect(radio('Measurement unit', 'in').getAttribute('aria-checked')).toBe('true');
    first.unmount();
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    try {
      await loadPage();
      await openEdit('classic_4x6');
      expect(radio('Measurement unit', 'mm').getAttribute('aria-checked')).toBe('true');
    } finally {
      if (real) Object.defineProperty(window, 'localStorage', real);
    }
  });

  it('the preview drives the form: a moved print area is saved, a selected one is handed back', async () => {
    await loadPage();
    const user = await openEdit('classic_4x6');
    const [a, b] = previewPropsRef.current!.frames;
    act(() => previewPropsRef.current!.onFramesChange([{ ...a, xMm: 5, yMm: 12.5 }, b]));
    act(() => previewPropsRef.current!.onFrameSelect(a.id));
    expect(previewPropsRef.current?.selectedFrameId).toBe(a.id);
    const save = await saveEditor(user);
    expect(save.layout.frames[0]).toMatchObject({ xMm: 5, yMm: 12.5, bleedMm: 3 });
  });
});
