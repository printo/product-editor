import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { AnnouncerProvider, useAnnounceWhen } from '@/lib/announcer';
import { Toast } from '@/components/ui/Toast';
import { EditorBanners, ErrorBanner } from '@/app/editor/layout/[name]/EditorBanners';

function Speaker({ text, assertive = false }: { text: string | null; assertive?: boolean }) {
  useAnnounceWhen(text, { assertive });
  return null;
}

const polite = () => screen.getByTestId('announcer-polite');
const assertive = () => screen.getByTestId('announcer-assertive');
const settle = () => act(() => { jest.advanceTimersByTime(60); });

describe('announcer', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('keeps its two regions in the page before anything is said', () => {
    render(<AnnouncerProvider><Speaker text={null} /></AnnouncerProvider>);
    expect(screen.getByRole('status')).toBe(polite());
    expect(screen.getByRole('alert')).toBe(assertive());
    expect(polite()).toBeEmptyDOMElement();
    expect(assertive()).toBeEmptyDOMElement();
  });

  it('speaks a message when it appears, politely or assertively, and not when it goes', () => {
    const { rerender } = render(<AnnouncerProvider><Speaker text={null} /></AnnouncerProvider>);
    rerender(<AnnouncerProvider><Speaker text="Saved" /></AnnouncerProvider>);
    settle();
    expect(polite()).toHaveTextContent('Saved');
    rerender(<AnnouncerProvider><Speaker text={null} /></AnnouncerProvider>);
    settle();
    expect(polite()).toHaveTextContent('Saved');
    rerender(<AnnouncerProvider><Speaker text="Upload failed" assertive /></AnnouncerProvider>);
    settle();
    expect(assertive()).toHaveTextContent('Upload failed');
  });

  it('reads two messages that arrive together as one', () => {
    render(<AnnouncerProvider><Speaker text="First" /><Speaker text="Second" /></AnnouncerProvider>);
    settle();
    expect(polite()).toHaveTextContent('First Second');
  });

  it('clears the region before the same words come again, so they are read again', () => {
    function Repeat() {
      const [n, setN] = useState(0);
      useAnnounceWhen(n % 2 ? 'Removed' : null);
      return <button onClick={() => setN(v => v + 1)}>next</button>;
    }
    render(<AnnouncerProvider><Repeat /></AnnouncerProvider>);
    act(() => { screen.getByText('next').click(); });
    settle();
    expect(polite()).toHaveTextContent('Removed');
    act(() => { screen.getByText('next').click(); });
    act(() => { screen.getByText('next').click(); });
    expect(polite()).toBeEmptyDOMElement();
    settle();
    expect(polite()).toHaveTextContent('Removed');
  });

  it('the editor banners, the error and a toast are spoken through it', () => {
    const noop = jest.fn();
    render(
      <AnnouncerProvider>
        <EditorBanners
          swapSource={null} setSwapSource={noop} persistDegraded={false} setPersistDegraded={noop}
          storageBlocked={false} setStorageBlocked={noop} uploadWarning="Too many files" setUploadWarning={noop}
          colorWarning={null} setColorWarning={noop} unsupportedWarning={null} setUnsupportedWarning={noop}
          qtyUnder={null} setQtyUnder={noop} headerHeight={0} toolbarHeight={0}
          setShowAutoFillPicker={noop} setPickerSelected={noop} uploadInputRef={{ current: null }}
        />
        <ErrorBanner error="Upload failed" setError={noop} />
        <Toast message="Template saved" tone="success" onDismiss={noop} />
      </AnnouncerProvider>,
    );
    settle();
    expect(polite()).toHaveTextContent('Too many files Template saved');
    expect(assertive()).toHaveTextContent('Upload failed');
  });
});
