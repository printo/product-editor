/**
 * Image processing utilities.
 */

// Cache for image metadata to avoid re-reading the same file multiple times
const metadataCache = new WeakMap<File, { width: number; height: number; orientation: number; element: HTMLImageElement }>();

/**
 * Gets image metadata including dimensions, orientation (EXIF), and the loaded HTMLImageElement.
 */
export async function getImageMetadata(file: File): Promise<{ width: number; height: number; orientation: number; element: HTMLImageElement }> {
  // Check cache first
  const cached = metadataCache.get(file);
  if (cached) return cached;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image'));
    };

    img.onload = async () => {
      let orientation = 1;
      try {
        // Dynamic import to bypass build-time resolution issues in Next.js Turbopack
        const { default: ExifReader } = await (import('exifreader') as any);
        const tags = await ExifReader.load(file);
        if (tags.Orientation) {
          orientation = (tags.Orientation.value as number) || 1;
        }
      } catch {
        // Ignore exif errors — orientation defaults to 1 (normal)
      }

      const width = img.naturalWidth;
      const height = img.naturalHeight;
      const result = { width, height, orientation, element: img };
      
      // Store in cache
      metadataCache.set(file, result);
      
      URL.revokeObjectURL(url);
      resolve(result);
    };

    img.src = url;
  });
}

/**
 * Reads the ICC profile embedded in JPEG APP2 markers and returns the
 * data color space signature ('CMYK', 'RGB ', etc.) or null if undetectable.
 */
export async function detectJpegColorSpace(file: File): Promise<string | null> {
  try {
    const buf = await file.slice(0, 65536).arrayBuffer();
    const d = new Uint8Array(buf);
    if (d[0] !== 0xFF || d[1] !== 0xD8) return null; // not a JPEG
    let offset = 2;
    while (offset + 4 <= d.length) {
      if (d[offset] !== 0xFF) break;
      const marker = d[offset + 1];
      if (marker === 0xD9 || marker === 0xDA) break; // EOI / SOS
      const segLen = (d[offset + 2] << 8) | d[offset + 3];
      if (marker === 0xE2 && segLen > 16) {
        // Check for "ICC_PROFILE\0" at offset+4
        const sig = String.fromCharCode(...Array.from(d.slice(offset + 4, offset + 16)));
        if (sig === 'ICC_PROFILE\0') {
          // ICC header color space at bytes [16..19] of the profile data
          // Profile data starts at offset + 4 (marker data) + 12 (sig) + 2 (seq/total) = offset + 18
          const icc = offset + 18;
          if (icc + 20 <= d.length) {
            return String.fromCharCode(d[icc + 16], d[icc + 17], d[icc + 18], d[icc + 19]);
          }
        }
      }
      offset += 2 + segLen;
    }
  } catch { /* ignore */ }
  return null;
}
