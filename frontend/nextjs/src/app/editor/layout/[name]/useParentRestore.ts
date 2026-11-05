'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { rememberImageSize } from '@/lib/image-utils';
import type { NormalizedLayout } from '@/lib/layout-utils';
import {
  readRestoreOrderId, requestRestore, restoreStatusFor, sendRestoreResult,
  type RestorePhoto, type RestoreResult, type RestoreWindow,
} from './restore-messages';
import { RestoredPhotos, type RestoredPhotoStatus } from './restored-photos';
import type { CanvasItem, SurfaceState } from './types';
import type { OwnRestore } from './useDesignPersistence';

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;

/** Photos fetched at once. Each one makes our server download an original, so
 *  this is kept low; cards fill in from the top. */
const PHOTOS_AT_ONCE = 3;
/** Tries per photo before it is shown as failed (the customer can tap to retry). */
const TRIES_PER_PHOTO = 2;
/** How long opening a card waits for the full-size photo before it opens with
 *  the preview instead. The print uses the original either way. */
const ORIGINAL_WAIT_MS = 8000;
/** Arrivals are put on screen together, so 200 photos are not 200 redraws. */
const PLACE_BATCH_MS = 120;

/** The photos a design names, in the order the cards show them. */
export function fileIdsInCardOrder(surfaces: ReadonlyArray<{ canvases: CanvasItem[] }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id?: string) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
  for (const s of surfaces) {
    for (const c of s.canvases) {
      c.frames.forEach(f => add(f.fileId));
      c.overlays.forEach(o => { if (o.type === 'image' && o.source === 'local') add(o.fileId); });
    }
  }
  return out;
}

/** Put arrived photos into the cards that name them and still have none.
 *  Returns the same array when nothing changed, and which cards did. */
export function fillRestoredPhotos(
  canvases: CanvasItem[],
  byId: ReadonlyMap<string, File>,
  getFileUrl: (file: File) => string,
): { canvases: CanvasItem[]; changed: number[] } {
  const changed: number[] = [];
  const next = canvases.map((c, idx) => {
    let touched = false;
    const frames = c.frames.map(f => {
      const file = !f.originalFile && f.fileId ? byId.get(f.fileId) : undefined;
      if (!file) return f;
      touched = true;
      return { ...f, originalFile: file };
    });
    const overlays = c.overlays.map(o => {
      if (o.type !== 'image' || o.source !== 'local' || o.originalFile || !o.fileId) return o;
      const file = byId.get(o.fileId);
      if (!file) return o;
      touched = true;
      return { ...o, originalFile: file, src: getFileUrl(file) };
    });
    if (!touched) return c;
    changed.push(idx);
    return { ...c, frames, overlays };
  });
  return changed.length ? { canvases: next, changed } : { canvases, changed };
}

/** Whether a saved design can go onto the layout as it is served now: every
 *  side it has cards on still exists and still has as many photo windows a
 *  card. A book's pages are made to match the design, so they are not judged. */
export function designFitsLayout(
  editorState: Record<string, unknown>,
  surfaces: ReadonlyArray<{ key: string; def: { frames?: unknown[] } }>,
  isBook: boolean,
): boolean {
  const saved = Array.isArray(editorState.surfaces) ? editorState.surfaces as Array<{ key?: string; canvases?: CanvasItem[] }> : [];
  if (!saved.length) return false;
  if (isBook) return true;
  return saved.every(s => {
    const cards = Array.isArray(s.canvases) ? s.canvases : [];
    if (!cards.length) return true;
    const now = surfaces.find(x => x.key === s.key);
    if (!now) return false;
    const windows = now.def.frames?.length || 1;
    return cards.every(c => Array.isArray(c.frames) && c.frames.length === windows);
  });
}

/** The photos to place again when only photos come back: the ones in the
 *  design's photo windows, in card order, when there is a design to read;
 *  else everything the page listed, in its order, leaving out what it marked
 *  as an added image or a calendar date's photo. */
export function photosToPlaceAgain(editorState: Record<string, unknown> | null, photos: RestorePhoto[]): RestorePhoto[] {
  if (editorState && Array.isArray(editorState.surfaces)) {
    const byId = new Map(photos.map(p => [p.fileId, p]));
    const out: RestorePhoto[] = [];
    const seen = new Set<string>();
    for (const s of editorState.surfaces as Array<{ canvases?: CanvasItem[] }>) {
      for (const c of s.canvases ?? []) {
        for (const f of c.frames ?? []) {
          const photo = f.fileId ? byId.get(f.fileId) : undefined;
          if (photo && !seen.has(photo.fileId)) { seen.add(photo.fileId); out.push(photo); }
        }
      }
    }
    if (out.length) return out;
  }
  return photos.filter(p => !p.kind || p.kind === 'frame');
}

