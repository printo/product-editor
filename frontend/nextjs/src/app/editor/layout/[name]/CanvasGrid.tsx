'use client';

import { displayLabelFor } from '@/lib/calendar';
import { CanvasCard, SurfaceCard, type CardProps } from './CanvasCard';
import { CalendarGridZone, CalendarRepeatCard, type CalendarCardsConfig } from './CalendarCards';
import type { CanvasItem, SurfaceState } from './types';

/** The cards: one per side for a multi-surface product, else a responsive grid
 *  of canvases. A one-month-a-page calendar draws each month's page: card i is
 *  month i with its date grid, and months past the last photo follow as cards
 *  repeating an earlier photo, as the print does. */
export function CanvasGrid({ canvases, surfaceStates, calendar, ...card }: CardProps & {
  canvases: CanvasItem[];
  surfaceStates: SurfaceState[];
  calendar?: CalendarCardsConfig | null;
}) {
  const cardCount = Math.max(canvases.length, calendar?.pages.length ?? 0);
  const aspectRatio = `${card.layout.canvas?.width || 1200} / ${card.layout.canvas?.height || 1800}`;
  return (
    <>
      {canvases.length > 0 && (
        <section className="space-y-6 pt-0">
          {surfaceStates.length > 1 ? (
            <div className="flex gap-6 items-start justify-center overflow-x-auto pb-4 px-4 w-full custom-scrollbar">
              {surfaceStates.map((surface) => (
                <SurfaceCard key={surface.key} surface={surface} {...card} />
              ))}
            </div>
          ) : (
            // A centred, wrapping flex row rather than a grid: a grid's fixed
            // column tracks leave a lone card (or a short last row) hugging
            // the left edge, while flex centres whatever the row holds. Each
            // card sets its own width (canvasCardWidthClass): a comfortable
            // size when there are only a few, else the share a grid column
            // had. A card never shrinks to its content width (an earlier
            // `sm:w-auto` left dead space between cards).
            <div className="flex flex-wrap justify-center gap-3 sm:gap-3.5">
              {canvases.map((canvas, idx) => {
                const page = calendar?.pages[idx];
                if (!calendar || !page) return <CanvasCard key={idx} canvas={canvas} idx={idx} cardCount={cardCount} {...card} />;
                return (
                  <CanvasCard
                    key={idx} canvas={canvas} idx={idx} cardCount={cardCount} {...card}
                    title={displayLabelFor(page.year, page.month)} subtitle={`Image ${idx + 1}`}
                  >
                    <CalendarGridZone page={page} calendar={calendar} />
                  </CanvasCard>
                );
              })}
              {calendar?.pages.slice(canvases.length).map(page => (
                <CalendarRepeatCard
                  key={`repeat-${page.surfaceIndex}`} page={page} calendar={calendar} aspectRatio={aspectRatio} cardCount={cardCount}
                  sourceDataUrl={canvases[page.canvasIdx]?.dataUrl ?? undefined}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
