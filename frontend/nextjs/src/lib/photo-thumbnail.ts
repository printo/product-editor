'use client';

import { useEffect, useState } from 'react';

/** A small JPEG of a photo for a picker grid, or null when the browser cannot
 *  make one. The photo is decoded once at full size and let go straight away,
 *  so a grid of many phone photos holds small images instead of every original
 *  (on a phone, a grid of 50 MB originals could crash the tab). */
export async function makePhotoThumbnail(file: File, width = 320): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: width, resizeQuality: 'medium', imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/** Thumbnail addresses for `files`, made one at a time. A file maps to its
 *  thumbnail's address, or to null when none could be made (the caller then
 *  shows the original); a file not in the map is still waiting. Addresses are
 *  released when the files change or the component goes away. */
export function usePhotoThumbnails(files: readonly File[]): ReadonlyMap<File, string | null> {
  const [thumbs, setThumbs] = useState<ReadonlyMap<File, string | null>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    (async () => {
      for (const file of files) {
        const blob = await makePhotoThumbnail(file);
        if (cancelled) return;
        const url = blob ? URL.createObjectURL(blob) : null;
        if (url) made.push(url);
        setThumbs(prev => new Map(prev).set(file, url));
      }
    })();
    return () => {
      cancelled = true;
      made.forEach(url => URL.revokeObjectURL(url));
    };
  }, [files]);
  return thumbs;
}