type CellEntry = { type?: string; uploadId?: string };
/** The dates of a calendar design that carry a photo, with the upload each names. */
export function calendarCellPhotos(cells: Record<string, unknown> | null | undefined): Array<{ iso: string; uploadId: string }> {
  const out: Array<{ iso: string; uploadId: string }> = [];
  for (const [iso, entries] of Object.entries(cells ?? {})) {
    for (const e of (Array.isArray(entries) ? entries : []) as CellEntry[]) {
      if (e?.type === 'image' && typeof e.uploadId === 'string' && e.uploadId) out.push({ iso, uploadId: e.uploadId });
    }
  }
  return out;
}

/** What the customer is told above the cards after a restore. */
export type RestoreNotice = 'photos_only' | 'layout_changed';
export const RESTORE_NOTICE_TEXT: Record<RestoreNotice, string> = {
  photos_only: 'We brought back your photos from last time. Cropping may look different, and text or stickers were not saved. Please look through them before you continue.',
  layout_changed: 'This product has changed a little since your last order. Your photos may sit differently. Please look at each one before you continue.',
};

const framesFiles = (canvases: CanvasItem[]): File[] =>
  canvases.flatMap(c => c.frames.map(f => f.originalFile)).filter((f): f is File => !!f);

/** Restoring a design from the copy the embedding company keeps.
 *
 *  Only in the embed, and only when its page put `restore_order_id` on the
 *  iframe address. After our own restore: if this order has no design yet, or
 *  names photos this browser does not hold, the page is asked for the earlier
 *  order (restore-messages.ts). Its design goes on screen at once; its photos
 *  are fetched by our server from the links it gave and arrive as previews, a
 *  few at a time from the first card down. Each preview is a stand-in for an
 *  original our server holds (restored-photos.ts): it is never stored in the
 *  browser and never uploaded. Opening a card loads that card's originals. */
