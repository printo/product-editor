/**
 * IndexedDB-backed File persistence for the editor.
 *
 * Background: the canvas auto-save (page.tsx → /api/canvas-state/{orderId})
 * strips `originalFile` from the JSON because Files can't be serialised. After
 * a refresh the dataUrl previews come back fine, but submitting / re-rendering
 * needs the original File. This module persists the raw blob client-side
 * keyed by a stable `fileId` so it survives reloads.
 *
 * Trade-offs:
 *  - IndexedDB has a per-origin quota (typically 50%–60% of free disk on
 *    desktop, less on mobile). 200 photos × 5 MB ≈ 1 GB; usually OK on
 *    desktop, may evict on phones. We don't shard or compress.
 *  - Single-process; if the user opens the same order in two tabs, both write
 *    to the same store. Last write wins. That matches the existing canvas
 *    state behavior.
 */

const DB_NAME = "product-editor-files";
const DB_VERSION = 2;
const STORE = "files";
// Smartcrop results — keyed by `${fileId}:${w}x${h}:${rotation}`. Computing a
// crop scans every pixel of the source image (~50–200 ms per 12 MP photo), so
// re-running on the same input is wasted work. Tiny JSON values; safe to keep
// across sessions until the file is removed.
const CROP_STORE = "crop_cache";

interface FileRecord {
  fileId: string;
  orderId: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

// ── In-memory fallback (Phase 3 — storage degrade path) ─────────────────────
// Safari ITP can block IndexedDB entirely inside a cross-site iframe (and
// private mode elsewhere). Rather than silently losing persistence, file
// operations transparently fall back to this Map: fileIds still get
// assigned (the B1 self-stabilising effect drains), submit and re-render
// keep working — only refresh durability is lost, and the UI is told via
// getPersistenceMode() so it can warn once.
const memFiles = new Map<string, FileRecord>();
let persistenceMode: "unknown" | "durable" | "memory" = "unknown";

export function getPersistenceMode(): "unknown" | "durable" | "memory" {
  return persistenceMode;
}

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    persistenceMode = "memory";
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "fileId" });
        store.createIndex("orderId", "orderId", { unique: false });
      }
      if (!db.objectStoreNames.contains(CROP_STORE)) {
        // Keyed by composite string; value is { x, y, width, height }.
        db.createObjectStore(CROP_STORE);
      }
    };
    req.onsuccess = () => { persistenceMode = "durable"; resolve(req.result); };
    req.onerror = () => { persistenceMode = "memory"; reject(req.error); };
  });
  // Blocked/erroring opens must not cache a rejected promise forever —
  // allow a later retry (e.g. user grants storage access).
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// In-memory fast-path so repeat lookups within a session don't pay an IDB
// round-trip. Cleared when the page reloads — IDB is the durable layer.
const cropMemo = new Map<string, { x: number; y: number; width: number; height: number }>();

export type CropResult = { x: number; y: number; width: number; height: number };

