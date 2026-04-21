/**
 * Image processing utilities.
 */

// Cache only dimensions and orientation — NOT the HTMLImageElement.
// A decoded 12 MP photo occupies ~48 MB of pixel data. Caching the element
// keeps it alive as long as the File is referenced, so 200 files would pin
// ~9.6 GB in memory for the entire session, crashing any device.
const metadataCache = new WeakMap<File, { width: number; height: number; orientation: number }>();

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to decode image')); };
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.src = url;
  });
}

/**
 * Gets image metadata including dimensions, orientation (EXIF), and a freshly
 * loaded HTMLImageElement. The element is NOT cached — callers should use it
 * immediately (e.g. for smart crop) and let it go so the browser can GC it.
 */
export async function getImageMetadata(file: File): Promise<{ width: number; height: number; orientation: number; element: HTMLImageElement }> {
  const cached = metadataCache.get(file);

  // Always load a fresh element — not stored in cache so pixel data can be GC'd after use.
  const element = await loadImageElement(file);

  if (cached) return { ...cached, element };

  let orientation = 1;
  try {
    // Read only the first 64 KB — EXIF data is always at the file head and ExifReader.load(file)
    // would otherwise read the entire file (potentially 10–20 MB per photo, 200× in a large batch).
    const { default: ExifReader } = await (import('exifreader') as any);
    const buf = await file.slice(0, 65536).arrayBuffer();
    const tags = await ExifReader.load(buf);
    if (tags.Orientation) orientation = (tags.Orientation.value as number) || 1;
  } catch {
    // Ignore EXIF errors — orientation defaults to 1 (normal)
  }

  const result = { width: element.naturalWidth, height: element.naturalHeight, orientation };
  metadataCache.set(file, result);
  return { ...result, element };
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
