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
const DB_VERSION = 1;
const STORE = "files";

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

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve(fileId);
    req.onerror = () => reject(req.error);
  });
}

export async function getFile(fileId: string): Promise<File | null> {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(fileId);
    req.onsuccess = () => {
      const rec = req.result as FileRecord | undefined;
      if (!rec) return resolve(null);
      resolve(new File([rec.blob], rec.name, { type: rec.type, lastModified: rec.lastModified }));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getFilesForOrder(orderId: string): Promise<Map<string, File>> {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const out = new Map<string, File>();
    const idx = store.index("orderId");
    const req = idx.openCursor(IDBKeyRange.only(orderId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      const rec = cursor.value as FileRecord;
      out.set(
        rec.fileId,
        new File([rec.blob], rec.name, { type: rec.type, lastModified: rec.lastModified }),
      );
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteOrder(orderId: string): Promise<void> {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
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
}

export async function deleteFile(fileId: string): Promise<void> {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(fileId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
