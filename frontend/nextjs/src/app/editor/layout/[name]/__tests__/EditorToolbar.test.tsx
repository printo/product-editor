import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { HeaderProvider, useHeader } from '@/context/HeaderContext';
import { EditorToolbar, useDashboardHeader } from '../EditorToolbar';
import type { SurfaceState } from '../types';

type Props = ComponentProps<typeof EditorToolbar>;
const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

function setup(overrides: Partial<Props> = {}) {
  const input = document.createElement('input');
  const props: Props = {
    setToolbarSentinel: jest.fn(), isToolbarStuck: false, toolbarHeight: 64, setToolbarEl: jest.fn(), headerHeight: 80,
    embedToken: null, orderId: 'ORDER-1', parentOrigin: 'https://printo.in',
    layout: { name: 'classic_prints_-_4x6_in', displayName: 'Classic Prints' }, layoutName: 'classic_prints_-_4x6_in',
    files: [photo('a.jpg'), photo('b.jpg')], surfaceStates: [] as SurfaceState[], qtyUnder: null, qtyNeeded: 0,
    totalUploadedCount: 2, uploadInputRef: { current: input },
    globalFitMode: 'contain', setGlobalFitMode: jest.fn(), fitModeUserToggledRef: { current: false },
    globalBlurFill: true, setGlobalBlurFill: jest.fn(), blurFillUserToggledRef: { current: false },
    isDownloading: false, setDisclaimerChecked: jest.fn(), setShowEmbedDisclaimer: jest.fn(), setShowDownloadModal: jest.fn(),
    ...overrides,
  };
  const click = jest.spyOn(input, 'click').mockImplementation(() => {});
  return { ...render(<EditorToolbar {...props} />), props, click };
}

describe('EditorToolbar', () => {
  it('dashboard: Download resets the disclaimer and opens the download options', () => {
    const { props } = setup();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save and continue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(props.setDisclaimerChecked).toHaveBeenCalledWith(false);
    expect(props.setShowDownloadModal).toHaveBeenCalledWith(true);
  });

  it('embed: Back tells the parent page, and Save & Continue opens the disclaimer', () => {
    const post = jest.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const { props } = setup({ embedToken: 'tok' });
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(post).toHaveBeenCalledWith({ type: 'pe:back', orderID: 'ORDER-1' }, 'https://printo.in');
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(props.setDisclaimerChecked).toHaveBeenCalledWith(false);
    expect(props.setShowEmbedDisclaimer).toHaveBeenCalledWith(true);
    post.mockRestore();
  });

  it('holds Download and Save & Continue until there is a photo, and Save & Continue while saving', () => {
    const { unmount } = setup({ files: [], totalUploadedCount: 0 });
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    unmount();
    setup({ embedToken: 'tok', isDownloading: true });
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
  });

  it('names the product by its display name, else by its formatted identifier', () => {
    const { unmount } = setup();
    expect(screen.getByRole('heading')).toHaveTextContent('Classic Prints');
    unmount();
    setup({ layout: { name: 'retro_polaroid' } });
    expect(screen.getByRole('heading').textContent).not.toBe('retro_polaroid');
    expect(screen.getByRole('heading').textContent).toMatch(/retro polaroid/i);
  });

  it('Add Photos: hidden before the first photo, opens the picker by click or Enter, counts against the order', () => {
    const { unmount } = setup({ files: [], totalUploadedCount: 0 });
    expect(screen.queryByText(/Add Photos/)).toBeNull();
    unmount();
    const { click } = setup({ qtyNeeded: 5 });
    expect(screen.getByText('Add Photos | Currently uploaded (2 of 5)')).toBeInTheDocument();
    const box = screen.getByText('Add Photos | Currently uploaded (2 of 5)').closest('[role="button"]')!;
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(click).toHaveBeenCalledTimes(2);
  });

  it('Add Photos: plain information once the order is full, and hidden while the shortfall banner shows', () => {
    const { unmount } = setup({ qtyNeeded: 2 });
    expect(screen.getByText('2 of 2 images uploaded').closest('[role="button"]')).toBeNull();
    unmount();
    setup({ qtyNeeded: 5, qtyUnder: { uploaded: 2, needed: 5 } });
    expect(screen.queryByText(/images uploaded|Add Photos/)).toBeNull();
  });

  it('Fit/Cover marks a real change as the user’s own, and ignores a click on the current mode', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(props.setGlobalFitMode).not.toHaveBeenCalled();
    expect(props.fitModeUserToggledRef.current).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cover' }));
    expect(props.setGlobalFitMode).toHaveBeenCalledWith('cover');
    expect(props.fitModeUserToggledRef.current).toBe(true);
  });

  it('Blur Effect toggles and is marked as the user’s own', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle blur effect' }));
    expect(props.blurFillUserToggledRef.current).toBe(true);
    const toggle = (props.setGlobalBlurFill as jest.Mock).mock.calls[0][0] as (v: boolean) => boolean;
    expect(toggle(true)).toBe(false);
  });

  it('hands the sentinel and toolbar to the sticky hook, and pins under the top bar when stuck', () => {
    const { props, container, unmount } = setup();
    const toolbar = screen.getByRole('button', { name: 'Toggle blur effect' }).closest('.backdrop-blur-3xl') as HTMLElement;
    expect(props.setToolbarEl).toHaveBeenCalledWith(toolbar);
    expect(props.setToolbarSentinel).toHaveBeenCalledWith(toolbar.parentElement!.firstElementChild);
    expect(toolbar.style.position).toBe('');
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(1);
    unmount();
    setup({ isToolbarStuck: true });
    const stuck = screen.getByRole('button', { name: 'Toggle blur effect' }).closest('.backdrop-blur-3xl') as HTMLElement;
    expect(stuck.style.position).toBe('fixed');
    expect(stuck.style.top).toBe('80px');
    // A spacer of the toolbar's height holds its place in the page.
    expect((stuck.previousElementSibling as HTMLElement).style.height).toBe('64px');
  });
});

describe('useDashboardHeader', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <HeaderProvider>{children}</HeaderProvider>;

  it('dashboard: titles the page and puts Back to Templates in the top bar', () => {
    const router = { push: jest.fn() };
    const { result } = renderHook(() => { useDashboardHeader(null, router); return useHeader(); }, { wrapper });
    expect(result.current.title).toBe('Preview Canvas');
    render(<>{result.current.rightActions}</>);
    fireEvent.click(screen.getByRole('button', { name: 'Back to templates' }));
    expect(router.push).toHaveBeenCalledWith('/dashboard');
  });

  it('embed: leaves the top bar alone', () => {
    const router = { push: jest.fn() };
    const { result } = renderHook(() => { useDashboardHeader('tok', router); return useHeader(); }, { wrapper });
    expect(result.current.title).toBe('');
    expect(result.current.rightActions).toBeNull();
  });
});
