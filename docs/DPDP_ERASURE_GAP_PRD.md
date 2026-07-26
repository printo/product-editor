# PRD — DPDP erasure does not reliably delete customer files

**Status:** CLOSED 2026-07-26. Phases 1, 2, 4 and 5 shipped (migration `0011`); phase 3 waived.
Found 2026-07-26 while clearing the production backlog.
**Severity:** High — compliance. The erasure endpoint can report success while the customer's photographs remain on disk.
**Related:** [`DATA_LIFECYCLE.md`](DATA_LIFECYCLE.md) · `api/purge.py` · `OrderDataPurgeView`

---

## 1. Summary

`purge_order_data()` — the function behind `DELETE /api/ops/orders/<order_id>/purge`, our DPDP right-to-erasure endpoint — locates a customer's uploaded files **only** through two fields on `CanvasData`:

- `image_paths`
- `render_state['image_paths']`

`image_paths` is blanked within seconds of the customer opening the editor, and a large class of uploads is never referenced by either field. When that happens the purge deletes the database rows, returns a success summary reporting `files_deleted: 0`, and **leaves the photographs on disk**.

This was observed directly: clearing 265 production orders logged `0 files (0.0 MB)` for order after order, while 6.4 GB of uploads remained. Only a filesystem-level sweep afterwards actually removed them.

---

## 2. Evidence

### 2.1 Autosave blanks `image_paths` every 2 seconds

The editor autosaves on a 2-second timer. Its payload ([`editor/layout/[name]/page.tsx`](../frontend/nextjs/src/app/editor/layout/%5Bname%5D/page.tsx)):

```ts
body: JSON.stringify({
  layout_name: layoutName,   // required by backend
  editor_state: editorState,
})
```

No `image_paths` — and correctly so: the browser never sees server-side file paths.

`CanvasStateView.put` ([`api/views.py`](../backend/django/api/views.py)) then does:

```python
image_paths = body.get('image_paths', [])       # -> []
CanvasData.objects.update_or_create(
    order_id=order_id, api_key=api_key,
    defaults=dict(
        layout_name=layout_name,
        image_paths=image_paths or [],          # -> overwrites stored paths with []
        ...
    ),
)
```

`update_or_create` writes every key in `defaults`, so each autosave overwrites whatever paths were recorded. Within one autosave cycle of opening the editor, `CanvasData.image_paths` is `[]` and stays that way.

### 2.2 What the purge can still see

`render_state['image_paths']` is written by `EditorRenderView` at submit and is *not* touched by autosave — that separation is the whole point of migration 0008's ownership contract. So it survives, and the purge can use it.

That leaves the purge working only for orders that **submitted a render after 0008 landed**. Everything else erases incompletely:

| Order shape | `image_paths` | `render_state` | Purge deletes files? |
|---|---|---|---|
| Submitted a render (post-0008) | `[]` | populated | ✅ yes |
| Submitted before 0008 | `[]` | null | ❌ no |
| Uploaded, never submitted (abandoned) | `[]` | null | ❌ no |
| Autosaved only (browsing/composing) | `[]` | null | ❌ no |

### 2.3 A second, independent gap

`UploadedFile` has **no order linkage at all**:

```python
api_key            = FK(APIKey)
file_path          = CharField(unique=True)
original_filename  = CharField()          # personal data
upload_session_id  = CharField()
```

So a file uploaded but never placed in a canvas belongs to no order as far as the schema is concerned. No order-scoped erasure can ever find it, regardless of how `image_paths` behaves. Abandoned uploads accumulate permanently and are invisible to a DPDP request.

`original_filename` is itself personal data (customers name files after people, places, events), so an un-erased row is a compliance issue even when the image bytes are gone.

---

## 3. Impact

- **A DPDP erasure request can be answered "done" while the data still exists.** The endpoint returns `files_deleted: 0` — technically accurate, but no caller reads it as failure, and nothing raises.
- **The scale is unbounded** for abandoned uploads: they are unreachable by both the erasure path *and* any order-scoped tooling.
- The nightly GC does eventually delete these files by age (7 days), so this is an *erasure-on-request* failure, not permanent retention. But DPDP obligates deletion **when asked**, not seven days later.

Not affected: the `reset_customer_data` command added today sweeps the filesystem afterwards, so a full-instance reset is complete. Only per-order erasure is broken.

---

## 4. Options

### Option A — stop autosave clobbering `image_paths` *(small)*

Only write `image_paths` in `defaults` when the caller actually supplied it:

```python
defaults = dict(layout_name=..., fit_mode=..., editor_state=..., expires_at=...)
if image_paths:                      # never blank what we already recorded
    defaults['image_paths'] = image_paths
```

- ✅ One-line-ish, no migration, fixes the common case going forward.
- ❌ Does nothing for rows already blanked, and nothing for abandoned uploads (§2.3).
- ⚠️ Check the restore path: `image_paths` is echoed back at `views.py:3052`. Confirm nothing depends on it being reset.

### Option B — give `UploadedFile` an order linkage *(migration)*

Add `order_id` (indexed `CharField`, matching `CanvasData.order_id`), populated at upload time from the `X-Order-ID` header the embed proxy already injects.

