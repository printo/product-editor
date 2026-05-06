# Cross-System Analysis

**Question:** how do the five Printo systems actually talk to each other today?

**TL;DR:** **PIA is the de-facto integration backbone**. Everything else is point-to-point and brittle. There is no event bus, no shared customer record, no shared product catalog, no shared inventory ledger.

## The five systems

| System | Tech | Role | Source available? |
|---|---|---|---|
| **Printo.in** | Flask 1.0.2 + Next.js 12 | E-commerce + ops back-office | ✅ Yes |
| **Printose** | Django 2.2 + 2× Next.js 10 | B2B corporate gifting | ✅ Yes |
| **Estimator** | PHP at `cs.printo.in` | In-store POS / order-creation backend | ❌ Not in scope |
| **PIA** | Unknown (`pia.printo.in`) | Internal auth + delivery dispatch | ❌ Not in scope |
| **Product Editor** | Next.js 16 + Django 5 | Print-file generator | ✅ Yes (this repo) |

## Integration map

```
                  ┌───────────────────────┐
                  │      PIA (auth)       │
                  │   pia.printo.in       │
                  └─────┬─────────┬───────┘
                        │ login   │ login
                        │ refresh │ refresh
                        │         │
                  ┌─────┴───┐ ┌───┴────────┐
                  │ Printose│ │ Product    │
                  │ (Django │ │ Editor     │
                  │  2.2)   │ │ (Django 5) │
                  └─────┬───┘ └────────┬───┘
                        │              │
                  bulk delivery    HMAC webhook
                  /deliveryq/      /api/internal
                  request-bulk     /pe-callback
                        │              │
                        ▼              ▼
                  ┌─────────────────────────┐
                  │  Printo.in (Flask 1.x)  │
                  │  webapp + printo-nextjs │
                  └────────────┬────────────┘
                               │
                       printo_integration
                       create_session.php
                               │
                               ▼
                       ┌───────────────┐
                       │  Estimator    │
                       │  cs.printo.in │
                       │   (PHP)       │
                       └───────────────┘
                               ▲
                               │ /hooks/erp_status callback
                               │
                       ┌───────┴───────┐
                       │  Printo.in    │
                       │  hooks_bp     │
                       └───────────────┘
```

## Edge-by-edge

### 1. Printo.in → PIA (auth)

- **Direction:** Printo.in delegates user login to PIA in some flows. `[UNVERIFIED]` how — not directly visible in `webapp/` view code; possibly via the Next.js layer.
- **Likely path:** none today. Printo.in has its own `PlatformUser` table (`webapp/inkmonkweb/models/platform_user.py:482`) and its own session via `flask-kvsession` + Flask-Login. PIA does not appear to be the source of identity for buyer accounts.
- **Implication:** **Identity is fragmented.** A Printo.in buyer is not the same row as a Printose recipient or an ops user in PIA.

### 2. Printo.in ↔ Estimator (PHP)

- **Direction:** bi-directional.
- **Outbound:** `webapp/inkmonkweb/erp_integration/printo_integration.py:33-35` — Flask backend POSTs to `cs.printo.in` PHP endpoints when an order is placed. Three target hostnames: test/live/cs.
- **Inbound:** Estimator → Printo.in `PUT /hooks/erp_status` (`webapp/inkmonkweb/views/hooks.py:545`) updates order status as Estimator's pipeline progresses.
- **Auth:** `[UNVERIFIED]` — likely API key in header.
- **Frequency:** every order with production/store-pickup routing.
- **Risk:** **single point of failure for store-pickup TAT**. A 30-minute Estimator outage = 30 minutes of no order handoff = TAT misses.

### 3. Printo.in ← Razorpay/PayU/Paytm/Epaylater webhooks

- **Direction:** PG → Printo.in.
- **Path:** `POST /hooks/razorpay-hooks` (`hooks.py:423`) and similar.
- **Auth:** webhook signature verification.
- **Used for:** payment confirmation. Without it, orders sit unfunded.

### 4. Printo.in ↔ Couriers (11 logistics integrations)

- **Direction:** bi-directional.
- **Outbound:** `webapp/inkmonkweb/shipping_integrations/{aftership,delhivery,dunzo,porter,shiprocket,shyplite,…}.py` for booking AWBs.
- **Inbound:** `POST /hooks/aftership` (`hooks.py:132`) — courier status updates.
- **Default:** DTDC (`default_config.py:215`).

