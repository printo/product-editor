# printo.in storefront — `pe-callback` integration guide

**Audience:** the team owning [printo.in](https://printo.in)'s backend / storefront. **Scope:** receive the signed webhook fired by the Product Editor when a customer's render completes, then fetch the rendered ZIP and attach it to the customer's order.

**Status:** as of Aug 13, 2026 — adds `print_download_url` / `mock_download_url` / `uploads_download_url` to the webhook payload. `download_url` is unchanged and still supported. Source-of-truth: `notify_caller_webhook_task` in [`backend/django/api/tasks.py`](../backend/django/api/tasks.py). If the contract below disagrees with that task, the task wins.

This document is a complete drop-in implementation. Pick the handler that matches your stack (Node/TypeScript or Python/Django shown), wire the route, set the env vars, and you're done.

---

## Why this exists

The Product Editor is a **standalone print-file generator** — it does not push files into Printo's OMS or any other backend. When a customer in printo.in's storefront finishes designing in the embed iframe and hits **Save & Continue**:

1. Product Editor renders 300-DPI PNGs (or PDFs) on Celery workers.
2. When done, Product Editor POSTs a **signed webhook** to whatever URL printo.in passed in `EmbedSession.callback_url` at session creation.
3. printo.in's handler verifies the signature, fetches the ZIP from `download_url`, and attaches it to the order.

This handler is what completes step 3.

---

## Contract

### Webhook request — `POST <your callback_url>`

**Headers:**

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Signature` | `sha256=<hex>` — HMAC-SHA256 of the **raw request body** with the api_key as the secret |

**Body — success:**

```json
{
  "order_id":             "PE-F5D6D769",
  "job_id":               "0c612ca1-465e-401f-9586-409f571580cd",
  "status":               "completed",
  "download_url":         "https://product-editor.printo.in/api/jobs/0c612ca1-.../download/",
  "print_download_url":   "https://product-editor.printo.in/api/jobs/0c612ca1-.../download/?content=print",
  "mock_download_url":    "https://product-editor.printo.in/api/jobs/0c612ca1-.../download/?content=mock",
  "uploads_download_url": "https://product-editor.printo.in/api/jobs/0c612ca1-.../download/?content=uploads",
  "expires_at":           "2026-06-04T14:39:11.123456+00:00",
  "file_count":           15,
  "layout_name":          "classic_4x6",
  "export_format":        "png"
}
```

**Which URL should you use?** All four point at the same completed job and take
the same Bearer auth. They differ only in what the ZIP contains:

| Field | ZIP contains | Use when |
|---|---|---|
| `download_url` | `1_customer_uploads/` + `2_mock/` + `3_print/`, in folders | You want one archive and will split it yourself |
| `print_download_url` | the 300 DPI print files, flat at the root | You store print files in their own field |
| `mock_download_url` | the small web preview JPEGs, flat at the root | You store mocks in their own field — this is the small, fast one |
| `uploads_download_url` | the customer's original photos, flat at the root | You need the originals |

`download_url` is unchanged from v1.8 and is **not** deprecated — if you already
read it, nothing needs to change. The three split URLs were added (Aug 2026) for
storefronts that keep mock and print in separate fields, so they can fetch each
directly instead of unpacking and sorting one archive.

`uploads_download_url` is **`null`** when the embed session was created with
`include_uploads: false` — there is nothing behind it in that case, so guard for
null rather than assuming a string.

Nothing is duplicated on our disk: the split is served by a `?content=` filter
over the same rendered files.

**Body — failure:** (sent best-effort if delivery fails after all retries are exhausted)

```json
{
  "order_id":    "PE-F5D6D769",
  "job_id":      "0c612ca1-465e-401f-9586-409f571580cd",
  "status":      "failed",
  "error":       "Webhook delivery failed after retries",
  "layout_name": "classic_4x6"
}
```

**Expected response from your handler:** `200 OK` (or any 2xx). Anything else is treated as a delivery failure — Product Editor retries up to **6 attempts total** (1 initial + 5 retries) with exponential backoff `2^n` seconds: 1, 2, 4, 8, 16 s. Per `notify_caller_webhook_task` `max_retries=5` in [`backend/django/api/tasks.py`](../backend/django/api/tasks.py).

### ZIP fetch — `GET <any of the four *_download_url values>`

**Headers:**

| Header | Value |
|---|---|
| `Authorization` | `Bearer <YOUR_PRINTO_API_KEY>` — same key your storefront uses to create embed sessions |

**Response:** `200 OK` with `Content-Type: application/zip`, body = the ZIP archive. The combined archive is typically 30–500 MB depending on canvas count; the mock archive is a small fraction of that. The download is streamed; do not buffer in memory.

**Archive layouts:**

```
download_url          →  1_customer_uploads/IMG_1258.jpg
                         2_mock/classic_4x6_1_preview.jpg
                         3_print/classic_4x6_1.png

print_download_url    →  classic_4x6_1.png          ← flat, no folder
mock_download_url     →  classic_4x6_1_preview.jpg  ← flat, no folder
uploads_download_url  →  IMG_1258.jpg               ← flat, no folder
```

A single-part archive puts its files at the root, since a folder containing only
one kind of file is just an extra level to walk. The combined archive keeps its
three numbered folders exactly as before.

**Status codes worth handling:**

| Code | Meaning |
|---|---|
| `200` | ZIP follows |
| `404` on `mock_download_url` | No previews could be generated for this job. Returned deliberately instead of a valid-looking empty ZIP, so you never store a 22-byte archive against an order |
| `404` on `uploads_download_url` | The originals were not kept (or have since been swept — see `expires_at`) |
| `409` | The job is not finished. Should not happen from a `status: completed` webhook |

---

## Drop-in handler — Node.js / TypeScript (Express, NestJS, etc.)

```ts
// printo-in/src/routes/pe-callback.ts
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import { writeFile } from 'node:fs/promises';

const PRINTO_API_KEY = process.env.PRODUCT_EDITOR_API_KEY!; // shared secret + bearer for download

const router = Router();

// Use a body parser that gives you the RAW bytes — Express's default
// `express.json()` consumes the stream and you can't recompute the HMAC.
// Mount this route BEFORE express.json() with `express.raw()`:
//   app.use('/api/internal/pe-callback', express.raw({ type: 'application/json' }))

router.post('/api/internal/pe-callback', async (req: Request, res: Response) => {
  // 1. Verify the HMAC signature on the raw body
  const sigHeader = req.header('X-Signature') ?? '';
  const expected = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : '';
  const actual = crypto
    .createHmac('sha256', PRINTO_API_KEY)
    .update(req.body) // req.body is a Buffer when express.raw() is used
    .digest('hex');

  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
  ) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Parse + validate the payload
  let payload: {
    order_id: string;
    job_id: string;
    status: 'completed' | 'failed';
    download_url?: string;
    // Split archives (Aug 2026). uploads_download_url is null when the
    // session opted out of shipping the customer's originals.
    print_download_url?: string;
    mock_download_url?: string;
    uploads_download_url?: string | null;
    expires_at?: string;
    file_count?: number;
    layout_name?: string;
    export_format?: 'png' | 'pdf';
    error?: string;
  };
  try {
    payload = JSON.parse(req.body.toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'Malformed JSON' });
  }

  // 3. Branch on status
  if (payload.status === 'failed') {
    // Surface the failure to the order — operator review.
    await markOrderRenderFailed(payload.order_id, payload.error ?? 'unknown');
    return res.status(200).json({ ok: true });
  }

  if (payload.status === 'completed' && payload.download_url) {
    // 4. Fetch the ZIP. Do this OUT-OF-BAND so this handler returns fast —
    //    Product Editor has a 10s timeout and will retry on slow responses.
    queueDownloadJob({
      orderId: payload.order_id,
      jobId: payload.job_id,
      // Prefer the split archives so mock and print land in their own
      // fields; fall back to the combined one for older jobs.
      printUrl: payload.print_download_url ?? payload.download_url,
      mockUrl: payload.mock_download_url,
      downloadUrl: payload.download_url,
      expiresAt: payload.expires_at,
      fileCount: payload.file_count,
      layoutName: payload.layout_name,
      exportFormat: payload.export_format,
    });
    return res.status(200).json({ ok: true, queued: true });
  }

  return res.status(400).json({ error: 'Unknown status' });
});

