import { render } from '@testing-library/react';
import { LayoutSVG } from '../LayoutSVG';

describe('LayoutSVG', () => {
  it('renders a single-canvas layout from its root canvas/frames', () => {
    const layout = {
      canvas: { width: 1200, height: 1800 },
      frames: [{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }],
    };
    const { container } = render(<LayoutSVG layout={layout} />);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 1200 1800');
    expect(container.querySelectorAll('rect')).toHaveLength(2); // background + one print area
  });

  it('renders a multi-surface layout from the matched surface', () => {
    const layout = {
      surfaces: [
        { key: 'front', canvas: { width: 900, height: 600 }, frames: [] },
        { key: 'back', canvas: { width: 700, height: 500 }, frames: [] },
      ],
    };
    const { container } = render(<LayoutSVG layout={layout} surfaceKey="back" />);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 700 500');
  });

  it('falls back to the front cover for a book layout, which has no root canvas', () => {
    // Book layouts carry no top-level canvas/frames by design (D7) — each
    // role authors its own under book.cover / book.innerPage / book.backCover.
    // Before this fix, a book fell through to the generic 1200x1800 default.
    const layout = {
      productType: 'book',
      book: {
        cover: {
          canvas: { width: 1240, height: 1748 },
          frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }],
        },
        innerPage: {
          canvas: { width: 1240, height: 1748 },
          frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }],
        },
      },
    };
    const { container } = render(<LayoutSVG layout={layout} />);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 1240 1748');
    expect(container.querySelectorAll('rect')).toHaveLength(2);
  });

  it('still falls back to the generic default for a layout with no canvas anywhere', () => {
    const { container } = render(<LayoutSVG layout={{}} />);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 1200 1800');
  });

  it('renders nothing for a null layout', () => {
    const { container } = render(<LayoutSVG layout={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('draws the artwork mask under the frame picture', () => {
    const layout = {
      canvas: { width: 1000, height: 1500 },
      frames: [],
      frameMaskUrl: '/api/layouts/masks/frame.png',
      artworkMaskUrl: '/api/layouts/masks/art.png',
    };
    const { container } = render(<LayoutSVG layout={layout} />);
    const images = Array.from(container.querySelectorAll('image'));
    expect(images.map(i => i.getAttribute('data-mask'))).toEqual(['artwork', 'frame']);
    expect(images[1].getAttribute('href')).toBe('/api/layouts/masks/frame.png');
  });

  it('reads a legacy mask into the right slot', () => {
    const { container } = render(<LayoutSVG layout={{ canvas: { width: 10, height: 10 }, frames: [], maskUrl: '/m.png', maskOnExport: true }} />);
    expect(container.querySelector('image')).toHaveAttribute('data-mask', 'artwork');
  });

  it('draws the bleed area as two dashed rectangles when the layout prints it', () => {
    const layout = {
      canvas: { width: 1000, height: 1500, widthMm: 100, heightMm: 150 },
      frames: [{ x: 0.17, y: 0.18, width: 0.66, height: 0.64, bleedMm: 3 }],
      printSheet: { mode: 'bleed' },
    };
    const { container } = render(<LayoutSVG layout={layout} />);
    const sheet = container.querySelector('[data-print-sheet]');
    expect(sheet).not.toBeNull();
    const [visible, bleed] = Array.from(sheet!.querySelectorAll('rect'));
    expect(bleed).toHaveAttribute('x', '170');
    expect(bleed).toHaveAttribute('width', '660');
    expect(visible).toHaveAttribute('x', '200');
    expect(visible).toHaveAttribute('width', '600');
    expect(bleed).toHaveAttribute('stroke', '#f43f5e');
  });

  it('draws no sheet for a whole-canvas layout', () => {
    const { container } = render(<LayoutSVG layout={{ canvas: { width: 10, height: 10 }, frames: [], printSheet: { mode: 'canvas' } }} />);
    expect(container.querySelector('[data-print-sheet]')).toBeNull();
  });
});
