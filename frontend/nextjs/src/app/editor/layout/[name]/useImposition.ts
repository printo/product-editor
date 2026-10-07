// Type-only import — erased at compile time, zero bundle impact.
// The actual Fabric.js runtime is loaded lazily inside executeImposition / the
// imposition preview useEffect so it does NOT inflate the initial page bundle.
import type { StaticCanvas as FabricStaticCanvas } from 'fabric';
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createZipFromDataUrls, downloadBlob } from '@/lib/zip-utils';
import { MEASURE_RETRY_LIMIT, MEASURE_RETRY_MS } from './editor-utils';
import {
  MM_TO_IN,
  CROP_MARK_LEN_MM,
  canvasSpecToInches,
  computeImpositionLayout,
  cropMarkLengthsFor,
  resolveSheetSize,
  type ItemSize,
} from './imposition';
import type { CanvasItem, ImpositionSettings, SurfaceState } from './types';

type Params = {
  /** The page's layout state (held as `any` there). */
  layout: any;
  surfaceStates: SurfaceState[];
  canvases: CanvasItem[];
  renderCanvas: (canvasItem: CanvasItem, options: { isExport?: boolean; includeMask?: boolean }) => Promise<string | null | undefined>;
  setError: Dispatch<SetStateAction<string | null>>;
  setRenderProgress: Dispatch<SetStateAction<{ current: number; total: number } | null>>;
};

/** Imposition (print sheets): the settings, the live sheet preview and the
 *  full-resolution export. The modal itself is ImpositionModal. */
