/**
 * An import of an old design that is part-way through: the layout exists and
 * the ops user is adjusting its canvas and print areas in the layout editor
 * before the artwork is cut to them (components/ImportDesignDialog.tsx).
 *
 * Kept for the tab only. The pasted export is small and goes to
 * sessionStorage, so a reload keeps the import going; the guide picture can
 * be megabytes, so it is tried there and otherwise lives in memory, and a
 * reload then shows the print areas without it.
 */

export interface ImportSession {
  /** The layout created for this design. */
  layout: string;
  /** The export exactly as pasted: the artwork is built from it again. */
  raw: string;
  templateName: string;
  /** Every picture of the design, whole, as one SVG the size of the canvas
   *  as imported, and that size: the guide keeps it if the canvas is resized. */
  guideSvg: string | null;
  guideMm: { width: number; height: number };
}

const KEY = 'pe:import-session';
const GUIDE_KEY = 'pe:import-session-guide';
let held: ImportSession | null = null;

const storage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

export function writeImportSession(session: ImportSession): void {
  held = session;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify({ layout: session.layout, raw: session.raw, templateName: session.templateName, guideMm: session.guideMm }));
  } catch {
    // Memory still has it for this page's lifetime.
  }
  try {
    if (session.guideSvg) store.setItem(GUIDE_KEY, session.guideSvg);
    else store.removeItem(GUIDE_KEY);
  } catch {
    try { store.removeItem(GUIDE_KEY); } catch { /* nothing to remove */ }
  }
}

/** The import under way for this layout, or null. */
export function readImportSession(layout?: string): ImportSession | null {
  let found = held;
  if (!found) {
    const store = storage();
    try {
      const saved = store?.getItem(KEY);
      const v = saved ? JSON.parse(saved) : null;
      if (v && typeof v.layout === 'string' && typeof v.raw === 'string') {
        found = {
          layout: v.layout, raw: v.raw, templateName: typeof v.templateName === 'string' ? v.templateName : '',
          guideSvg: store?.getItem(GUIDE_KEY) ?? null,
          guideMm: { width: Number(v.guideMm?.width) || 0, height: Number(v.guideMm?.height) || 0 },
        };
      }
    } catch {
      found = null;
    }
  }
  if (!found || (layout !== undefined && found.layout !== layout)) return null;
  return found;
}

export function clearImportSession(): void {
  held = null;
  const store = storage();
  try {
    store?.removeItem(KEY);
    store?.removeItem(GUIDE_KEY);
  } catch {
    // Nothing to clear.
  }
}
