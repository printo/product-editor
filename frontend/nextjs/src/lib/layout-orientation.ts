/** The Portrait / Landscape choice on a dashboard layout card. The orientation
 *  is fixed here, before the editor opens, and rides the editor address as
 *  `?orientation=`; the server does the turning (services/layout_orientation.py). */
export type OrientationChoice = 'portrait' | 'landscape';

/** What `GET /layouts` says about a layout: how it is drawn and why it can
 *  never be turned (null when it can). */
export type OrientationInfo = {
  orientation: OrientationChoice | 'square' | null;
  blocked: string | null;
};

const CANNOT_TURN: Record<string, string> = {
  not_rotatable: 'This layout is switched off for rotating.',
  has_captions: 'This layout has captions, so it stays as designed.',
  has_overlays: 'This layout has fixed text or stickers, so it stays as designed.',
  svg_mask: 'This layout has an SVG mask, so it stays as designed.',
  square_layout: 'This layout is square, so it has no portrait or landscape.',
};

/** Why the choice is locked, in words, or null when either can be chosen. */
export function orientationLockedReason(info: OrientationInfo | null | undefined): string | null {
  if (!info) return 'Orientation is not available for this layout.';
  if (!info.blocked) return info.orientation === 'portrait' || info.orientation === 'landscape' ? null : 'Orientation is not available for this layout.';
  return CANNOT_TURN[info.blocked] ?? 'This layout stays as designed.';
}

/** Published template counts per orientation, as `GET /layouts` carries them
 *  (`templateCounts`): a template faces one way, so a layout opened turned may
 *  offer fewer, or none. */
export type TemplateCounts = Partial<Record<OrientationChoice, number>>;

/** The templates a card promises for the way it will open: the count for the
 *  chosen (else the drawn) orientation when the server gave one, else the
 *  total. Until 2026-10-29 the card said "2 Templates" with Landscape chosen
 *  and the turned layout then offered none. */
export function templateCountFor(total: number, counts: TemplateCounts | null | undefined, choice: OrientationChoice | null, info: OrientationInfo | null | undefined): number {
  const drawn = info?.orientation === 'portrait' || info?.orientation === 'landscape' ? info.orientation : null;
  const facing = orientationLockedReason(info) ? null : choice ?? drawn;
  const n = facing && counts ? counts[facing] : undefined;
  return typeof n === 'number' ? n : total;
}

/** The editor address for a card: the layout's own orientation adds nothing, so
 *  a card left alone opens exactly as before. */
export function layoutEditorHref(layoutId: string, choice: OrientationChoice | null, info: OrientationInfo | null | undefined): string {
  const base = `/editor/layout/${layoutId}`;
  if (!choice || orientationLockedReason(info) || choice === info?.orientation) return base;
  return `${base}?orientation=${choice}`;
}