export function useImposition({ layout, surfaceStates, canvases, renderCanvas, setError, setRenderProgress }: Params) {
  const [showImpositionModal, setShowImpositionModal] = useState(false);
  const [isImposing, setIsImposing] = useState(false);
  const [impositionSettings, setImpositionSettings] = useState<ImpositionSettings>({
    preset: 'a4', widthIn: 8.27, heightIn: 11.69, marginMm: 6, gutterMm: 5, orientation: 'portrait',
    cropMarksEnabled: true, cropMarkLenMm: CROP_MARK_LEN_MM,
  });
  const impositionPreviewRef = useRef<HTMLCanvasElement>(null);
  const impositionPreviewBoxRef = useRef<HTMLDivElement>(null);
  const [previewBox, setPreviewBox] = useState({ w: 0, h: 0 });
  const impositionFabricRef = useRef<FabricStaticCanvas | null>(null);
  const [previewSheetIdx, setPreviewSheetIdx] = useState(0);

  /** The canvases destined for the sheet, in placement order. */
  const impositionCanvases = useMemo(
    () => (surfaceStates.length > 1 ? surfaceStates.flatMap(s => s.canvases) : canvases),
    [surfaceStates, canvases],
  );

  /**
   * Physical size of each of those canvases, in inches — index for index.
   *
   * Every surface contributes ITS OWN dimensions: a multi-surface product whose
   * sides differ in size must not be imposed at the first side's size. `null`
   * means the layout carries no usable dimensions, in which case imposition is
   * refused rather than guessing a size (a wrong guess prints at the wrong
   * scale with no visible symptom).
   */
  const impositionItems = useMemo<ItemSize[] | null>(() => {
    if (!layout) return null;
    if (surfaceStates.length > 1) {
      const sizes: ItemSize[] = [];
      for (const s of surfaceStates) {
        const size = canvasSpecToInches(s.def?.canvas);
        if (!size) return null;
        for (let i = 0; i < s.canvases.length; i++) sizes.push(size);
      }
      return sizes;
    }
    // Single surface: `canvases` is the live array (surfaceStates[0].canvases
    // only re-syncs on surface switch), but the physical size still comes from
    // the surface definition.
    const size = canvasSpecToInches(surfaceStates[0]?.def?.canvas ?? layout.canvas);
    return size ? canvases.map(() => size) : null;
  }, [layout, surfaceStates, canvases]);

  const impositionResult = useMemo(
    () => computeImpositionLayout(impositionSettings, impositionItems ?? []),
    [impositionSettings, impositionItems],
  );

  const sheetCount = impositionResult.sheets.length;
  const impositionPlacedTotal = useMemo(
    () => impositionResult.placedPerCanvas.reduce((a, b) => a + b, 0),
    [impositionResult],
  );
  const impositionSheetLabel = impositionSettings.preset === 'custom'
    ? `${impositionSettings.widthIn}″ × ${impositionSettings.heightIn}″`
    : impositionSettings.preset.toUpperCase();

  // Keep the page selector inside range when the settings change the sheet
  // count, and start every visit to the modal on sheet 1.
  useEffect(() => {
    setPreviewSheetIdx(p => (p < sheetCount ? p : Math.max(0, sheetCount - 1)));
  }, [sheetCount]);
  useEffect(() => {
    if (showImpositionModal) setPreviewSheetIdx(0);
  }, [showImpositionModal]);

  // The preview scales to the box it is actually given. A fixed pixel budget
  // overflowed the pane on landscape sheets, and `max-w-full` then squashed
  // the canvas horizontally while Fabric's inline height held — the sheet
  // rendered at the wrong aspect ratio.
  useEffect(() => {
    const el = impositionPreviewBoxRef.current;
    if (!el || !showImpositionModal) return;

    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    // Only publish a genuinely new size. Returning a fresh object on every
    // observer tick would re-run the draw effect, which resizes the canvas
    // inside this very box — a feedback loop that disposed and rebuilt the
    // Fabric scene forever and never reached the final render.
    const measure = () => {
      const w = Math.floor(el.clientWidth), h = Math.floor(el.clientHeight);
      setPreviewBox(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
      // A ResizeObserver only delivers during the document's rendering steps,
      // and a hidden document runs none — so if the box has no size yet, the
      // observer alone may never report the real one and the preview would
      // stay blank until the operator happened to change a setting. Poll
      // briefly to cover that; the observer takes over once a size exists.
      if ((w <= 0 || h <= 0) && attempts < MEASURE_RETRY_LIMIT) {
        attempts++;
        retry = setTimeout(measure, MEASURE_RETRY_MS);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // A tab that was hidden when the modal opened delivered no observer
    // callbacks at all; re-measure the moment it becomes visible again.
    document.addEventListener('visibilitychange', measure);
    return () => {
      ro.disconnect();
      document.removeEventListener('visibilitychange', measure);
      if (retry) clearTimeout(retry);
    };
  }, [showImpositionModal]);

  // Decoded sheet thumbnails, keyed by dataUrl. Rebuilding the preview used to
  // re-decode every placed image on every keystroke; a gang run of one design
  // now decodes once.
  const previewImgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  useEffect(() => {
    if (!showImpositionModal) previewImgCache.current.clear();
  }, [showImpositionModal]);

  useEffect(() => {
    const canvasEl = impositionPreviewRef.current;
    const { sheets, cropMarks } = impositionResult;
    if (!canvasEl || sheets.length === 0 || !showImpositionModal) return;
    // Measure the box HERE rather than trusting the observer's last delivery.
    // previewBox stays in the dependency list purely as a resize trigger: if
    // the box happens to be zero-width on first paint and the observer hasn't
    // reported yet, a live read still gets the real size on the next run.
    const boxEl = impositionPreviewBoxRef.current;
    const availW = boxEl?.clientWidth ?? 0;
    const availH = boxEl?.clientHeight ?? 0;
    if (availW <= 0 || availH <= 0) return;
    const sheet = sheets[Math.min(previewSheetIdx, sheets.length - 1)];
    if (!sheet) return;

    const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
    const scale = Math.min(availW / sheetWIn, availH / sheetHIn);
    if (!(scale > 0) || !Number.isFinite(scale)) return;
    const pw = Math.round(sheetWIn * scale), ph = Math.round(sheetHIn * scale);
    const mPx = (impositionSettings.marginMm / MM_TO_IN) * scale;
    const markOffset = cropMarks.offsetIn * scale;

    let aborted = false;

    // Lazy-load Fabric.js only when the imposition modal is actually opened.
    const run = async () => {
      const { StaticCanvas, Rect: FabricRect, FabricImage, Line } = await import('fabric');
      if (aborted) return;

      if (impositionFabricRef.current) {
        impositionFabricRef.current.dispose();
        impositionFabricRef.current = null;
      }
      const fc = new StaticCanvas(canvasEl, {
        width: pw, height: ph, backgroundColor: '#f8fafc', renderOnAddRemove: false,
      });
      impositionFabricRef.current = fc;
      fc.add(new FabricRect({
        left: mPx, top: mPx, originX: 'left', originY: 'top', width: pw - 2 * mPx, height: ph - 2 * mPx,
        fill: '#ffffff', stroke: '#e2e8f0', strokeWidth: 1,
        strokeDashArray: [4, 3], selectable: false, evented: false,
      }));
      fc.add(new FabricRect({
        left: 0, top: 0, originX: 'left', originY: 'top', width: pw, height: ph,
        fill: 'transparent', stroke: '#94a3b8', strokeWidth: 1.5,
        selectable: false, evented: false,
      }));

      const loadEl = async (dataUrl: string) => {
        const hit = previewImgCache.current.get(dataUrl);
        if (hit) return hit;
        const decoded = await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
        const el = decoded.getElement() as HTMLImageElement;
        previewImgCache.current.set(dataUrl, el);
        return el;
      };

      for (const item of sheet.items) {
        if (aborted) return;
        const [px, py, iw, ih] = [item.x * scale, item.y * scale, item.w * scale, item.h * scale];
        const c = impositionCanvases[item.canvasIdx];
        if (c?.dataUrl) {
          try {
            const el = await loadEl(c.dataUrl);
            if (aborted) return;
            const img = new FabricImage(el, { selectable: false, evented: false });
            if (item.rotated) {
              img.set({
                left: px + iw / 2, top: py + ih / 2,
                originX: 'center', originY: 'center',
                scaleX: ih / (img.width || 1), scaleY: iw / (img.height || 1),
                angle: -90,
              });
            } else {
              img.set({
                left: px, top: py, originX: 'left', originY: 'top',
                scaleX: iw / (img.width || 1), scaleY: ih / (img.height || 1),
              });
            }
            fc.add(img);
          } catch { }
        }
        // Skipped entirely when the gutter/margin leaves no room — drawing them
        // anyway put black lines across the neighbouring photo.
        // Per-side lengths: an edge facing the paper gets a usable mark, an
        // edge facing another photo stays short enough not to bleed onto it.
        const L = cropMarkLengthsFor(item, sheet.items, impositionSettings, sheetWIn, sheetHIn);
        const vLen = { '-1': L.top * scale, '1': L.bottom * scale } as Record<string, number>;
        const hLen = { '-1': L.left * scale, '1': L.right * scale } as Record<string, number>;
        for (const [cx, cy, dx, dy] of [
          [px, py, -1, -1], [px + iw, py, 1, -1],
          [px, py + ih, -1, 1], [px + iw, py + ih, 1, 1],
        ] as [number, number, number, number][]) {
          const vl = vLen[String(dy)];
          const hl = hLen[String(dx)];
          if (vl > 0) fc.add(new Line([cx, cy + dy * markOffset, cx, cy + dy * (markOffset + vl)], { stroke: '#64748b', strokeWidth: 0.5, selectable: false, evented: false }));
          if (hl > 0) fc.add(new Line([cx + dx * markOffset, cy, cx + dx * (markOffset + hl), cy], { stroke: '#64748b', strokeWidth: 0.5, selectable: false, evented: false }));
        }
      }
      // renderAll, not requestRenderAll: the whole scene is built in one pass,
      // so there is nothing to coalesce, and the rAF that requestRenderAll
      // schedules never fires while the document is hidden — a backgrounded tab
      // would show an empty preview until something forced a repaint.
      if (!aborted) fc.renderAll();
    };

    // Debounced so holding a key in the margin/gutter field doesn't tear down
    // and rebuild the whole Fabric scene on every digit.
    const timer = setTimeout(run, 100);
    return () => {
      aborted = true;
      clearTimeout(timer);
      if (impositionFabricRef.current) {
        impositionFabricRef.current.dispose();
        impositionFabricRef.current = null;
      }
    };
  }, [impositionResult, previewSheetIdx, impositionSettings, impositionCanvases, showImpositionModal, previewBox]);

  const executeImposition = async () => {
    if (!impositionItems) {
      setError('This layout has no physical dimensions, so it cannot be imposed.');
      return;
    }
    setIsImposing(true);
    try {
      const dpi = 300;
      const { sheets: impositionSheets, cropMarks } = computeImpositionLayout(
        impositionSettings,
        impositionItems,
      );
      const { w: sheetWIn, h: sheetHIn } = resolveSheetSize(impositionSettings);
      const sheetW = Math.round(sheetWIn * dpi), sheetH = Math.round(sheetHIn * dpi);

      // 1. Prepare for sheet generation
      const cropMarkOff = Math.round(cropMarks.offsetIn * dpi);
      const sheetBlobs: { name: string; blob: Blob }[] = [];
      // StaticCanvas, not Canvas: the interactive one allocates a second
      // full-size "upper canvas" it never uses (~139 MB per A4 sheet), and
      // retina scaling would silently export every sheet at 2x on a Mac.
      const { StaticCanvas, FabricImage, Line } = await import('fabric');

      // A gang run places the same design dozens of times. Render each distinct
      // canvas once at full resolution and reuse it, instead of once per slot.
      const renderedByIdx = new Map<number, string>();
      const renderOnce = async (idx: number) => {
        const hit = renderedByIdx.get(idx);
        if (hit !== undefined) return hit;
        const dataUrl = (await renderCanvas(impositionCanvases[idx], { isExport: true, includeMask: true })) || '';
        renderedByIdx.set(idx, dataUrl);
        return dataUrl;
      };

      const totalItems = impositionSheets.reduce((acc, s) => acc + s.items.length, 0);
      let done = 0;

      // 2. Process each sheet sequentially to keep memory usage low
      for (let si = 0; si < impositionSheets.length; si++) {
        const sheet = impositionSheets[si];
        const sheetEl = document.createElement('canvas');
        sheetEl.width = sheetW; sheetEl.height = sheetH;
        const fabricSheet = new StaticCanvas(sheetEl, {
          width: sheetW, height: sheetH, backgroundColor: 'white',
          renderOnAddRemove: false, enableRetinaScaling: false,
        });

        // For each item in the sheet, render the high-res canvas and place it
        for (let ii = 0; ii < sheet.items.length; ii++) {
          const item = sheet.items[ii];
          const [px, py, pw, ph] = [Math.round(item.x * dpi), Math.round(item.y * dpi), Math.round(item.w * dpi), Math.round(item.h * dpi)];

          try {
            const dataUrl = await renderOnce(item.canvasIdx);
            if (dataUrl) {
              const img = await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
              if (item.rotated) {
                img.set({ left: px + pw / 2, top: py + ph / 2, originX: 'center', originY: 'center', scaleX: ph / img.width!, scaleY: pw / img.height!, angle: -90, selectable: false, evented: false });
              } else {
                img.set({ left: px, top: py, originX: 'left', originY: 'top', scaleX: pw / img.width!, scaleY: ph / img.height!, selectable: false, evented: false });
              }
              fabricSheet.add(img);
            }
          } catch (err) {
            console.error('Failed to render imposition item:', err);
          }

          // Crop marks, clamped by resolveCropMarkGeometry so they can never
          // reach into the neighbouring photo or run off the sheet edge.
          const L = cropMarkLengthsFor(item, sheet.items, impositionSettings, sheetWIn, sheetHIn);
          const vPx = { '-1': Math.round(L.top * dpi), '1': Math.round(L.bottom * dpi) } as Record<string, number>;
          const hPx = { '-1': Math.round(L.left * dpi), '1': Math.round(L.right * dpi) } as Record<string, number>;
          for (const [cx, cy, dx, dy] of [[px, py, -1, -1], [px + pw, py, 1, -1], [px, py + ph, -1, 1], [px + pw, py + ph, 1, 1]] as [number, number, number, number][]) {
            const vl = vPx[String(dy)];
            const hl = hPx[String(dx)];
            if (vl > 0) fabricSheet.add(new Line([cx, cy + dy * cropMarkOff, cx, cy + dy * (cropMarkOff + vl)], { stroke: '#000', strokeWidth: 1, selectable: false, evented: false }));
            if (hl > 0) fabricSheet.add(new Line([cx + dx * cropMarkOff, cy, cx + dx * (cropMarkOff + hl), cy], { stroke: '#000', strokeWidth: 1, selectable: false, evented: false }));
          }

          done++;
          setRenderProgress({ current: done, total: totalItems });
          await new Promise(r => setTimeout(r, 0));
        }

        fabricSheet.renderAll();
        const blob = await new Promise<Blob>(res => sheetEl.toBlob(b => res(b!), 'image/png'));
        sheetBlobs.push({ name: `imposition-sheet-${si + 1}.png`, blob });
        fabricSheet.dispose();
      }

      if (sheetBlobs.length === 0) {
        setError('Nothing could be placed on the sheet — try a larger sheet size or smaller margins.');
        return;
      }
      if (sheetBlobs.length === 1) downloadBlob(sheetBlobs[0].blob, sheetBlobs[0].name);
      else {
        downloadBlob(await createZipFromDataUrls(sheetBlobs), 'imposition-sheets.zip');
      }
    } catch (err) {
      console.error('Imposition failed:', err);
      setError('Imposition failed.');
    } finally {
      setIsImposing(false);
      setShowImpositionModal(false);
      setRenderProgress(null);
    }
  };

  return {
    showImpositionModal, setShowImpositionModal, isImposing,
    impositionSettings, setImpositionSettings,
    impositionPreviewRef, impositionPreviewBoxRef,
    previewSheetIdx, setPreviewSheetIdx,
    impositionResult, sheetCount, impositionPlacedTotal, impositionSheetLabel,
    executeImposition,
  };
}

export type Imposition = ReturnType<typeof useImposition>;
