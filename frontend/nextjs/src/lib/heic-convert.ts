import { partitionByAllowedType, unsupportedFilesMessage } from '@/lib/upload-utils';

/**
 * Client-side HEIC/HEIF (iPhone photo format) to JPEG conversion.
 *
 * Chrome, Firefox, and Android can't decode HEIC in <img>/canvas at all —
 * only Safari can, via Apple's own codec. So HEIC must be normalized to
 * JPEG at pick-time, before the file is ever previewed on the Fabric canvas
 * or uploaded. Once converted, it's just a JPEG for the rest of the
 * pipeline — no backend changes needed.
 *
 * heic2any is dynamically imported so its WASM decoder (~1-1.5MB) is only
 * fetched when a customer actually picks a HEIC file.
 */

const HEIC_EXTENSIONS = ['heic', 'heif'];
const HEIC_MIME_TYPES = ['image/heic', 'image/heif'];

function fileExtension(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

export function isHeicFile(file: File): boolean {
  return (
    HEIC_EXTENSIONS.includes(fileExtension(file.name)) ||
    HEIC_MIME_TYPES.includes(file.type.toLowerCase())
  );
}

export class HeicConversionError extends Error {
  /** Which half of the conversion failed — see reportHeicFailure. */
  readonly stage: HeicFailureStage;

  constructor(message: string, stage: HeicFailureStage, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HeicConversionError';
    this.stage = stage;
  }
}

/**
 * 'load'   — the heic2any chunk itself never arrived (offline, a blocked or
 *            404'd chunk, a CSP that rejects it inside the embed iframe).
 *            Retrying usually works, and it is NOT a problem with the photo.
 * 'decode' — the chunk loaded and the decoder rejected this specific file.
 *            Retrying will fail identically; re-exporting as JPEG is the fix.
 *
 * The two used to share one bare `catch {}`, which discarded the underlying
 * error entirely — so a live failure reported by a customer could not be
 * told apart from a bad photo, and nothing reached Sentry. Never widen this
 * back into a single silent catch.
 */
export type HeicFailureStage = 'load' | 'decode';

function reportHeicFailure(stage: HeicFailureStage, file: File, cause: unknown): void {
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  console.error(
    `[heic-convert] ${stage} failed for "${file.name}" ` +
      `(${file.type || 'no mime'}, ${file.size} bytes): ${detail}`,
  );
  // Imported lazily and fire-and-forget: this module is a plain utility on the
  // photo-pick path, and a static @sentry/nextjs import would put the whole
  // SDK in its import graph (which the Jest resolver also can't follow).
  // Reporting must never delay or break a pick, so nothing here is awaited.
  void import('@sentry/nextjs')
    .then(Sentry => {
      Sentry.captureException(cause instanceof Error ? cause : new Error(detail), {
        tags: { feature: 'heic-convert', heic_stage: stage },
        extra: { fileName: file.name, fileSize: file.size, fileType: file.type },
      });
    })
    .catch(() => {
      // Sentry absent (no DSN in dev, or blocked) — the console.error above
      // is still the record.
    });
}

/**
 * Second-chance decode using the browser's own image pipeline.
 *
 * heic2any bundles a 2021 build of libheif, which rejects some HEICs current
 * iPhones produce (10-bit HEVC, certain HDR/Live Photo containers). Safari
 * and iOS decode those natively via Apple's system codec, and HEIC uploads
 * come overwhelmingly from iPhones — so when the bundled decoder gives up,
 * the platform underneath it very often succeeds. Chrome/Firefox have no HEIC
 * codec and throw here, which is fine: they land back on the caller's error.
 *
 * Off-screen canvas only — never attached to the document.
 */
/**
 * Last-resort decode on the server, where a current libheif runs.
 *
 * This is the path that actually rescues a modern iPhone photo. `heic2any`
 * bundles a 2021 libheif that cannot read the `tmap` gain-map HDR structure
 * iOS 18 writes, and the browser fallback above only exists on Safari/iOS —
 * Chrome and Firefox ship no HEIC codec at all. So on the desktop browsers
 * most customers use, neither client-side attempt can succeed and this is the
 * only thing standing between the customer and "please re-export as JPEG".
 *
 * Built by the caller because only it knows which proxy to talk to (embed vs
 * internal) and how to authenticate — keeping this module free of both.
 */
export type ServerHeicConverter = (file: File) => Promise<File>;

export function createServerHeicConverter(
  apiBase: string,
  getAuthHeaders: () => Record<string, string>,
): ServerHeicConverter {
  return async (file: File): Promise<File> => {
    const body = new FormData();
    body.append('file', file, file.name);
    // No Content-Type header: the browser must set the multipart boundary.
    const res = await fetch(`${apiBase}/heic/convert`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body,
    });
    if (!res.ok) {
      throw new Error(`server HEIC convert failed: ${res.status}`);
    }
    const blob = await res.blob();
    if (blob.size === 0) throw new Error('server returned an empty image');
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  };
}

