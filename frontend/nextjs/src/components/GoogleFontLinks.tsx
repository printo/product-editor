'use client';

import { useCallback, useEffect, useState } from 'react';
import { configurePrintFonts, isGenericFont, loadBlankFont } from '@/lib/overlay-fonts';


const fontHref = (fontName: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700&display=swap`;

/**
 * Tracks which Google fonts the editor has asked for. `loadGoogleFont` only
 * records the name — rendering `<GoogleFontLinks>` is what actually loads it.
 *
 * Returning `prev` unchanged when the font is already known keeps this safe to
 * call from an effect that also depends on it.
 */
export function useGoogleFonts(printFonts?: { apiBase: string; getAuthHeaders: () => Record<string, string> }) {
  const [fontsLoaded, setFontsLoaded] = useState<Set<string>>(new Set());

  // Every page that draws text overlays uses this hook, so this is where the
  // canvas learns where the print's font files are served (the page's proxy),
  // and where the blank fallback font is fetched, well before any text is
  // drawn. The canvas draws from those files, not from the Google copies
  // loaded below, which the font picker shows (lib/overlay-fonts.ts).
  const apiBase = printFonts?.apiBase;
  const getAuthHeaders = printFonts?.getAuthHeaders;
  useEffect(() => {
    if (!apiBase || !getAuthHeaders) return;
    configurePrintFonts({ apiBase, getAuthHeaders });
    void loadBlankFont();
  }, [apiBase, getAuthHeaders]);

  const loadGoogleFont = useCallback((fontName: string) => {
    if (isGenericFont(fontName)) return;
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
