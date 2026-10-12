/**
 * The ops holiday screen: load a locale/year, edit locally, Save PUTs the
 * whole year, 404 is an empty year, field validation, Clear year, and the
 * read-only view for the Editor tier.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Page from '@/app/editor/layouts/holidays/page';
import { HeaderProvider } from '@/context/HeaderContext';

let mockSession: { data: Record<string, unknown> | null } = { data: null };
let mockSearch = new URLSearchParams('year=2026');

jest.mock('next-auth/react', () => ({ useSession: () => mockSession }));
jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

type Reply = { status?: number; body?: unknown };
type Call = { url: string; method: string; body?: unknown };

function stubFetch(replies: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(replies).find((k) => `${method} ${url}`.includes(k));
    if (!key) throw new Error(`Unexpected fetch in test: ${method} ${url}`);
    const entry = replies[key];
    const r = Array.isArray(entry) ? entry.shift() ?? {} : entry;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
    } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof global.fetch;
  return calls;
}

const READ = 'GET /api/internal/proxy/holidays/en-IN/2026';
const WRITE = '/api/internal/proxy/ops/holidays/en-IN/2026';

const FILE_2026 = {
  year: 2026,
  locale: 'en-IN',
  _meta: { source: 'seed' },
  events: [
    { date: '2026-08-15', name: 'Independence Day', type: 'national', color: '#DC2626' },
    { date: '2026-01-26', name: 'Republic Day', type: 'national', color: '#DC2626' },
  ],
};

const OPS = { data: { is_ops_team: true } };
const EDITOR = { data: { is_ops_team: false, is_staff: false } };

function renderPage() {
  return render(
    <HeaderProvider>
      <Page />
    </HeaderProvider>,
  );
}

async function fillAddForm(user: ReturnType<typeof userEvent.setup>, date: string, name: string) {
  const form = await screen.findByTestId('holiday-form');
  const dateInput = within(form).getByLabelText('Date');
  await user.clear(dateInput);
  if (date) await user.type(dateInput, date);
  const nameInput = within(form).getByLabelText('Name');
  await user.clear(nameInput);
  if (name) await user.type(nameInput, name);
  return form;
}

beforeEach(() => {
  mockSession = OPS;
  mockSearch = new URLSearchParams('year=2026');
});

describe('holidays page', () => {
  it('loads the year and lists it sorted by date', async () => {
    const calls = stubFetch({ [READ]: { body: FILE_2026 } });
    renderPage();
    const rows = await screen.findAllByTestId('holiday-row');
    expect(rows.map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual([
      'Republic Day',
      'Independence Day',
    ]);
    expect(calls[0].url).toBe('/api/internal/proxy/holidays/en-IN/2026');
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });

  it('honours ?locale= from the calendar editor link', async () => {
    mockSearch = new URLSearchParams('locale=generic&year=2026');
    const calls = stubFetch({ 'GET /api/internal/proxy/holidays/generic/2026': { status: 404, body: {} } });
    renderPage();
    await screen.findByTestId('holidays-empty');
    expect(calls[0].url).toBe('/api/internal/proxy/holidays/generic/2026');
  });

  it('adds, edits and deletes locally, then Save PUTs the whole year', async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      [READ]: { body: FILE_2026 },
      [`PUT ${WRITE}`]: {
        body: {
          ...FILE_2026,
          events: [
            { date: '2026-01-26', name: 'Republic Day (India)', type: 'national', color: '#DC2626' },
            { date: '2026-11-08', name: 'Diwali', type: 'festival' },
          ],
        },
      },
    });
    renderPage();
    await screen.findAllByTestId('holiday-row');

    // Add Diwali with a type.
    await user.click(screen.getAllByRole('button', { name: /Add holiday/ })[0]);
    const form = await fillAddForm(user, '2026-11-08', 'Diwali');
    await user.click(within(form).getByTestId('holiday-type'));
    await user.click(screen.getByRole('option', { name: 'Festival' }));
    await user.click(within(form).getByRole('button', { name: 'Add to list' }));
    expect(screen.getAllByTestId('holiday-row')).toHaveLength(3);
    expect(screen.getByTestId('unsaved-badge')).toBeInTheDocument();

    // Rename Republic Day.
    await user.click(screen.getByRole('button', { name: 'Edit Republic Day' }));
    const editForm = await screen.findByTestId('holiday-form');
    const name = within(editForm).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Republic Day (India)');
    await user.click(within(editForm).getByRole('button', { name: 'Update' }));

    // Delete Independence Day.
    await user.click(screen.getByRole('button', { name: 'Delete Independence Day' }));
    expect(screen.getAllByTestId('holiday-row')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    await screen.findByText('Holidays saved');

    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(WRITE);
    expect(put?.body).toEqual({
      year: 2026,
      locale: 'en-IN',
      _meta: { source: 'seed' },
      events: [
        { date: '2026-01-26', name: 'Republic Day (India)', type: 'national', color: '#DC2626' },
        { date: '2026-11-08', name: 'Diwali', type: 'festival' },
      ],
    });
    expect(screen.queryByTestId('unsaved-badge')).not.toBeInTheDocument();
  });

  it('shows the server detail when Save is refused', async () => {
    const user = userEvent.setup();
    stubFetch({
      [READ]: { body: FILE_2026 },
      [`PUT ${WRITE}`]: { status: 400, body: { detail: 'events[0].name is required' } },
    });
    renderPage();
    await screen.findAllByTestId('holiday-row');
    await user.click(screen.getByRole('button', { name: 'Delete Republic Day' }));
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(await screen.findByText('events[0].name is required')).toBeInTheDocument();
    expect(screen.getByTestId('unsaved-badge')).toBeInTheDocument();
  });

  it('Discard changes puts the saved list back', async () => {
    const user = userEvent.setup();
    stubFetch({ [READ]: { body: FILE_2026 } });
    renderPage();
    await screen.findAllByTestId('holiday-row');
    await user.click(screen.getByRole('button', { name: 'Delete Republic Day' }));
    await user.click(screen.getByRole('button', { name: /Discard changes/ }));
    expect(screen.getAllByTestId('holiday-row')).toHaveLength(2);
    expect(screen.queryByTestId('unsaved-badge')).not.toBeInTheDocument();
  });

  it('treats a 404 as an empty year and lets ops start one', async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      [READ]: { status: 404, body: { detail: 'No holiday data' } },
      [`PUT ${WRITE}`]: { body: { year: 2026, locale: 'en-IN', events: [{ date: '2026-01-01', name: 'New Year' }] } },
    });
    renderPage();
    expect(await screen.findByText('No holidays for en-IN 2026 yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Clear year/ })).not.toBeInTheDocument();

    await user.click(within(screen.getByTestId('holidays-empty')).getByRole('button', { name: /Add holiday/ }));
    const form = await fillAddForm(user, '2026-01-01', 'New Year');
    await user.click(within(form).getByRole('button', { name: 'Add to list' }));
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    await screen.findByText('Holidays saved');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      events: [{ date: '2026-01-01', name: 'New Year' }],
    });
  });

  it('explains what is wrong with a holiday instead of adding it', async () => {
    const user = userEvent.setup();
    stubFetch({ [READ]: { body: FILE_2026 } });
    renderPage();
    await screen.findAllByTestId('holiday-row');
    await user.click(screen.getAllByRole('button', { name: /Add holiday/ })[0]);

    let form = await fillAddForm(user, '2026-03-04', '');
    await user.click(within(form).getByRole('button', { name: 'Add to list' }));
    expect(within(form).getByText(/Enter a name/)).toBeInTheDocument();

    form = await fillAddForm(user, '2027-03-22', 'Holi');
    await user.click(within(form).getByRole('button', { name: 'Add to list' }));
    expect(within(form).getByText(/Pick a date in 2026/)).toBeInTheDocument();

    form = await fillAddForm(user, '2026-01-26', 'republic day');
    await user.click(within(form).getByRole('button', { name: 'Add to list' }));
    expect(within(form).getByText(/already listed on this date/)).toBeInTheDocument();

    expect(screen.getAllByTestId('holiday-row')).toHaveLength(2);
    expect(screen.queryByTestId('unsaved-badge')).not.toBeInTheDocument();
  });

  it('asks before switching year with unsaved changes', async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      [READ]: { body: FILE_2026 },
      'GET /api/internal/proxy/holidays/en-IN/2027': { status: 404, body: {} },
    });
    renderPage();
    await screen.findAllByTestId('holiday-row');
    await user.click(screen.getByRole('button', { name: 'Delete Republic Day' }));

    await user.click(screen.getByTestId('holiday-year-picker'));
    await user.click(screen.getByRole('option', { name: '2027' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.url.endsWith('/2027'))).toBe(false);
    expect(screen.getByTestId('unsaved-badge')).toBeInTheDocument();

    await user.click(screen.getByTestId('holiday-year-picker'));
    await user.click(screen.getByRole('option', { name: '2027' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard and switch' }));
    expect(await screen.findByText('No holidays for en-IN 2027 yet')).toBeInTheDocument();
  });

  it('Clear year DELETEs after an in-page confirmation', async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      [READ]: { body: FILE_2026 },
      [`DELETE ${WRITE}`]: { status: 204 },
    });
    renderPage();
    await screen.findAllByTestId('holiday-row');
    await user.click(screen.getByRole('button', { name: /Clear year/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Clear year' }));
    expect(await screen.findByText('No holidays for en-IN 2026 yet')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(WRITE);
  });

  it('is read-only for the Editor tier', async () => {
    mockSession = EDITOR;
    stubFetch({ [READ]: { body: FILE_2026 } });
    renderPage();
    await screen.findAllByTestId('holiday-row');
    expect(screen.getByTestId('holidays-read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add holiday/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Clear year/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });
});

