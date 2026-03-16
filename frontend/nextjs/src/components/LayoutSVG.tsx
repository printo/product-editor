'use client';

import React from 'react';
import { normalizeLayout, getSurface } from '@/lib/layout-utils';

interface LayoutSVGProps {
  layout: any;
  className?: string;
  showFrames?: boolean;
  /** For multi-surface layouts, render only this surface. Defaults to first surface. */
  surfaceKey?: string;
}

export const LayoutSVG: React.FC<LayoutSVGProps> = ({
  layout,
  className = "max-w-full max-h-full drop-shadow-md bg-white",
  showFrames = true,
  surfaceKey,
}) => {
  if (!layout) return null;

  const normalized = normalizeLayout(layout);
  const surface = getSurface(normalized, surfaceKey);
  if (!surface) return null;

  const w = Math.max(surface.canvas?.width || 1200, 1);
  const h = Math.max(surface.canvas?.height || 1800, 1);
  const frames = surface.frames || [];

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect width={w} height={h} fill="white" />
      {showFrames && frames.map((f: any, i: number) => {
        const isPercent = (f.width <= 1 && f.height <= 1);
        const rectX = isPercent ? f.x * w : f.x;
        const rectY = isPercent ? f.y * h : f.y;
        const rectW = isPercent ? f.width * w : f.width;
        const rectH = isPercent ? f.height * h : f.height;

        return (
          <rect
            key={i}
            x={rectX}
            y={rectY}
            width={rectW}
            height={rectH}
            fill="#e2e8f0"
            stroke="#94a3b8"
            strokeWidth={Math.max(w, h) * 0.005}
          />
        );
      })}
      {surface.maskUrl && (
        <image
          href={surface.maskUrl}
          x="0"
          y="0"
          width={w}
          height={h}
          preserveAspectRatio="none"
        />
      )}
    </svg>
  );
};
