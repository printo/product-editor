/**
 * Which persisted photos (file-store.ts records) the editor still uses, so
 * the ones it has dropped can be deleted from IndexedDB.
 *
 * A record is deleted only when NOTHING names its fileId, so collecting an id
 * too many just keeps a photo a little longer, while missing one deletes a
 * photo the design still shows. Hence a deep walk over every `fileId` key
 * rather than a list of the places photos live today (frames, image overlays,
 * held-out book pages, whatever is added next).
 */
export function collectFileIds(
  value: unknown,
  into: Set<string> = new Set(),
  idOfFile?: (file: Blob) => string | undefined,
): Set<string> {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      // A photo still in state keeps its record even when the frame holding
      // it has momentarily lost its `fileId` (see the persist effect).
      const id = idOfFile?.(v);
      if (id) into.add(id);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    for (const [k, child] of Object.entries(v)) {
      if (k === 'fileId' && typeof child === 'string' && child) into.add(child);
      else walk(child);
    }
  };
  walk(value);
  return into;
}

/** Ids from `known` that none of `sources` references. */
export function unreferencedFileIds(
  known: Iterable<string>,
  sources: unknown[],
  idOfFile?: (file: Blob) => string | undefined,
): string[] {
  const referenced = new Set<string>();
  sources.forEach(s => collectFileIds(s, referenced, idOfFile));
  return Array.from(known).filter(id => !referenced.has(id));
}
