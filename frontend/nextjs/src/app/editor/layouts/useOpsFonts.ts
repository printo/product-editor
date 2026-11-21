/**
 * The ops font list: read once signed in, saved when ops tick a font, and each
 * listed font loaded for the picker's preview.
 * Moved out of page.tsx unchanged (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, step 3).
 */
import { useCallback, useEffect, useState } from 'react';
import { useGoogleFonts } from '@/components/GoogleFontLinks';
import { DEFAULT_OVERLAY_FONT, pickerFonts } from '@/lib/overlay-fonts';

export function useOpsFonts(accessToken: string | undefined) {
  const [selectedFonts, setSelectedFonts] = useState<string[]>([DEFAULT_OVERLAY_FONT]);
  const { fontsLoaded, loadGoogleFont } = useGoogleFonts();
  const [isSavingFonts, setIsSavingFonts] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    fetch('/api/internal/proxy/fonts', {
      headers: { Accept: 'application/json' },
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.fonts) setSelectedFonts(pickerFonts(data.fonts)); })
      .catch(() => {});
  }, [accessToken]);

  const saveFontsToBackend = useCallback(async (fonts: string[]) => {
    if (!accessToken) return;
    setIsSavingFonts(true);
    try {
      await fetch('/api/internal/proxy/fonts', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ fonts }),
      });
    } catch {}
    setIsSavingFonts(false);
  }, [accessToken]);

  // Pre-load selected Google Fonts for preview
  useEffect(() => {
    selectedFonts.forEach(f => loadGoogleFont(f));
  }, [selectedFonts, loadGoogleFont]);

  return { selectedFonts, setSelectedFonts, fontsLoaded, loadGoogleFont, isSavingFonts, saveFontsToBackend };
}
