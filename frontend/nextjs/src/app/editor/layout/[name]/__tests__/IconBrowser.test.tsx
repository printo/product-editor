import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IconBrowser } from '../IconBrowser';

const origin = window.location.origin;
const getAuthHeaders = () => ({ 'X-Embed-Token': 't' });
const realFetch = global.fetch;

function respond(status: number, body: unknown) {
  const mock = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

async function open(onAddImage = jest.fn()) {
  render(<IconBrowser onAddImage={onAddImage} apiBase="/api/embed/proxy" getAuthHeaders={getAuthHeaders} />);
  fireEvent.click(screen.getByRole('button', { name: /Add New Icon/ }));
  await screen.findByRole('img', { name: 'like' });
  return onAddImage;
}

async function searchFor(text: string) {
  jest.useFakeTimers();
  fireEvent.change(screen.getByPlaceholderText('Search icons...'), { target: { value: text } });
  await act(async () => { jest.advanceTimersByTime(300); });
  jest.useRealTimers();
}

afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); });

describe('IconBrowser', () => {
  it('shows the starter icons from our own server, with no request to Iconify', async () => {
    const fetched = respond(200, { icons: [] });
    await open();
    const like = screen.getByRole('img', { name: 'like' });
    expect(like).toHaveAttribute('src', `${origin}/api/icons/flat-color-icons/like.svg`);
    expect(screen.getAllByRole('img').every(img => img.getAttribute('src')!.startsWith(`${origin}/api/icons/`))).toBe(true);
    expect(fetched).not.toHaveBeenCalled();
  });

  it('searches through the page’s proxy and loads each tile from our own server', async () => {
    const fetched = respond(200, { icons: [{ prefix: 'mdi', name: 'heart' }, { prefix: 'noto', name: 'red-heart' }] });
    await open();
    await searchFor('Love');
    await screen.findByRole('img', { name: 'heart' });
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0][0]).toBe('/api/embed/proxy/icon-search?q=love');
    expect(fetched.mock.calls[0][1]).toEqual({ headers: { 'X-Embed-Token': 't' } });
    expect(screen.getByRole('img', { name: 'red-heart' })).toHaveAttribute('src', `${origin}/api/icons/noto/red-heart.svg`);
  });

  it('adds the icon to the design under Iconify’s address, which names it wherever the design is opened', async () => {
    respond(200, { icons: [{ prefix: 'mdi', name: 'heart' }] });
    const onAddImage = await open();
    await searchFor('love');
    fireEvent.click((await screen.findByRole('img', { name: 'heart' })).closest('button')!);
    expect(onAddImage).toHaveBeenCalledWith(expect.objectContaining({
      src: 'https://api.iconify.design/mdi/heart.svg', source: 'icon', label: 'mdi:heart',
    }));
  });

  it('shows a plain placeholder for a tile that did not load, and does not offer it', async () => {
    respond(200, { icons: [{ prefix: 'mdi', name: 'heart' }, { prefix: 'mdi', name: 'star' }] });
    const onAddImage = await open();
    await searchFor('love');
    fireEvent.error(await screen.findByRole('img', { name: 'heart' }));
    expect(screen.queryByRole('img', { name: 'heart' })).toBeNull();
    const tile = screen.getByTitle('heart could not be loaded');
    expect(tile).toBeDisabled();
    fireEvent.click(tile);
    expect(onAddImage).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'star' })).toBeInTheDocument();
  });

  it('says the search is busy when our server cannot ask just now', async () => {
    respond(503, { detail: 'Icon search unavailable, try again shortly.' });
    await open();
    await searchFor('love');
    await waitFor(() => expect(screen.getByText('Icon search is busy. Please try again in a minute.')).toBeInTheDocument());
  });

  it('says so plainly when nothing matches', async () => {
    respond(200, { icons: [] });
    await open();
    await searchFor('zzzz');
    await waitFor(() => expect(screen.getByText('No icons found.')).toBeInTheDocument());
  });

  it('does not search for a single letter', async () => {
    const fetched = respond(200, { icons: [] });
    await open();
    await searchFor('l');
    expect(fetched).not.toHaveBeenCalled();
  });
});
