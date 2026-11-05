/**
 * Asking the page that embeds the editor for an earlier order's design.
 *
 * We keep a customer's photos only until the retention clock runs out; the
 * company that embeds the editor may keep its own long-term copy. When its
 * page opens the editor with `restore_order_id=<its own order reference>` in
 * the iframe address, the editor asks that page for the design:
 *
 *   editor → page   pe:restore_request { orderId, restoreOrderId }
 *   page → editor   pe:restore_data    { orderId, schema_version, editor_state,
 *                                        photos: [{ file_id, name, url }], error? }
 *   editor → page   pe:restore_result  { orderId, restoreOrderId, status, … }
 *
 * The page decides whether this customer may have that order. Nothing here
 * goes to our server: `restore_order_id` is read from the address and passed
 * to the page as it is, and each photo's link is later handed to our server,
 * which fetches only from the hosts entered on that company's API key.
 *
 * Pure apart from the window it is handed, so it is unit-testable.
 */

export const RESTORE_REQUEST = 'pe:restore_request';
export const RESTORE_DATA = 'pe:restore_data';
export const RESTORE_RESULT = 'pe:restore_result';

/** How long the embedding page has to answer. */
export const RESTORE_REPLY_TIMEOUT_MS = 10_000;
/** A design larger than this is refused (ordinary ones are under 100 KB). */
export const MAX_RESTORE_DESIGN_CHARS = 2 * 1024 * 1024;
export const MAX_RESTORE_PHOTOS = 2000;
const MAX_URL_CHARS = 2000;
const MAX_NAME_CHARS = 255;

const ORDER_ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
const FILE_ID_RE = /^[A-Za-z0-9_.\-]{1,100}$/;

export interface RestorePhoto {
  fileId: string;
  name: string;
  url: string;
}

export type RestoreReply =
  | { ok: true; editorState: Record<string, unknown> | null; photos: RestorePhoto[]; schemaVersion: number | null }
  | { ok: false; reason: RestoreFailure };

export type RestoreFailure =
  | 'not_embedded'   // the editor is not inside another page
  | 'timeout'        // the page did not answer in time
  | 'declined'       // the page answered with an error (not found, not this customer's)
  | 'invalid_reply'; // the answer was not in the agreed shape

/** The order reference to restore from, as the embedding page put it on the
 *  iframe address; null when absent or not a plain order id. */
export function readRestoreOrderId(search: string): string | null {
  const value = (new URLSearchParams(search).get('restore_order_id') || '').trim();
  return ORDER_ID_RE.test(value) ? value : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Read a `pe:restore_data` message. Fails closed: anything not in the agreed
 *  shape is `invalid_reply`, and a single bad photo entry is dropped rather
 *  than trusted. Links must be https; which hosts are allowed is the server's
 *  decision, not this function's. */
export function parseRestoreData(raw: unknown, expected: { orderId: string }): RestoreReply {
  if (!isRecord(raw) || raw.type !== RESTORE_DATA) return { ok: false, reason: 'invalid_reply' };
  if (raw.orderId !== expected.orderId) return { ok: false, reason: 'invalid_reply' };
  if (raw.error) return { ok: false, reason: 'declined' };

  let editorState: Record<string, unknown> | null = null;
  if (raw.editor_state != null) {
    if (!isRecord(raw.editor_state)) return { ok: false, reason: 'invalid_reply' };
    let size = 0;
    try { size = JSON.stringify(raw.editor_state).length; } catch { return { ok: false, reason: 'invalid_reply' }; }
    if (size > MAX_RESTORE_DESIGN_CHARS) return { ok: false, reason: 'invalid_reply' };
    editorState = raw.editor_state;
  }

  if (!Array.isArray(raw.photos) || raw.photos.length > MAX_RESTORE_PHOTOS) {
    return { ok: false, reason: 'invalid_reply' };
  }
  const photos: RestorePhoto[] = [];
  const seen = new Set<string>();
  for (const entry of raw.photos) {
    if (!isRecord(entry)) continue;
    const fileId = entry.file_id;
    const url = entry.url;
    if (typeof fileId !== 'string' || !FILE_ID_RE.test(fileId) || seen.has(fileId)) continue;
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS) continue;
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (parsed.protocol !== 'https:') continue;
    const rawName = typeof entry.name === 'string' ? entry.name
      : typeof entry.original_name === 'string' ? entry.original_name : '';
    seen.add(fileId);
    photos.push({ fileId, url, name: rawName.slice(0, MAX_NAME_CHARS) });
  }
  if (!editorState && photos.length === 0) return { ok: false, reason: 'invalid_reply' };

  const schemaVersion = typeof raw.schema_version === 'number' ? raw.schema_version : null;
  return { ok: true, editorState, photos, schemaVersion };
}

