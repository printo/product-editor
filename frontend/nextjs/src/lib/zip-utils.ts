import JSZip from 'jszip';

/**
 * Creates a zip file from an array of Data URLs or Blobs with optimized batching.
 * @param items Array of { name: string, url?: string, blob?: Blob } objects
 * @param onProgress Optional callback for progress tracking (0 to 1)
 * @returns Blob of the generated zip file
 */
export const createZipFromDataUrls = async (
  items: { name: string, url?: string, blob?: Blob }[],
  onProgress?: (p: number) => void
): Promise<Blob> => {
  const zip = new JSZip();
  const total = items.length;

  // Process in small chunks to keep the main thread responsive
  const CHUNK_SIZE = 10;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    
    await Promise.all(chunk.map(async (item) => {
      if (item.blob) {
        zip.file(item.name, item.blob);
      } else if (item.url) {
        if (item.url.startsWith('data:')) {
          // Data URL: extract base64 payload after the comma
          const base64Data = item.url.split(',')[1];
          if (base64Data) {
            zip.file(item.name, base64Data, { base64: true });
          }
        } else {
          // Blob URL or HTTP URL: fetch the binary data
          try {
            const res = await fetch(item.url);
            if (!res.ok) throw new Error(`Failed to fetch ${item.url}`);
            const blob = await res.blob();
            zip.file(item.name, blob);
          } catch (err) {
            console.error(`Error zipping file ${item.name}:`, err);
          }
        }
      }
    }));

    if (onProgress) onProgress((i + chunk.length) / total);
    
    // Yield to main thread
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Use 'STORE' for speed since images are already compressed PNGs
  return await zip.generateAsync({ 
    type: 'blob',
    compression: 'STORE', 
    streamFiles: true
  });
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