export function useParentRestore({
  embedToken, parentOrigin, orderId, apiBase, getAuthHeaders, normalizedLayoutState,
  surfaceStatesRef, setSurfaceStates, canvasesRef, setCanvases, setFiles, activeSurfaceKeyRef,
  skipNextGenerateRef, getFileUrl, renderCanvas, fileIdByFileRef,
  layoutVersionRef, placePhotosRef, isBookProduct = false, isCalendarProduct = false, calendarCells,
  setCalendarCells, setCalendarCellImagePreviews,
}: {
  embedToken: string | null;
  parentOrigin: string;
  orderId: string;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  normalizedLayoutState: NormalizedLayout | null;
  surfaceStatesRef: Ref<SurfaceState[]>;
  setSurfaceStates: Setter<SurfaceState[]>;
  canvasesRef: Ref<CanvasItem[]>;
  setCanvases: Setter<CanvasItem[]>;
  setFiles: Setter<File[]>;
  activeSurfaceKeyRef: Ref<string>;
  skipNextGenerateRef: Ref<boolean>;
  getFileUrl: (file: File) => string;
  renderCanvas: (c: CanvasItem, options?: { thumbnail?: boolean; layoutOverride?: unknown }) => Promise<string | null>;
  /** Filled in by the page once useAutosaveAndRestore has made it. */
  fileIdByFileRef: Ref<WeakMap<File, string> | null>;
  /** The layout's version as served now (`/editor/init`), when known. */
  layoutVersionRef?: Ref<number | null>;
  /** Adds photos exactly as a pick from the device does (useFileIntake), so
   *  the quantity rules, page limits and prompts are the usual ones. Filled in
   *  by the page. */
  placePhotosRef?: Ref<((files: File[]) => Promise<void>) | null>;
  isBookProduct?: boolean;
  isCalendarProduct?: boolean;
  calendarCells?: Record<string, any[]>;
  setCalendarCells?: Setter<Record<string, any[]>>;
  setCalendarCellImagePreviews?: Setter<Record<string, string>>;
}) {
  const restoreOrderId = useMemo<string | null>(
    () => (typeof window === 'undefined' || !embedToken ? null : readRestoreOrderId(window.location.search)),
    [embedToken],
  );

  const [restoredPhotos] = useState(() => new RestoredPhotos());
  const [photoStatus, setPhotoStatus] = useState<ReadonlyMap<string, RestoredPhotoStatus>>(new Map());
  const photoStatusRef = useRef<Map<string, RestoredPhotoStatus>>(new Map());
  const linksRef = useRef(new Map<string, RestorePhoto>());
  const standInCountRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  // Read at call time so a callback made on the first render still sees the
  // layout and order id that arrived later.
  const latest = useRef({ orderId, apiBase, getAuthHeaders, normalizedLayoutState, parentOrigin, renderCanvas, calendarCells, isBookProduct, isCalendarProduct });
  useEffect(() => {
    latest.current = { orderId, apiBase, getAuthHeaders, normalizedLayoutState, parentOrigin, renderCanvas, calendarCells, isBookProduct, isCalendarProduct };
  }, [orderId, apiBase, getAuthHeaders, normalizedLayoutState, parentOrigin, renderCanvas, calendarCells, isBookProduct, isCalendarProduct]);

  // What the customer is told above the cards, and how far a photos-only
  // restore has got while there are no cards to show yet.
  const [restoreNotice, setRestoreNotice] = useState<RestoreNotice | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<{ done: number; total: number } | null>(null);

  const setStatus = useCallback((changes: Array<[string, RestoredPhotoStatus | null]>) => {
    const next = new Map(photoStatusRef.current);
    for (const [id, status] of changes) {
      if (status) next.set(id, status); else next.delete(id);
    }
    photoStatusRef.current = next;
    if (aliveRef.current) setPhotoStatus(next);
  }, []);

  const tellParent = useCallback((result: RestoreResult) => {
    if (!restoreOrderId) return;
    sendRestoreResult(window as unknown as RestoreWindow, latest.current.parentOrigin,
      { orderId: latest.current.orderId, restoreOrderId }, result);
  }, [restoreOrderId]);

  // ── Putting arrived photos on the cards ──────────────────────────────────
  const arrivedRef = useRef(new Map<string, File>());
  const placeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Wait (briefly) until what React has committed satisfies `ready`. The
   *  refs this hook reads are refreshed after each commit, so right after a
   *  state change they still show the state before it. */
  const whenCommitted = useCallback(async (ready: () => boolean, maxMs = 3000): Promise<boolean> => {
    const until = Date.now() + maxMs;
    while (aliveRef.current && !ready()) {
      if (Date.now() > until) return false;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return aliveRef.current;
  }, []);

  const placeArrived = useCallback(async () => {
    placeTimerRef.current = null;
    const byId = arrivedRef.current;
    if (!byId.size || !aliveRef.current) return;
    arrivedRef.current = new Map();

    // Files first, in one synchronous pass, so an edit made a moment later
    // already sees the photo. Functional updates: they apply to whatever the
    // state is by then, never to a copy read earlier.
    const fill = (canvases: CanvasItem[]) => fillRestoredPhotos(canvases, byId, getFileUrl).canvases;
    setSurfaceStates(prev => prev.map(s => {
      const canvases = fill(s.canvases);
      return canvases === s.canvases ? s : { ...s, canvases };
    }));
    const activeFilled = fill(canvasesRef.current);
    if (activeFilled !== canvasesRef.current) {
      setCanvases(prev => fill(prev));
      // `files` mirrors the active side's photos; setting it would rebuild the
      // cards, which is exactly what must not happen to a restored design.
      skipNextGenerateRef.current = true;
      setFiles(framesFiles(activeFilled));
    }
    setStatus([...byId.keys()].map(id => [id, null]));

    // Thumbnails next, drawn from the cards as they stand once that is on
    // screen, and kept only if the card is still that very card: an edit made
    // meanwhile has drawn its own, newer one.
    const arrived = new Set(byId.values());
    const uses = (c: CanvasItem) =>
      c.frames.some(f => f.originalFile && arrived.has(f.originalFile)) ||
      c.overlays.some(o => o.type === 'image' && o.originalFile && arrived.has(o.originalFile));
    const activeKey = () => activeSurfaceKeyRef.current;
    const cardsOf = (s: SurfaceState) => (s.key === activeKey() ? canvasesRef.current : s.canvases);
    const unfilled = (c: CanvasItem) =>
      c.frames.some(f => !f.originalFile && f.fileId && byId.has(f.fileId)) ||
      c.overlays.some(o => o.type === 'image' && o.source === 'local' && !o.originalFile && o.fileId && byId.has(o.fileId));
    await whenCommitted(() => !surfaceStatesRef.current.some(s => cardsOf(s).some(unfilled)));

    const multi = surfaceStatesRef.current.length > 1;
    for (const surfaceKey of surfaceStatesRef.current.map(s => s.key)) {
      const count = cardsOf(surfaceStatesRef.current.find(s => s.key === surfaceKey)!).length;
      for (let idx = 0; idx < count; idx++) {
        if (!aliveRef.current) return;
        const surface = surfaceStatesRef.current.find(s => s.key === surfaceKey);
        const card = surface ? cardsOf(surface)[idx] : undefined;
        if (!surface || !card || !uses(card)) continue;
        const layoutOverride = multi ? { ...latest.current.normalizedLayoutState?._raw, ...surface.def } : undefined;
        let dataUrl: string | null = null;
        try {
          dataUrl = await latest.current.renderCanvas(card, { thumbnail: true, ...(layoutOverride ? { layoutOverride } : {}) });
        } catch { /* the card keeps what it shows */ }
        if (!dataUrl || !aliveRef.current) continue;
        const patch = (canvases: CanvasItem[]) =>
          (canvases.includes(card) ? canvases.map(c => (c === card ? { ...c, dataUrl } : c)) : canvases);
        if (surfaceKey === activeKey()) setCanvases(prev => patch(prev));
        else setSurfaceStates(prev => prev.map(s => {
          if (s.key !== surfaceKey) return s;
          const canvases = patch(s.canvases);
          return canvases === s.canvases ? s : { ...s, canvases };
        }));
      }
    }
  }, [activeSurfaceKeyRef, canvasesRef, getFileUrl, setCanvases, setFiles, setStatus, setSurfaceStates, skipNextGenerateRef, surfaceStatesRef, whenCommitted]);

  const queuePlace = useCallback((fileId: string, file: File) => {
    arrivedRef.current.set(fileId, file);
    if (!placeTimerRef.current) placeTimerRef.current = setTimeout(() => { void placeArrived(); }, PLACE_BATCH_MS);
  }, [placeArrived]);
  useEffect(() => () => { if (placeTimerRef.current) clearTimeout(placeTimerRef.current); }, []);

  // ── Fetching: our server pulls the original, we show its preview ─────────
  const fetchStandIn = useCallback(async (photo: RestorePhoto): Promise<File> => {
    const { apiBase: base, getAuthHeaders: auth, orderId: order } = latest.current;
    const made = await fetch(`${base}/upload/from-url`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: photo.url, order_id: order, ...(photo.name ? { filename: photo.name } : {}) }),
    });
    if (!made.ok) throw new Error(`fetch ${made.status}`);
    const info = await made.json() as { upload_id?: string; filename?: string; width?: number; height?: number };
    if (!info.upload_id) throw new Error('no upload');
    const shown = await fetch(`${base}/photos/${info.upload_id}/preview`, { headers: auth() });
    if (!shown.ok) throw new Error(`preview ${shown.status}`);
    const blob = await shown.blob();
    // Each stand-in gets its own timestamp: the card builder tells photos
    // apart by name, size and timestamp, and two previews can share the rest.
    standInCountRef.current += 1;
    const file = new File([blob], info.filename || photo.name || 'photo', {
      type: blob.type || 'image/jpeg', lastModified: standInCountRef.current,
    });
    restoredPhotos.addStandIn(file, {
      uploadId: info.upload_id, width: info.width ?? 0, height: info.height ?? 0, fileId: photo.fileId,
    });
    if (info.width && info.height) rememberImageSize(file, info.width, info.height);
    fileIdByFileRef.current?.set(file, photo.fileId);
    return file;
  }, [fileIdByFileRef, restoredPhotos]);

  /** Fetch these photos, a few at a time, in the order given. Resolves with
   *  how many arrived. */
  const loadPhotos = useCallback(async (fileIds: string[]): Promise<number> => {
    const queue = fileIds.filter(id => linksRef.current.has(id));
    setStatus(queue.map(id => [id, 'arriving']));
    let loaded = 0;
    const worker = async () => {
      for (;;) {
        const fileId = queue.shift();
        if (!fileId || !aliveRef.current) return;
        const photo = linksRef.current.get(fileId)!;
        let file: File | null = null;
        for (let attempt = 0; attempt < TRIES_PER_PHOTO && !file && aliveRef.current; attempt++) {
          try { file = await fetchStandIn(photo); } catch { /* try again, then give up */ }
        }
        if (file) { loaded += 1; queuePlace(fileId, file); }
        else setStatus([[fileId, 'failed']]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PHOTOS_AT_ONCE, queue.length) }, worker));
    // The last arrivals go on the cards now, so whoever waits for this (the
    // message to the embedding page) speaks of what the customer can see.
    if (placeTimerRef.current) {
      clearTimeout(placeTimerRef.current);
      await placeArrived();
    }
    return loaded;
  }, [fetchStandIn, queuePlace, setStatus, placeArrived]);

  /** "Couldn't load this photo. Tap to try again." */
  const retryRestoredPhotos = useCallback((fileIds: string[]) => {
    const again = fileIds.filter(id => photoStatusRef.current.get(id) === 'failed');
    if (again.length) void loadPhotos(again);
  }, [loadPhotos]);

  // ── Photos only: an order with no saved design, or one this product no
  // longer fits. Every photo is fetched first, then placed as one pick.
  const placePhotosAgain = useCallback(async (photos: RestorePhoto[], markRestored: () => void): Promise<number> => {
    setRestoreProgress({ done: 0, total: photos.length });
    const files: Array<File | null> = photos.map(() => null);
    let next = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= photos.length || !aliveRef.current) return;
        for (let attempt = 0; attempt < TRIES_PER_PHOTO && !files[i] && aliveRef.current; attempt++) {
          try { files[i] = await fetchStandIn(photos[i]); } catch { /* try again, then leave it out */ }
        }
        done += 1;
        if (aliveRef.current) setRestoreProgress({ done, total: photos.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PHOTOS_AT_ONCE, photos.length) }, worker));
    const arrived = files.filter((f): f is File => !!f);
    if (!aliveRef.current) return 0;
    setRestoreProgress(null);
    // Not over work the customer began while the photos were on their way.
    const started = surfaceStatesRef.current.some(s => s.canvases.length > 0) || canvasesRef.current.length > 0;
    if (!arrived.length || started || !placePhotosRef?.current) return 0;
    markRestored();
    await placePhotosRef.current(arrived);
    return arrived.length;
  }, [fetchStandIn, surfaceStatesRef, canvasesRef, placePhotosRef]);

  // ── A calendar's date photos. The design names each by an upload of the
  // earlier order, long gone from our server; each is fetched again from the
  // page's link and the date is pointed at the new upload.
  const showCellPhoto = useCallback(async (iso: string, uploadId: string): Promise<boolean> => {
    const { apiBase: base, getAuthHeaders: auth } = latest.current;
    const res = await fetch(`${base}/photos/${uploadId}/preview?size=512`, { headers: auth() });
    if (!res.ok) return false;
    const url = URL.createObjectURL(await res.blob());
    if (!aliveRef.current) { URL.revokeObjectURL(url); return false; }
    setCalendarCellImagePreviews?.(prev => {
      if (prev[iso]) URL.revokeObjectURL(prev[iso]);
      return { ...prev, [iso]: url };
    });
    return true;
  }, [setCalendarCellImagePreviews]);

  const restoreCellPhotos = useCallback(async (cells: Array<{ iso: string; uploadId: string }>): Promise<number> => {
    let loaded = 0;
    const queue = [...cells];
    const worker = async () => {
      for (;;) {
        const cell = queue.shift();
        if (!cell || !aliveRef.current) return;
        const link = linksRef.current.get(cell.uploadId);
        try {
          let uploadId = cell.uploadId;
          if (link) {
            const { apiBase: base, getAuthHeaders: auth, orderId: order } = latest.current;
            const made = await fetch(`${base}/upload/from-url`, {
              method: 'POST',
              headers: { ...auth(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: link.url, order_id: order, ...(link.name ? { filename: link.name } : {}) }),
            });
            if (!made.ok) continue;
            const info = await made.json() as { upload_id?: string };
            if (!info.upload_id) continue;
            uploadId = info.upload_id;
            const from = cell.uploadId;
            setCalendarCells?.(prev => {
              const entries = prev[cell.iso];
              if (!Array.isArray(entries) || !entries.some(e => e?.type === 'image' && e.uploadId === from)) return prev;
              return { ...prev, [cell.iso]: entries.map(e => (e?.type === 'image' && e.uploadId === from ? { ...e, uploadId } : e)) };
            });
          }
          if (await showCellPhoto(cell.iso, uploadId)) loaded += 1;
        } catch { /* the date keeps its "image expired" prompt */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PHOTOS_AT_ONCE, queue.length) }, worker));
    return loaded;
  }, [setCalendarCells, showCellPhoto]);

  // ── The restore itself: called from inside useAutosaveAndRestore's restore,
  // so autosave stays off until it returns. Photos keep arriving afterwards.
  const restoreFromParent = useCallback(async (own: OwnRestore) => {
    if (!restoreOrderId) return;
    // Our own saved design wins. The page is asked only when there is nothing
    // to show yet and this order was not already restored once (the customer
    // may have cleared it since), or when photos it names are not here.
    const needsDesign = !own.hasCards && own.restoredFrom !== restoreOrderId;
    // A calendar this order already holds: its date photos are uploads of
    // this order, so they are read straight back from our server.
    if (!needsDesign && latest.current.isCalendarProduct) {
      void whenCommitted(() => Object.keys(latest.current.calendarCells ?? {}).length > 0, 1500)
        .then(() => restoreCellPhotos(calendarCellPhotos(latest.current.calendarCells)));
    }
    if (!needsDesign && own.missingFileIds.length === 0) return;

    const win = window as unknown as RestoreWindow;
    const ancestors = (window.location as unknown as { ancestorOrigins?: ArrayLike<string> }).ancestorOrigins;
    const reply = await requestRestore({
      win, orderId: latest.current.orderId, restoreOrderId,
      targetOrigin: latest.current.parentOrigin,
      expectedOrigin: ancestors && ancestors.length > 0 && ancestors[0] ? ancestors[0] : null,
    });
    if (!reply.ok) {
      tellParent({ status: 'none', reason: reply.reason, photosTotal: 0, photosLoaded: 0 });
      return;
    }
    for (const photo of reply.photos) linksRef.current.set(photo.fileId, photo);

    if (!needsDesign) {
      // Our own design is on screen; only its photos are wanted.
      const wanted = own.missingFileIds;
      const withLinks = wanted.filter(id => linksRef.current.has(id));
      const onScreen = () => surfaceStatesRef.current.some(s => s.canvases.length > 0) || canvasesRef.current.length > 0;
      void whenCommitted(() => withLinks.length === 0 || onScreen())
        .then(() => loadPhotos(withLinks))
        .then(loaded => {
          tellParent({ status: restoreStatusFor(wanted.length, loaded), mode: 'design', photosTotal: wanted.length, photosLoaded: loaded });
        });
      return;
    }

    // The customer may have started adding photos while the page was
    // answering; their work is never replaced.
    if (surfaceStatesRef.current.some(s => s.canvases.length > 0) || canvasesRef.current.length > 0) {
      tellParent({ status: 'none', reason: 'design_in_progress', photosTotal: reply.photos.length, photosLoaded: 0 });
      return;
    }

    const design = reply.editorState;
    const fits = !!design && designFitsLayout(design, surfaceStatesRef.current, latest.current.isBookProduct);
    if (design && fits && own.applyDesign(design, restoreOrderId)) {
      // The whole design is back. Say so if the product was changed since.
      const servedVersion = layoutVersionRef?.current ?? null;
      if (reply.layoutVersion != null && servedVersion != null && reply.layoutVersion !== servedVersion) {
        setRestoreNotice('layout_changed');
      }
      const surfaces = Array.isArray(design.surfaces) ? design.surfaces as Array<{ canvases: CanvasItem[] }> : [];
      const hidden = (design.bookState as { hiddenSurfaces?: Array<{ canvases: CanvasItem[] }> } | undefined)?.hiddenSurfaces ?? [];
      const wanted = fileIdsInCardOrder([...surfaces, ...hidden].filter(s => Array.isArray(s?.canvases)));
      const withLinks = wanted.filter(id => linksRef.current.has(id));
      const cal = design.calendarState as { cells?: Record<string, unknown> } | undefined;
      const cellPhotos = latest.current.isCalendarProduct
        ? calendarCellPhotos(cal?.cells).filter(c => linksRef.current.has(c.uploadId))
        : [];
      const total = wanted.length + cellPhotos.length;
      // Not awaited: autosave may start, and the photos fill in behind the
      // design. They start once the design is on screen, so the first
      // arrivals find their cards.
      const onScreen = () => surfaceStatesRef.current.some(s => s.canvases.length > 0) || canvasesRef.current.length > 0;
      void whenCommitted(() => withLinks.length === 0 || onScreen())
        .then(() => Promise.all([loadPhotos(withLinks), restoreCellPhotos(cellPhotos)]))
        .then(([cards, cells]) => {
          tellParent({ status: restoreStatusFor(total, cards + cells), mode: 'design', photosTotal: total, photosLoaded: cards + cells });
        });
      return;
    }

    // No design to put back (an order from before designs were kept), or one
    // this product no longer fits: the photos are placed again, in order.
    const photos = photosToPlaceAgain(design, reply.photos);
    if (!photos.length) {
      tellParent({ status: 'none', reason: 'no_photos', photosTotal: 0, photosLoaded: 0 });
      return;
    }
    const notice: RestoreNotice = design ? 'layout_changed' : 'photos_only';
    void placePhotosAgain(photos, () => own.markRestored(restoreOrderId)).then(loaded => {
      if (loaded > 0 && aliveRef.current) setRestoreNotice(notice);
      tellParent({ status: restoreStatusFor(photos.length, loaded), mode: 'photos', photosTotal: photos.length, photosLoaded: loaded });
    });
  }, [restoreOrderId, tellParent, loadPhotos, surfaceStatesRef, canvasesRef, whenCommitted, layoutVersionRef, placePhotosAgain, restoreCellPhotos]);

  // ── Opening a card: its originals, at full size ──────────────────────────
  const originalUrlsRef = useRef(new Map<File, string>());
  const [openingCard, setOpeningCard] = useState<string | null>(null);

  const releaseOriginals = useCallback((keep: Set<File> = new Set()) => {
    for (const [file, url] of originalUrlsRef.current) {
      if (keep.has(file)) continue;
      URL.revokeObjectURL(url);
      originalUrlsRef.current.delete(file);
    }
  }, []);
  useEffect(() => () => releaseOriginals(), [releaseOriginals]);

  /** Before the canvas editor opens on a restored card: load the originals of
   *  its photos so the customer edits the real picture. Waits a few seconds at
   *  most; a slow one opens with the preview and nothing else changes, since
   *  the print uses the server's original whichever is on screen. */
  const prepareOriginals = useCallback(async (card: CanvasItem, cardKey: string) => {
    const standIns = card.frames
      .map(f => f.originalFile)
      .filter((f): f is File => !!f && restoredPhotos.isStandIn(f));
    // The card opened before this one is closed by now: let its originals go.
    releaseOriginals(new Set(standIns));
    const missing = standIns.filter(f => !originalUrlsRef.current.has(f));
    if (!missing.length) return;
    setOpeningCard(cardKey);
    const { apiBase: base, getAuthHeaders: auth } = latest.current;
    const all = Promise.all(missing.map(async (file) => {
      const uploadId = restoredPhotos.serverPhotoOf(file)?.uploadId;
      if (!uploadId) return;
      try {
        const res = await fetch(`${base}/photos/${uploadId}/preview?size=full`, { headers: auth() });
        if (!res.ok) return;
        const blob = await res.blob();
        if (aliveRef.current && !originalUrlsRef.current.has(file)) {
          originalUrlsRef.current.set(file, URL.createObjectURL(blob));
        }
      } catch { /* the preview stays */ }
    }));
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([all, new Promise<void>(resolve => { timer = setTimeout(resolve, ORIGINAL_WAIT_MS); })]);
    if (timer) clearTimeout(timer);
    if (aliveRef.current) setOpeningCard(null);
  }, [releaseOriginals, restoredPhotos]);

  /** For the canvas editor: the original when it is loaded, else what the
   *  cards use. Stable, so the editor does not rebuild when one arrives. */
  const getEditFileUrl = useCallback(
    (file: File): string => originalUrlsRef.current.get(file) ?? getFileUrl(file),
    [getFileUrl],
  );

  return {
    restoreOrderId, restoreFromParent: restoreOrderId ? restoreFromParent : undefined,
    restoredPhotos, photoStatus, retryRestoredPhotos,
    prepareOriginals, openingCard, getEditFileUrl,
    restoreNotice, dismissRestoreNotice: () => setRestoreNotice(null), restoreProgress,
  };
}
