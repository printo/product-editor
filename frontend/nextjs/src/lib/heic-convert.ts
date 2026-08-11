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
  constructor(message: string) {
    super(message);
    this.name = 'HeicConversionError';
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

  let result: Blob | Blob[];
  try {
    const { default: heic2any } = await import('heic2any');
    result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  } catch {
    throw new HeicConversionError(
      `"${file.name}" is an iPhone photo (HEIC) that couldn't be converted. ` +
        `Please try again, or re-export it as JPEG from Photos.`
    );
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