export async function getCachedCrop(key: string): Promise<CropResult | null> {
  const memo = cropMemo.get(key);
  if (memo) return memo;
  try {
    const db = await openDb();
    const value: CropResult | undefined = await new Promise((resolve, reject) => {
      const req = db.transaction(CROP_STORE, "readonly").objectStore(CROP_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (value) cropMemo.set(key, value);
    return value || null;
  } catch {
    return null;
  }
}

export async function setCachedCrop(key: string, value: CropResult): Promise<void> {
  cropMemo.set(key, value);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(CROP_STORE, "readwrite").objectStore(CROP_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // IDB write failed (quota? blocked?) — memo cache still serves the session.
  }
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDb().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function makeFileId(): string {
  // crypto.randomUUID is supported in all browsers we target (Chrome 92+,
  // Safari 15.4+, Firefox 95+). Falls back to a hand-rolled UUID v4 if absent.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Thrown when persistence is genuinely out of space (after one prune+retry).
 *  Callers surface a "photos can't be backed up on this device" notice. */
export class FileStoreQuotaError extends Error {
  constructor() {
    super("IndexedDB quota exceeded — file persistence degraded");
    this.name = "FileStoreQuotaError";
  }
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "QuotaExceededError"
    : (err as { name?: string } | null)?.name === "QuotaExceededError";
}

/** Advisory only — Safari private mode returns null; the estimate covers the
 *  whole origin, not just this DB. Never block on it. */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    if (typeof usage !== "number" || typeof quota !== "number") return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

interface OrderFootprint {
  orderId: string;
  bytes: number;
  count: number;
  newestCreatedAt: number;
}

/** One cursor pass over the store summing blob sizes per order. */
export async function getOrderFootprints(): Promise<OrderFootprint[]> {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const acc = new Map<string, OrderFootprint>();
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(Array.from(acc.values()));
      const rec = cursor.value as FileRecord;
      const entry = acc.get(rec.orderId) || {
        orderId: rec.orderId, bytes: 0, count: 0, newestCreatedAt: 0,
      };
      entry.bytes += rec.blob?.size || 0;
      entry.count += 1;
      entry.newestCreatedAt = Math.max(entry.newestCreatedAt, rec.createdAt || 0);
      acc.set(rec.orderId, entry);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// Bounds (Phase 3): stale orders age out after a week (well under the 30-day
// server-side CanvasData expiry); above the soft budget or half the origin
// quota, remaining non-current orders evict oldest-first.
const MAX_ORDER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SOFT_BUDGET_BYTES = 800 * 1024 * 1024;

/**
 * Bound the store: never touches the CURRENT order (post-submit resume is a
 * Phase 1 guarantee). Failures are swallowed — pruning is best-effort.
 */
export async function pruneStaleOrders(currentOrderId: string): Promise<void> {
  try {
    const footprints = (await getOrderFootprints()).filter(f => f.orderId !== currentOrderId);
    if (footprints.length === 0) return;

    const now = Date.now();
    const stale = footprints.filter(f => now - f.newestCreatedAt > MAX_ORDER_AGE_MS);
    for (const f of stale) {
      await deleteOrder(f.orderId).catch(() => {});
    }

    let remaining = footprints.filter(f => now - f.newestCreatedAt <= MAX_ORDER_AGE_MS);
    let totalBytes = remaining.reduce((n, f) => n + f.bytes, 0);
    const est = await estimateUsage();
    const overQuota = est ? est.quota > 0 && est.usage / est.quota > 0.5 : false;
    if (totalBytes > SOFT_BUDGET_BYTES || overQuota) {
      remaining = remaining.sort((a, b) => a.newestCreatedAt - b.newestCreatedAt);
      for (const f of remaining) {
        if (totalBytes <= SOFT_BUDGET_BYTES && !overQuota) break;
        await deleteOrder(f.orderId).catch(() => {});
        totalBytes -= f.bytes;
      }
    }
  } catch {
    // Best-effort only.
  }
}

export async function saveFile(orderId: string, file: File): Promise<string> {
  const fileId = makeFileId();
  const record: FileRecord = {
    fileId,
    orderId,
    blob: file,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    createdAt: Date.now(),
  };
  const putOnce = async (): Promise<string> => {
    const store = await tx("readwrite");
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(fileId);
      req.onerror = () => reject(req.error);
    });
  };
  try {
    return await putOnce();
  } catch (err) {
    if (!isQuotaError(err)) {
      // IndexedDB unavailable (ITP-blocked iframe, private mode): degrade to
      // the in-memory map so fileIds resolve and in-session flows keep
      // working. Refresh durability is lost; the UI warns once.
      memFiles.set(fileId, record);
      persistenceMode = "memory";
      return fileId;
    }
    // Out of space: reclaim stale orders once, retry once, then surface a
    // typed error so the editor can warn that persistence is degraded
    // (previously this was swallowed and the photo silently printed blank
    // after a refresh — a quota-triggered wrong print).
    await pruneStaleOrders(orderId);
    try {
      return await putOnce();
    } catch (err2) {
      if (isQuotaError(err2)) throw new FileStoreQuotaError();
      throw err2;
    }
  }
}

function recordToFile(rec: FileRecord): File {
  return new File([rec.blob], rec.name, { type: rec.type, lastModified: rec.lastModified });
}

export async function getFile(fileId: string): Promise<File | null> {
  const mem = memFiles.get(fileId);
  if (mem) return recordToFile(mem);
  try {
    const store = await tx("readonly");
    return await new Promise((resolve, reject) => {
      const req = store.get(fileId);
      req.onsuccess = () => {
        const rec = req.result as FileRecord | undefined;
        if (!rec) return resolve(null);
        resolve(recordToFile(rec));
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // memory-mode miss — nothing durable to read
  }
}

export async function getFilesForOrder(orderId: string): Promise<Map<string, File>> {
  const out = new Map<string, File>();
  memFiles.forEach(rec => {
    if (rec.orderId === orderId) out.set(rec.fileId, recordToFile(rec));
  });
  try {
    const store = await tx("readonly");
    return await new Promise((resolve, reject) => {
      const idx = store.index("orderId");
      const req = idx.openCursor(IDBKeyRange.only(orderId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        const rec = cursor.value as FileRecord;
        out.set(rec.fileId, recordToFile(rec));
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return out; // memory-mode: whatever this session holds
  }
}

export async function deleteOrder(orderId: string): Promise<void> {
  memFiles.forEach((rec, id) => {
    if (rec.orderId === orderId) memFiles.delete(id);
  });
  try {
    const store = await tx("readwrite");
    return await new Promise((resolve, reject) => {
      const idx = store.index("orderId");
      const req = idx.openCursor(IDBKeyRange.only(orderId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // memory-mode: already cleared above
  }
}

export async function deleteFile(fileId: string): Promise<void> {
  memFiles.delete(fileId);
  try {
    const store = await tx("readwrite");
    return await new Promise((resolve, reject) => {
      const req = store.delete(fileId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // memory-mode: already cleared above
  }
}
