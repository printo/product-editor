import { renderHook, waitFor } from '@testing-library/react';
import { useLayoutTemplates } from '../useLayoutTemplates';

const headers = () => ({ 'X-Embed-Token': 'tok' });

describe('useLayoutTemplates', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('loads the layout’s published templates through the page’s proxy and keeps only well-formed ones', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ templates: [
        { id: 'retro-birthday', displayName: 'Retro Birthday', layoutName: 'classic_4x6', thumbnailUrl: null, decoration: { surfaces: { default: { overlays: [] } } } },
        { id: 'broken' },
      ] }),
    })) as unknown as typeof fetch;
    const { result } = renderHook(() => useLayoutTemplates({ apiBase: '/api/embed/proxy', getAuthHeaders: headers, layoutName: 'classic_4x6', enabled: true }));
    await waitFor(() => expect(result.current.templatesLoaded).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith('/api/embed/proxy/templates?layout=classic_4x6', expect.objectContaining({ headers: expect.objectContaining({ 'X-Embed-Token': 'tok' }) }));
    expect(result.current.templates.map(t => t.id)).toEqual(['retro-birthday']);
  });

  it('asks for the templates of the way the layout opens (the dashboard choice)', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ templates: [] }) })) as unknown as typeof fetch;
    const { result } = renderHook(() => useLayoutTemplates({ apiBase: '/api/internal/proxy', getAuthHeaders: headers, layoutName: 'classic_4x6', enabled: true, orientation: 'landscape' }));
    await waitFor(() => expect(result.current.templatesLoaded).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith('/api/internal/proxy/templates?layout=classic_4x6&orientation=landscape', expect.anything());
  });

  it('does nothing while disabled or without a layout, and treats a failure as no templates', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const off = renderHook(() => useLayoutTemplates({ apiBase: '/api/internal/proxy', getAuthHeaders: headers, layoutName: 'classic_4x6', enabled: false }));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(off.result.current.templatesLoaded).toBe(false);
    const failing = renderHook(() => useLayoutTemplates({ apiBase: '/api/internal/proxy', getAuthHeaders: headers, layoutName: 'classic_4x6', enabled: true }));
    await waitFor(() => expect(failing.result.current.templatesLoaded).toBe(true));
    expect(failing.result.current.templates).toEqual([]);
  });
});
