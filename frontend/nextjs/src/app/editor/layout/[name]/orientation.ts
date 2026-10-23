/** What the server did with the orientation asked for (the `orientation`
 *  object on /editor/init; twin of services/layout_orientation.apply_orientation). */
export type OrientationReport = {
  requested: 'portrait' | 'landscape' | null;
  applied: boolean;
  reason: string | null;
  orientation: 'portrait' | 'landscape' | 'square' | null;
  /** Why the layout can never be turned, whatever was asked; null when it can. */
  blocked: string | null;
};

export type OrientationChoice = 'portrait' | 'landscape';

/** Reasons the layout cannot be turned, in words for the toggle's tooltip. */
const CANNOT_TURN: Record<string, string> = {
  not_rotatable: 'This layout is switched off for rotating.',
  has_captions: 'This layout has captions, so it stays as designed.',
  has_overlays: 'This layout has fixed text or stickers, so it stays as designed.',
  svg_mask: 'This layout has an SVG mask, so it stays as designed.',
  square_layout: 'This layout is square, so it has no portrait or landscape.',
};

/** Why the toggle is locked, or null when either orientation can be chosen. */
export function orientationLockedReason(report: OrientationReport | null): string | null {
  if (!report?.blocked) return null;
  return CANNOT_TURN[report.blocked] ?? null;
}

/** The orientation the layout was drawn in. The report says what is served;
 *  when it was turned, the drawn one is the other. */
export function authoredOrientation(report: OrientationReport | null): OrientationChoice | null {
  if (!report?.orientation || report.orientation === 'square') return null;
  if (!report.applied) return report.orientation;
  return report.orientation === 'portrait' ? 'landscape' : 'portrait';
}

/** The address to open for `choice`: the layout's own orientation drops the
 *  param, and a fresh order id is generated (no `order_id`) so a design saved
 *  for the other shape is never restored onto it. Other params are kept. */
export function orientationSwitchSearch(search: string, choice: OrientationChoice, authored: OrientationChoice | null): string {
  const sp = new URLSearchParams(search);
  sp.delete('order_id');
  sp.delete('canvas');
  if (choice === authored) sp.delete('orientation');
  else sp.set('orientation', choice);
  const out = sp.toString();
  return out ? `?${out}` : '';
}
