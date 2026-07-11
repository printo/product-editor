/**
 * Chunked upload utilities for the server-side render flow.
 *
 * Uses the existing backend API:
 *   POST /upload/init           → { upload_id, chunk_size }
 *   PUT  /upload/{id}/chunk?index=N  → { chunk_index, received, total }
 *   POST /upload/{id}/complete  → { file_path, filename, file_size }
 *
 * The upload_id returned by init is used as the frame identifier in the
 * POST /editor/render payload so the backend can map frames to file paths.
 */

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB — matches backend CHUNK_SIZE
const MAX_PARALLEL_FILES = 4;        // saturates ~10 Mbps uplink without flooding

// ─── Allowed image types ────────────────────────────────────────────────────
// Mirror of the backend validator (api/validators.py → ALLOWED_IMAGE_TYPES).
// The server rejects anything outside this set, so we filter client-side to
// fail fast with a clear, file-named message instead of a late, cryptic
// "Upload complete failed for …" surfaced from Django at render time.
export const ALLOWED_IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'tiff', 'tif', 'gif',
] as const;

// `accept` value for <input type="file">. Explicit extensions + MIME types so
// the OS picker greys out unsupported files. Plain `image/*` lets through SVG,
// BMP, AVIF, HEIC, etc. — none of which the renderer accepts (this is how a
// stray favicon.svg slipped in and only failed at render time).
export const IMAGE_ACCEPT_ATTR =
  '.jpg,.jpeg,.jpe,.jfif,.png,.webp,.tiff,.tif,.gif,' +
  'image/jpeg,image/png,image/webp,image/tiff,image/gif';

// Short, human-readable form for error copy.
export const ALLOWED_IMAGE_LABEL = 'JPG, PNG, WEBP, TIFF, or GIF';

function fileExtension(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

export function isAllowedImageFile(file: File): boolean {
  return (ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(file.name));
}

/** Split files into supported vs unsupported by extension (backend-matching). */
export function partitionByAllowedType(files: File[]): { accepted: File[]; rejected: File[] } {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const f of files) (isAllowedImageFile(f) ? accepted : rejected).push(f);
  return { accepted, rejected };
}

/** User-facing message naming the unsupported file(s) so they can be found and removed. */
export function unsupportedFilesMessage(rejected: File[]): string {
  const names = rejected.map(f => `"${f.name}"`).join(', ');
  const isOne = rejected.length === 1;
  return (
    `${names} ${isOne ? 'is' : 'are'} not a supported image type and ` +
    `${isOne ? 'was' : 'were'} skipped. Allowed types: ${ALLOWED_IMAGE_LABEL}.`
  );
}

// ─── Transient-failure retry ─────────────────────────────────────────────────
// A bulk render upload fires hundreds of requests (a 100-file batch is ~400:
// init + chunk(s) + complete per file). Over that many round-trips a transient
// upstream hiccup is near-certain — a gunicorn worker recycling at its
// --max-requests boundary, a dropped keepalive, a brief nginx/Next.js upstream
// stall — and nginx surfaces those as a bare 502/503/504. Without retries a
// SINGLE such blip rejects the whole batch (uploadFiles uses Promise.all),
// which is exactly the "Chunk 0 upload failed … 502" failure seen on
// large-quantity jobs. Every step is idempotent server-side (chunk PUT rewrites
// <index>.part and dedupes; init just mints a fresh session), so retry is safe.
const MAX_UPLOAD_ATTEMPTS = 4;                                  // 1 initial + 3 retries
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Exponential backoff with ±25% jitter: ~0.5s, 1s, 2s (capped at 8s). */
function backoffDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * fetch() that retries transient network errors and retryable HTTP statuses.
 * `buildInit` is a factory so each attempt gets a fresh body (a re-sliced chunk
 * Blob is single-read once handed to fetch) and fresh auth headers (in case a
 * token refreshed between attempts). Returns the final Response — including a
 * still-failing one after the last attempt — so callers keep their existing
 * status-based error handling.
 */
async function fetchWithRetry(
  url: string,
  buildInit: () => RequestInit,
  attempts: number = MAX_UPLOAD_ATTEMPTS,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, buildInit());
      if (RETRYABLE_STATUS.has(res.status) && attempt < attempts) {
        await res.arrayBuffer().catch(() => {}); // drain so the connection can be reused
        await sleep(backoffDelay(attempt));
        continue;
      }
      return res;
    } catch (err) {
      // Network-level failure (connection reset, aborted, DNS). Retry.
      lastError = err;
      if (attempt >= attempts) throw err;
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastError ?? new Error('fetchWithRetry: retries exhausted');
}

export interface UploadResult {
  uploadId: string;   // upload_id from init — used as frame identifier
  filePath: string;   // assembled server path returned by complete
  filename: string;
}

// ─── In-session resume (Phase 3) ─────────────────────────────────────────────
// The backend persists received chunks per upload session for 24 h and the
// chunk PUT is idempotent, so a failed submit doesn't need to restart every
// file from scratch: we remember {uploadId, acked chunks} per File and, on the
// next attempt, skip init and already-acked chunks. Completed files remember
// their final UploadResult and are not re-sent at all. WeakMap-keyed by the
// File object — a page refresh mints fresh Files, which safely restarts.
interface UploadSession {
  uploadId: string;
  acked: Set<number>;
  totalChunks: number;
  result?: UploadResult;
}
const uploadSessions = new WeakMap<File, UploadSession>();

/** Marker error for a staging session the server no longer knows about
 *  (GC'd after 24 h, or a restarted backend) — restart the file once. */
