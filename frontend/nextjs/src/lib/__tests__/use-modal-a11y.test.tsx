/** Tests for the modal a11y hook (Phase 4): Escape-to-close, focus trap, focus restore. */
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useModalA11y } from '@/lib/use-modal-a11y';

function Modal({ onClose, active = true, focusLast = false }: {
  onClose: (() => void) | null;
  active?: boolean;
  focusLast?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLButtonElement>(null);
  useModalA11y(ref, onClose, active, focusLast ? lastRef : undefined);
  return (
    <div ref={ref} role="dialog">
      <button>First</button>
      <button ref={lastRef}>Last</button>
    </div>
  );
}

describe('useModalA11y', () => {
  it('closes on Escape', () => {
    const onClose = jest.fn();
    render(<Modal onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focuses the first focusable element on mount', () => {
    const onClose = jest.fn();
    render(<Modal onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByText('First'));
  });

  it('does nothing when inactive', () => {
    const onClose = jest.fn();
    render(<Modal onClose={onClose} active={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('restores focus to the opener on unmount', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const onClose = jest.fn();
    const { unmount } = render(<Modal onClose={onClose} />);
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    document.body.removeChild(opener);
  });

  it('focuses initialFocusRef instead of the first element when given', () => {
    render(<Modal onClose={jest.fn()} focusLast />);
    expect(document.activeElement).toBe(screen.getByText('Last'));
  });

  it('keeps Tab inside: forward from the last wraps to the first, back from the first to the last', () => {
    render(<Modal onClose={jest.fn()} />);
    const first = screen.getByText('First');
    const last = screen.getByText('Last');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  describe('who handles Escape', () => {
    const pageHandler = jest.fn();
    beforeEach(() => {
      pageHandler.mockClear();
      document.addEventListener('keydown', pageHandler);
    });
    afterEach(() => document.removeEventListener('keydown', pageHandler));

    it('with an onClose, the dialog closes and the event stops there', () => {
      const onClose = jest.fn();
      render(<Modal onClose={onClose} />);
      fireEvent.keyDown(screen.getByText('First'), { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(pageHandler).not.toHaveBeenCalled();
    });

    it('with onClose null, Escape is left to the page', () => {
      render(<Modal onClose={null} />);
      fireEvent.keyDown(screen.getByText('First'), { key: 'Escape' });
      expect(pageHandler).toHaveBeenCalledTimes(1);
    });
  });

  it('a new onClose on every render neither moves focus nor goes stale', () => {
    const closes: number[] = [];
    function Rerendering() {
      const [n, setN] = useState(0);
      const ref = useRef<HTMLDivElement>(null);
      useModalA11y(ref, () => closes.push(n));
      return (
        <div ref={ref} role="dialog">
          <button>First</button>
          <button onClick={() => setN(v => v + 1)}>Bump</button>
        </div>
      );
    }
    render(<Rerendering />);
    const bump = screen.getByText('Bump');
    bump.focus();
    fireEvent.click(bump);
    expect(document.activeElement).toBe(bump);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closes).toEqual([1]);
  });
});
