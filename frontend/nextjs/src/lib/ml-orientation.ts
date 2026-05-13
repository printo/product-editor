/**
 * Server-side auto-orientation client.
 *
 * Detection happens entirely on the backend (`services/orientation.py`,
 * MediaPipe Pose Landmarker, Apache 2.0). The browser only sends each
 * file's bytes once via multipart upload and gets the suggested rotation
 * back in the same response. No client-side model load, no model
 * download to the customer's device, consistent quality regardless of
 * the customer's hardware.
 *
 * Lifecycle:
 *   1. `generateCanvases` in the editor page calls `detectFileOrientation`
 *      per file, in parallel batches (BATCH_SIZE=8 — matches the rest of
 *      the upload pipeline).
 *   2. Backend `POST /api/orientation/detect` writes the file to a temp
 *      path, runs PoseLandmarker, deletes the temp, returns the rotation.
 *   3. If 503 (mode=off) or 204 (no usable pose) or any network error,
 *      caller falls back to the aspect-ratio heuristic (`shouldAutoRotate90`
 *      in `editor/layout/[name]/page.tsx`).
 *
 * Cache: results are memoised per file content-fingerprint
 * (`name:size:lastModified`) so the same file doesn't re-upload + re-infer
 * if the user changes layout / re-opens the editor with state restored
 * from IndexedDB. Memoisation is in-memory only (Map on the module);
 * a refresh re-runs detection, which is fine — backend is fast.
 */

type OrientationResult = {
  rotation: 0 | 90 | 180 | 270;
  confidence: number;
  source: string;
};

const memo = new Map<string, OrientationResult | null>();
const inflight = new Map<string, Promise<OrientationResult | null>>();

let runtimeConfigPromise: Promise<{ autoOrientationMode: string } | null> | null = null;

/**
 * One-shot fetch of `/api/config` shared across all callers. The frontend
 * uses this to decide whether to bother calling the detect endpoint at
 * all — when mode=off we skip the network round-trip entirely.
 */
export function getRuntimeConfig(
  apiBase: string,
  fetchHeaders?: HeadersInit,
): Promise<{ autoOrientationMode: string } | null> {
  if (runtimeConfigPromise) return runtimeConfigPromise;
  runtimeConfigPromise = (async () => {
    try {
      const res = await fetch(`${apiBase}/config`, {
        headers: fetchHeaders,
        cache: 'no-store',
      });
      if (!res.ok) return null;
      return (await res.json()) as { autoOrientationMode: string };
    } catch {
      return null;
    }
  })();
  return runtimeConfigPromise;
}

function fingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Send a single file to the backend orientation endpoint and return the
 * suggested rotation, or null if nothing usable came back (network
 * error, mode=off, no pose detected, low confidence, etc.). Callers
 * should fall back to the aspect-ratio heuristic on null.
 */
export async function detectFileOrientation(
  apiBase: string,
  file: File,
  fetchHeaders?: HeadersInit,
  signal?: AbortSignal,
): Promise<OrientationResult | null> {
  const key = fingerprint(file);

  // Per-session memo: same file → reuse result rather than re-uploading
  // for every layout change / canvas regeneration.
  if (memo.has(key)) return memo.get(key) ?? null;

  // Coalesce concurrent calls for the same file — generateCanvases
  // sometimes asks for the same file twice within a few ms.
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<OrientationResult | null> => {
    try {
      const formData = new FormData();
      formData.append('file', file, file.name);

      const headers = new Headers(fetchHeaders);
      // FormData with a File sets Content-Type with the right boundary
      // automatically — explicitly setting it here breaks multipart parsing.
      headers.delete('Content-Type');

      const res = await fetch(`${apiBase}/orientation/detect`, {
        method: 'POST',
        body: formData,
        headers,
        signal,
        cache: 'no-store',
      });

      if (res.status === 503 || res.status === 204) {
        // 503: AUTO_ORIENTATION_MODE=off, or mediapipe not available.
        // 204: model couldn't determine a confident rotation.
        // Both: caller falls back to aspect heuristic.
        return null;
      }
      if (!res.ok) return null;
      const data = (await res.json()) as OrientationResult;
      if (![0, 90, 180, 270].includes(data.rotation)) return null;
      return data;
    } catch {
      // Network error / abort → fall back. Don't throw — caller is mid-loop.
      return null;
    }
  })();

  inflight.set(key, promise);
  try {
    const result = await promise;
    memo.set(key, result);
    return result;
  } finally {
    inflight.delete(key);
  }
}
