'use client';

import React from 'react';

interface LayoutSVGProps {
  layout: any;
  className?: string;
  showFrames?: boolean;
}

export const LayoutSVG: React.FC<LayoutSVGProps> = ({ 
  layout, 
  className = "max-w-full max-h-full drop-shadow-md bg-white",
  showFrames = true
}) => {
  if (!layout) return null;

  const w = Math.max(layout.canvas?.width || 1200, 1);
  const h = Math.max(layout.canvas?.height || 1800, 1);
  const frames = layout.frames || [];

  return (
    <svg 
      viewBox={`0 0 ${w} ${h}`} 
      className={className}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect width={w} height={h} fill="white" />
      {showFrames && frames.map((f: any, i: number) => {
        // If values are <= 1, assume they are percentages and scale by width/height
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
      {layout.maskUrl && (
        <image 
          href={layout.maskUrl} 
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
