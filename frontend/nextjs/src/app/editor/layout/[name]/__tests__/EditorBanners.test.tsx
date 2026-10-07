import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { EditorBanners, ErrorBanner } from '../EditorBanners';

type Props = ComponentProps<typeof EditorBanners>;

function setup(overrides: Partial<Props> = {}) {
  const input = document.createElement('input');
  const props: Props = {
    swapSource: null, setSwapSource: jest.fn(), persistDegraded: false, setPersistDegraded: jest.fn(),
    storageBlocked: false, setStorageBlocked: jest.fn(), uploadWarning: null, setUploadWarning: jest.fn(),
    colorWarning: null, setColorWarning: jest.fn(), unsupportedWarning: null, setUnsupportedWarning: jest.fn(),
    qtyUnder: null, setQtyUnder: jest.fn(), headerHeight: 80, toolbarHeight: 64,
    setShowAutoFillPicker: jest.fn(), setPickerSelected: jest.fn(), uploadInputRef: { current: input },
    ...overrides,
  };
  const click = jest.spyOn(input, 'click').mockImplementation(() => {});
  return { ...render(<EditorBanners {...props} />), props, click };
}

describe('EditorBanners', () => {
  it('shows nothing when there is nothing to say', () => {
    const { container } = setup();
    expect(container).toBeEmptyDOMElement();
  });

  it('tap-to-swap: says what to do and can be cancelled', () => {
    const { props } = setup({ swapSource: { idx: 0, surfaceKey: null } });
    expect(screen.getByRole('status')).toHaveTextContent('Tap another photo to swap');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel swap' }));
    expect(props.setSwapSource).toHaveBeenCalledWith(null);
  });

  it('storage: a blocked store and a full one read differently, and dismissing clears both', () => {
    const { props, unmount } = setup({ storageBlocked: true });
    expect(screen.getByRole('status')).toHaveTextContent('Your browser is blocking local storage');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss storage warning' }));
    expect(props.setPersistDegraded).toHaveBeenCalledWith(false);
    expect(props.setStorageBlocked).toHaveBeenCalledWith(false);
    unmount();
    setup({ persistDegraded: true });
    expect(screen.getByRole('status')).toHaveTextContent("This device's storage is full");
  });

  it('stacks the upload, colour and unsupported-file warnings top right, each dismissable', () => {
    const { props, container } = setup({ uploadWarning: 'Too many files', colorWarning: 'CMYK photo', unsupportedWarning: 'notes.txt' });
    expect(screen.getByText('Too many files')).toBeInTheDocument();
    expect(screen.getByText('CMYK → RGB colour shift')).toBeInTheDocument();
    expect(screen.getByText('Unsupported file')).toBeInTheDocument();
    const tops = Array.from(container.children).map(c => c.className.match(/\btop-(24|44|64)\b/)?.[0]);
    expect(tops).toEqual(['top-24', 'top-44', 'top-64']);
    container.querySelectorAll('button').forEach(b => fireEvent.click(b));
    expect(props.setUploadWarning).toHaveBeenCalledWith(null);
    expect(props.setColorWarning).toHaveBeenCalledWith(null);
    expect(props.setUnsupportedWarning).toHaveBeenCalledWith(null);
  });

  it('a lone unsupported-file warning takes the top slot', () => {
    const { container } = setup({ unsupportedWarning: 'notes.txt' });
    expect((container.firstElementChild as HTMLElement).className).toMatch(/\btop-24\b/);
  });

  it('under the ordered quantity: counts, a progress bar, and the two ways to fill the gap', () => {
    const { props, click } = setup({ qtyUnder: { uploaded: 3, needed: 12 } });
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('3 of 12 images uploaded');
    expect(banner).toHaveTextContent('Upload 9 more photos, or repeat from the images already uploaded.');
    // Below both bars: the top bar and the toolbar, plus a gap.
    expect(banner.style.top).toBe('156px');
    expect((banner.querySelector('.bg-indigo-600.h-full') as HTMLElement).style.width).toBe('25%');
    fireEvent.click(screen.getByRole('button', { name: 'Choose which to repeat' }));
    expect(props.setShowAutoFillPicker).toHaveBeenCalledWith(true);
    expect(props.setPickerSelected).toHaveBeenCalledWith(new Set());
    fireEvent.click(screen.getByRole('button', { name: 'Upload More' }));
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(props.setQtyUnder).toHaveBeenCalledWith(null);
  });

  it('says "photo" for one missing', () => {
    setup({ qtyUnder: { uploaded: 11, needed: 12 } });
    expect(screen.getByRole('status')).toHaveTextContent('Upload 1 more photo, or');
  });
});

describe('ErrorBanner', () => {
  it('shows the error and clears it', () => {
    const setError = jest.fn();
    const { container, rerender } = render(<ErrorBanner error={null} setError={setError} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ErrorBanner error="Upload failed" setError={setError} />);
    expect(screen.getByText('Upload failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(setError).toHaveBeenCalledWith(null);
  });
});
