/**
 * Tests for the CalendarLayoutEditor wrapper page
 * (review fix Gap B — phase 6 integration coverage).
 *
 * Covers the load + save + rename + error states that connect the
 * controlled `CalendarLayoutEditor` to real `/api/internal/proxy/*`
 * endpoints. Uses jest.mock for fetch + next/navigation.
 *
 * The page calls useHeader() (wizard step bar lives in the app header), so
 * every render is wrapped in the real HeaderProvider. The editor itself is
 * a 4-step wizard — Save/Cancel only render on step 4, reached by clicking
 * the `step-4` indicator pill.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Page from '@/app/editor/layouts/calendar/[name]/page';
import { HeaderProvider } from '@/context/HeaderContext';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockParams: { name: string } = { name: 'new' };

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useParams: () => mockParams,
}));

// Capture fetch URLs/bodies for assertions. Matches the real fetch
// signature (RequestInfo | URL) so it satisfies `typeof global.fetch`.
function makeFetchStub(
  responses: Record<string, { status?: number; body: unknown }>
) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href
      : input.url;
    const matchKey = Object.keys(responses).find((k) => url.includes(k));
    if (!matchKey) {
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }
    const r = responses[matchKey];
    return {
      ok: !r.status || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      json: async () => r.body,
      __init: init, // expose for body assertion if needed
    } as unknown as Response;
  });
}

const STYLE_RESPONSE = {
  name: 'modern-genz',
  palettes: [
    {
      name: 'butter',
      label: 'Butter & Purple',
      bg: '#FEF3C7', month: '#A855F7', weekday: '#A855F7',
      grid: '#FBCFE8', date: '#0F172A', pill: '#CCFBF1',
      dotCycle: ['#A855F7', '#EC4899', '#0EA5E9'],
    },
  ],
};

const HOLIDAYS_RESPONSE = {
  year: new Date().getFullYear(),
  locale: 'en-IN',
  events: [{ date: `${new Date().getFullYear()}-01-26`, name: 'Republic Day', color: '#DC2626' }],
};

const EXISTING_LAYOUT = {
  name: 'family_calendar',
  productType: 'calendar',
  canvas: { width: 1500, height: 2100, widthMm: 127, heightMm: 177.8, dpi: 300 },
  frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.42 }],
  calendars: [{ x: 0.05, y: 0.55, width: 0.9, height: 0.42 }],
  calendar: {
    themePreset: 'modern-minimalist',
    calendarType: 'english',
    weekStart: 'sunday',
    holidaySource: { enabled: true, locale: 'en-IN', showInCells: true },
  },
  monthRange: { count: 12, defaultYear: 'current' },
};

function renderPage() {
  return render(
    <HeaderProvider>
      <Page />
    </HeaderProvider>
  );
}

/** Jump to the wizard's Review step, where Save/Cancel live. */
async function goToReviewStep() {
  await userEvent.click(screen.getByTestId('step-4'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.name = 'new';  // default; individual tests override
});

afterEach(() => {
  // Reset the global fetch override so cross-test pollution can't sneak in.
  delete (global as unknown as { fetch?: unknown }).fetch;
});

// ─── Loading + new-route flow ───────────────────────────────────────────────

describe('CalendarLayoutEditor wrapper — new route', () => {
  it('shows loading state initially', () => {
    global.fetch = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
    });
    renderPage();
    expect(screen.getByText(/Loading calendar layout editor/i)).toBeInTheDocument();
  });

  it('mounts a blank editor after style + holiday fetches resolve', async () => {
    global.fetch = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-layout-editor')).toBeInTheDocument()
    );
    // 'new' route uses the default seed name.
    expect((screen.getByTestId('layout-name') as HTMLInputElement).value)
      .toBe('untitled_calendar');
  });
});

// ─── Existing-layout flow ───────────────────────────────────────────────────

describe('CalendarLayoutEditor wrapper — existing route', () => {
  beforeEach(() => {
    mockParams.name = 'family_calendar';
  });

  it('fetches the layout JSON and populates the editor', async () => {
    global.fetch = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
      'layouts/family_calendar': { body: EXISTING_LAYOUT },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-layout-editor')).toBeInTheDocument()
    );
    expect((screen.getByTestId('layout-name') as HTMLInputElement).value)
      .toBe('family_calendar');
  });

  it('renders a "not found" error when the layout fetch 404s', async () => {
    global.fetch = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
      'layouts/family_calendar': { status: 404, body: { detail: 'not found' } },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());
  });

  it('rejects non-calendar layouts with a pointer to the regular editor', async () => {
    const nonCalendar = { ...EXISTING_LAYOUT, productType: 'single' };
    global.fetch = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
      'layouts/family_calendar': { body: nonCalendar },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/regular layout editor/i)).toBeInTheDocument()
    );
  });
});

// ─── Save + rename flow ─────────────────────────────────────────────────────

describe('CalendarLayoutEditor wrapper — save flow', () => {
  it('POSTs the serialised JSON to the ops endpoint and redirects on success (new route)', async () => {
    const fetchStub = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
      'ops/layouts': { body: { ok: true } },
    });
    global.fetch = fetchStub;
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-layout-editor')).toBeInTheDocument()
    );
    await goToReviewStep();
    await userEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() => {
      // Find the ops POST call.
      const opsCall = fetchStub.mock.calls.find((args) =>
        String(args[0]).includes('/ops/layouts/')
      );
      expect(opsCall).toBeTruthy();
    });
    expect(mockReplace).toHaveBeenCalledWith(
      expect.stringMatching(/\/editor\/layouts\/calendar\//)
    );
  });

  it('includes old_name in the body when the layout is renamed', async () => {
    mockParams.name = 'family_calendar';
    const fetchStub = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
      'layouts/family_calendar': { body: EXISTING_LAYOUT },
      'ops/layouts': { body: { ok: true } },
    });
    global.fetch = fetchStub;
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-layout-editor')).toBeInTheDocument()
    );

    // Rename: clear + retype the name field (step 1), then save (step 4).
    const nameInput = screen.getByTestId('layout-name');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'family_calendar_v2');
    await goToReviewStep();
    await userEvent.click(screen.getByTestId('save-btn'));

    await waitFor(() => {
      const opsCall = fetchStub.mock.calls.find((args) =>
        String(args[0]).includes('/ops/layouts/family_calendar_v2')
      );
      expect(opsCall).toBeTruthy();
      const init = opsCall![1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body.old_name).toBe('family_calendar');
      expect(body.name).toBe('family_calendar_v2');
    });
  });

  it('shows the server error message when save fails', async () => {
    global.fetch = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
      'ops/layouts': { status: 400, body: { detail: 'layout name conflict' } },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-layout-editor')).toBeInTheDocument()
    );
    await goToReviewStep();
    await userEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('save-error')).toHaveTextContent(/layout name conflict/i)
    );
  });

  it('Cancel navigates to /editor/layouts', async () => {
    global.fetch = makeFetchStub({
      'calendar-styles/modern-genz': { body: STYLE_RESPONSE },
      'holidays/en-IN': { body: HOLIDAYS_RESPONSE },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-layout-editor')).toBeInTheDocument()
    );
    await goToReviewStep();
    await userEvent.click(screen.getByTestId('cancel-btn'));
    expect(mockPush).toHaveBeenCalledWith('/editor/layouts');
  });
});
