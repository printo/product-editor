import { render, screen } from '@testing-library/react';
import CanvasCardSkeleton from '../CanvasCardSkeleton';

describe('CanvasCardSkeleton', () => {
  it('renders one placeholder card per requested count', () => {
    const { container } = render(<CanvasCardSkeleton count={4} aspectRatio="1200 / 1800" />);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });

  it('applies the supplied aspect ratio to the thumbnail box', () => {
    // The skeleton must reserve the same space the real card will occupy,
    // otherwise the swap to real cards shifts the page.
    const { container } = render(<CanvasCardSkeleton count={1} aspectRatio="1050 / 875" />);
    const thumb = container.querySelector('[aria-hidden="true"] > div');
    expect(thumb).toHaveStyle({ aspectRatio: '1050 / 875' });
  });

  it('announces the restore to assistive tech without exposing the decorative cards', () => {
    render(<CanvasCardSkeleton count={3} aspectRatio="1200 / 1800" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Restoring your saved design');
    // Cards carry no semantics of their own — they are pure visual filler.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders nothing but the live region when count is zero', () => {
    const { container } = render(<CanvasCardSkeleton count={0} aspectRatio="1200 / 1800" />);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('keeps the grid column classes in step with the real card grid', () => {
    // Guards the geometry contract with page.tsx: if the card grid's column
    // ramp changes, this fails and the skeleton gets updated alongside it.
    const { container } = render(<CanvasCardSkeleton count={2} aspectRatio="1200 / 1800" />);
    const grid = container.querySelector('.grid');
    expect(grid).toHaveClass(
      'grid-cols-1',
      'sm:grid-cols-2',
      'md:grid-cols-3',
      'lg:grid-cols-4',
      'xl:grid-cols-5',
      '2xl:grid-cols-7',
    );
  });
});