- ✅ Makes erasure **provable**: "delete every `UploadedFile` where `order_id = X`" needs no cooperation from canvas state.
- ✅ Catches abandoned uploads — the class Option A cannot reach.
- ❌ Migration plus backfill; existing rows have no order and stay unreachable.
- ⚠️ The direct partner API (`GenerateLayoutView`) has no order context on upload — needs a decision on what to record there.

### Option C — filesystem sweep in the purge *(belt and braces)*

After the row-driven pass, scan `UPLOADS_DIR`/`EXPORTS_DIR` for anything belonging to the order and remove it — the same backstop `reset_customer_data` uses.

- ✅ Catches everything, including pre-existing rows.
- ❌ Needs a reliable path→order mapping to be safe. Uploads are stored flat, so today there is none; without one, a sweep either misses files or risks deleting another order's.
- Only viable *after* B, or alongside an upload-path convention that embeds the order id.

### Recommendation

**A + B.** A stops the bleeding immediately and is safe to ship on its own. B is the durable fix and the only one that makes erasure defensible if it is ever audited — an erasure you cannot prove is one you cannot claim. C becomes trivial once B exists, and should be added then as a verification step rather than the mechanism.

Existing rows blanked before A ships remain unreachable by order. They are still deleted by the GC on age, so the exposure is bounded at the retention window (currently 7 days) rather than indefinite.

---

## 5. Phasing

| Phase | Scope | Est. |
|---|---|---|
| ~~1~~ | ✅ **Shipped.** Option A — `image_paths` written only when supplied; covered by `services/tests/test_erasure_contract.py` | 0.5 d |
| ~~2~~ | ✅ **Shipped.** `UploadedFile.order_id` (migration 0011), populated from `X-Order-ID`/request at upload; direct-API uploads record blank | 1.5 d |
| ~~3~~ | ⏭️ **Waived.** No backfill — the instance was reset to a fresh start, so every customer table was empty (0 rows) when `0011` landed. There is nothing legacy to infer. See the caveat below before writing any future cleanup. | — |
| ~~4~~ | ✅ **Shipped.** Post-commit verification sweep: every attempted path/dir is re-checked and retried once, survivors returned as `residual_files` / `residual_dirs` and factored into `erasure_complete` | 1 d |
| ~~5~~ | ✅ **Shipped.** Returns `unlocated_upload_rows` + `erasure_complete`, and logs a warning when incomplete | 0.5 d |

**Complete.**

Phase 5 is worth doing even alone: today a silent incomplete erasure is indistinguishable from a complete one.

---

## 6. Verification for whichever option ships

A purge is only correct if, for a given `order_id`:

1. no `UploadedFile` / `ExportedResult` / `CanvasData` / `RenderJob` / `EmbedSession` row remains, **and**
2. no file for that order remains under `UPLOADS_DIR` or `EXPORTS_DIR`, **and**
3. the response reports the counts it actually deleted.

Today only (1) holds. The test should assert all three against a seeded order that has autosaved — because an order that never autosaved passes even with the bug present, which is exactly why this went unnoticed.


---

## 7. Post-implementation notes

### Do not write a "delete rows with blank `order_id`" cleanup

`order_id=''` is the **legitimate** value for uploads that genuinely have no
order context — the direct partner API (`GenerateLayoutView`) uploads before any
order exists. A cleanup that deletes blank-`order_id` rows would destroy valid,
current uploads alongside legacy ones. The two are distinguishable only by
`created_at` relative to when `0011` was deployed, not by the field itself.

Phase 3 was waived rather than implemented precisely because the fresh-start
reset removed the legacy rows, so no such tool ever needed writing.

### Discovery, not just verification (added after the first pass)

The sweep initially could only verify that everything the purge *knew about* was
gone — uploads were stored flat under `UPLOADS_DIR` with a random filename
prefix, so nothing in the path identified the owner, and a file whose row was
lost was unreachable.

Uploads are now written to **`UPLOADS_DIR/<order_id>/`**
(`services.storage.order_upload_dir`). Ownership is visible in the path, so the
purge deletes the order's directory outright: it erases what is actually there
rather than what the database remembers. Verified against a file placed on disk
with **no `UploadedFile` row at all** — previously invisible to erasure, now
removed.

Two deliberate exclusions:

- **`_no_order/`** holds direct partner API uploads, which are made before any
  order exists. They belong to no order and are excluded from the directory
  delete; the GC still removes them on age.
- When a *surviving* order references a file inside the directory (shared
  original), the purge falls back to deleting file-by-file and leaves the shared
  one — the `keep_paths` rule still wins over discovery.

### Path traversal — caught in review, worth remembering

`order_id` permits `.` as a character, so **`..` matched the validation regex**.
Since the purge `rmtree`s the directory the order id resolves to, `order_id=".."`
would have targeted the parent of the uploads root.

`upload_subdir()` now rejects dot-only and dot-leading names explicitly, and
`order_upload_dir()` re-checks that the resolved path stays inside
`UPLOADS_DIR`. Six traversal cases are pinned in
`services/tests/test_erasure_contract.py`.

The lesson generalises: a validation regex written for *identifiers* is not
automatically safe as a *path segment*. Anything reused as a filesystem name
needs its own check.

### Verified failure mode

Deletion failing silently was the whole problem, so the sweep was tested against
a simulated `OSError` on unlink:

    file still on disk : True
    residual_files     : ['stubborn.jpg']
    erasure_complete   : False
    errors reported    : 2

Before phase 4 that same failure returned a clean success.
