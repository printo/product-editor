/**
 * Tests for the BookLayoutEditor wrapper page: an existing layout's fields
 * the editor has no control for survive a save, and newly chosen mask PNGs
 * go up as multipart `mask_<role>`.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Page from '@/app/editor/layouts/book/[name]/page';
import { HeaderProvider } from '@/context/HeaderContext';

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockParams: { name: string } = { name: 'softcover_a4' };
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useParams: () => mockParams,
}));

const STORED = {
  name: 'softcover_a4',
  displayName: 'Softcover A4',
  productType: 'book',
  book: {
    gutterMm: 12,
    pageCount: { min: 20, max: 60, step: 4, default: 24 },
    pageOverrides: { '3': { frames: [{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }] } },
    cover: { canvas: { width: 3579, height: 2551, widthMm: 303, heightMm: 216, dpi: 300 }, frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] },
    innerPage: { canvas: { width: 3508, height: 2480, dpi: 300 }, frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] },
  },
};

function stubFetch() {
  const fetchStub = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/ops/layouts/')) {
      return { ok: true, status: 200, json: async () => ({ status: 'success', layout: { ...STORED, book: { ...STORED.book, cover: { ...STORED.book.cover, maskUrl: '/api/layouts/masks/softcover_a4_cover_mask.png' } } } }) } as unknown as Response;
    }
    if (url.includes('/layouts/softcover_a4')) {
      return { ok: true, status: 200, json: async () => STORED } as unknown as Response;
    }
    throw new Error(`Unexpected fetch ${url} ${init?.method ?? ''}`);
  });
  global.fetch = fetchStub as unknown as typeof fetch;
  return fetchStub;
}

function opsCall(stub: jest.Mock) {
  return stub.mock.calls.find((args) => String(args[0]).includes('/ops/layouts/'));
}

afterEach(() => {
  delete (global as unknown as { fetch?: unknown }).fetch;
  jest.clearAllMocks();
});

it('keeps pageOverrides and other stored fields when saving an existing layout', async () => {
  const stub = stubFetch();
  render(<HeaderProvider><Page /></HeaderProvider>);
  await screen.findByTestId('book-layout-editor');
  // A pixels-only role canvas loads at its real size, not the fallback.
  expect(screen.getByTestId('role-section-inner-page')).toHaveTextContent('Inner page');
  await userEvent.click(screen.getByTestId('save-btn'));
  await waitFor(() => expect(opsCall(stub)).toBeTruthy());
  const body = JSON.parse(opsCall(stub)![1]!.body as string);
  expect(body.layout_data.book.pageOverrides).toEqual(STORED.book.pageOverrides);
  expect(body.layout_data.book.innerPage.canvas.widthMm).toBe(297);
  expect(body.layout_data).not.toHaveProperty('displayName');
  expect(body.display_name).toBe('Softcover A4');
});

it('uploads a chosen cover mask as multipart mask_cover', async () => {
  const stub = stubFetch();
  render(<HeaderProvider><Page /></HeaderProvider>);
  await screen.findByTestId('book-layout-editor');
  await userEvent.upload(screen.getByTestId('cover-mask-input'), new File(['png'], 'cover_frame.png', { type: 'image/png' }));
  await userEvent.click(screen.getByTestId('save-btn'));
  await waitFor(() => expect(opsCall(stub)).toBeTruthy());
  const init = opsCall(stub)![1]!;
  const form = init.body as FormData;
  expect(form).toBeInstanceOf(FormData);
  expect((form.get('mask_cover') as File).name).toBe('cover_frame.png');
  expect(form.get('mask_innerPage')).toBeNull();
  expect(JSON.parse(form.get('layout_data') as string).book.pageOverrides).toEqual(STORED.book.pageOverrides);
  expect(await screen.findByTestId('cover-mask-current')).toHaveTextContent('softcover_a4_cover_mask.png');
});
