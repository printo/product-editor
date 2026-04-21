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

export interface UploadResult {
  uploadId: string;   // upload_id from init — used as frame identifier
  filePath: string;   // assembled server path returned by complete
  filename: string;
}

/**
 * Upload a single file using the chunked upload API.
 * onProgress fires with a 0–1 fraction as chunks land.
 */
export async function uploadFile(
  file: File,
  apiBase: string,
  getHeaders: () => Record<string, string>,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // ── 1. Init ───────────────────────────────────────────────────────────────
  const initRes = await fetch(`${apiBase}/upload/init`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      file_size: file.size,
      total_chunks: totalChunks,
    }),
  });
  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}));
    throw new Error(`Upload init failed for "${file.name}": ${err.detail ?? initRes.status}`);
  }
  const { upload_id } = await initRes.json();

  // ── 2. Upload chunks sequentially ─────────────────────────────────────────
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    const chunkRes = await fetch(`${apiBase}/upload/${upload_id}/chunk?index=${i}`, {
      method: 'PUT',
      headers: {
        ...getHeaders(),
        'Content-Range': `bytes ${start}-${end - 1}/${file.size}`,
      },
      body: chunk,
    });
    if (!chunkRes.ok) {
      const err = await chunkRes.json().catch(() => ({}));
      throw new Error(`Chunk ${i} upload failed for "${file.name}": ${err.detail ?? chunkRes.status}`);
    }

    onProgress?.((i + 1) / totalChunks * 0.95); // 0–95% for chunks
  }

  // ── 3. Complete ───────────────────────────────────────────────────────────
  const completeRes = await fetch(`${apiBase}/upload/${upload_id}/complete`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
  });
  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({}));
    throw new Error(`Upload complete failed for "${file.name}": ${err.detail ?? completeRes.status}`);
  }
  const { file_path, filename } = await completeRes.json();

  onProgress?.(1);
  return { uploadId: upload_id, filePath: file_path, filename };
}

/**
 * Upload multiple files in parallel (up to MAX_PARALLEL_FILES at once).
 * Returns a Map<File, UploadResult> preserving identity for frame mapping.
 * onProgress fires with (completedCount, totalCount) after each file finishes.
 */
export async function uploadFiles(
  files: File[],
  apiBase: string,
  getHeaders: () => Record<string, string>,
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<File, UploadResult>> {
  const results = new Map<File, UploadResult>();
  let completed = 0;

  for (let i = 0; i < files.length; i += MAX_PARALLEL_FILES) {
    const batch = files.slice(i, i + MAX_PARALLEL_FILES);
    await Promise.all(
      batch.map(async (file) => {
        const result = await uploadFile(file, apiBase, getHeaders);
        results.set(file, result);
        onProgress?.(++completed, files.length);
      }),
    );
  }

  return results;
}
