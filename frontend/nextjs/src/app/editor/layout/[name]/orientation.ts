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
