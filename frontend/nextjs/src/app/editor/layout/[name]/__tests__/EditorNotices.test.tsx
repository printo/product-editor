import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  EmptySurfaceWarning, DuplicateFillWarning, LowDpiWarning, QtyShortfallWarning,
  TextRemovedToast, UnprintableTextNote, UnprintableTextWarning, UNPRINTABLE_HELP, UNSUPPORTED_REMOVED,
} from '../EditorNotices';
import type { LowDpiFrame } from '@/lib/dpi-utils';

const lowDpi = (canvasIdx: number, frameIdx: number, dpi: number, surfaceLabel?: string): LowDpiFrame => ({
  canvasIdx, frameIdx, dpi, surfaceLabel, surfaceKey: null, severity: 'warn',
});

describe('EmptySurfaceWarning', () => {
  it('renders nothing when every side has a photo', () => {
    const { container } = render(<EmptySurfaceWarning surfaces={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Whole sentences on purpose: the space after the side names once went
  // missing in the compiled page ("Frontwill print blank").
  it('names the one side that will print blank', () => {
    render(<EmptySurfaceWarning surfaces={[{ key: 'back', label: 'Back' }]} />);
    expect(screen.getByText('One side has no photo')).toBeInTheDocument();
    expect(screen.getByText("Back will print blank. You can continue if that's intended.")).toBeInTheDocument();
  });

  it('lists every blank side', () => {
    render(<EmptySurfaceWarning surfaces={[{ key: 'front', label: 'Front' }, { key: 'back', label: 'Back' }]} />);
    expect(screen.getByText('Some sides have no photo')).toBeInTheDocument();
    expect(screen.getByText("Front, Back will print blank. You can continue if that's intended.")).toBeInTheDocument();
  });
});

describe('DuplicateFillWarning', () => {
  it('renders nothing without duplicates', () => {
    const { container } = render(<DuplicateFillWarning duplicates={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says where a repeated photo is placed', () => {
    render(<DuplicateFillWarning duplicates={[{ fileName: 'beach.jpg', placements: ['Front', 'Back'] }]} />);
    expect(screen.getByText('A photo is used more than once')).toBeInTheDocument();
    expect(screen.getByText('beach.jpg — Front and Back')).toBeInTheDocument();
  });

  it('shows three repeats and counts the rest', () => {
    const duplicates = ['a', 'b', 'c', 'd', 'e'].map(n => ({ fileName: `${n}.jpg`, placements: ['page 1', 'page 2'] }));
    render(<DuplicateFillWarning duplicates={duplicates} />);
    expect(screen.getByText('Some photos are used more than once')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.queryByText(/^d\.jpg/)).not.toBeInTheDocument();
    expect(screen.getByText('…and 2 more')).toBeInTheDocument();
  });
});

describe('LowDpiWarning', () => {
  it('renders nothing when every photo is sharp enough', () => {
    const { container } = render(<LowDpiWarning frames={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names each soft photo by side (or canvas number) with its rounded DPI', () => {
    render(<LowDpiWarning frames={[lowDpi(0, 0, 142.6, 'Front'), lowDpi(2, 1, 88.2)]} />);
    expect(screen.getByText('Some photos are below print resolution')).toBeInTheDocument();
    expect(screen.getByText('Front, photo 1 — ~143 DPI')).toBeInTheDocument();
    expect(screen.getByText('Canvas 3, photo 2 — ~88 DPI')).toBeInTheDocument();
  });

  it('shows three and counts the rest', () => {
    render(<LowDpiWarning frames={[0, 1, 2, 3].map(i => lowDpi(i, 0, 120))} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('…and 1 more')).toBeInTheDocument();
  });
});

describe('QtyShortfallWarning', () => {
  it('renders nothing when the order has no quantity', () => {
    const { container } = render(<QtyShortfallWarning uploaded={3} needed={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once the quantity is met or passed', () => {
    const { container, rerender } = render(<QtyShortfallWarning uploaded={5} needed={5} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<QtyShortfallWarning uploaded={6} needed={5} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says how many photos are placed out of how many were ordered', () => {
    render(<QtyShortfallWarning uploaded={3} needed={5} />);
    expect(screen.getByText('You have uploaded only 3 out of 5 photos')).toBeInTheDocument();
    expect(screen.getByText('Go back to add more or repeat from uploaded ones.')).toBeInTheDocument();
  });
});

describe('UnprintableTextNote', () => {
  it('renders nothing when the whole text prints', () => {
    const { container } = render(<UnprintableTextNote chars={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says they won’t print and what to use instead', () => {
    render(<UnprintableTextNote chars={['\u{1F57A}', '\u{1F3B6}']} />);
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent(UNPRINTABLE_HELP);
    expect(note).toHaveTextContent('Please use the cliparts, images or icons from the sidebar instead.');
  });
});

describe('UnprintableTextNote after a removal', () => {
  it('says the characters are not supported and were removed, though the box is clean again', () => {
    render(<UnprintableTextNote chars={[]} removed />);
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent(UNSUPPORTED_REMOVED);
    expect(note).toHaveTextContent('not supported in text, so they were removed');
    expect(note).toHaveTextContent('Please use the cliparts, images or icons from the sidebar instead.');
  });
});

describe('UnprintableTextWarning', () => {
  it('renders nothing when every text prints', () => {
    const { container } = render(<UnprintableTextWarning texts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the cards; a single-card side needs no card number', () => {
    render(<UnprintableTextWarning texts={[{ where: 'Canvas 2', chars: ['\u{1F57A}'] }, { where: 'Back', chars: ['\u{1F3B6}'] }]} />);
    expect(screen.getByText('Some of your text won’t print')).toBeInTheDocument();
    expect(screen.getByText('Canvas 2, Back')).toBeInTheDocument();
    expect(screen.getByText(UNPRINTABLE_HELP)).toBeInTheDocument();
  });
});

describe('TextRemovedToast', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows nothing when the editor opens, whatever was removed before', () => {
    render(<TextRemovedToast removals={3} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('appears when characters are removed, pointing to the sidebar, and goes after eight seconds', () => {
    const { rerender } = render(<TextRemovedToast removals={0} />);
    rerender(<TextRemovedToast removals={1} />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent(UNSUPPORTED_REMOVED);
    expect(toast).toHaveTextContent('Please use the cliparts, images or icons from the sidebar instead.');
    act(() => { jest.advanceTimersByTime(7999); });
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('can be dismissed, and comes back for the next removal', () => {
    const { rerender } = render(<TextRemovedToast removals={0} />);
    rerender(<TextRemovedToast removals={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<TextRemovedToast removals={2} />);
    expect(screen.getByRole('status')).toHaveTextContent(UNSUPPORTED_REMOVED);
  });

  it('starts its eight seconds again when more is removed while it is showing', () => {
    const { rerender } = render(<TextRemovedToast removals={0} />);
    rerender(<TextRemovedToast removals={1} />);
    act(() => { jest.advanceTimersByTime(6000); });
    rerender(<TextRemovedToast removals={2} />);
    act(() => { jest.advanceTimersByTime(6000); });
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(2000); });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