### 5. Printose → PIA (auth)

- **Direction:** Printose → PIA.
- **Path:** `gifting/tasks.py:31` POST `https://pia.printo.in/api/v1/auth/`; `:49` POST `/auth/refresh-token/`.
- **Auth:** `printose@printo.in` shared service account (`[UNVERIFIED]` — credentials in `localsettings.py`).
- **Frequency:** per Celery task that needs to call PIA.

### 6. Printose → PIA (delivery dispatch)

- **Direction:** Printose → PIA.
- **Path:** `gifting/tasks.py:943` POST `https://pia.printo.in/api/v1/deliveryq/request-bulk/delivery/`.
- **Used for:** bulk shipment booking. PIA appears to act as a **logistics aggregator** in front of the courier integrations.
- **Implication:** **PIA is the right place to host a unified fulfillment service** — both Printose and Product Editor could route through it.

### 7. Printose → Estimator (PHP) — DORMANT

- **Direction:** would be Printose → Estimator.
- **Path:** `Printose/printo_se_api/apiserver/estimator/api.py:24, 62, 85` calls `api_create_session.php` with `order_ref_id = "PSWR-<id>"`.
- **Status:** **All callsites in `gifting/views.py:146-152` are commented out.** Integration exists in code but is currently disabled. `[UNVERIFIED]` whether this is a temporary kill-switch or a permanent retirement.

### 8. Printose → remove.bg / Zoho Desk

- **Direction:** outbound.
- `remove.bg` for image background removal (`gifting/views.py:111-115`).
- Zoho Desk for support tickets (`gifting/tickets.py:14-101`).

### 9. Product Editor ← Printo.in storefront (embed)

- **Direction:** storefront → Product Editor.
- **Bootstrap:** `POST /api/embed/session` with Bearer api_key, body `{order_id, callback_url}` → `{token, expires_at}`. Then iframe loads `?token=<token>` (`product-editor/CLAUDE.md:189`).
- **iframe runtime:** all calls go through `/api/embed/proxy/[...path]` with `X-Embed-Token` header → resolved server-side to api_key + order_id (`product-editor/frontend/nextjs/src/app/api/embed/proxy/[...path]/route.ts`).

### 10. Product Editor → Printo.in storefront (webhook)

- **Direction:** Product Editor → storefront.
- **Path:** Product Editor's Celery `notify_caller_webhook_task` POSTs to `EmbedSession.callback_url` with `{order_id, job_id, status, download_url, expires_at, file_count, layout_name, export_format}`, signed with `X-Signature: sha256=<HMAC-SHA256(api_key, body)>`.
- **Then:** storefront pulls the ZIP from `download_url` with `Authorization: Bearer api_key`.
- **Storefront integration status:** **PENDING** per `PRD.md:33`. Storefront team must add `POST /api/internal/pe-callback` handler. Until then, dashboard users use the alternative polling path (`GET /api/render-status/{job_id}/`).

### 11. Product Editor → PIA (auth)

- **Direction:** Product Editor → PIA.
- **Path:** `frontend/nextjs/src/pia-auth.ts:29` `https://pia.printo.in/api/v1/auth/` for login; `:109` for refresh.
- **Auth:** end-user credentials passed through.
- **Used for:** ops dashboard login (when ops users open the editor directly, not via embed).

### 12. Product Editor ↔ Estimator

- **Status:** **NONE**.
- **Verified by:** `grep -rn "estimator\|printose\|cs\.printo\.in"` against `product-editor/backend/` and `frontend/` returns zero matches in runtime code. (Legacy `.kiro/specs/` design docs were deleted in v1.10 cleanup.)
- **By design:** Product Editor is a **standalone print-file generator**. The storefront hands the ZIP to its existing OMS via its own (existing) integration; Product Editor never sees Estimator.

## What's missing across all systems

