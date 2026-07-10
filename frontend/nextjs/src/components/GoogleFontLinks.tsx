'use client';

import { useCallback, useState } from 'react';

const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace', 'cursive'];

const fontHref = (fontName: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700&display=swap`;

/**
 * Tracks which Google fonts the editor has asked for. `loadGoogleFont` only
 * records the name — rendering `<GoogleFontLinks>` is what actually loads it.
 *
 * Returning `prev` unchanged when the font is already known keeps this safe to
 * call from an effect that also depends on it.
 */
export function useGoogleFonts() {
  const [fontsLoaded, setFontsLoaded] = useState<Set<string>>(new Set());

  const loadGoogleFont = useCallback((fontName: string) => {
    if (GENERIC_FAMILIES.includes(fontName)) return;
    setFontsLoaded(prev => (prev.has(fontName) ? prev : new Set(prev).add(fontName)));
  }, []);

  return { fontsLoaded, loadGoogleFont };
}

/**
 * React 19 hoists `<link rel="stylesheet">` into `<head>` and dedupes by href,
 * so the stylesheets unmount with the editor instead of accumulating in the
 * document the way a manual `document.head.appendChild` did.
 */
export function GoogleFontLinks({ fonts }: { fonts: Set<string> }) {
  return (
    <>
      {[...fonts].map(fontName => (
        <link key={fontName} rel="stylesheet" href={fontHref(fontName)} precedence="default" />
      ))}
    </>
  );
}
