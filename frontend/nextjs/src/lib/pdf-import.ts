/**
 * Client-side PDF page rasterization via pdfjs-dist — the PDF analogue of
 * heic-convert.ts. Neither the Fabric canvas preview nor the backend
 * (Pillow has no PDF reader) can open a PDF, so a customer's chosen pages
 * are rasterized to PNG entirely in the browser before they ever become
 * "a file" anywhere else in the app.
 *
 * Runs on the MAIN THREAD ONLY — no Worker is ever constructed. This app
 * already hit a real Turbopack bug where an inline-Worker-payload library
 * (Pica) silently hangs forever under Turbopack's module transform, never
 * resolving or rejecting (see fabric-renderer.ts). Rather than risk the
 * same failure class with pdf.js's own Worker, `ensureMainThreadPdfJs()`
 * below imports the worker's code as a plain module and exposes it via
 * `globalThis.pdfjsWorker` — verified directly against the installed
 * pdfjs-dist@6.2.108 source that this causes its PDFWorker to skip
 * constructing a real Worker entirely and use its in-process "fake worker"
 * path instead (a same-thread LoopbackPort, not a Worker thread). Trade-off:
 * parsing/rasterizing now briefly holds the UI thread per page instead of
 * running off it — accepted deliberately, see the feature's plan doc.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  PDF_MAX_OUTPUT_DIMENSION_PX,
  PDF_MAX_PAGES,
  PDF_RASTER_DPI,
  PDF_THUMBNAIL_TARGET_LONG_EDGE_PX,
  computeRasterScale,
  computeThumbnailScale,
} from '@/lib/pdf-raster-scale';

const PDF_EXTENSIONS = ['pdf'];
const PDF_MIME_TYPES = ['application/pdf'];

function fileExtension(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

export function isPdfFile(file: File): boolean {
  return (
    PDF_EXTENSIONS.includes(fileExtension(file.name)) ||
    PDF_MIME_TYPES.includes(file.type.toLowerCase())
  );
}

export class PdfImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfImportError';
  }
}

// ─── Main-thread-only pdf.js setup (module-level, runs once) ───────────────

let mainThreadSetup: Promise<void> | null = null;

async function ensureMainThreadPdfJs(): Promise<void> {
  if (!mainThreadSetup) {
    mainThreadSetup = import('pdfjs-dist/build/pdf.worker.mjs').then(workerModule => {
      (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
    });
  }
  return mainThreadSetup;
}

// ─── Document handle ────────────────────────────────────────────────────────

export interface PdfDocumentHandle {
  numPages: number;
  /** Inherited from the source File — see pdf-import.ts's lastModified note
   *  in rasterizeSelectedPages for why this matters for file identity. */
  sourceLastModified: number;
  getPageSizePt(pageNumber: number): Promise<{ widthPt: number; heightPt: number }>;
  renderPageToDataUrl(pageNumber: number, scale: number): Promise<string>;
  renderPageToBlob(pageNumber: number, scale: number): Promise<Blob>;
  destroy(): void;
}

export async function openPdfDocument(file: File): Promise<PdfDocumentHandle> {
  await ensureMainThreadPdfJs();
  const pdfjsLib = await import('pdfjs-dist');

  const data = new Uint8Array(await file.arrayBuffer());
  // destroy() lives on the loading task (owns the worker/transport), not on
  // the resolved PDFDocumentProxy — confirmed against the installed
  // pdfjs-dist types (PDFDocumentProxy has no destroy method at all).
  const loadingTask = pdfjsLib.getDocument({ data });
  let doc: PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    void loadingTask.destroy();
    if (err instanceof pdfjsLib.PasswordException) {
      throw new PdfImportError('This PDF is password-protected. Please remove the password and try again.');
    }
    if (err instanceof pdfjsLib.InvalidPDFException) {
      throw new PdfImportError("This file doesn't look like a valid PDF — it may be corrupted.");
    }
    throw new PdfImportError('This PDF couldn\'t be opened. Please try again or use a different file.');
  }

  if (doc.numPages === 0) {
    void loadingTask.destroy();
    throw new PdfImportError('This PDF has no pages.');
  }
  if (doc.numPages > PDF_MAX_PAGES) {
    void loadingTask.destroy();
    throw new PdfImportError(
      `This PDF has ${doc.numPages} pages — please split it or use a document under ${PDF_MAX_PAGES} pages.`,
    );
  }

  const pageCache = new Map<number, PDFPageProxy>();
  const getCachedPage = async (pageNumber: number): Promise<PDFPageProxy> => {
    let page = pageCache.get(pageNumber);
    if (!page) {
      page = await doc.getPage(pageNumber);
      pageCache.set(pageNumber, page);
    }
    return page;
  };

  const renderToCanvas = async (pageNumber: number, scale: number): Promise<HTMLCanvasElement> => {
    const page = await getCachedPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    if (!canvas.getContext('2d')) {
      throw new PdfImportError('This browser could not prepare a canvas to render the PDF.');
    }
    // `canvas`, not `canvasContext`, is the primary/required param in this
    // pdfjs-dist version — canvasContext is kept only for backwards compat.
    await page.render({ canvas, viewport }).promise;
    return canvas;
  };

  return {
    numPages: doc.numPages,
    sourceLastModified: file.lastModified,
    async getPageSizePt(pageNumber) {
      const page = await getCachedPage(pageNumber);
      const [x0, y0, x1, y1] = page.view;
      return { widthPt: x1 - x0, heightPt: y1 - y0 };
    },
    async renderPageToDataUrl(pageNumber, scale) {
      const canvas = await renderToCanvas(pageNumber, scale);
      return canvas.toDataURL('image/png');
    },
    async renderPageToBlob(pageNumber, scale) {
      const canvas = await renderToCanvas(pageNumber, scale);
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new PdfImportError('Converting this page to an image failed.'));
        }, 'image/png');
      });
    },
    destroy() {
      pageCache.clear();
      void loadingTask.destroy();
    },
  };
}

