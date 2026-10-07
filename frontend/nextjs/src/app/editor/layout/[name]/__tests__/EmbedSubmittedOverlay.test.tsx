import { act, fireEvent, render, screen } from '@testing-library/react';
import { EmbedSubmittedOverlay } from '../EmbedSubmittedOverlay';

const API_BASE = '/api/embed/proxy';
const JOB_ID = 'job-123';
const authHeaders = () => ({ 'X-Embed-Token': 'tok' });

/** Each call to fetch answers with the next status body, or rejects for an Error. */
function serveStatuses(...replies: Array<Record<string, unknown> | Error>) {
  const fetchMock = jest.fn();
  for (const reply of replies) {
    if (reply instanceof Error) fetchMock.mockRejectedValueOnce(reply);
    else fetchMock.mockResolvedValueOnce({ ok: true, json: async () => reply });
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Lets the poll's fetch settle, then runs any timer due within `ms`. */
async function wait(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function renderOverlay(onBackToEditor = jest.fn()) {
  const view = render(
    <EmbedSubmittedOverlay jobId={JOB_ID} apiBase={API_BASE} getAuthHeaders={authHeaders} onBackToEditor={onBackToEditor} />,
  );
  return { ...view, onBackToEditor };
}

describe('EmbedSubmittedOverlay', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    // No jitter: the poll delays become exactly 3 s, 4.5 s, 6.75 s, ...
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.fetch = realFetch;
  });

  it('polls the render status through the given API with the auth headers', async () => {
    const fetchMock = serveStatuses({ status: 'queued' });
    renderOverlay();
    await wait(0);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/render-status/${JOB_ID}/`, { headers: { 'X-Embed-Token': 'tok' } });
    expect(screen.getByRole('status')).toHaveTextContent('Design submitted — queued…');
  });

  it('shows the queue wait, then the ready state, and stops polling', async () => {
    const fetchMock = serveStatuses(
      { status: 'queued', estimated_wait_seconds: 40 },
      { status: 'processing' },
      { status: 'completed' },
    );
    renderOverlay();
    await wait(0);
    expect(screen.getByText('Queued — about ~40 s wait')).toBeInTheDocument();
    await wait(3000);
    expect(screen.getByText('Preparing your print files…')).toBeInTheDocument();
    await wait(4500);
    expect(screen.getByText('Your design is ready')).toBeInTheDocument();
    await wait(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('on failure, shows the reason and a way back to the editor', async () => {
    const fetchMock = serveStatuses({ status: 'failed', error: 'Disk full.' });
    const { onBackToEditor } = renderOverlay();
    await wait(0);
    expect(screen.getByText('Something went wrong preparing your design')).toBeInTheDocument();
    expect(screen.getByText(/Disk full\. Your design is safe/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to editor' }));
    expect(onBackToEditor).toHaveBeenCalledTimes(1);
    await wait(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known state through a failed poll and tries again', async () => {
    serveStatuses(
      { status: 'queued', estimated_wait_seconds: 30 },
      new Error('network down'),
      { status: 'completed' },
    );
    renderOverlay();
    await wait(0);
    expect(screen.getByText('Queued — about ~30 s wait')).toBeInTheDocument();
    await wait(3000);
    expect(screen.getByText('Queued — about ~30 s wait')).toBeInTheDocument();
    await wait(4500);
    expect(screen.getByText('Your design is ready')).toBeInTheDocument();
  });

  it('offers to edit the design again, both while waiting and once ready', async () => {
    serveStatuses({ status: 'queued' }, { status: 'completed' });
    const { onBackToEditor } = renderOverlay();
    await wait(0);
    fireEvent.click(screen.getByRole('button', { name: 'Edit design' }));
    await wait(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Edit design again' }));
    expect(onBackToEditor).toHaveBeenCalledTimes(2);
  });

  it('stops polling once closed', async () => {
    const fetchMock = serveStatuses({ status: 'queued' }, { status: 'queued' });
    const { unmount } = renderOverlay();
    await wait(0);
    unmount();
    await wait(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
