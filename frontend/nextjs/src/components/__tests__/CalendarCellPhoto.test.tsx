/**
 * Where a moved photo is drawn. The move is stored as seen on the page; the
 * picture is positioned before it is turned, so each turn maps it differently.
 */
import { render, screen } from '@testing-library/react';
import { CalendarCellPhoto } from '@/components/CalendarCellPhoto';
import type { CellImagePlacement } from '@/types/calendar';

const drawnAt = (over: Partial<CellImagePlacement>) => {
  const { unmount } = render(
    <CalendarCellPhoto src="blob:p" alt="photo" className="relative"
      placement={{ fit: 'cover', rotation: 0, blur: false, panX: 0, panY: 0, ...over }} />,
  );
  const position = (screen.getByAltText('photo') as HTMLImageElement).style.objectPosition;
  unmount();
  return position;
};

describe('CalendarCellPhoto', () => {
  it('an untouched photo sits in the centre', () => {
    expect(drawnAt({})).toBe('50% 50%');
  });

  it('moved right shows the photo’s left side; moved down shows its top', () => {
    expect(drawnAt({ panX: 1 })).toBe('0% 50%');
    expect(drawnAt({ panX: -1 })).toBe('100% 50%');
    expect(drawnAt({ panY: 1 })).toBe('50% 0%');
    expect(drawnAt({ panX: 0.5, panY: -0.5 })).toBe('25% 75%');
  });

  it('a move on the page is turned back into the picture’s own axes', () => {
    // A quarter turn clockwise: the picture's left side is at the top of the page.
    expect(drawnAt({ rotation: 90, panY: 1 })).toBe('0% 50%');
    expect(drawnAt({ rotation: 90, panX: 1 })).toBe('50% 100%');
    expect(drawnAt({ rotation: 180, panX: 1, panY: 1 })).toBe('100% 100%');
    expect(drawnAt({ rotation: 270, panY: 1 })).toBe('100% 50%');
    expect(drawnAt({ rotation: 270, panX: 1 })).toBe('50% 0%');
  });
});
