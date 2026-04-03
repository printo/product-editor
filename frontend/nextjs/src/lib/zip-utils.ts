import JSZip from 'jszip';

/**
 * Creates a zip file from an array of Data URLs.
 * @param images Array of { name: string, url: string } objects
 * @returns Blob of the generated zip file
 */
export const createZipFromDataUrls = async (images: { name: string, url: string }[]): Promise<Blob> => {
  const zip = new JSZip();

  for (const img of images) {
    if (img.url.startsWith('data:')) {
      // Data URL: extract base64 payload after the comma
      const base64Data = img.url.split(',')[1];
      if (base64Data) {
        zip.file(img.name, base64Data, { base64: true });
      }
    } else {
      // Blob URL or HTTP URL: fetch the binary data
      const res = await fetch(img.url);
      const blob = await res.blob();
      zip.file(img.name, blob);
    }
  }

  return await zip.generateAsync({ type: 'blob' });
};

/**
 * Creates a zip with folder structure for multi-surface exports.
 * @param surfaces Record of surfaceKey → array of data/blob URLs
 * @param layoutName Used as the root folder name
 */
export const createMultiSurfaceZip = async (
  surfaces: Record<string, string[]>,
  layoutName: string,
): Promise<Blob> => {
  const zip = new JSZip();

  for (const [surfaceKey, urls] of Object.entries(surfaces)) {
    for (let i = 0; i < urls.length; i++) {
      const filename = urls.length === 1
        ? `${layoutName}/${surfaceKey}/canvas.png`
        : `${layoutName}/${surfaceKey}/canvas-${i + 1}.png`;
      const url = urls[i];
      if (url.startsWith('data:')) {
        const base64Data = url.split(',')[1];
        if (base64Data) zip.file(filename, base64Data, { base64: true });
      } else {
        const res = await fetch(url);
        const blob = await res.blob();
        zip.file(filename, blob);
      }
    }
  }

  return await zip.generateAsync({ type: 'blob' });
};

/**
 * Triggers a browser download of a blob.
 */
export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
