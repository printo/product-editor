import { fireEvent, render, screen } from '@testing-library/react';
import { BookPageCount, BookSpreadPreview, type BookPreviewPage } from '../BookSpreadPreview';

const page = (key: string, label: string, dataUrl: string | null = 'data:image/png;base64,AA'): BookPreviewPage =>
  ({ key, label, dataUrl, canvasWidth: 1200, canvasHeight: 1800, canvasWidthMm: 200 });

describe('BookPageCount', () => {
  const setup = (over: Partial<Parameters<typeof BookPageCount>[0]> = {}) => {
    const props = {
      isBookProduct: true, bookPageBounds: [8, 40, 4, 20] as [number, number, number, number], bookPageCount: 20,
      handleBookPageCountChange: jest.fn(), setShowSpreadPreview: jest.fn(), ...over,
    };
    return { ...render(<BookPageCount {...props} />), props };
  };

  it('shows nothing for a product that is not a book, or a book without page bounds', () => {
    expect(setup({ isBookProduct: false }).container).toBeEmptyDOMElement();
    expect(setup({ bookPageBounds: null }).container).toBeEmptyDOMElement();
  });

  it('steps the page count by the layout step and opens the spread preview', () => {
    const { props } = setup();
    expect(screen.getByText('8–40 pages, in steps of 4')).toBeInTheDocument();
    expect(screen.getByText('20 pages')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fewer pages' }));
    fireEvent.click(screen.getByRole('button', { name: 'More pages' }));
    expect((props.handleBookPageCountChange as jest.Mock).mock.calls).toEqual([[16], [24]]);
    fireEvent.click(screen.getByRole('button', { name: 'Preview spreads' }));
    expect(props.setShowSpreadPreview).toHaveBeenCalledWith(true);
  });

  it('stops at the bounds', () => {
    const { unmount } = setup({ bookPageCount: 8 });
    expect(screen.getByRole('button', { name: 'Fewer pages' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More pages' })).toBeEnabled();
    unmount();
    setup({ bookPageCount: 40 });
    expect(screen.getByRole('button', { name: 'More pages' })).toBeDisabled();
  });
});

describe('BookSpreadPreview', () => {
  const setup = (over: Partial<Parameters<typeof BookSpreadPreview>[0]> = {}) => {
    const props = {
      showSpreadPreview: true, setShowSpreadPreview: jest.fn(), bookSpreads: [] as BookPreviewPage[][],
      bookCoverPreview: null, bookBackCoverPreview: null, bookSpineWidthMm: null, ...over,
    };
    return { ...render(<BookSpreadPreview {...props} />), props };
  };

  it('shows nothing until opened, and closes', () => {
    expect(setup({ showSpreadPreview: false }).container).toBeEmptyDOMElement();
    const { props } = setup();
    expect(screen.getByText('No pages to preview yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close spread preview' }));
    expect(props.setShowSpreadPreview).toHaveBeenCalledWith(false);
  });

  it('draws the cover wrap back · spine · front with the spine width', () => {
    setup({ bookCoverPreview: page('cover', 'Front Cover'), bookBackCoverPreview: page('back_cover', 'Back Cover'), bookSpineWidthMm: 6.24 });
    expect(screen.getByAltText('Back cover')).toBeInTheDocument();
    expect(screen.getByAltText('Front cover')).toBeInTheDocument();
    expect(screen.getByText('Spine')).toBeInTheDocument();
    expect(screen.getByTitle('Spine: 6.2mm')).toBeInTheDocument();
    expect(screen.getByText(/Cover wrap — back · spine/).textContent).toBe('Cover wrap — back · spine (~6.2mm) · front');
    expect(screen.queryByText('No pages to preview yet.')).toBeNull();
  });

  it('a spine too thin to label is drawn unlabelled', () => {
    setup({ bookCoverPreview: page('cover', 'Front Cover'), bookSpineWidthMm: 2 });
    expect(screen.queryByText('Spine')).toBeNull();
  });

  it('lists the inner spreads with their page labels, and a placeholder for a blank page', () => {
    setup({ bookSpreads: [[page('page_01', 'Page 1')], [page('page_02', 'Page 2', null), page('page_03', 'Page 3')]] });
    expect(screen.getByText('Page 1')).toBeInTheDocument();
    expect(screen.getByText('Page 2 · Page 3')).toBeInTheDocument();
    expect(screen.getByAltText('Page 3')).toBeInTheDocument();
    expect(screen.queryByAltText('Page 2')).toBeNull();
  });
});
