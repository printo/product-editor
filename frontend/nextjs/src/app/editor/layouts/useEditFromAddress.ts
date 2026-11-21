/**
 * `?edit=<layout>` opens the editor on that layout; with `&import=1` and an
 * import under way for it, the editor also shows the design's pictures and
 * Save carries the import on. Read once, then taken off the address so a
 * reload or the Back button does not reopen it.
 * Moved out of page.tsx unchanged (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, step 3).
 */
import { useEffect, useRef } from 'react';
import { readImportSession } from '@/lib/import-session';

export type ImportGuide = { url: string; widthMm: number; heightMm: number };

export function useEditFromAddress(
  status: string,
  openEditModal: (name: string) => unknown,
  setImportFor: (name: string) => void,
  setImportGuide: (guide: ImportGuide | null) => void,
) {
  const openedFromAddress = useRef(false);
  useEffect(() => {
    if (status !== 'authenticated' || openedFromAddress.current) return;
    openedFromAddress.current = true;
    const query = new URLSearchParams(window.location.search);
    const name = query.get('edit');
    if (!name || !/^[a-z0-9_-]+$/i.test(name)) return;
    const session = query.get('import') ? readImportSession(name) : null;
    window.history.replaceState(null, '', window.location.pathname);
    if (session) {
      setImportFor(name);
      setImportGuide(session.guideSvg
        ? { url: URL.createObjectURL(new Blob([session.guideSvg], { type: 'image/svg+xml' })), widthMm: session.guideMm.width, heightMm: session.guideMm.height }
        : null);
    }
    void openEditModal(name);
    // openEditModal only sets state; it is recreated every render, and the
    // page's own once-only rule is the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
}
