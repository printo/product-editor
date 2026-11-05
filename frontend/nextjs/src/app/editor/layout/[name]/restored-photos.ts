/**
 * Photos the editor shows without holding the customer's own file.
 *
 * A design restored from the embedding company's copy draws each photo from a
 * small preview our server made of the original it fetched. That preview sits
 * in the design as an ordinary `File` (a "stand-in"), so cropping, rotating,
 * swapping and adding more photos all work as they do for a photo picked from
 * the device. What must never happen is the stand-in being sent to print in
 * place of the original. So:
 *
 *   - every stand-in is recorded here with the server upload it stands for,
 *     and the submit sends that upload id instead of uploading the file;
 *   - a file marked as a stand-in with no upload on record blocks the submit
 *     (`standInWithoutUpload`), rather than being uploaded.
 *
 * Kept in WeakMaps keyed by the File, so nothing here is saved with the
 * design, and a photo the customer removes is forgotten with its File.
 */

export interface ServerPhoto {
  /** The upload on our server that holds the original. */
  uploadId: string;
  /** The original's size in pixels, as displayed (EXIF turn applied). */
  width: number;
  height: number;
  /** The id the photo goes by in the saved design. */
  fileId: string;
}

/** Where a restored photo stands: on its way, or given up on for now. A photo
 *  that has arrived has no entry. */
export type RestoredPhotoStatus = 'arriving' | 'failed';

interface CardLike {
  frames: ReadonlyArray<{ fileId?: string; originalFile: File | null }>;
  overlays: ReadonlyArray<{ type: string; source?: string; fileId?: string; originalFile?: File }>;
}

/** What a card should say about its restored photos: some could not be
 *  loaded (with their ids, for a retry), some are still on their way, or
 *  nothing (null). A photo that is merely not on this device, with no
 *  restore in play, is not this function's business. */
export function restoreNoteForCard(
  card: CardLike | null | undefined,
  status: ReadonlyMap<string, RestoredPhotoStatus> | undefined,
): { state: RestoredPhotoStatus; fileIds: string[] } | null {
  if (!card || !status || status.size === 0) return null;
  const ids: string[] = [];
  card.frames.forEach(f => { if (f.fileId && !f.originalFile) ids.push(f.fileId); });
  card.overlays.forEach(o => {
    if (o.type === 'image' && o.source === 'local' && o.fileId && !o.originalFile) ids.push(o.fileId);
  });
  const failed = ids.filter(id => status.get(id) === 'failed');
  if (failed.length) return { state: 'failed', fileIds: failed };
  const arriving = ids.filter(id => status.get(id) === 'arriving');
  return arriving.length ? { state: 'arriving', fileIds: arriving } : null;
}

export class RestoredPhotos {
  private standIns = new WeakSet<File>();
  private uploads = new WeakMap<File, ServerPhoto>();

  /** Record a preview file standing in for an original our server holds. */
  addStandIn(file: File, photo: ServerPhoto): void {
    this.standIns.add(file);
    this.uploads.set(file, photo);
  }

  isStandIn(file: File | null | undefined): boolean {
    return !!file && this.standIns.has(file);
  }

  /** The server upload a file stands for, when it is one of ours. */
  serverPhotoOf(file: File | null | undefined): ServerPhoto | undefined {
    return file ? this.uploads.get(file) : undefined;
  }

  /** Stand-ins among `files` with no server upload on record. Always empty
   *  unless something has gone wrong; the submit refuses to go on if not. */
  standInWithoutUpload(files: Iterable<File>): File[] {
    const out: File[] = [];
    for (const file of files) {
      if (this.standIns.has(file) && !this.uploads.get(file)?.uploadId) out.push(file);
    }
    return out;
  }
}