// Background fetcher (run via your existing job queue: BullMQ, Sidekiq-equivalent, etc.)
export async function fetchAndAttachRenderedFiles(args: {
  orderId: string;
  jobId: string;
  downloadUrl: string;
}): Promise<void> {
  const res = await fetch(args.downloadUrl, {
    headers: { Authorization: `Bearer ${PRINTO_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  // Stream to disk / S3 — don't buffer in memory; ZIP can be 500 MB+.
  const tempPath = `/tmp/pe-${args.jobId}.zip`;
  const file = Readable.fromWeb(res.body as any);
  // ... pipe to S3 via your existing uploader, OR:
  await writeFile(tempPath, file as any);

  await attachZipToOrder(args.orderId, tempPath);
}

// Stubs you'll wire to your storefront's order model:
async function markOrderRenderFailed(orderId: string, reason: string) { /* ... */ }
async function queueDownloadJob(payload: any) { /* enqueue to BullMQ etc. */ }
async function attachZipToOrder(orderId: string, zipPath: string) { /* ... */ }

export default router;
```

---

## Drop-in handler — Python / Django (DRF)

```python
# printo_in/api/views.py
import hmac
import hashlib
import json
import logging
import os

import requests
from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

logger = logging.getLogger(__name__)
PRINTO_API_KEY = os.environ['PRODUCT_EDITOR_API_KEY']  # shared secret + bearer


@csrf_exempt
@require_POST
def pe_callback(request):
    # 1. Verify HMAC against the RAW body (request.body, not request.data)
    sig_header = request.headers.get('X-Signature', '')
    expected = sig_header.removeprefix('sha256=') if sig_header.startswith('sha256=') else ''
    actual = hmac.new(
        PRINTO_API_KEY.encode('utf-8'),
        request.body,
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, actual):
        return JsonResponse({'error': 'Invalid signature'}, status=401)

    # 2. Parse payload
    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Malformed JSON'}, status=400)

    status = payload.get('status')
    order_id = payload.get('order_id')

    # 3. Branch on status
    if status == 'failed':
        mark_order_render_failed.delay(order_id, payload.get('error', 'unknown'))
        return JsonResponse({'ok': True}, status=200)

    if status == 'completed' and payload.get('download_url'):
        # Split archives (Aug 2026): fetch mock and print separately so each
        # lands in its own field. Falls back to the combined archive for jobs
        # rendered before this shipped. uploads_download_url may be None.
        print_url = payload.get('print_download_url') or payload['download_url']
        mock_url = payload.get('mock_download_url')
        # Fetch out-of-band — Product Editor has a 10s webhook timeout.
        fetch_and_attach_rendered_files.delay(
            order_id=order_id,
            job_id=payload['job_id'],
            download_url=payload['download_url'],
            expires_at=payload.get('expires_at'),
            file_count=payload.get('file_count'),
            layout_name=payload.get('layout_name'),
            export_format=payload.get('export_format'),
        )
        return JsonResponse({'ok': True, 'queued': True}, status=200)

    return JsonResponse({'error': 'Unknown status'}, status=400)


# Celery task — fire-and-forget, retries via Celery's own machinery.
from celery import shared_task


@shared_task(bind=True, max_retries=3, default_retry_delay=30)
def fetch_and_attach_rendered_files(
    self,
    order_id: str,
    job_id: str,
    download_url: str,
    **kwargs,
):
    try:
        with requests.get(
            download_url,
            headers={'Authorization': f'Bearer {PRINTO_API_KEY}'},
            stream=True,
            timeout=600,
        ) as resp:
            resp.raise_for_status()
            tmp_path = f'/tmp/pe-{job_id}.zip'
            with open(tmp_path, 'wb') as out:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):  # 1 MB
                    out.write(chunk)

        attach_zip_to_order(order_id, tmp_path)
    except requests.RequestException as exc:
        raise self.retry(exc=exc)


@shared_task
def mark_order_render_failed(order_id: str, reason: str):
    # ... your storefront's order model update ...
    pass


def attach_zip_to_order(order_id: str, zip_path: str):
    # ... your storefront's order model update ...
    pass
```

---

## Wiring

### 1. Env vars

Add to your storefront's `.env`:

```bash
# Same api_key your storefront already uses to create EmbedSessions on
# Product Editor. Used for two things:
#   (a) HMAC-SHA256 verification of incoming webhooks (shared secret)
#   (b) Bearer auth when fetching the ZIP from download_url
PRODUCT_EDITOR_API_KEY=<the api_key from your existing embed setup>
```

The api_key is the **same value** you POST to Product Editor at `POST /api/embed/session` in the `Authorization: Bearer …` header. You already have this — no new key needed.

### 2. Route registration

```ts
// Express:
import peCallback from './routes/pe-callback';
app.use(peCallback);

// or NestJS:
@Module({ controllers: [PECallbackController] })
```

```python
# Django urls.py:
from .views import pe_callback

urlpatterns = [
    path('api/internal/pe-callback', pe_callback),
    # ...
]
```

### 3. Tell Product Editor where to call you

When your storefront creates an embed session, include `callback_url`:

```bash
curl -X POST https://product-editor.printo.in/api/embed/session \
  -H "Authorization: Bearer $PRODUCT_EDITOR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "order_id": "PE-F5D6D769",
    "callback_url": "https://printo.in/api/internal/pe-callback"
  }'
```

The `callback_url` flows through the embed proxy to the backend, gets stamped onto `CanvasData`, and is the exact URL the webhook task POSTs to when render completes. No domain allowlist on Product Editor's side — auth is enforced by the api_key + HMAC. `callback_url` must be `https://` and ≤ 2000 chars.

### 4. Restrict uploads to the ordered quantity

Append `qty=<N>` to the iframe URL, alongside the session token:

```html
<iframe src="https://product-editor.printo.in/editor/layout/circle_48mm?token=<uuid>&qty=12"></iframe>
```

`qty` is the number of items the customer ordered. It is **not** a field on
`POST /api/embed/session` — send it on the iframe URL or it has no effect.

What the editor does with it:

| Photos placed | Behaviour |
|---|---|
| More than `qty` | **Blocked.** A modal offers *Keep first N* (trims the selection) or *Choose again* (discards it). There is no way to proceed with more than `qty`. |
| Fewer than `qty` | **Allowed, with warnings.** A banner offers Auto-fill / pick-to-fill, and the pre-submit modal repeats the shortfall. The customer can still submit — they will receive fewer prints than ordered. |
| Exactly `qty` | Nothing shown. |

Under-upload is deliberately not blocked: `qty` reaches us through a URL the
customer's browser can edit, so treating it as a hard gate in both directions
would let a wrong value strand a real order at checkout. If your storefront
needs a guaranteed count, re-check `file_count` on the completion webhook
before accepting the order.

Applies to **single-surface products only** (photo prints, magnets, coasters).
Two-sided products, calendars and books have a surface count fixed by the
layout, which `qty` does not describe — the param is ignored there.

> **Known limitation:** `qty` is enforced in the browser only; nothing
> server-side validates it today. A customer who edits the URL can change it.
> Moving `qty` into the embed session so it is stored server-side and checked
> at render time is planned — see `docs/PRD.md` §8.0.

### 5. Firewall

Allow inbound HTTPS from Product Editor's egress IP range to your `/api/internal/pe-callback` endpoint. Confirm the IP set with infra; add to allowlist.

---

## Testing locally

While developing the handler, point `callback_url` at a local tunnel (e.g. `https://<subdomain>.ngrok-free.app/api/internal/pe-callback`) and trigger an embed session + Save & Continue from your storefront. Watch your logs for the HMAC verification result.

For unit-testing the handler without Product Editor in the loop:

```ts
// Generate a valid signed payload for tests
import crypto from 'node:crypto';
const body = JSON.stringify({
  order_id: 'TEST-1',
  job_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  status: 'completed',
  download_url: 'https://product-editor.printo.in/api/jobs/aaaaaaaa-.../download/',
  print_download_url: 'https://product-editor.printo.in/api/jobs/aaaaaaaa-.../download/?content=print',
  mock_download_url: 'https://product-editor.printo.in/api/jobs/aaaaaaaa-.../download/?content=mock',
  uploads_download_url: 'https://product-editor.printo.in/api/jobs/aaaaaaaa-.../download/?content=uploads',
  expires_at: '2026-06-04T14:39:11.123456+00:00',
  file_count: 1,
  layout_name: 'classic_4x6',
  export_format: 'png',
});
const sig = crypto
  .createHmac('sha256', process.env.PRODUCT_EDITOR_API_KEY!)
  .update(body)
  .digest('hex');

await fetch('http://localhost:3000/api/internal/pe-callback', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Signature': `sha256=${sig}`,
  },
  body,
});
```

---

## Common mistakes to avoid

| Mistake | Symptom | Fix |
|---|---|---|
| Letting `express.json()` parse the body before verification | HMAC always fails — the parsed body's stringification differs from the original bytes | Use `express.raw({ type: 'application/json' })` and verify against the raw `Buffer`, then `JSON.parse(buf.toString())` for the payload |
| Comparing HMAC with `===` instead of constant-time | Timing-attack vulnerable | Use `crypto.timingSafeEqual` (Node) / `hmac.compare_digest` (Python) |
| Using a hard-coded secret in the verification | Secret rotation breaks the integration silently | Read from env; rotate api_key on both sides simultaneously |
| Downloading the ZIP synchronously inside the webhook handler | Webhook timeouts (Product Editor's limit is 10 s); Product Editor retries up to 6 attempts; each retry creates duplicate downstream work | Enqueue a job and return 200 immediately; download in the worker |
| Storing the ZIP in memory before persisting | OOM at 500 MB renders | Stream with `iter_content` (Python) or `Readable.fromWeb` (Node) directly to S3/disk |
| Skipping the HMAC check entirely | Anyone who knows the URL can forge order completions | Don't |

---

## What also fires alongside the webhook

Inside the embed iframe, after Save & Continue, the browser posts a message to the parent:

```js
window.parent.postMessage(
  { type: 'pe:render_job', jobId: '<uuid>', orderID: '<order_id>' },
  parentOrigin // strictly locked, never '*'
);
```

This is purely for the storefront's **UX** ("your design is being prepared") — the actual file delivery happens via the webhook above. Don't rely on this message for fulfillment; it's optional and best-effort.

---

## Reference

- Webhook fired by `notify_caller_webhook_task` in [`backend/django/api/tasks.py`](../backend/django/api/tasks.py). Task config: `max_retries=5`, retry delay `2 ** retry_number` seconds.
- Payload shape constructed in the same file (`webhook_payload = {...}`). Keep this doc in sync if the task changes.
- Embed-session creation: see `EmbedSessionView` in `backend/django/api/views.py`.
- ZIP download endpoint: `RenderJobDownloadView` in the same file. Streams via `StreamingHttpResponse`; safe for 500 MB+ payloads.
- Embed proxy path allowlist + token cache: [`frontend/nextjs/src/app/api/embed/proxy/[...path]/route.ts`](frontend/nextjs/src/app/api/embed/proxy/[...path]/route.ts).
