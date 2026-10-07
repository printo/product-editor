'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  saveFile, deleteFile, getFilesForOrder, pruneStaleOrders, pruneUnreferencedFiles,
  FileStoreQuotaError, getPersistenceMode,
} from '@/lib/file-store';
import type { BookLayoutLike } from '@/lib/book-layout';
import type { NormalizedLayout } from '@/lib/layout-utils';
import type { CalendarTheme, CalendarType } from '@/types/calendar';
import { reconcilePageCount } from './book-pages';
import { MAX_SKELETON_CARDS, ORPHAN_FILE_MIN_AGE_MS, readCardCountHint, writeCardCountHint } from './editor-utils';
import { renderCanvas as renderCanvasCore } from './fabric-renderer';
import { collectFileIds, unreferencedFileIds } from './file-refs';
import type { CanvasItem, FitMode, SurfaceState } from './types';

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;

/** Saving and bringing back the customer's design: the one debounced
 *  autosave writer and its three triggers, the restore that runs once the
 *  layout is ready (photos come back from the browser's IndexedDB store), the
 *  restore placeholders, and the bookkeeping of which stored photos this tab
 *  may delete. Autosave never writes before the restore has landed. */
export function useAutosaveAndRestore({
  layout, layoutLoading, layoutName, orderId, apiBase, getAuthHeaders, legacyOrderIdRef, normalizedLayoutState,
  canvases, setCanvases, setFiles, surfaceStatesRef, setSurfaceStates, activeSurfaceKey, activeSurfaceKeyRef, setActiveSurfaceKey,
  setGlobalFitMode, getFileUrl, skipNextGenerateRef,
  isCalendarProduct, calendarTheme, setCalendarTheme, calendarType, setCalendarType, genzPalette, setGenzPalette,
  calendarCells, setCalendarCells, isBookProduct, bookPageCount, setBookPageCount, bookHiddenPagesRef, setBookHiddenPages,
}: {
  layout: any;
  layoutLoading: boolean;
  layoutName: string;
  orderId: string;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  legacyOrderIdRef: Ref<string | null>;
  normalizedLayoutState: NormalizedLayout | null;
  canvases: CanvasItem[];
  setCanvases: Setter<CanvasItem[]>;
  setFiles: Setter<File[]>;
  surfaceStatesRef: Ref<SurfaceState[]>;
  setSurfaceStates: Setter<SurfaceState[]>;
  activeSurfaceKey: string;
  activeSurfaceKeyRef: Ref<string>;
  setActiveSurfaceKey: Setter<string>;
  setGlobalFitMode: Setter<FitMode>;
  getFileUrl: (file: File) => string;
  skipNextGenerateRef: Ref<boolean>;
  isCalendarProduct: boolean;
  calendarTheme: CalendarTheme;
  setCalendarTheme: Setter<CalendarTheme>;
  calendarType: CalendarType;
  setCalendarType: Setter<CalendarType>;
  genzPalette: string | undefined;
  setGenzPalette: Setter<string | undefined>;
  calendarCells: Record<string, any[]>;
  setCalendarCells: Setter<Record<string, any[]>>;
  isBookProduct: boolean;
  bookPageCount: number;
  setBookPageCount: Setter<number>;
  bookHiddenPagesRef: Ref<Record<string, SurfaceState>>;
  setBookHiddenPages: Setter<Record<string, SurfaceState>>;
}) {
  // ── Restore placeholders ────────────────────────────────────────────────
  // `order_id` is written into the URL on first mount, so its presence at
  // startup means this is a revisit and a restore may be inbound. Knowing that
  // synchronously — before any fetch — lets the grid show skeletons instead of
  // the "No images selected" empty state, which otherwise claims the customer's
  // design is gone for the ~2s the restore takes. Cleared on every exit path of
  // the restore effect, including the 404 "nothing saved" case.
  const [restorePending, setRestorePending] = useState<boolean>(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('order_id')
  );
  // The autosave gate — deliberately NOT restorePending. That one only starts
  // true when `order_id` is already in the URL, and the embed iframe URL never
  // carries it (the id is adopted from the session after mount), so in the
  // customer flow it started false and autosave could PUT pre-restore state
  // over a saved design. This starts false for everyone and flips once, in the
  // restore effect's `finally`. The ref mirrors it for the debounced writer.
  const [restoreSettled, setRestoreSettled] = useState(false);
  const restoreSettledRef = useRef(false);
  // Card count from the last visit, so the placeholder count is right on the
  // first paint rather than snapping when the payload lands. Purely cosmetic —
  // any failure just falls back to a default.
  const [restoreCount, setRestoreCount] = useState<number>(() => readCardCountHint());

  const [isSaving, setIsSaving] = useState<'idle' | 'saving' | 'saved'>('idle');

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Tracks the 3-second "saved → idle" indicator reset so it can be cancelled
  // on unmount and won't call setState on a dead component.
  const saveIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel pending save / idle-reset timers on unmount so they don't call
  // setState on an unmounted component. (This was part of the page's unmount
  // cleanup, which still revokes the photo URLs.)
  useEffect(() => () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    if (saveIdleTimeoutRef.current) clearTimeout(saveIdleTimeoutRef.current);
  }, []);

  // Track whether we've attempted a restore on this page-load already.
  const restoredRef = useRef(false);
  // Set to true during restore so the resulting state-update doesn't trigger
  // a redundant auto-save of data we just loaded from the server.
  const isRestoringRef = useRef(false);

  /**
   * Strip un-serialisable File objects from a canvas item so it can be
   * stored as JSON.  The dataUrl is kept so the preview is still visible
   * after restore even though the original File is gone.
   */
  const serializeCanvasState = useCallback((items: CanvasItem[]) =>
    items.map(c => ({
      ...c,
      dataUrl: null, // strip base64 preview to reduce payload size — regenerate on restore
      frames: c.frames.map(f => ({ ...f, originalFile: null })),
      overlays: c.overlays.map(o => ({ ...o, originalFile: undefined })),
    }))
    , []);

  // ── Stored-photo bookkeeping (file-store.ts) ─────────────────────────────
  // The persist effect patches fileIds into surfaceStates only, and the
  // canvases → surfaceStates sync copies the active surface's canvases (which
  // never got them) back over it on the next edit. Keyed by File, the same
  // photo gets its existing id back instead of being stored again — once per
  // edit before this, and once per frame for a qty auto-fill.
  const fileIdByFileRef = useRef(new WeakMap<File, string>());
  const fileSaveInFlightRef = useRef(new WeakMap<File, Promise<string>>());
  // Records this tab saved or restored: the only ones it may delete. Another
  // tab's records are invisible to it and so never deleted from here.
  const sessionFilesRef = useRef(new Map<string, File>());
  // A photo brought back after its record was deleted (modal undo) still
  // carries the old id; the persist effect stores it again.
  const deletedFileIdsRef = useRef(new Set<string>());

  /** Delete the records this tab owns that neither the design just saved nor
   *  the current state uses. Runs after a successful autosave, so the server's
   *  copy of the design never names a deleted photo. */
  const reclaimUnusedFiles = useCallback((savedState: unknown) => {
    const idOfFile = (b: Blob) => (b instanceof File ? fileIdByFileRef.current.get(b) : undefined);
    const unused = unreferencedFileIds(
      sessionFilesRef.current.keys(),
      [savedState, surfaceStatesRef.current, bookHiddenPagesRef.current],
      idOfFile,
    );
    for (const id of unused) {
      const file = sessionFilesRef.current.get(id);
      sessionFilesRef.current.delete(id);
      if (file && fileIdByFileRef.current.get(file) === id) fileIdByFileRef.current.delete(file);
      deletedFileIdsRef.current.add(id);
      void deleteFile(id);
    }
  }, [bookHiddenPagesRef, surfaceStatesRef]);

  // ── Auto-save: one debounced writer, three triggers ──────────────────────
  // The triggers below (active surface's canvases, calendar choices, book page
  // count) all go through scheduleAutosave, so they share one timer, one
  // payload and one restore guard. Don't add a trigger that PUTs canvas-state
  // any other way: the calendar and book triggers used to carry their own copy
  // of the save with no restore guard, and a layout-load default (ops theme
  // preset, template page count) fired it mid-restore, overwriting the saved
  // design with pre-restore state.
  //
  // Calendar/book values are read when the timer FIRES rather than when it was
  // armed, so whichever trigger re-armed it last can't write another's state as
  // of an older render.
  const autosaveProductRef = useRef({
    isCalendarProduct, isBookProduct, calendarTheme, calendarType, genzPalette, calendarCells, bookPageCount,
  });
  useEffect(() => {
    autosaveProductRef.current = {
      isCalendarProduct, isBookProduct, calendarTheme, calendarType, genzPalette, calendarCells, bookPageCount,
    };
  }, [isCalendarProduct, isBookProduct, calendarTheme, calendarType, genzPalette, calendarCells, bookPageCount]);

  const scheduleAutosave = useCallback(() => {
    // Never write while a restore is still in flight. State is empty on mount
    // and an empty save is deliberately allowed (see "delete all" below), so a
    // canvas-state GET slower than the 2 s debounce would otherwise lose the
    // race and PUT an empty design over the customer's saved one — silently.
    // Production responses are ~400 ms, but this app is used mostly on phones
    // and tablets where a >2 s response is ordinary.
    if (!restoreSettledRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setIsSaving('saving');

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const product = autosaveProductRef.current;
        // Read from refs so the timeout always uses the latest surface data,
        // even if other surfaces were updated during the 2 s debounce window.
        const latestSurfaces = surfaceStatesRef.current;
        const latestActiveKey = activeSurfaceKeyRef.current;

        // The backend stores `editor_state` as an opaque JSON blob.
        const editorState: Record<string, any> = {
          surfaces: latestSurfaces.map(s => ({
            key: s.key,
            canvases: serializeCanvasState(s.canvases),
            globalFitMode: s.globalFitMode,
          })),
          activeSurfaceKey: latestActiveKey,
          layoutName,
        };
        // Calendar products persist the customer's theme/type/palette/cell
        // choices so they survive page refresh (PRD §10.3 / audit fix #1).
        if (product.isCalendarProduct) {
          editorState.calendarState = {
            themePreset: product.calendarTheme,
            calendarType: product.calendarType,
            genzPalette: product.genzPalette,
            cells: product.calendarCells,
          };
        }
        // Book products persist the customer's page count AND the pages held
        // out of range by a shrink (BOOK_LAYOUT_PRD.md R1) — a NEW top-level
        // key, not appended into `surfaces`, so it can never be mistaken for
        // an active page by `_extract_canvases_meta`/`_extract_book_state`
        // (which only look at `canvases`) even though editor_state is never
        // read by the render path anyway (render_state is submit-time only).
        if (product.isBookProduct) {
          editorState.bookState = {
            pageCount: product.bookPageCount,
            hiddenSurfaces: Object.entries(bookHiddenPagesRef.current).map(([key, s]) => ({
              key,
              canvases: serializeCanvasState(s.canvases),
              globalFitMode: s.globalFitMode,
            })),
          };
        }

        const res = await fetch(`${apiBase}/canvas-state/${orderId}/`, {
          method: 'PUT',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            layout_name: layoutName,   // required by backend
            editor_state: editorState,
          }),
        });

        if (res.ok) {
          setIsSaving('saved');
          // Reset indicator to idle after 3 s; tracked so unmount can cancel it.
          if (saveIdleTimeoutRef.current) clearTimeout(saveIdleTimeoutRef.current);
          saveIdleTimeoutRef.current = setTimeout(() => setIsSaving('idle'), 3000);
          reclaimUnusedFiles(editorState);
        } else {
          setIsSaving('idle');
        }
      } catch {
        setIsSaving('idle');
      }
    }, 2000);
  }, [apiBase, orderId, layoutName, getAuthHeaders, serializeCanvasState, reclaimUnusedFiles, bookHiddenPagesRef, surfaceStatesRef, activeSurfaceKeyRef]);

  const cancelAutosave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
  }, []);

  // Trigger: the active surface's canvases, and the restore settling.
  useEffect(() => {
    // Don't save before the layout is known or before the orderId is set.
    if (!orderId || !layout) return;
    // Checked here as well as in scheduleAutosave so the restore-suppression
    // flag below is never consumed before the restore has landed.
    // `restoreSettled` must stay in the deps: work done while the restore was
    // in flight is saved by the re-run it triggers.
    if (!restoreSettled) return;
    // Skip the first save that fires as a side-effect of restoring state —
    // we'd just be writing back the exact data we loaded from the server.
    if (isRestoringRef.current) { isRestoringRef.current = false; return; }
    // Allow saving even when canvases is empty — this covers the "delete all"
    // case so that a refresh after clearing doesn't restore the old design.
    scheduleAutosave();
    return cancelAutosave;
    // surfaceStates/activeSurfaceKey are intentionally read via refs so this
    // effect only re-runs when the active surface's canvases actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvases, orderId, layout, restoreSettled]);

  // Trigger: calendar choices. Theme / type / palette / cell edits never touch
  // `canvases`, so without this they would never auto-save.
  useEffect(() => {
    if (!isCalendarProduct || !orderId || !layout) return;
    scheduleAutosave();
    return cancelAutosave;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarTheme, calendarType, genzPalette, calendarCells]);

  // Trigger: book page count. A pure count change (no photo edits) doesn't
  // touch `canvases` either. bookHiddenPages changes together with the count,
  // so it needs no trigger of its own — the writer reads it via ref.
  useEffect(() => {
    if (!isBookProduct || !orderId || !layout) return;
    scheduleAutosave();
    return cancelAutosave;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookPageCount]);

  // ── Regenerate canvas previews (autosave-payload-bloat fix) ──────────────
  // After restore, regenerate base64 previews that were stripped to reduce
  // autosave payload. Runs asynchronously in the background — previews appear
  // as they're ready, never blocking canvas state update.
  const regenerateCanvasPreviews = useCallback(async (canvasesToRender: CanvasItem[]) => {
    if (!layout) return canvasesToRender;

    try {
      const withPreviews = await Promise.all(
        canvasesToRender.map(async (c) => {
          // If dataUrl already exists, skip regeneration
          if (c.dataUrl) return c;
          try {
            const newDataUrl = await renderCanvasCore(c, layout, getFileUrl, { thumbnail: true });
            return { ...c, dataUrl: newDataUrl };
          } catch {
            // On render error, keep the canvas as-is (dataUrl remains null)
            return c;
          }
        }),
      );
      return withPreviews;
    } catch {
      return canvasesToRender;
    }
  }, [layout, getFileUrl]);

  // ── Auto-restore: run once after layout is ready ──────────────────────────
  useEffect(() => {
    if (!orderId || !layout || layoutLoading || restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      try {
        let restoreId = orderId;
        let res = await fetch(`${apiBase}/canvas-state/${restoreId}/`, {
          headers: { ...getAuthHeaders(), Accept: 'application/json' },
        });
        // Pre-adoption fallback (Phase 3): an autosave made before this
        // deploy may live under the old client-generated PE- id. One guarded
        // extra GET recovers it; the next autosave re-keys it to the session
        // id, so this self-migrates.
        if (!res.ok && legacyOrderIdRef.current && legacyOrderIdRef.current !== restoreId) {
          restoreId = legacyOrderIdRef.current;
          res = await fetch(`${apiBase}/canvas-state/${restoreId}/`, {
            headers: { ...getAuthHeaders(), Accept: 'application/json' },
          });
        }
        if (!res.ok) return; // 404 = first visit, no state to restore

        const data = await res.json();
        if (!data?.editor_state?.surfaces?.length) return;

        const savedLayoutName: string | undefined = data.editor_state.layoutName;
        // Don't restore if it belongs to a different layout template.
        if (savedLayoutName && savedLayoutName !== layoutName) return;

        const savedSurfaces: Array<{
          key: string;
          canvases: CanvasItem[];
          globalFitMode: FitMode;
        }> = data.editor_state.surfaces;

        // NOTE: the auto-save suppression flag is deliberately NOT set here.
        // It used to be, which meant a payload that restored nothing (an active
        // surface with zero canvases) still armed it — and the flag then
        // swallowed the customer's next genuine save. It is set below, only on
        // the path that actually applies state.

        // Remove any stale ?canvas= param from a previous session so the modal
        // doesn't auto-open on top of the freshly-restored state.
        const sp = new URLSearchParams(window.location.search);
        if (sp.has('canvas')) {
          sp.delete('canvas');
          window.history.replaceState(null, '', sp.toString() ? `?${sp.toString()}` : window.location.pathname);
        }

        // Bound the store before hydrating (Phase 3): age out other orders'
        // blobs and evict oldest-first under pressure. Never touches the
        // current order.
        void pruneStaleOrders(restoreId);

        // Hydrate Files from IndexedDB (B1 fix). We strip `originalFile` on
        // serialise but persist the raw blob client-side keyed by `fileId`,
        // so refreshing the page recovers everything needed to re-render.
        const fileMap = await getFilesForOrder(restoreId).catch(() => new Map<string, File>());
        const restoredFile = (fileId: string): File | undefined => {
          const file = fileMap.get(fileId);
          if (file) {
            fileIdByFileRef.current.set(file, fileId);
            sessionFilesRef.current.set(fileId, file);
          }
          return file;
        };
        const hydrate = (canvases: CanvasItem[]): CanvasItem[] =>
          canvases.map(c => ({
            ...c,
            frames: c.frames.map(f => {
              if (!f.fileId) return f;
              const file = restoredFile(f.fileId);
              return file ? { ...f, originalFile: file } : f;
            }),
            overlays: c.overlays.map(o => {
              if (o.type !== 'image' || !o.fileId) return o;
              const file = restoredFile(o.fileId);
              if (!file) return o;
              // Re-create the blob URL since the saved one was revoked when
              // the previous browser session ended. getFileUrl caches by File
              // reference so revocation hooks elsewhere still work.
              return { ...o, originalFile: file, src: getFileUrl(file) };
            }),
          }));

        // Book products: `prev` (surfaceStates) was sized at the TEMPLATE
        // DEFAULT page count when the layout loaded — the saved count isn't
        // known until now. Resize it via the same reconciliation a live
        // page-count change uses, BEFORE the generic per-key hydrate below
        // runs (which only UPDATES entries already in `prev` — it can't add
        // ones that aren't there). Skipping this would silently drop every
        // page beyond the template default on restore (BOOK_LAYOUT_PRD.md
        // R1). Two sequential `setSurfaceStates` calls in this effect is
        // safe: React's updater form always sees the previous updater's
        // committed result even within one batch.
        if (isBookProduct) {
          const rawBookLayout = normalizedLayoutState?._raw as BookLayoutLike | undefined;
          const savedBookState = data.editor_state.bookState;
          if (rawBookLayout) {
            const { visible, resolvedCount } = reconcilePageCount(
              rawBookLayout, savedBookState?.pageCount, [], {},
            );
            setSurfaceStates(visible);
            setBookPageCount(resolvedCount);
          }
          if (Array.isArray(savedBookState?.hiddenSurfaces)) {
            const archive: Record<string, SurfaceState> = {};
            for (const h of savedBookState.hiddenSurfaces) {
              if (!h?.key || !Array.isArray(h.canvases) || !h.canvases.length) continue;
              // A held page carries no real `def` while archived — nothing
              // reads it there, and reconcilePageCount always recomputes a
              // fresh `def` the moment the page re-enters `visible`.
              archive[h.key] = {
                key: h.key,
                label: h.key,
                def: {
                  key: h.key, label: h.key,
                  canvas: { width: 0, height: 0 }, frames: [],
                  maskUrl: null, maskOnExport: false,
                },
                files: [],
                canvases: hydrate(h.canvases),
                globalFitMode: h.globalFitMode ?? 'contain',
              };
            }
            setBookHiddenPages(archive);
          }
        }

        // Merge saved canvas data into the surface states that were just
        // initialised from the layout definition.
        setSurfaceStates(prev => prev.map(s => {
          const saved = savedSurfaces.find(ss => ss.key === s.key);
          if (!saved || !saved.canvases?.length) return s;
          return {
            ...s,
            canvases: hydrate(saved.canvases),
            globalFitMode: saved.globalFitMode ?? s.globalFitMode,
          };
        }));

        // Restore calendar state (theme, type, palette, cells) if present.
        const savedCalendar = data.editor_state.calendarState;
        if (savedCalendar && isCalendarProduct) {
          if (savedCalendar.themePreset) setCalendarTheme(savedCalendar.themePreset as CalendarTheme);
          if (savedCalendar.calendarType) setCalendarType(savedCalendar.calendarType as CalendarType);
          if (savedCalendar.genzPalette) setGenzPalette(savedCalendar.genzPalette);
          // Current saves hold a flat ISO-keyed `cells` map; legacy saves hold
          // the 12-slot `cellsPerCanvas` array — merge it flat (ISO dates are
          // globally unique, so union is lossless).
          const flat: Record<string, any[]> = {};
          if (Array.isArray(savedCalendar.cellsPerCanvas)) {
            for (const m of savedCalendar.cellsPerCanvas) Object.assign(flat, m || {});
          }
          if (savedCalendar.cells && typeof savedCalendar.cells === 'object') {
            Object.assign(flat, savedCalendar.cells);
          }
          if (Object.keys(flat).length) setCalendarCells(flat);
        }

        // Activate the surface that was open when the user last saved.
        const savedActiveKey: string | undefined = data.editor_state.activeSurfaceKey;
        if (savedActiveKey) setActiveSurfaceKey(savedActiveKey);

        // Sync the active-surface shortcut state.
        const activeSaved = savedSurfaces.find(
          ss => ss.key === (savedActiveKey ?? activeSurfaceKey)
        );
        if (activeSaved?.canvases?.length) {
          // Correct the placeholder count before the cards swap in, in case the
          // local hint was stale or unavailable.
          setRestoreCount(Math.min(activeSaved.canvases.length, MAX_SKELETON_CARDS));
          const hydrated = hydrate(activeSaved.canvases);
          // Suppress the one auto-save fire these updates trigger — we would
          // just be writing back what we loaded a moment ago.
          isRestoringRef.current = true;
          skipNextGenerateRef.current = true; // suppress generateCanvases trigger
          setCanvases(hydrated);
          // Regenerate canvas previews that were stripped from autosave payload
          // to reduce size. Runs async in the background — previews appear as
          // they're ready, never blocking UI update.
          void regenerateCanvasPreviews(hydrated).then(withPreviews => {
            if (withPreviews.some(c => c.dataUrl !== (hydrated.find(h => h.id === c.id)?.dataUrl || null))) {
              setCanvases(withPreviews);
            }
          });
          // Repopulate `files` from the hydrated frames in the SAME commit
          // (Phase 3): with files left empty the skip flag went stale and
          // swallowed the user's NEXT real upload (blank grid), and any
          // post-restore re-pick lost the identity merge. The flag suppresses
          // exactly this one legitimate generate fire.
          const restoredFiles = hydrated
            .flatMap(c => c.frames.map(f => f.originalFile))
            .filter((f): f is File => !!f);
          if (restoredFiles.length) setFiles(restoredFiles);
          // Restoring the saved fit mode must NOT re-run smartcrop over the
          // customer's manual pans — the fit-mode effect only recomputes
          // offsets for USER toggles (fitModeUserToggledRef).
          setGlobalFitMode(activeSaved.globalFitMode ?? 'contain');
        }

        // Delete this order's older stored photos the restored design doesn't
        // use: ones dropped in a session that closed before its next save, and
        // everything the editor stored before it cleaned up after itself.
        // Only here, once a saved design was actually applied — never on a
        // failed or empty restore, where "unused" would mean every photo.
        void pruneUnreferencedFiles(restoreId, collectFileIds(data.editor_state), ORPHAN_FILE_MIN_AGE_MS);
      } catch {
        // Restore failures are silent — user just starts fresh.
      } finally {
        // Every exit path lands here — 404 (nothing saved), a layout mismatch,
        // a thrown fetch, or success. Leaving this set would strand the
        // skeletons on screen in place of the upload prompt.
        setRestorePending(false);
        restoreSettledRef.current = true;
        setRestoreSettled(true);
      }
    })();
    // Run exactly once when layout becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, layoutLoading, orderId]);

  // Remember the card count for this order so a refresh can size its restore
  // placeholders correctly before the payload lands.
  useEffect(() => {
    if (orderId) writeCardCountHint(orderId, canvases.length);
  }, [canvases.length, orderId]);

  return { restorePending, restoreCount, isSaving, fileIdByFileRef, fileSaveInFlightRef, sessionFilesRef, deletedFileIdsRef };
}

/** Stores each photo the design uses in the browser's IndexedDB once, and
 *  writes the stored id back into the design, so a refresh can bring the
 *  photo back. Reports when storage is full or blocked. */
export function usePhotoStore({
  orderId, surfaceStates, setSurfaceStates, fileIdByFileRef, fileSaveInFlightRef, sessionFilesRef, deletedFileIdsRef,
  setPersistDegraded, setStorageBlocked,
}: {
  orderId: string;
  surfaceStates: SurfaceState[];
  setSurfaceStates: Setter<SurfaceState[]>;
  fileIdByFileRef: Ref<WeakMap<File, string>>;
  fileSaveInFlightRef: Ref<WeakMap<File, Promise<string>>>;
  sessionFilesRef: Ref<Map<string, File>>;
  deletedFileIdsRef: Ref<Set<string>>;
  setPersistDegraded: Setter<boolean>;
  setStorageBlocked: Setter<boolean>;
}) {
  // ── Persist Files to IndexedDB on add (B1: survives page refresh) ────────
  // Watches surfaceStates for any frame/overlay that has an originalFile but
  // no fileId, persists the blob, then patches the fileId back into state.
  // Self-stabilising: once every File has a fileId the effect no-ops.
  useEffect(() => {
    if (!orderId) return;
    type Pending = { surfaceKey: string; canvasIdx: number; kind: 'frame' | 'overlay'; idx: number; file: File };
    const pending: Pending[] = [];
    const needsId = (fileId?: string) => !fileId || deletedFileIdsRef.current.has(fileId);

    surfaceStates.forEach(s => {
      s.canvases.forEach((c, ci) => {
        c.frames.forEach((f, fi) => {
          if (f.originalFile && needsId(f.fileId)) {
            pending.push({ surfaceKey: s.key, canvasIdx: ci, kind: 'frame', idx: fi, file: f.originalFile });
          }
        });
        c.overlays.forEach((o, oi) => {
          if (o.type === 'image' && o.source === 'local' && o.originalFile && needsId(o.fileId)) {
            pending.push({ surfaceKey: s.key, canvasIdx: ci, kind: 'overlay', idx: oi, file: o.originalFile });
          }
        });
      });
    });

    if (!pending.length) return;

    // One stored copy per File: reuse the id it already has, or join a save
    // already in flight (a re-run of this effect cancels the previous run's
    // patch, not its saves).
    const persistFile = (file: File): Promise<string> => {
      const known = fileIdByFileRef.current.get(file);
      if (known && !deletedFileIdsRef.current.has(known)) return Promise.resolve(known);
      let saving = fileSaveInFlightRef.current.get(file);
      if (!saving) {
        saving = saveFile(orderId, file).then(id => {
          fileIdByFileRef.current.set(file, id);
          sessionFilesRef.current.set(id, file);
          return id;
        });
        fileSaveInFlightRef.current.set(file, saving);
        const settle = () => { fileSaveInFlightRef.current.delete(file); };
        saving.then(settle, settle);
      }
      return saving;
    };

    let cancelled = false;
    (async () => {
      const results = await Promise.all(pending.map(async (p) => {
        try {
          const fileId = await persistFile(p.file);
          return { ...p, fileId };
        } catch (e) {
          // Quota exhaustion must be VISIBLE (Phase 3): the photo still works
          // this session, but it can't be recovered after a refresh — warn
          // instead of silently printing blank later.
          if (e instanceof FileStoreQuotaError) setPersistDegraded(true);
          return null;
        }
      }));
      if (cancelled) return;
      if (getPersistenceMode() === 'memory') setStorageBlocked(true);
      const ok = results.filter((r): r is Pending & { fileId: string } => r !== null);
      if (!ok.length) return;

      setSurfaceStates(prev => prev.map(s => {
        const sIds = ok.filter(i => i.surfaceKey === s.key);
        if (!sIds.length) return s;
        return {
          ...s,
          canvases: s.canvases.map((c, ci) => {
            const cIds = sIds.filter(i => i.canvasIdx === ci);
            if (!cIds.length) return c;
            return {
              ...c,
              frames: c.frames.map((f, fi) => {
                const m = cIds.find(i => i.kind === 'frame' && i.idx === fi);
                return m ? { ...f, fileId: m.fileId } : f;
              }),
              overlays: c.overlays.map((o, oi) => {
                const m = cIds.find(i => i.kind === 'overlay' && i.idx === oi);
                if (!m || o.type !== 'image') return o;
                return { ...o, fileId: m.fileId };
              }),
            };
          }),
        };
      }));
    })();

    return () => { cancelled = true; };
  }, [surfaceStates, orderId, setSurfaceStates, fileIdByFileRef, fileSaveInFlightRef, sessionFilesRef, deletedFileIdsRef, setPersistDegraded, setStorageBlocked]);
}
