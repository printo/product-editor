import { act, renderHook } from '@testing-library/react';
import { useEditorEnvironment, useLoginRedirect } from '../useEditorEnvironment';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() };
let mockParams: Record<string, string | string[]> = { name: 'classic_4x6' };
let mockSession: { data: unknown; status: string } = { data: null, status: 'authenticated' };
jest.mock('next/navigation', () => ({ useParams: () => mockParams, useRouter: () => mockRouter }));
jest.mock('next-auth/react', () => ({ useSession: () => mockSession }));

const at = (search: string) => window.history.replaceState(null, '', `/editor/layout/classic_4x6${search}`);
const env = () => renderHook(() => useEditorEnvironment());

describe('useEditorEnvironment', () => {
  afterEach(() => { at(''); delete process.env.NEXT_PUBLIC_EMBED_PARENT_ORIGIN; });

  it('reads the layout name from the route, as a string or the first of an array', () => {
    expect(env().result.current.layoutName).toBe('classic_4x6');
    mockParams = { name: ['retro', 'x'] };
    expect(env().result.current.layoutName).toBe('retro');
    mockParams = { name: 'classic_4x6' };
  });

  it('embed: the token from the URL, the embed proxy, and the token as its only header', () => {
    at('?token=tok-1&order_id=EXT-1');
    const { result } = env();
    expect(result.current.embedToken).toBe('tok-1');
    expect(result.current.apiBase).toBe('/api/embed/proxy');
    expect(result.current.getAuthHeaders()).toEqual({ 'X-Embed-Token': 'tok-1' });
  });

  it('dashboard: the internal proxy, which needs no header', () => {
    at('?order_id=PE-1');
    const { result } = env();
    expect(result.current.embedToken).toBeNull();
    expect(result.current.apiBase).toBe('/api/internal/proxy');
    expect(result.current.getAuthHeaders()).toEqual({});
  });

  it('keeps the order id from the URL', () => {
    at('?order_id=EXT-42&x=1');
    expect(env().result.current.orderId).toBe('EXT-42');
    expect(window.location.search).toBe('?order_id=EXT-42&x=1');
  });

  it('without one, makes up a PE- id and writes it into the URL, keeping the rest', () => {
    at('?token=tok-1');
    const { result } = env();
    expect(result.current.orderId).toMatch(/^PE-[0-9A-F]{8}$/);
    const sp = new URLSearchParams(window.location.search);
    expect(sp.get('order_id')).toBe(result.current.orderId);
    expect(sp.get('token')).toBe('tok-1');
  });

  it('follows a changed order id into the URL (the embed session id, once adopted)', () => {
    at('?order_id=PE-OLD');
    const { result } = env();
    act(() => result.current.setOrderId('EXT-NEW'));
    expect(new URLSearchParams(window.location.search).get('order_id')).toBe('EXT-NEW');
  });

  it('quantity: the session value outranks the ?qty= fallback', () => {
    at('?order_id=PE-1&qty=5');
    const { result } = env();
    expect(result.current.orderQty).toBe(5);
    act(() => result.current.setSessionQty(12));
    expect(result.current.orderQty).toBe(12);
  });

  it.each(['0', '-3', 'abc', ''])('quantity: ?qty=%p is no quantity', (qty) => {
    at(`?order_id=PE-1&qty=${qty}`);
    expect(env().result.current.orderQty).toBeNull();
  });

  it('parent origin: the referrer, else the configured origin, else printo.in', () => {
    const referrer = jest.spyOn(document, 'referrer', 'get');
    referrer.mockReturnValue('https://alpha.printo.in/product-editor?x=1');
    expect(env().result.current.parentOrigin).toBe('https://alpha.printo.in');
    referrer.mockReturnValue('');
    process.env.NEXT_PUBLIC_EMBED_PARENT_ORIGIN = 'https://staging.printo.in';
    expect(env().result.current.parentOrigin).toBe('https://staging.printo.in');
    delete process.env.NEXT_PUBLIC_EMBED_PARENT_ORIGIN;
    expect(env().result.current.parentOrigin).toBe('https://printo.in');
    referrer.mockRestore();
  });

  it('parent origin: the frame’s ancestor comes first', () => {
    Object.defineProperty(window.location, 'ancestorOrigins', { value: { length: 1, 0: 'https://www.printo.in' }, configurable: true });
    expect(env().result.current.parentOrigin).toBe('https://www.printo.in');
    Reflect.deleteProperty(window.location, 'ancestorOrigins');
  });

  it('hands through the session', () => {
    mockSession = { data: { user: { id: 'E1' } }, status: 'authenticated' };
    const { result } = env();
    expect(result.current.status).toBe('authenticated');
    expect(result.current.session).toEqual({ user: { id: 'E1' } });
    expect(result.current.router).toBe(mockRouter);
  });
});

describe('useLoginRedirect', () => {
  const run = (p: Partial<Parameters<typeof useLoginRedirect>[0]>) => {
    const router = { push: jest.fn() };
    renderHook(() => useLoginRedirect({ status: 'authenticated', session: null, embedToken: null, router, ...p }));
    return router.push;
  };

  it('sends a signed-out dashboard visitor to /login', () => {
    expect(run({ status: 'unauthenticated' })).toHaveBeenCalledWith('/login');
  });

  it('and one whose session could not be refreshed', () => {
    expect(run({ session: { error: 'RefreshAccessTokenError' } as never })).toHaveBeenCalledWith('/login');
  });

  it('never in the embed, and not while signed in or still loading', () => {
    expect(run({ status: 'unauthenticated', embedToken: 'tok' })).not.toHaveBeenCalled();
    expect(run({})).not.toHaveBeenCalled();
    expect(run({ status: 'loading' })).not.toHaveBeenCalled();
  });
});
