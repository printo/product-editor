import { reportClientError } from './client-error-report';
import { countStoredFiles, estimateUsage, getPersistenceMode, type OrderFilesReadout } from './file-store';

/**
 * A short report to the team's Google Chat alerts when a saved design comes
 * back and some of its photos are not on this device any more.
 *
 * Photos live only in the browser's own storage until Save & Continue, so a
 * refresh that loses them leaves the customer with "Photo not on this device"
 * cards. Seen on an iPhone inside printo.in's page (2026-11-22) and not
 * reproduced anywhere else; this says which of the possible causes it is:
 * storage blocked, the store emptied, nothing kept for this order, or records
 * kept but unreadable. Counts and yes/no answers only: no photo, file name,
 * order id or address is sent.
 */
export type MissingPhotosCause =
  | 'storage blocked'
  | 'store emptied'
  | 'nothing kept for this order'
  | 'kept but unreadable'
  | 'some never kept';

export function missingPhotosCause(
  readout: OrderFilesReadout | null,
  storedAnywhere: number | null,
  mode: string,
): MissingPhotosCause {
  if (!readout?.storeOpened || mode === 'memory') return 'storage blocked';
  if (readout.unreadable > 0) return 'kept but unreadable';
  if (readout.recordsForOrder === 0) return storedAnywhere === 0 ? 'store emptied' : 'nothing kept for this order';
  return 'some never kept';
}

function yesNo(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'yes' : 'no';
}

async function ask<T>(fn: () => Promise<T> | undefined): Promise<T | null> {
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

export async function reportMissingPhotos(
  expected: number,
  missing: number,
  readout: OrderFilesReadout | null,
): Promise<void> {
  try {
    if (typeof window === 'undefined' || missing <= 0) return;
    let framed: boolean | null;
    try {
      framed = window.self !== window.top;
    } catch {
      framed = true;
    }
    const [storedAnywhere, persisted, storageAccess, usage] = await Promise.all([
      countStoredFiles(),
      ask(() => navigator.storage?.persisted?.()),
      ask(() => document.hasStorageAccess?.()),
      estimateUsage(),
    ]);
    const mode = getPersistenceMode();
    const cause = missingPhotosCause(readout, storedAnywhere, mode);
    const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
    const lines = [
      `Photos the saved design names: ${expected}; missing on this device: ${missing}`,
      `Store opened: ${yesNo(readout ? readout.storeOpened : null)} (mode: ${mode})`,
      `Kept for this order: ${readout?.recordsForOrder ?? 'unknown'}, of which unreadable: ${readout?.unreadable ?? 'unknown'}`,
      `Of those, kept as raw data: ${readout?.keptAsData ?? 'unknown'}`,
      `Kept for any order on this device: ${storedAnywhere ?? 'unknown'}`,
      `Inside another site's page: ${yesNo(framed)}`,
      `Storage access granted: ${yesNo(storageAccess)}; storage kept for good: ${yesNo(persisted)}`,
      `Storage used: ${usage ? `${mb(usage.usage)} of ${mb(usage.quota)}` : 'unknown'}`,
    ];
    reportClientError({
      kind: 'photos-missing',
      level: 'warning',
      message: `Photos missing after refresh (${cause}): ${missing} of ${expected}`,
      stack: lines.join('\n'),
    });
  } catch {
    // A report must never get in the customer's way.
  }
}
