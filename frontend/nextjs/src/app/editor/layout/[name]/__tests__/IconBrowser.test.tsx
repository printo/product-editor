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
  await act(async () => { jest.advanceTimersByTime(500); });
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
    expect(fetched.mock.calls[0][1]).toEqual(expect.objectContaining({ headers: { 'X-Embed-Token': 't' } }));
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

  describe('only the word now in the box counts', () => {
    /** Each search waits until the test answers it; a cancelled one rejects, as a browser's does. */
    function controlledSearches() {
      const open = new Map<string, { answer: (icons: string[]) => void; signal: AbortSignal }>();
      const mock = jest.fn((url: string, init: { signal: AbortSignal }) => new Promise((resolve, reject) => {
        const q = new URL(url, 'http://x').searchParams.get('q')!;
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        open.set(q, {
          signal: init.signal,
          answer: icons => resolve({ ok: true, status: 200, json: async () => ({ icons: icons.map(name => ({ prefix: 'mdi', name })) }) }),
        });
      }));
      global.fetch = mock as unknown as typeof fetch;
      return { open, mock };
    }

    const type = (text: string) => fireEvent.change(screen.getByPlaceholderText('Search icons...'), { target: { value: text } });
    const pause = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });

    async function ready() {
      const searches = controlledSearches();
      await open();
      jest.useFakeTimers();
      return searches;
    }

    it('waits for half a second of no typing, so partial words are not searched', async () => {
      const { mock } = await ready();
      for (const word of ['lo', 'lov', 'love']) {
        type(word);
        await pause(499);
      }
      expect(mock).not.toHaveBeenCalled();
      await pause(1);
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0][0]).toBe('/api/embed/proxy/icon-search?q=love');
    });

    it('a late answer for an earlier word does not replace the right one', async () => {
      const { open: searches } = await ready();
      type('lov');
      await pause(500);
      const earlier = searches.get('lov')!;
      type('love');
      await pause(500);
      expect(earlier.signal.aborted).toBe(true);
      await act(async () => { searches.get('love')!.answer(['right']); });
      expect(screen.getByRole('img', { name: 'right' })).toBeInTheDocument();
      await act(async () => { earlier.answer(['wrong']); });
      expect(screen.queryByRole('img', { name: 'wrong' })).toBeNull();
      expect(screen.getByRole('img', { name: 'right' })).toBeInTheDocument();
    });

    it('cancelling a search does not end the spinner or say the search is busy', async () => {
      const { open: searches } = await ready();
      type('lov');
      await pause(500);
      type('love');
      await pause(0);
      expect(searches.get('lov')!.signal.aborted).toBe(true);
      expect(screen.getByText('Searching...')).toBeInTheDocument();
      expect(screen.queryByText(/busy/)).toBeNull();
      await pause(500);
      expect(screen.getByText('Searching...')).toBeInTheDocument();
      await act(async () => { searches.get('love')!.answer(['right']); });
      expect(screen.queryByText('Searching...')).toBeNull();
      expect(screen.queryByText(/busy/)).toBeNull();
    });

    it('an answer arriving just as more is typed is not shown', async () => {
      const { open: searches } = await ready();
      type('lov');
      await pause(500);
      const earlier = searches.get('lov')!;
      type('love');
      await act(async () => { earlier.answer(['wrong']); });
      expect(screen.queryByRole('img', { name: 'wrong' })).toBeNull();
    });

    it('a search still running stops when the icon browser goes away', async () => {
      const { open: searches } = controlledSearches();
      const { unmount } = render(<IconBrowser onAddImage={jest.fn()} apiBase="/api/embed/proxy" getAuthHeaders={getAuthHeaders} />);
      fireEvent.click(screen.getByRole('button', { name: /Add New Icon/ }));
      await screen.findByRole('img', { name: 'like' });
      jest.useFakeTimers();
      type('love');
      await pause(500);
      unmount();
      expect(searches.get('love')!.signal.aborted).toBe(true);
    });
  });

  it('does not search for a single letter', async () => {
    const fetched = respond(200, { icons: [] });
    await open();
    await searchFor('l');
    expect(fetched).not.toHaveBeenCalled();
  });
});
