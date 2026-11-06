'use client';

import type { CSSProperties } from 'react';
import type { CellImagePlacement } from '@/types/calendar';

/**
 * A date's photo drawn in its box the way the print places it
 * (`_draw_cell_image`): turned, then filling the box and cropped, or shown
 * whole with the sides empty or blurred. The box is whatever `className`
 * sizes this to, and it must be positioned (`relative` or `absolute`); pure CSS, so the date editor's preview and the month
 * grid's tiny cells draw the same thing.
 */
export function CalendarCellPhoto({ src, placement, className, alt = '' }: {
  src: string;
  placement: CellImagePlacement;
  className?: string;
  alt?: string;
}) {
  const sideways = placement.rotation === 90 || placement.rotation === 270;
  // A sideways photo is laid out in the turned box (height x width), then turned back into place.
  const turned: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: sideways ? '100cqh' : '100cqw',
    height: sideways ? '100cqw' : '100cqh',
    maxWidth: 'none',
    transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)`,
  };
  return (
    <div
      className={className}
      style={{ overflow: 'hidden', containerType: 'size' }}
      data-testid="calendar-cell-photo"
      data-fit={placement.fit}
      data-rotation={placement.rotation}
      data-blur={placement.blur ? 'on' : 'off'}
    >
      {placement.blur && (
        // The print stretches the photo over the box and blurs it; scaled up a
        // little here so the soft edge a CSS blur leaves falls outside the box.
        <img
          src={src}
          alt=""
          aria-hidden
          draggable={false}
          style={{
            ...turned,
            objectFit: 'fill',
            filter: 'blur(4cqmin)',
            transform: `${turned.transform} scale(1.2)`,
          }}
        />
      )}
      <img src={src} alt={alt} draggable={false} style={{ ...turned, objectFit: placement.fit }} />
    </div>
  );
}