class UploadSessionLostError extends Error {}

/**
 * Upload a single file using the chunked upload API.
 * onProgress fires with a 0–1 fraction as chunks land.
 * Resumes a previous partially-uploaded session for the same File object.
 */
export async function uploadFile(
  file: File,
  apiBase: string,
  getHeaders: () => Record<string, string>,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  try {
    return await uploadFileOnce(file, apiBase, getHeaders, onProgress);
  } catch (err) {
    if (err instanceof UploadSessionLostError) {
      // Stale session (server staging GC'd) — one clean restart from init.
      uploadSessions.delete(file);
      return uploadFileOnce(file, apiBase, getHeaders, onProgress);
    }
    throw err;
  }
}

async function uploadFileOnce(
  file: File,
  apiBase: string,
  getHeaders: () => Record<string, string>,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const cached = uploadSessions.get(file);
  if (cached?.result) {
    onProgress?.(1);
    return cached.result;
  }

  let session: UploadSession;
  if (cached && cached.totalChunks === totalChunks) {
    session = cached;
  } else {
    // ── 1. Init ────────────────────────────────────────────────────────────
    const initRes = await fetchWithRetry(`${apiBase}/upload/init`, () => ({
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        file_size: file.size,
        total_chunks: totalChunks,
      }),
    }));
    if (!initRes.ok) {
      const err = await initRes.json().catch(() => ({}));
      throw new Error(`Upload init failed for "${file.name}": ${err.detail ?? initRes.status}`);
    }
    const { upload_id } = await initRes.json();
    session = { uploadId: upload_id, acked: new Set<number>(), totalChunks };
    uploadSessions.set(file, session);
  }

  // ── 2. Upload chunks sequentially (skipping already-acked ones) ──────────
  for (let i = 0; i < totalChunks; i++) {
    if (session.acked.has(i)) {
      onProgress?.((i + 1) / totalChunks * 0.95);
      continue;
    }
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);

    // Re-slice inside the factory so every retry sends a fresh, unconsumed Blob.
    const chunkRes = await fetchWithRetry(`${apiBase}/upload/${session.uploadId}/chunk?index=${i}`, () => ({
      method: 'PUT',
      headers: {
        ...getHeaders(),
        'Content-Range': `bytes ${start}-${end - 1}/${file.size}`,
      },
      body: file.slice(start, end),
    }));
    if (chunkRes.status === 404 && session.acked.size > 0) {
      throw new UploadSessionLostError();
    }
    if (!chunkRes.ok) {
      const err = await chunkRes.json().catch(() => ({}));
      throw new Error(`Chunk ${i} upload failed for "${file.name}": ${err.detail ?? chunkRes.status}`);
    }
    session.acked.add(i);

    onProgress?.((i + 1) / totalChunks * 0.95); // 0–95% for chunks
  }

  // ── 3. Complete ───────────────────────────────────────────────────────────
  const completeRes = await fetchWithRetry(`${apiBase}/upload/${session.uploadId}/complete`, () => ({
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
  }));
  if (completeRes.status === 404) {
    throw new UploadSessionLostError();
  }
  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({}));
    throw new Error(`Upload complete failed for "${file.name}": ${err.detail ?? completeRes.status}`);
  }
  const { file_path, filename } = await completeRes.json();

  onProgress?.(1);
  const result = { uploadId: session.uploadId, filePath: file_path, filename };
  session.result = result;
  return result;
}

/**
 * Upload multiple files in parallel (up to MAX_PARALLEL_FILES at once).
 * Returns a Map<File, UploadResult> preserving identity for frame mapping.
 *
 * onProgress is BYTE-weighted (Phase 3): fires with (uploadedBytes,
 * totalBytes) as chunks land, so a 40 MB photo advances the bar smoothly
 * instead of jumping when the whole file completes.
 *
 * Failure semantics: every file is attempted (allSettled); if ANY ultimately
 * fails, ONE aggregated error naming the failed files is thrown — successful
 * files keep their in-session upload state, so the next submit only
 * re-transfers what actually failed.
 */
export async function uploadFiles(
  files: File[],
  apiBase: string,
  getHeaders: () => Record<string, string>,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<Map<File, UploadResult>> {
  const results = new Map<File, UploadResult>();
  const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
  const fractions = new Map<File, number>();

  const emit = () => {
    let done = 0;
    for (const f of files) done += (fractions.get(f) || 0) * f.size;
    onProgress?.(Math.min(done, totalBytes), totalBytes);
  };

  const failures: { file: File; error: unknown }[] = [];
  for (let i = 0; i < files.length; i += MAX_PARALLEL_FILES) {
    const batch = files.slice(i, i + MAX_PARALLEL_FILES);
    const settled = await Promise.allSettled(
      batch.map(async (file) => {
        const result = await uploadFile(file, apiBase, getHeaders, (frac) => {
          fractions.set(file, frac);
          emit();
        });
        results.set(file, result);
      }),
    );
    settled.forEach((s, idx) => {
      if (s.status === 'rejected') failures.push({ file: batch[idx], error: s.reason });
    });
  }

  if (failures.length > 0) {
    const names = failures.slice(0, 3).map(f => `"${f.file.name}"`).join(', ');
    const more = failures.length > 3 ? ` and ${failures.length - 3} more` : '';
    const first = failures[0].error instanceof Error ? ` (${failures[0].error.message})` : '';
    throw new Error(
      `${failures.length} of ${files.length} photos failed to upload: ${names}${more}${first}. ` +
      `Your other photos are saved — submitting again will only re-send the failed ones.`,
    );
  }

  return results;
}
