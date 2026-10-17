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
            // `justify-items-center` + the card's `sm:w-auto` made each card
            // shrink to its CONTENT width (~187px, set by the meta label and
            // action rail) and centre inside a much wider grid column. The
            // surplus showed up as dead space between cards — 63px of visible
            // gap at 5 columns despite gap-3.5, and worse as columns widen.
            // Shrinking `gap` never touched it.
            //
            // Stretch from sm up so a card fills its column: the gutter is
            // then exactly the gap, and the thumbnail gets the reclaimed
            // width instead. Mobile keeps centring, where the card is a fixed
            // 86vw and is meant to sit centred.
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7 gap-3 sm:gap-3.5 justify-items-center sm:justify-items-stretch">
              {canvases.map((canvas, idx) => {
                const page = calendar?.pages[idx];
                if (!calendar || !page) return <CanvasCard key={idx} canvas={canvas} idx={idx} {...card} />;
                return (
                  <CanvasCard
                    key={idx} canvas={canvas} idx={idx} {...card}
                    title={displayLabelFor(page.year, page.month)} subtitle={`Image ${idx + 1}`}
                  >
                    <CalendarGridZone page={page} calendar={calendar} />
                  </CanvasCard>
                );
              })}
              {calendar?.pages.slice(canvases.length).map(page => (
                <CalendarRepeatCard
                  key={`repeat-${page.surfaceIndex}`} page={page} calendar={calendar} aspectRatio={aspectRatio}
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