function jpegName(name: string): string {
  return name.replace(/\.(heic|heif)$/i, '') + '.jpg';
}

async function decodeHeicViaBrowser(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92),
    );
    if (!blob) throw new Error('canvas.toBlob returned null');
    return blob;
  } finally {
    bitmap.close();
  }
}

/**
 * Converts a single HEIC/HEIF File to JPEG. Non-HEIC files pass through
 * unchanged, so callers can await this unconditionally on every pick.
 *
 * Three decoders are tried in order, cheapest first:
 *   1. heic2any        — no round-trip, but a 2021 libheif: fails on the
 *                        tmap gain-map HDR photos current iPhones produce.
 *   2. the browser     — free and instant where it exists, i.e. Safari/iOS
 *                        only; Chrome and Firefox have no HEIC codec.
 *   3. the server      — current libheif, works everywhere, costs one upload.
 *
 * Throws HeicConversionError only when all available decoders fail.
 */
export async function convertHeicFileIfNeeded(
  file: File,
  serverConvert?: ServerHeicConverter,
): Promise<File> {
  if (!isHeicFile(file)) return file;

  let result: Blob | Blob[] | null = null;
  // Kept for the report if every decoder fails: the FIRST failure describes
  // the photo, while later ones mostly describe the browser ("no HEIC codec"),
  // which says nothing useful about why this file could not be read.
  let primaryError: unknown = null;
  let stage: HeicFailureStage = 'decode';

  // 1. heic2any — no network round-trip when it works.
  try {
    const { default: heic2any } = await import('heic2any');
    result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  } catch (err) {
    primaryError = err;
    // A failed dynamic import is a chunk-load problem, not a bad photo.
    stage = err instanceof Error && /import|chunk|fetch|network/i.test(err.message)
      ? 'load'
      : 'decode';
  }

  // 2. The browser's own codec — Safari/iOS only.
  if (result === null) {
    try {
      result = await decodeHeicViaBrowser(file);
    } catch (err) {
      console.error('[heic-convert] browser codec unavailable or failed:', err);
    }
  }

  // 3. The server — current libheif. Returns a finished File, not a Blob.
  if (result === null && serverConvert) {
    try {
      return await serverConvert(file);
    } catch (err) {
      console.error('[heic-convert] server conversion failed:', err);
    }
  }

  if (result === null) {
    reportHeicFailure(stage, file, primaryError);
    throw new HeicConversionError(
      `"${file.name}" is an iPhone photo (HEIC) that couldn't be converted. ` +
        `Please re-export it as JPEG from Photos and add it again.`,
      stage,
      { cause: primaryError },
    );
  }

  // heic2any returns an array for multi-image HEIC (e.g. a Live Photo's
  // paired frames) — the first frame is the actual photo.
  const blob = Array.isArray(result) ? result[0] : result;
  return new File([blob], jpegName(file.name), {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  });
}

export interface HeicConversionFailure {
  file: File;
  message: string;
}

/**
 * Batch variant for multi-file pickers/drops. Never throws — a file that
 * fails to convert is bucketed into `failures` (with its own message) so it
 * doesn't block the rest of the selection.
 */
export async function convertHeicFiles(
  files: File[],
  serverConvert?: ServerHeicConverter,
): Promise<{ converted: File[]; failures: HeicConversionFailure[] }> {
  const converted: File[] = [];
  const failures: HeicConversionFailure[] = [];
  // Sequential on purpose: a 24 MP HEIC decode is heavy, and a 20-photo pick
  // decoding in parallel would either wedge a phone's memory (client path) or
  // open 20 concurrent conversion requests (server path).
  for (const file of files) {
    try {
      converted.push(await convertHeicFileIfNeeded(file, serverConvert));
    } catch (err) {
      failures.push({
        file,
        message: err instanceof Error ? err.message : `"${file.name}" couldn't be converted.`,
      });
    }
  }
  return { converted, failures };
}

/**
 * Convenience wrapper for multi-file pickers/drops: converts any HEIC files,
 * then partitions the result by the backend-allowed extension list, merging
 * both kinds of rejection (wrong format, failed HEIC conversion) into one
 * user-facing warning string. Keeps handleFileChange/handleDrop in sync so
 * they can't drift on how the two rejection paths are combined.
 */
export async function convertAndPartitionFiles(
  files: File[],
  serverConvert?: ServerHeicConverter,
): Promise<{ accepted: File[]; warning: string | null }> {
  const { converted, failures } = await convertHeicFiles(files, serverConvert);
  const { accepted, rejected } = partitionByAllowedType(converted);
  const warnings = [
    ...(rejected.length > 0 ? [unsupportedFilesMessage(rejected)] : []),
    ...failures.map(f => f.message),
  ];
  return { accepted, warning: warnings.length > 0 ? warnings.join(' ') : null };
}