/** The parts of a window this module touches (a real window in the editor,
 *  a stand-in under test). */
export interface RestoreWindow {
  parent: unknown;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
interface PostTarget { postMessage(message: unknown, targetOrigin: string): void }

const parentOf = (win: RestoreWindow): PostTarget | null =>
  win.parent && win.parent !== win ? (win.parent as PostTarget) : null;

/** Ask the embedding page for the design and wait for its answer.
 *
 *  A reply counts only when it comes from the window that embeds the editor
 *  (`event.source === window.parent`), never from a sibling frame or a pop-up,
 *  and when `expectedOrigin` is known (the browser reports the embedding
 *  page's origin) only from that origin. The request is posted to
 *  `targetOrigin`, never to '*'. A message of another type, or from anyone
 *  else, is ignored and the wait goes on; the first `pe:restore_data` from the
 *  page settles it, valid or not. */
export function requestRestore({
  win, orderId, restoreOrderId, targetOrigin, expectedOrigin, timeoutMs = RESTORE_REPLY_TIMEOUT_MS,
}: {
  win: RestoreWindow;
  orderId: string;
  restoreOrderId: string;
  targetOrigin: string;
  /** The embedding page's origin when the browser reports it, else null. */
  expectedOrigin: string | null;
  timeoutMs?: number;
}): Promise<RestoreReply> {
  const parent = parentOf(win);
  if (!parent) return Promise.resolve({ ok: false, reason: 'not_embedded' });

  return new Promise<RestoreReply>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (reply: RestoreReply) => {
      if (timer) clearTimeout(timer);
      win.removeEventListener('message', onMessage);
      resolve(reply);
    };
    function onMessage(event: MessageEvent) {
      if (event.source !== (parent as unknown)) return;
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      const data: unknown = event.data;
      if (!isRecord(data) || data.type !== RESTORE_DATA) return;
      finish(parseRestoreData(data, { orderId }));
    }
    win.addEventListener('message', onMessage);
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    try {
      parent.postMessage({ type: RESTORE_REQUEST, orderId, restoreOrderId }, targetOrigin);
    } catch {
      finish({ ok: false, reason: 'not_embedded' });
    }
  });
}

export type RestoreStatus = 'restored' | 'partial' | 'none';

export interface RestoreResult {
  status: RestoreStatus;
  /** Why nothing was restored, when status is 'none'. */
  reason?: RestoreFailure | 'layout_changed' | 'design_in_progress' | 'no_design';
  photosTotal: number;
  photosLoaded: number;
}

/** Tell the embedding page how the restore went, so it can show its own
 *  message. Best effort: a page that is not listening loses nothing. */
export function sendRestoreResult(
  win: RestoreWindow,
  targetOrigin: string,
  ids: { orderId: string; restoreOrderId: string },
  result: RestoreResult,
): void {
  const parent = parentOf(win);
  if (!parent) return;
  try {
    parent.postMessage({
      type: RESTORE_RESULT,
      orderId: ids.orderId,
      restoreOrderId: ids.restoreOrderId,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      photos: { total: result.photosTotal, loaded: result.photosLoaded, failed: result.photosTotal - result.photosLoaded },
    }, targetOrigin);
  } catch { /* nothing to do */ }
}

/** `restored` when every photo came back, `partial` when some did, `none`
 *  when a design with photos came back with none of them. A design with no
 *  photos at all (text only) counts as restored. */
export function restoreStatusFor(total: number, loaded: number): RestoreStatus {
  if (loaded >= total) return 'restored';
  return loaded > 0 ? 'partial' : 'none';
}
