/** Tests for the modal a11y hook (Phase 4): Escape-to-close + focus restore. */
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { useModalA11y } from '@/lib/use-modal-a11y';

function Modal({ onClose, active = true }: { onClose: () => void; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y(ref, onClose, active);
  return (
    <div ref={ref} role="dialog">
      <button>First</button>
      <button>Last</button>
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
});
