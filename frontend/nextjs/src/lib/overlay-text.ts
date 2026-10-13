/**
 * The text box a text overlay wraps in, shared by the live editor
 * (FabricEditor.tsx), the card thumbnail (fabric-renderer.ts) and — by the
 * same rule, in Python — the print (services/overlay_renderer.py).
 *
 * `TextOverlay.width` is the box width as a percentage of the canvas, saved
 * when the customer resizes the box in the editor. Overlays saved before it
 * existed have none and get the editor's historical default, 80% of the
 * canvas, so they keep wrapping where they always did. Until 2026-10-13 the
 * thumbnail built its Textbox with no width (every word on its own line) and
 * the print never wrapped at all.
 */

export const DEFAULT_TEXT_BOX_WIDTH_PCT = 80;

/** The wrap box width in canvas px for an overlay with an optional `width` (%). */
export function textBoxWidthPx(overlay: { width?: number }, canvasW: number): number {
  const pct = overlay.width != null && overlay.width > 0 ? overlay.width : DEFAULT_TEXT_BOX_WIDTH_PCT;
  return (pct / 100) * canvasW;
}

/** Where (x, y) sits on the box: its left edge, right edge or centre, by textAlign. */
export function textOriginX(textAlign: string | undefined): 'left' | 'center' | 'right' {
  return textAlign === 'left' ? 'left' : textAlign === 'right' ? 'right' : 'center';
}