/**
 * Generates a low-res thumbnail per page for the picker grid, calling back
 * as each one resolves so the modal can reveal thumbnails progressively
 * (main-thread rendering means later pages genuinely aren't ready yet, not
 * just artificially staggered). A single page's thumbnail failing calls
 * back with `null` (the modal shows a "couldn't preview" placeholder but
 * the page stays selectable) rather than silently never resolving for that
 * page — the page's own selectability isn't affected; only the full-
 * resolution rasterization on confirm is treated as a hard failure (see
 * rasterizeSelectedPages).
 */
export async function generateThumbnails(
  doc: PdfDocumentHandle,
  onThumbnail: (pageIndex0: number, dataUrl: string | null) => void,
): Promise<void> {
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    try {
      const { widthPt, heightPt } = await doc.getPageSizePt(pageNumber);
      const scale = computeThumbnailScale(widthPt, heightPt, PDF_THUMBNAIL_TARGET_LONG_EDGE_PX);
      const dataUrl = await doc.renderPageToDataUrl(pageNumber, scale);
      onThumbnail(pageNumber - 1, dataUrl);
    } catch {
      onThumbnail(pageNumber - 1, null);
    }
    await new Promise(r => setTimeout(r, 0)); // yield between pages
  }
}

function derivedPageFileName(sourceFileName: string, pageNumber: number): string {
  const base = sourceFileName.replace(/\.pdf$/i, '');
  return `${base}-page-${pageNumber}.png`;
}

/**
 * Marks every File rasterizeSelectedPages produces. The main editor's
 * auto-orientation (server-side pose detection, then an aspect-ratio
 * rotate-to-fill fallback — see resolveRotation in page.tsx) is designed
 * for photos held sideways, not document pages: pose detection on a
 * rasterized PDF page is meaningless, and the aspect fallback would happily
 * rotate a deliberately-designed document 90° just because its ratio
 * doesn't match the frame. Call sites check `pdfDerivedFiles.has(file)` and
 * skip auto-orientation entirely for a hit, rather than threading a new
 * parameter through the whole canvas-generation call chain for one flag.
 */
export const pdfDerivedFiles = new WeakSet<File>();

/**
 * Rasterizes exactly the selected pages at full print resolution. One page
 * at a time (not Promise.all) — mirrors the imposition-sheet export loop in
 * page.tsx: render → toBlob → new File → yield to the main thread, so a
 * multi-page selection doesn't block the UI in one unbroken stretch.
 *
 * `lastModified` is inherited from the source PDF (doc.sourceLastModified),
 * not stamped with the current time. PDF rendering is deterministic — same
 * bytes + same scale → same pixels — so a derived page's identity
 * (name:size:lastModified, which this app uses for edit-preservation and
 * IndexedDB persistence — see canvas-merge.ts/file-store.ts) stays stable
 * and reproducible across repeated imports of the same PDF+page, exactly
 * like a directly-picked photo. Stamping Date.now() instead would silently
 * lose any edits on re-import, since wall-clock time isn't deterministic.
 *
 * Rejects the whole call if any single page fails to rasterize, rather than
 * returning fewer files than requested — a selected-but-unconvertible page
 * must never just vanish from the output without telling the customer.
 */
export async function rasterizeSelectedPages(
  doc: PdfDocumentHandle,
  pageNumbers: number[],
  sourceFileName: string,
  onProgress?: (current: number, total: number) => void,
): Promise<File[]> {
  const results: File[] = [];
  for (let i = 0; i < pageNumbers.length; i++) {
    const pageNumber = pageNumbers[i];
    const { widthPt, heightPt } = await doc.getPageSizePt(pageNumber);
    const { scale } = computeRasterScale(widthPt, heightPt, PDF_RASTER_DPI, PDF_MAX_OUTPUT_DIMENSION_PX);
    const blob = await doc.renderPageToBlob(pageNumber, scale);
    const derivedFile = new File([blob], derivedPageFileName(sourceFileName, pageNumber), {
      type: 'image/png',
      lastModified: doc.sourceLastModified,
    });
    pdfDerivedFiles.add(derivedFile);
    results.push(derivedFile);
    onProgress?.(i + 1, pageNumbers.length);
    await new Promise(r => setTimeout(r, 0));
  }
  return results;
}
