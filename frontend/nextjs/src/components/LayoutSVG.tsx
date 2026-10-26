'use client';

import React from 'react';
import { mmToPx } from '@/lib/units';
import { resolveMaskSlots } from '@/lib/mask-slots';
import { printSheetAreasPx } from '@/lib/print-sheet';

interface LayoutSVGProps {
  layout: any;
  className?: string;
  surfaceKey?: string;
  /** Overrides the frame-picture slot (outside the bleed area). */
  maskUrl?: string;
}

// The dashed guides the ops preview and the live editor use for the same two
// things: the visible area in emerald, the bleed in rose.
const VISIBLE_STROKE = '#10b981';
const BLEED_STROKE = '#f43f5e';

export const LayoutSVG = ({ layout, className = "w-full h-full", surfaceKey, maskUrl: maskUrlProp }: LayoutSVGProps) => {
  if (!layout) return null;

  // Handle multi-surface vs single surface layouts
  const activeSurface = surfaceKey && layout.surfaces
    ? layout.surfaces.find((s: any) => s.key === surfaceKey)
    : layout;

  // Book layouts (productType === 'book') carry no root-level canvas/frames —
  // by design (BOOK_LAYOUT_PRD.md D7), each role authors its own canvas under
  // `book.cover` / `book.innerPage` / `book.backCover`. Without this, every
  // book fell through to the generic placeholder default below. The front
  // cover is the representative thumbnail — same as the editor's card grid,
  // which always shows the cover first.
  const bookCover = layout.productType === 'book' ? layout.book?.cover : undefined;

  const canvas = activeSurface?.canvas || layout.canvas || bookCover?.canvas
    || { width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4 };
  const frames = activeSurface?.frames || layout.frames || bookCover?.frames || [];
  const borderRadiusMm = layout.borderRadiusMm || 0;

  // The block whose masks and print sheet this drawing shows: the surface,
  // the root, or the book's front cover.
  const block = activeSurface?.canvas ? activeSurface : (bookCover ?? layout);
  const slots = resolveMaskSlots(block);
  const frameMaskUrl = maskUrlProp || slots.frameMaskUrl;
  const artworkMaskUrl = slots.artworkMaskUrl;
  // Calendars and books always print whole; only a generic layout has a sheet.
  const sheet = layout.productType === 'calendar' || layout.productType === 'book'
    ? null
    : printSheetAreasPx(block?.printSheet, canvas, frames);

  const viewBox = `0 0 ${canvas.width} ${canvas.height}`;
  const dpi = canvas.dpi || 300;
  const borderRadiusPx = mmToPx(borderRadiusMm, dpi);

  return (
    <svg viewBox={viewBox} className={className} xmlns="http://www.w3.org/2000/svg">
      {/* Background with optional rounded corners */}
      <rect
        x="0" y="0"
        width={canvas.width} height={canvas.height}
        fill="white"
        rx={borderRadiusPx} ry={borderRadiusPx}
      />

      {/* Render Frames (Print Areas) */}
      {frames.map((frame: any, i: number) => {
        const x = frame.x * canvas.width;
        const y = frame.y * canvas.height;
        const w = frame.width * canvas.width;
        const h = frame.height * canvas.height;
        const bleedMm = Number(frame.bleedMm || 0);
        const bleedPx = mmToPx(bleedMm, dpi);
        const frameRadiusMm = frame.borderRadiusMm || borderRadiusMm;
        const frameRadiusPx = mmToPx(frameRadiusMm, dpi);

        return (
          <g key={i}>
            {/* Bleed Area (Dashed Line) */}
            {bleedMm > 0 && (
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                fill="none"
                stroke="#6366f1"
                strokeWidth="1"
                strokeDasharray="4 2"
                opacity="0.3"
                rx={frameRadiusPx} ry={frameRadiusPx}
              />
            )}
            {/* Print Area */}
            <rect
              x={x + bleedPx}
              y={y + bleedPx}
              width={w - bleedPx * 2}
              height={h - bleedPx * 2}
              fill="#e2e8f0"
              stroke="#94a3b8"
              strokeWidth="2"
              rx={frameRadiusPx} ry={frameRadiusPx}
            />
          </g>
        );
      })}

      {/* Masks: the artwork (inside the bleed area, printed) under the frame
          picture (outside it, preview only) — the customer preview's order. */}
      {artworkMaskUrl && (
        <image
          data-mask="artwork"
          href={artworkMaskUrl}
          x="0"
          y="0"
          width={canvas.width}
          height={canvas.height}
          preserveAspectRatio="none"
          style={{ pointerEvents: 'none' }}
        />
      )}
      {frameMaskUrl && (
        <image
          data-mask="frame"
          href={frameMaskUrl}
          x="0"
          y="0"
          width={canvas.width}
          height={canvas.height}
          preserveAspectRatio="none"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* The print sheet: what the print file is when the layout prints its
          bleed area rather than the whole canvas. Visible area, then the
          bleed around it. */}
      {sheet && (
        <g data-print-sheet="bleed" style={{ pointerEvents: 'none' }}>
          <rect
            x={sheet.visible.x} y={sheet.visible.y}
            width={sheet.visible.width} height={sheet.visible.height}
            fill="none" stroke={VISIBLE_STROKE} strokeWidth="3" strokeDasharray="12 8" opacity="0.9"
          />
          <rect
            x={sheet.bleed.x} y={sheet.bleed.y}
            width={sheet.bleed.width} height={sheet.bleed.height}
            fill="none" stroke={BLEED_STROKE} strokeWidth="3" strokeDasharray="12 8" opacity="0.9"
          />
        </g>
      )}
    </svg>
  );
};