| Concern | State today | Risk |
|---|---|---|
| **Unified customer record** | Each system has its own. Printo.in's `PlatformUser` mixes buyers/sellers/ops. Printose has `accounts.User` with M2M to `Department`. Product Editor has no users (PIA is upstream). Estimator's customer model `[UNVERIFIED]`. | No CLV/LTV; cross-channel marketing impossible; DPDP compliance hard |
| **Unified product catalog** | Printo.in has `CustomizableProduct` (478 LOC) + `Product` + `RateCard` + ~15 catalog tables. Printose has `Product` + `ProductOptions`. No sync. | Product changes must be made in 2+ places |
| **Unified inventory** | None. Inventory presumably lives in Estimator (or upstream); not visible to Printo.in customers in real-time. Drift between online and retail is structural. | Stockouts visible only after order placed |
| **Unified order ledger** | Printo.in has `Job` + `Cart` + `SellerOrder`. Printose has `GiftRecipient` (the unit of fulfillment). Estimator has its own. Cross-channel revenue reporting requires manual joins in BI. | Finance / GST reporting harder than it should be |
| **Event bus** | None. All cross-system calls are point-to-point HTTP. | Adding a new consumer (e.g. analytics) requires changing every caller |
| **Shared identity** | None. PIA is partial — only Printose and Product Editor use it; storefront buyers don't. | See first row |

## End-to-end traces

### Trace A — Online order, home delivery (purely Printo.in)

```
Browser → printo-nextjs (Next 12) → server.js → Flask /api/jobs (POST)
       → Flask /api/carts/mine (PUT to add)
       → Flask /api/cart-payment-attempts (POST)
       → Razorpay (redirect / SDK)
       → Razorpay → Flask /hooks/razorpay-hooks (POST webhook)
       → Flask creates SellerOrder, sends ZeptoMail confirmation
       → Flask Celery task creates AWB via shipping_integrations/dtdc.py
       → Aftership webhook → /hooks/aftership for status updates
```

**Single system. Brittle but contained.**

### Trace B — Online order, store pickup

```
Browser → printo-nextjs → Flask /api/jobs → Flask /api/carts/mine
       → Razorpay (success)
       → Flask Celery task printo_integration.py → POST cs.printo.in/api_create_session.php
       → Estimator: creates production session, returns reference
       → Estimator → PUT https://printo.in/hooks/erp_status (callback)
       → Flask updates SellerOrder.status, notifies customer via ZeptoMail
```

**Two systems. Estimator outage = silent stall.** No retry/backoff documented in `printo_integration.py`. `[UNVERIFIED]` retry behavior.

### Trace C — Personalised product (e.g. fridge magnet) via embed

```
Browser → printo.in PDP → embed iframe loads product-editor.printo.in/?token=<t>
       → Product Editor /api/embed/proxy resolves token → {api_key, order_id, callback_url}
       → Customer composes canvas, clicks "Save & Continue"
       → /api/editor/render → Celery render at 300 DPI
       → notify_caller_webhook_task → POST printo.in /api/internal/pe-callback
              with X-Signature HMAC + download_url
       → Printo.in storefront verifies HMAC, GETs download_url with Bearer api_key
       → Storefront attaches ZIP to order, then triggers its existing
         printo_integration.py path → Estimator
```

**Three systems. Newest, cleanest contract.**

### Trace D — Walk-in retail order

```
Cashier at store → Estimator UI (PHP) → Estimator DB
                → ?? GST e-invoice generation [UNVERIFIED — likely Estimator]
                → ?? inventory decrement [UNVERIFIED]
                → ?? customer record creation [UNVERIFIED]
```

**Untraceable from the inspected repos.** The walk-in flow is entirely inside Estimator. No visibility from Printo.in or Printose unless the customer also has an online account, which most don't.

### Trace E — Corporate gifting (Printose)

```
HR admin → printose_admin_ui → Django /api/v1/campaigns/<pk>/generate/
                              → 100s of GiftRecipient rows + slugs
       → Email to each recipient with /g/<slug> URL
Recipient → printose Next.js /g/<slug> → Django /api/v1/gift/<slug>/
          → PATCH with selections
          → Recipient uploads photo → remove.bg or local MediaPipe
       → State machine moves through 19 states (gifting/models.py:284)
       → Celery task POST pia.printo.in/api/v1/deliveryq/request-bulk/delivery/
       → PIA dispatches via courier
       → Recipient receives → /f/<slug> feedback
```

**Three systems (Printose, PIA, courier). Estimator is NOT in this path** (the integration is commented out).

## Conclusion

The integration topology has two distinct shapes:

1. **Old shape (Printo.in ↔ Estimator):** point-to-point HTTP calls between Flask views, no retry, no observability beyond Sentry.
2. **New shape (Product Editor ↔ Storefront):** HMAC-signed webhooks, embed tokens, allowlisted proxy routes, Bearer auth on the download.

The migration roadmap (`08-migration-roadmap.md`) recommends adopting the **new shape** as the standard for all future integrations, and using PIA as the central event/auth backbone.
