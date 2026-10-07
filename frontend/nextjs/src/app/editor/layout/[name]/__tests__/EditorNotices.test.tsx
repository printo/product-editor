import { render, screen } from '@testing-library/react';
import {
  EmptySurfaceWarning, DuplicateFillWarning, LowDpiWarning, QtyShortfallWarning,
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
