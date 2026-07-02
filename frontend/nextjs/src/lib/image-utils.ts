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

/**
 * Fast client-side completeness check. Reads only the file's head + a short
 * tail and looks for the format's terminating marker — so a photo cut off
 * mid-transfer (the common truncated iOS/WhatsApp JPEG) is caught instantly,
 * before upload, without decoding the pixels. Browsers render such files
 * leniently in the editor preview, but they would print with a missing/grey
 * edge, and the strict server-side Pillow decode fails on them.
 *
 * Returns true when the file looks complete (or is a type we can't cheaply
 * marker-check → don't block), false when it's detectably truncated/empty.
 */
export async function isImageComplete(file: File): Promise<boolean> {
  try {
    if (file.size === 0) return false;
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());

    // JPEG: starts FF D8, must end with the EOI marker FF D9. A few cameras
    // append padding/thumbnail bytes after EOI, so scan a short tail for it.
    if (head[0] === 0xFF && head[1] === 0xD8) {
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 64)).arrayBuffer());
      for (let i = tail.length - 2; i >= 0; i--) {
        if (tail[i] === 0xFF && tail[i + 1] === 0xD9) return true;
      }
      return false;
    }

    // PNG: 89 50 4E 47 … ends with the IEND chunk (49 45 4E 44) + its 4-byte CRC.
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) {
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 8)).arrayBuffer());
      return tail[0] === 0x49 && tail[1] === 0x45 && tail[2] === 0x4E && tail[3] === 0x44;
    }

    // GIF: terminated by the trailer byte 0x3B (';').
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 1)).arrayBuffer());
      return tail[0] === 0x3B;
    }

    // WEBP (RIFF): bytes 4..7 are the little-endian payload size; the whole
    // file must be at least that + 8 (the RIFF header). A short file is truncated.
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
      const declared = head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24);
      return file.size >= declared + 8;
    }
  } catch {
    // Can't read the file — don't block here; the server stays the backstop.
    return true;
  }
  // TIFF and anything else: no cheap end-marker — treat as complete.
  return true;
}
