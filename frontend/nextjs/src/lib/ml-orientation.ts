/**
 * Server-side auto-orientation client.
 *
 * Detection happens entirely on the backend (`services/orientation.py`,
 * MediaPipe Pose Landmarker, Apache 2.0). The browser sends a small
 * downscaled copy of each photo and gets the suggested rotation back.
 * No client-side model load, consistent quality regardless of device.
 *
 * Why downscale before sending: MediaPipe Pose internally works at
 * ~256 px; a 640 px long-edge JPEG is more than enough and detects
 * identically to the full-resolution original. Sending the raw file
 * (1–5 MB for a phone photo) for all 200 photos in a batch was
 * 200 MB–1 GB of upload traffic on top of the real render upload —
 * a major contributor to the editor lagging / crashing on large
 * batches. The downscaled copy is ~30–90 KB.
 *
 * Lifecycle:
 *   1. `generateCanvases` calls `detectFileOrientation` per file,
 *      passing the already-decoded `HTMLImageElement` from
 *      `getImageMetadata` so we don't decode the image twice.
 *   2. We draw that element onto a ≤640 px canvas, export JPEG.
 *   3. Backend `POST /api/orientation/detect` runs PoseLandmarker,
 *      returns `{rotation, confidence, source}`.
 *   4. On 503 (mode off) / 204 (no pose) / error → return null,
 *      caller falls back to the aspect-ratio heuristic.
 *
 * Cache: results memoised per file fingerprint (name:size:lastModified)
 * for the session; the same file never re-uploads or re-infers.
 */

export type OrientationResult = {
  rotation: 0 | 90 | 180 | 270;
  confidence: number;
  source: string;
};

/**
 * Outcome of an orientation request — a 3-way result the caller branches on:
 *
 *  - `OrientationResult`  → the model gave a confident rotation; use it.
 *  - `'no-rotate'`        → the model RAN but found nothing confident
 *                           (no pose / ambiguous tilt / occluded), OR the
 *                           request errored. Caller leaves the photo as-is
 *                           (rotation 0). It must NOT fall back to the
 *                           aspect-ratio heuristic — that heuristic flips
 *                           wide group photos sideways in portrait frames.
 *  - `'use-heuristic'`    → the backend reports AUTO_ORIENTATION_MODE=off.
 *                           Caller uses the legacy aspect-ratio heuristic
 *                           (the explicit pre-ML behaviour).
 */
export type OrientationOutcome = OrientationResult | 'no-rotate' | 'use-heuristic';

const memo = new Map<string, OrientationOutcome>();
const inflight = new Map<string, Promise<OrientationOutcome>>();

// Long-edge cap for the copy we send to the backend. Pose detection is
// resolution-insensitive well below this; 640 keeps faces/shoulders crisp.
const DETECT_MAX_EDGE = 640;
const DETECT_JPEG_QUALITY = 0.82;

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
 * Draw an already-decoded image element onto a small canvas and return a
 * JPEG blob. Returns null if the browser can't produce one (caller then
 * falls back to sending the original file). Reuses the caller's decoded
 * HTMLImageElement — no second decode.
 */
async function downscaleForDetection(imgEl: HTMLImageElement): Promise<Blob | null> {
  const sw = imgEl.naturalWidth;
  const sh = imgEl.naturalHeight;
  if (!sw || !sh) return null;

  const scale = Math.min(1, DETECT_MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(imgEl, 0, 0, w, h);
  } catch {
    // Tainted canvas / decode race — fall back to original file upstream.
    return null;
  }
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', DETECT_JPEG_QUALITY);
  });
}

/**
 * Detect the rotation a file's subject needs.
 *
 * Returns an `OrientationOutcome` (see the type's docstring):
 *   - `OrientationResult` — model gave a confident rotation
 *   - `'no-rotate'`       — model ran, no confident answer (or request
 *                           errored). Caller leaves the photo as-is.
 *   - `'use-heuristic'`   — backend has AUTO_ORIENTATION_MODE=off; caller
 *                           uses the legacy aspect-ratio heuristic.
 *
 * Critically, a model "no answer" maps to `'no-rotate'`, NOT to the
 * aspect-ratio heuristic. The heuristic rotates any landscape photo 90°
 * into a portrait frame — which lays the people in a wide group shot on
 * their side. Only an explicit mode=off makes the caller fall back to it.
 *
 * `imgEl` is the already-decoded element from `getImageMetadata`; passing
 * it lets us downscale without a second decode.
 */
export async function detectFileOrientation(
  apiBase: string,
  file: File,
  imgEl?: HTMLImageElement | null,
  fetchHeaders?: HeadersInit,
  signal?: AbortSignal,
): Promise<OrientationOutcome> {
  const key = fingerprint(file);

  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<OrientationOutcome> => {
    try {
      // Prefer a downscaled JPEG (~50 KB); fall back to the raw file only
      // if we couldn't produce one.
      let payload: Blob = file;
      if (imgEl) {
        const small = await downscaleForDetection(imgEl);
        if (small) payload = small;
      }

      const formData = new FormData();
      formData.append('file', payload, file.name);

      const headers = new Headers(fetchHeaders);
      // FormData sets its own multipart Content-Type w/ boundary — setting
      // it manually breaks server-side parsing.
      headers.delete('Content-Type');

      const res = await fetch(`${apiBase}/orientation/detect`, {
        method: 'POST',
        body: formData,
        headers,
        signal,
        cache: 'no-store',
      });

      // 503: AUTO_ORIENTATION_MODE=off (or mediapipe unavailable). This is
      // the ONLY case where the caller should use the aspect-ratio
      // heuristic — it's the explicit pre-ML behaviour.
      if (res.status === 503) return 'use-heuristic';
      // 204: model ran, found no confident pose → leave the photo as-is.
      if (res.status === 204) return 'no-rotate';
      // Any other non-OK → don't guess, leave as-is.
      if (!res.ok) return 'no-rotate';
      const data = (await res.json()) as OrientationResult;
      if (![0, 90, 180, 270].includes(data.rotation)) return 'no-rotate';
      return data;
    } catch {
      // Network error / abort → leave as-is (safer than rotating blind).
      return 'no-rotate';
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
