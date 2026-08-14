/**
 * Cell-image upload orchestrator (CALENDAR_FEATURE_PRD.md §5 Phase 8).
 *
 * One-call helper that the CalendarEditPanel's host page invokes from
 * `onRequestImageOverride`. Owns the full lifecycle:
 *
 *   1. Sanity-check (MIME, size) the picked File.
 *   2. Persist the original File to IndexedDB (B1 pattern) so refresh
 *      restores a working preview without re-uploading.
 *   3. POST chunks via the existing chunked-upload API.
 *   4. Optional: auto-orient via /api/orientation/detect (v1.11 wiring).
 *   5. Return { uploadId, fileId, blobUrl, rotation? } for the cell
 *      override + the preview thumb.
 *
 * Auto-orientation is OPT-IN — calendars are typically product shots
 * (mugs, t-shirts, posters) where the customer chose a deliberate crop;
 * automatic rotation could fight that intent. Pass `autoOrient: true`
 * only on layouts where it makes sense (e.g. family-photo calendars).
 *
 * No fetch / IDB mocking infrastructure here — host pages inject their
 * own `uploadFn` / `saveFileFn` for testing. In production these default
 * to the real impls.
 */

import {
  uploadFile as defaultUploadFile,
  type UploadResult,
} from '@/lib/upload-utils';
import { saveFile as defaultSaveFile } from '@/lib/file-store';
import { detectFileOrientation } from '@/lib/ml-orientation';
import { convertHeicFileIfNeeded, createServerHeicConverter } from '@/lib/heic-convert';

/** ── Public contract ─────────────────────────────────────────────────── */

export interface UploadCalendarCellImageOptions {
  /** Backend base URL used for upload + orientation endpoints (no trailing slash). */
  apiBase: string;
  /** Order ID that scopes the IDB record (mirrors editor's frame-file persistence). */
  orderId: string;
  /** Returns auth headers (Bearer key for direct, X-Embed-Token for embed). */
  getAuthHeaders: () => Record<string, string>;
  /**
   * When true, the helper also runs the picked image through
   * /api/orientation/detect and returns the suggested rotation. The cell
   * renderer can choose whether to apply it. Defaults to false.
   */
  autoOrient?: boolean;
  /** Optional progress callback (0..1) for the chunked upload step. */
  onProgress?: (fraction: number) => void;
  /** Test seam: inject a fake uploader. Defaults to the real chunked-upload. */
  uploadFn?: typeof defaultUploadFile;
  /** Test seam: inject a fake IDB saver. Defaults to the real file-store saveFile. */
  saveFileFn?: typeof defaultSaveFile;
}

export interface UploadCalendarCellImageResult {
  /** Server-side upload id — goes onto the CalendarCellOverride. */
  uploadId: string;
  /** IDB record id — lets the editor restore the preview on refresh.
   *  null when persistence failed (device storage full) — the upload itself
   *  still succeeded; `persistDegraded` is set so the UI can warn. */
  fileId: string | null;
  /** True when the IDB save failed (quota) — surface a storage notice. */
  persistDegraded?: boolean;
  /** Object URL for an immediate preview. Caller is responsible for revoking on unmount. */
  blobUrl: string;
  /** Server filename (echoes back from /upload/complete). */
  filename: string;
  /** Rotation suggested by the orientation service, 0/90/180/270. Only set when `autoOrient: true` and ML succeeded. */
  rotation?: 0 | 90 | 180 | 270;
}

/** ── File validation ────────────────────────────────────────────────── */

const MAX_CELL_IMAGE_MB = 50; // mirrors backend MAX_UPLOAD_FILE_SIZE_MB
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export class CalendarCellUploadError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CalendarCellUploadError';
  }
}

/**
 * Validate a candidate File before uploading. Returns the file unchanged
 * if it passes; throws CalendarCellUploadError otherwise so the caller
 * can show a friendly message inline.
 */
export function validateCellImageFile(file: File): File {
  if (!file) {
    throw new CalendarCellUploadError('missing', 'No file was provided.');
  }
  if (file.size <= 0) {
    throw new CalendarCellUploadError('empty', 'The selected file is empty.');
  }
  if (file.size > MAX_CELL_IMAGE_MB * 1024 * 1024) {
    throw new CalendarCellUploadError(
      'too-large',
      `Image exceeds the ${MAX_CELL_IMAGE_MB} MB limit.`,
    );
  }
  // Some browsers report '' for HEIC; allow when the extension matches.
  const mime = file.type.toLowerCase();
  if (mime && !ALLOWED_MIMES.has(mime) && !mime.startsWith('image/')) {
    throw new CalendarCellUploadError(
      'unsupported-type',
      `File type "${file.type}" isn't supported. Use JPEG, PNG, WebP, or HEIC.`,
    );
  }
  return file;
}

/** ── Orchestrator ───────────────────────────────────────────────────── */

export async function uploadCalendarCellImage(
  file: File,
  opts: UploadCalendarCellImageOptions,
): Promise<UploadCalendarCellImageResult> {
  // iPhone HEIC/HEIF photos are converted to JPEG first — neither the
  // preview blobUrl below nor the backend (no HEIC decoder) can open HEIC.
  // Wrapped in the module's own error type so callers only need to handle
  // CalendarCellUploadError, not reach into heic-convert.ts too.
  try {
    file = await convertHeicFileIfNeeded(
      file,
      createServerHeicConverter(opts.apiBase, opts.getAuthHeaders),
    );
  } catch (err) {
    throw new CalendarCellUploadError(
      'heic-conversion-failed',
      err instanceof Error ? err.message : `"${file.name}" couldn't be converted.`,
    );
  }
  validateCellImageFile(file);

  const uploadFn = opts.uploadFn ?? defaultUploadFile;
  const saveFileFn = opts.saveFileFn ?? defaultSaveFile;

  // Run upload + IDB save in parallel — they have no data dependency and
  // both are I/O-bound. The IDB save is BEST-EFFORT (Phase 3): a device
  // with full storage must not fail an upload the server actually
  // accepted, so a quota error yields fileId:null + persistDegraded and
  // the cell keeps working for this session.
  let persistDegraded = false;
  const [uploadResult, fileId]: [UploadResult, string | null] = await Promise.all([
    uploadFn(file, opts.apiBase, opts.getAuthHeaders, opts.onProgress, opts.orderId),
    saveFileFn(opts.orderId, file).catch(() => {
      persistDegraded = true;
      return null;
    }),
  ]);

  // Auto-orient is a fire-and-await step that gates the result; if the
  // orientation service is off or the image has no detected pose we just
  // skip rotation. Errors here NEVER fail the upload (orientation is
  // advisory).
  let rotation: 0 | 90 | 180 | 270 | undefined;
  if (opts.autoOrient) {
    try {
      const outcome = await detectFileOrientation(
        opts.apiBase,
        file,
        null,
        opts.getAuthHeaders(),
      );
      if (typeof outcome === 'object' && outcome !== null && 'rotation' in outcome) {
        rotation = outcome.rotation as 0 | 90 | 180 | 270;
      }
    } catch {
      // Swallow — orientation never blocks the upload.
    }
  }

  // Object URL for the preview thumb. Caller revokes when the cell is
  // unmounted or the override is removed to avoid the (small) blob-cache
  // leak documented in CLAUDE.md (B1 pattern image overlays).
  const blobUrl = URL.createObjectURL(file);

  return {
    uploadId: uploadResult.uploadId,
    fileId,
    persistDegraded,
    blobUrl,
    filename: uploadResult.filename,
    rotation,
  };
}
