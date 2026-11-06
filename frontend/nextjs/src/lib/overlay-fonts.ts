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

/**
 * A font with an empty, zero-wide glyph for every character
 * (public/fonts/pe-blank.ttf, built by scripts/make-blank-font.py).
 */
export const BLANK_FONT = 'PE Blank';
const BLANK_FONT_URL = '/fonts/pe-blank.ttf';
// The bundled Inter is a variable font with an optical-size axis. A browser
// would pick a display cut for large text; the print keeps every axis but
// weight at its default (services/fonts.py), so pin the same here.
const PRINT_FONT_DESCRIPTORS = { weight: '400', variationSettings: '"opsz" 14' } as FontFaceDescriptors & { variationSettings: string };

const quoted = (family: string) => `"${family}"`;
const unquoted = (family: string) => family.replace(/^["']|["']$/g, '');

/**
 * The name a family's print font file is registered under in the browser.
 * Not the family's own name: that one belongs to Google's copy, which the
 * font picker shows, and which leaves out characters the print's file has
 * (the bundled Inter draws ♥ and →; Google's Inter in a browser does not).
 */
export function printFontName(name: string | null | undefined): string {
  return `${overlayFontFamily(name)} (print)`;
}

/** Whether the browser has finished loading a face called `family`. */
function faceLoaded(family: string): boolean {
  let loaded = false;
  document.fonts.forEach(face => {
    if (face.status === 'loaded' && unquoted(face.family) === family) loaded = true;
  });
  return loaded;
}

/** Whether a text in this family can be drawn as the print draws it right
 *  now: the print's font file and the blank font are both loaded. */
export function overlayFontsReady(name: string | null | undefined): boolean {
  if (typeof document === 'undefined' || !document.fonts?.forEach) return false;
  return faceLoaded(BLANK_FONT) && faceLoaded(printFontName(name));
}

/**
 * What the canvas draws a text overlay with: the font file the print uses
 * for the family (`GET /api/fonts/file/<family>`), then the blank font.
 *
 * The print draws from that one file and has no fallback. A browser left to
 * itself borrows a missing glyph (an emoji in a script font) from the device,
 * so the editor showed text the print left out. With the blank font next in
 * line the browser finds an empty glyph there instead, and with the print's
 * own file first it has exactly the print's characters: the editor and the
 * thumbnail show what the print draws, no more and no less.
 *
 * Until both are loaded this is the family from Google, drawn as it always
 * was: a canvas never waits for a font, so listing the blank font early
 * would hide every letter. Callers load the fonts (`loadOverlayFonts`) and
 * draw again when they are ready. If either fails to load, nothing changes
 * from before.
 */
export function overlayFontStack(name: string | null | undefined): string {
  return overlayFontsReady(name)
    ? `${quoted(printFontName(name))}, ${quoted(BLANK_FONT)}`
    : quoted(overlayFontFamily(name));
}

/**
 * The text a canvas draws for an overlay: without the two invisible
 * "variation selector" characters that follow some symbols (the one after a
 * heart asks for the colour emoji). A browser obeys that request by going
 * straight to the device's emoji font, past the font list; the print has no
 * glyph for the selector and ignores it. Dropping it makes the browser draw
 * the heart from the chosen font, or not at all, as the print does.
 */
export function canvasText(text: string): string {
  return text.replace(/[\uFE0E\uFE0F]/g, '');
}

type FontSource = { apiBase: string; getAuthHeaders: () => Record<string, string> };
let fontSource: FontSource | null = null;

/** Where print font files come from: the page's proxy and its auth headers.
 *  Set once by each page that draws text overlays (`useGoogleFonts`). */
export function configurePrintFonts(source: FontSource | null): void {
  fontSource = source;
}

const loading = new Map<string, Promise<void>>();
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 30_000;

function canRegisterFonts(): boolean {
  return typeof document !== 'undefined' && typeof FontFace !== 'undefined' && !!document.fonts?.add;
}

/** Load one font under `name` from whatever `source` yields, once at a time,
 *  and not again for a while after a failure. Resolves either way. */
function register(name: string, source: () => Promise<string | ArrayBuffer>, descriptors?: FontFaceDescriptors): Promise<void> {
  if (!canRegisterFonts() || faceLoaded(name)) return Promise.resolve();
  if (Date.now() - (failedAt.get(name) ?? -Infinity) < RETRY_AFTER_MS) return Promise.resolve();
  let pending = loading.get(name);
  if (!pending) {
    pending = source()
      .then(src => new FontFace(name, src, descriptors).load())
      .then(face => { document.fonts.add(face); })
      .catch(() => { failedAt.set(name, Date.now()); })
      .finally(() => { loading.delete(name); });
    loading.set(name, pending);
  }
  return pending;
}

/** Fetch the blank font and hand it to the browser. Resolves either way. */
export function loadBlankFont(): Promise<void> {
  return register(BLANK_FONT, () => Promise.resolve(`url(${BLANK_FONT_URL})`));
}

/** Fetch the font file the print draws `family` with. Resolves either way. */
function loadPrintFont(family: string): Promise<void> {
  const source = fontSource;
  if (!source) return Promise.resolve();
  return register(printFontName(family), async () => {
    const res = await fetch(`${source.apiBase}/fonts/file/${encodeURIComponent(family)}`, { headers: source.getAuthHeaders() });
    if (!res.ok) throw new Error(`Font file ${res.status}`);
    return res.arrayBuffer();
  }, PRINT_FONT_DESCRIPTORS);
}

/**
 * Load what these text overlays are drawn with: the blank font and each
 * family's print file. Resolves either way; ask `overlayFontsReady` after.
 */
export async function loadOverlayFonts(texts: readonly { fontFamily?: string | null }[]): Promise<void> {
  const families = new Set(texts.map(t => overlayFontFamily(t.fontFamily)));
  await Promise.all([loadBlankFont(), ...[...families].map(loadPrintFont)]);
}

/** A font's name in the picker, with the Indian languages it can print: a name
 *  like "Hind Madurai" does not tell a customer it is the Tamil one. */
export function fontOptionLabel(family: string, languages?: Record<string, string[]>): string {
  const names = languages?.[family];
  return names?.length ? `${family} · ${names.join(', ')}` : family;
}

/** The fonts a picker offers: the ops list without generics, never empty. */
export function pickerFonts(fonts: readonly string[]): string[] {
  const google = fonts.filter(f => f.trim() && !isGenericFont(f));
  return google.length ? google : [DEFAULT_OVERLAY_FONT];
}
