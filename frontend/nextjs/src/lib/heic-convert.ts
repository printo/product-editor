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
 * Throws HeicConversionError on failure (corrupt file, an exotic
 * multi-image HEIC variant, or the WASM decoder failing to load).
 */
export async function convertHeicFileIfNeeded(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;

  let heic2any: typeof import('heic2any').default;
  try {
    ({ default: heic2any } = await import('heic2any'));
  } catch (err) {
    reportHeicFailure('load', file, err);
    throw new HeicConversionError(
      `"${file.name}" is an iPhone photo (HEIC) and the converter couldn't be ` +
        `loaded. Check your connection and try adding it again.`,
      'load',
      { cause: err },
    );
  }

  let result: Blob | Blob[];
  try {
    result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  } catch (err) {
    try {
      result = await decodeHeicViaBrowser(file);
    } catch (fallbackErr) {
      // Report the ORIGINAL heic2any error — the fallback failing on Chrome
      // just means "no system HEIC codec", which says nothing about the file.
      console.error('[heic-convert] browser fallback also failed:', fallbackErr);
      reportHeicFailure('decode', file, err);
      throw new HeicConversionError(
        `"${file.name}" is an iPhone photo (HEIC) that couldn't be converted. ` +
          `Please re-export it as JPEG from Photos and add it again.`,
        'decode',
        { cause: err },
      );
    }
  }

  // heic2any returns an array for multi-image HEIC (e.g. a Live Photo's
  // paired frames) — the first frame is the actual photo.
  const blob = Array.isArray(result) ? result[0] : result;
  const newName = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
  return new File([blob], newName, { type: 'image/jpeg', lastModified: file.lastModified });
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
  files: File[]
): Promise<{ converted: File[]; failures: HeicConversionFailure[] }> {
  const converted: File[] = [];
  const failures: HeicConversionFailure[] = [];
  for (const file of files) {
    try {
      converted.push(await convertHeicFileIfNeeded(file));
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
  files: File[]
): Promise<{ accepted: File[]; warning: string | null }> {
  const { converted, failures } = await convertHeicFiles(files);
  const { accepted, rejected } = partitionByAllowedType(converted);
  const warnings = [
    ...(rejected.length > 0 ? [unsupportedFilesMessage(rejected)] : []),
    ...failures.map(f => f.message),
  ];
  return { accepted, warning: warnings.length > 0 ? warnings.join(' ') : null };
}
