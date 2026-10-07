'use client';

import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CalendarTheme, CalendarType } from '@/types/calendar';
import { isAllowedImageFile, unsupportedFilesMessage, uploadFiles } from '@/lib/upload-utils';
import { formatWait } from './editor-utils';
import type { CanvasItem, FrameState, Overlay, SurfaceState } from './types';

type Setter<T> = Dispatch<SetStateAction<T>>;

/** Save & Continue (embed) and Download (dashboard): upload every photo,
 *  submit the render job, then tell the storefront (embed) or poll and
 *  download the ZIP (dashboard). Holds the submit-side state: the progress
 *  label, the include-uploads choice, the disclaimer tick and the embed's
 *  submitted panel. */
export function useServerRender({
  layout, layoutName, embedToken, parentOrigin, apiBase, getAuthHeaders, orderId, surfaceStates, canvases, activeSurfaceKey,
  isCalendarProduct, calendarTheme, calendarType, genzPalette, calendarCells, isBookProduct, bookPageCount,
  qtyNeeded, totalUploadedCount, setIsDownloading, setShowDownloadModal, setRenderProgress, setError,
}: {
  layout: any;
  layoutName: string;
  embedToken: string | null;
  parentOrigin: string;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  orderId: string;
  surfaceStates: SurfaceState[];
  canvases: CanvasItem[];
  activeSurfaceKey: string;
  isCalendarProduct: boolean;
  calendarTheme: CalendarTheme;
  calendarType: CalendarType;
  genzPalette: string | undefined;
  calendarCells: Record<string, any[]>;
  isBookProduct: boolean;
  bookPageCount: number;
  qtyNeeded: number;
  totalUploadedCount: number;
  setIsDownloading: Setter<boolean>;
  setShowDownloadModal: Setter<boolean>;
  setRenderProgress: Setter<{ current: number; total: number } | null>;
  setError: Setter<string | null>;
}) {
  const [serverRenderLabel, setServerRenderLabel] = useState<string | null>(null);
  // Include the customer's original uploads in the download ZIP — OFF by default
  // so the archive is just mock + print (much smaller/faster). The ref mirrors
  // it for the async download-URL builder below.
  const [includeUploads, setIncludeUploads] = useState(false);
  const includeUploadsRef = useRef(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Job id behind the embed post-submit status panel (Phase 3).
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);

  // All exports go through the server-side pipeline (Celery + Pillow at 300 DPI).
  // The previous "≤20 canvases → render in browser, JSZip" optimisation was
  // removed in v1.8 — uniform contract, predictable progress UI, and the
  // server pipeline is faster on big jobs while the small-job overhead
  // (~10–20 s of upload + poll) is acceptable.
  const executeServerRender = async () => {
    setIsDownloading(true);
    // Embed customers get plain product wording; the dashboard keeps the
    // operational labels staff rely on to tell a slow upload from a slow
    // render. The work is identical either way — only the copy differs.
    setServerRenderLabel(embedToken ? 'Saving your design…' : 'Preparing upload…');
    setRenderProgress({ current: 0, total: 100 });
    try {
      // 1. Collect all canvases in order across all surfaces. A surface the
      // customer left EMPTY is included as one blank canvas (null upload_ids)
      // rather than dropped: dropping it used to make the engine render that
      // surface with the other surface's photos (Phase 3 wrong-print fix) —
      // now it prints blank and the pre-submit warning tells the customer so.
      const allCanvases = surfaceStates.length > 1
        ? surfaceStates.flatMap(s =>
            s.canvases.length > 0
              ? s.canvases.map(c => ({ ...c, surfaceKey: s.key }))
              : [{
                  id: 0,
                  frames: (s.def.frames || [{ }]).map((_, fi) => ({
                    id: fi,
                    originalFile: null,
                    offset: { x: 0, y: 0 },
                    scale: 1,
                    rotation: 0,
                    fitMode: s.globalFitMode,
                  })) as FrameState[],
                  overlays: [] as Overlay[],
                  bgColor: '#ffffff',
                  paperColor: '#ffffff',
                  dataUrl: null,
                  surfaceKey: s.key,
                }]
          )
        // Send the REAL surface key, not a literal 'canvas'. For a single
        // surface of a type:product layout (e.g. a ?surfaces=front view of a
        // 2-sided product) the engine's per-surface grouping keys off this;
        // the literal matched no surface and printed every side blank. Legacy
        // type:single layouts fall back to 'canvas', which the engine ignores.
        : canvases.map(c => ({ ...c, surfaceKey: surfaceStates[0]?.key ?? activeSurfaceKey ?? 'canvas' }));

      // 2. Collect unique File objects in frame order, then any local
      //    image-overlay files (stickers the customer uploaded) so they upload
      //    in the same batch and the server can resolve them for the print.
      const allFiles: File[] = [];
      const seenFiles = new Set<File>();
      for (const c of allCanvases) {
        for (const frame of c.frames) {
          if (frame.originalFile && !seenFiles.has(frame.originalFile)) {
            seenFiles.add(frame.originalFile);
            allFiles.push(frame.originalFile);
          }
        }
        for (const ov of c.overlays) {
          if (ov.type === 'image' && ov.originalFile && !seenFiles.has(ov.originalFile)) {
            seenFiles.add(ov.originalFile);
            allFiles.push(ov.originalFile);
          }
        }
      }

      // Guard: a frame that once held a photo (it carries a persisted fileId)
      // but whose File did not rehydrate this session (originalFile === null)
      // would submit an empty slot. Rather than silently ship an incomplete
      // design, block the submit and name the photos to re-upload. This closes
      // the client side of the silent wrong-print bug (the backend now renders
      // such a slot blank instead of shifting other photos into it).
      const lostFrames: string[] = [];
      allCanvases.forEach((c, ci) => {
        c.frames.forEach((frame, fi) => {
          if ((frame.fileId || frame.fileName) && !frame.originalFile) {
            lostFrames.push(
              allCanvases.length > 1 ? `page ${ci + 1}, photo ${fi + 1}` : `photo ${fi + 1}`,
            );
          }
        });
      });
      if (lostFrames.length > 0) {
        const shown = lostFrames.slice(0, 3).join('; ');
        const more = lostFrames.length > 3 ? `, and ${lostFrames.length - 3} more` : '';
        setError(
          `${lostFrames.length} photo${lostFrames.length > 1 ? 's' : ''} could not be ` +
          `recovered (${shown}${more}). Please re-upload ` +
          `${lostFrames.length > 1 ? 'them' : 'it'} before continuing so your print ` +
          `matches your design.`,
        );
        return;
      }

      if (allFiles.length === 0) {
        setError('No files to upload for server render.');
        return;
      }

      // Block unsupported types before uploading so the failure names the file
      // (e.g. a .svg restored from a prior session) instead of surfacing the
      // backend's cryptic "Upload complete failed for …" mid-batch.
      const badFiles = allFiles.filter(f => !isAllowedImageFile(f));
      if (badFiles.length > 0) {
        setError(unsupportedFilesMessage(badFiles));
        return;
      }

      // 3. Upload files — progress 0–60%
      setServerRenderLabel(embedToken ? 'Saving your photos…' : 'Uploading files…');
      const uploadResults = await uploadFiles(
        allFiles,
        apiBase,
        getAuthHeaders,
        (completed, total) => {
          setRenderProgress({ current: Math.round((completed / total) * 60), total: 100 });
        },
        orderId,
      );

      // 4. Build render payload: canvases → frames → upload_id + per-frame transforms
      setServerRenderLabel(embedToken ? 'Finishing up…' : 'Submitting render job…');
      setRenderProgress({ current: 65, total: 100 });

      const canvasesPayload = allCanvases.map((c, canvasIdx) => ({
        canvas_index: canvasIdx,
        surface_key: (c as any).surfaceKey,
        // Phase 2 (WYSIWYG): carry the customer's canvas background + paper mat
        // colours so the print matches the preview (engine defaulted to white).
        bg_color: (c as any).bgColor ?? null,
        paper_color: (c as any).paperColor ?? null,
        frames: c.frames.map((frame, frameIdx) => {
          const up = frame.originalFile ? uploadResults.get(frame.originalFile) : null;
          return {
            frame_index: frameIdx,
            upload_id: up?.uploadId ?? null,
            offset_x: frame.offset.x,
            offset_y: frame.offset.y,
            scale: frame.scale,
            rotation: frame.rotation,
            fit_mode: frame.fitMode,
            // WYSIWYG extras. Fill sides (contain-only). Captions are a
            // per-template opt-in (layout.frameCaptionsEnabled), OFF by default,
            // so we never carry a caption into the print for a product that
            // wasn't designed for one — even if stale state has one set.
            fill_style: frame.fillStyle ?? null,
            caption: (layout as any)?.frameCaptionsEnabled ? (frame.caption?.trim() || null) : null,
            caption_enabled: Boolean((layout as any)?.frameCaptionsEnabled && frame.captionEnabled),
          };
        }),
        // Phase 2 (WYSIWYG): carry text / shape / image overlays into the print.
        // The engine already renders them (services/overlay_renderer.py); they
        // were just never sent. Shapes already match the backend union. Drop the
        // non-serialisable File; for a local image overlay set fileId to the
        // server upload id so the backend can resolve the bytes, and drop the
        // (revoked) blob src. Clipart/icon overlays keep their src path.
        overlays: c.overlays.map((ov) => {
          if (ov.type !== 'image') return ov;
          const up = ov.originalFile ? uploadResults.get(ov.originalFile) : null;
          const rest: Record<string, unknown> = { ...ov };
          delete rest.originalFile;
          rest.fileId = up?.uploadId ?? ov.fileId ?? null;
          rest.src = ov.source === 'local' ? null : ov.src;
          return rest;
        }),
      }));

      // For calendar products, attach the product-wide calendar block to every
      // canvas entry. Cells are ONE flat ISO-keyed map (entries belong to
      // dates, not photo canvases) — the server merges duplicates
      // idempotently and each month's renderer draws only its own dates.
      if (isCalendarProduct) {
        canvasesPayload.forEach((c) => {
          (c as any).calendar = {
            themePreset: calendarTheme,
            calendarType,
            genzPalette,
            cells: calendarCells,
          };
        });
      }

      // For book products, attach the customer's chosen page count (D2) so
      // the engine's materialize_pages() produces the SAME page count the
      // customer edited — `_extract_book_state` reads this the same way
      // `_extract_calendar_state` reads the calendar block above. No
      // pageOverrides here — that's the ops escape hatch (bespoke per-page
      // content authored on the template), never customer-editable.
      if (isBookProduct) {
        canvasesPayload.forEach((c) => {
          (c as any).book = { pageCount: bookPageCount };
        });
      }

      const renderRes = await fetch(`${apiBase}/editor/render`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout_name: layoutName,
          order_id: orderId,
          canvases: canvasesPayload,
          // True when the pre-submit modal showed QtyShortfallWarning and the
          // customer submitted anyway. The server recounts the photos itself
          // and only forwards this flag in the webhook's qty_summary.
          qty_shortfall_acknowledged: qtyNeeded > 0 && totalUploadedCount < qtyNeeded,
        }),
      });

      if (!renderRes.ok) {
        const err = await renderRes.json().catch(() => ({}));
        throw new Error(err.detail ?? `Render job submission failed: ${renderRes.status}`);
      }

      const { job_id, order_id: serverOrderId } = await renderRes.json();

      // 5. Embed path: fire postMessage, then show the LIVE status panel
      // (Phase 3 — no more dead-end): the overlay polls render-status via the
      // embed proxy, surfaces queued/rendering/done/failed honestly, and
      // offers a way back into the editor.
      if (embedToken) {
        window.parent.postMessage({
          type: 'pe:render_job',
          jobId: job_id,
          orderID: serverOrderId || orderId,
        }, parentOrigin);
        setSubmittedJobId(job_id);
        setSubmitted(true);
        return;
      }

      // 6. Direct/admin path: poll render-status until done.
      // Exponential backoff: starts at 2 s, doubles to 10 s cap, with ±20%
      // jitter so concurrent jobs don't synchronise their polls. A 10-min
      // render now triggers ~50 requests instead of the previous 150.
      setServerRenderLabel('Rendering on server…');
      setRenderProgress({ current: 70, total: 100 });

      const POLL_DEADLINE = Date.now() + 10 * 60 * 1000; // 10 minutes
      let pollDelay = 2000;
      let pollCount = 0;
      while (Date.now() < POLL_DEADLINE) {
        const jitter = 0.8 + Math.random() * 0.4; // 0.8x - 1.2x
        await new Promise(r => setTimeout(r, Math.round(pollDelay * jitter)));
        pollDelay = Math.min(pollDelay * 1.5, 10000);
        pollCount += 1;

        const statusRes = await fetch(`${apiBase}/render-status/${job_id}/`, {
          headers: getAuthHeaders(),
        });
        if (!statusRes.ok) continue;

        const jobStatus = await statusRes.json();

        // Honest wait status (Phase 3): show the REAL queue position/state
        // from RenderStatusView instead of a synthetic "rendering" animation.
        if (jobStatus.status === 'queued') {
          setServerRenderLabel(
            jobStatus.estimated_wait_seconds != null
              ? `Queued — about ${formatWait(jobStatus.estimated_wait_seconds)} wait`
              : 'Queued…'
          );
          setRenderProgress({ current: 70, total: 100 });
          continue;
        }
        if (jobStatus.status === 'processing') {
          setServerRenderLabel('Rendering your print files…');
        }

        if (jobStatus.status === 'completed') {
          setServerRenderLabel('Downloading…');
          setRenderProgress({ current: 100, total: 100 });

          // Trigger a native browser download instead of fetch+blob.
          // For 200-photo jobs the ZIP is 500–700 MB — buffering that into
          // a JS Blob via `await dlRes.blob()` pushes the browser tab past
          // its heap budget AND fights Cloudflare's 100 s time-to-first-
          // byte limit. A `<a download>` navigation streams chunks
          // straight to disk via the browser's native download manager
          // (its own progress UI included). The internal proxy already
          // forwards Content-Disposition from Django so the saved
          // filename is correct without us having to set the `download`
          // attribute. Cookie auth flows through navigation just like fetch.
          const downloadUrl = `${apiBase}/jobs/${job_id}/download/?include_uploads=${includeUploadsRef.current ? '1' : '0'}`;
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.rel = 'noopener';
          // download attr is a hint — Content-Disposition from upstream wins
          // when present (Django sends "<layout>-<short-id>.zip"). This is just
          // the fallback name if that header is ever stripped.
          a.download = `${layout?.name || layoutName}.zip`;
          // Detached on purpose: a link needn't be in the document to download.
          a.click();
          return;
        }

        if (jobStatus.status === 'failed') {
          throw new Error(jobStatus.error || 'Server render failed');
        }

        // Ease progress 70 → 99 while rendering (cap at poll #15 so the bar
        // doesn't stall when polls slow down due to backoff).
        setRenderProgress({ current: Math.min(99, 70 + Math.min(pollCount, 15) * 2), total: 100 });
      }

      throw new Error('Render job timed out after 10 minutes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Server render failed.');
    } finally {
      setIsDownloading(false);
      setShowDownloadModal(false);
      setServerRenderLabel(null);
      setRenderProgress(null);
    }
  };

  // Dashboard ZIP download: always server-render. The previous client-side
  // path (in-browser canvas-to-blob → JSZip → downloadBlob) was removed in
  // v1.8 to give all users — regardless of canvas count — the same Celery
  // pipeline. The server pipeline is faster on large batches, more memory-
  // friendly on small ones, and produces identical output. Trade-off: small
  // (≤20 canvas) jobs now incur an upload + poll round-trip (~10–20 s extra
  // on a fast connection) instead of rendering instantly in the browser.
  const executeBatchDownload = async () => {
    const allCanvases = surfaceStates.length > 1
      ? surfaceStates.flatMap(s => s.canvases)
      : canvases;
    if (allCanvases.length === 0) {
      setError('No canvases to download.');
      return;
    }
    setShowDownloadModal(false);
    return executeServerRender();
  };

  // Embed Save & Continue: always server-render. The Celery render task
  // produces a downloadable ZIP and (when the parent registered a callback at
  // session creation) POSTs the download URL + HMAC-signed payload to the
  // parent's webhook. The iframe additionally fires `pe:render_job` so the
  // parent's frontend can show "your design is being prepared" UX.
  const handleSubmitDesign = async () => {
    const allCanvases = surfaceStates.length > 1
      ? surfaceStates.flatMap(s => s.canvases)
      : canvases;
    if (allCanvases.length === 0) return;
    return executeServerRender();
  };

  return {
    serverRenderLabel, includeUploads, setIncludeUploads, includeUploadsRef, disclaimerChecked, setDisclaimerChecked,
    submitted, setSubmitted, submittedJobId, setSubmittedJobId, executeBatchDownload, handleSubmitDesign,
  };
}
