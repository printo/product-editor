// Text overlays use Google Fonts only. A CSS generic ('sans-serif', 'cursive')
// renders in whatever font the customer's device has, which the print
// (backend services/google_fonts.py) can't reproduce, so the pickers never
// offer one and an overlay without a family — or with a generic one from an
// older design — is drawn in Inter, the same default the print uses.

export const DEFAULT_OVERLAY_FONT = 'Inter';

const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
]);

export function isGenericFont(name: string): boolean {
  return GENERIC_FAMILIES.has(name.trim().toLowerCase());
}

/** The family a text overlay is drawn in. */
export function overlayFontFamily(name: string | null | undefined): string {
  const family = (name ?? '').trim();
  return !family || isGenericFont(family) ? DEFAULT_OVERLAY_FONT : family;
}

/** The fonts a picker offers: the ops list without generics, never empty. */
export function pickerFonts(fonts: readonly string[]): string[] {
  const google = fonts.filter(f => f.trim() && !isGenericFont(f));
  return google.length ? google : [DEFAULT_OVERLAY_FONT];
}
