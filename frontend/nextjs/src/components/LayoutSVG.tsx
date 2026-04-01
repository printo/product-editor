'use client';

import React from 'react';

interface LayoutSVGProps {
  layout: any;
  className?: string;
  surfaceKey?: string;
  maskUrl?: string;
}

export const LayoutSVG = ({ layout, className = "w-full h-full", surfaceKey, maskUrl: maskUrlProp }: LayoutSVGProps) => {
  if (!layout) return null;

  // Handle multi-surface vs single surface layouts
  const activeSurface = surfaceKey && layout.surfaces 
    ? layout.surfaces.find((s: any) => s.key === surfaceKey)
    : layout;

  const canvas = activeSurface.canvas || layout.canvas || { width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4 };
  const frames = activeSurface.frames || layout.frames || [];
  const borderRadiusMm = layout.borderRadiusMm || 0; 
  const maskUrl = maskUrlProp || activeSurface.maskUrl || layout.maskUrl;

  const viewBox = `0 0 ${canvas.width} ${canvas.height}`;
  const dpi = canvas.dpi || 300;
  const mmToPx = (mm: number) => (mm / 25.4) * dpi;
  const borderRadiusPx = mmToPx(borderRadiusMm);

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
        const bleedPx = mmToPx(bleedMm);
        const frameRadiusMm = frame.borderRadiusMm || borderRadiusMm;
        const frameRadiusPx = mmToPx(frameRadiusMm);

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

      {/* Mask Overlay */}
      {maskUrl && (
        <image
          href={maskUrl}
          x="0"
          y="0"
          width={canvas.width}
          height={canvas.height}
          preserveAspectRatio="none"
          style={{ pointerEvents: 'none' }}
        />
      )}
    </svg>
  );
};
