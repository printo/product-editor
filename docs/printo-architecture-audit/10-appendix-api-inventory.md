# Appendix — API Inventory

Sample of the most-relevant endpoints across the three audited systems. **Not exhaustive** — Printo.in alone has ~200+ endpoints; this captures the operationally important surface.

## A. Printo.in

### Public buyer API (`market_api_bp`)

| Method | Path | Handler | Auth | Notes |
|---|---|---|---|---|
| GET, POST, PUT, DELETE, PATCH | `/jobs` | `market_api.py:1425` | session + flask-kvsession | Core domain entity |
| GET, POST, PUT, DELETE, PATCH | `/carts/mine` | `market_api.py:1505,1535` | session | Single per session |
| POST | `/cart-payment-attempts` | `market_api.py:1538` | session | Initiates payment |
| GET, POST | `/customizable-products` | `market_api.py:1398` | optional | Catalog read; admin write |
| GET, POST | `/customized-layouts` | `market_api.py:1367` | session | Per-job design data |
| GET, POST | `/product-categories` | `market_api.py:1198` | optional | Catalog read; admin write |
| GET, POST | `/sellers` | `market_api.py:1290` | session | Seller registration |
| GET, POST | `/seller-reviews-and-ratings` | `market_api.py:1294` | session | Reviews entity |
| POST | `/api/login` | `market_api.py:2456` | none | Username/password |
| POST | `/api/google` | `market_api.py:2396` | none | Google OAuth |
| POST | `/api/facebook` | `market_api.py:2423` | none | Facebook OAuth |
| POST | `/api/request-password-reset` | `market_api.py:1867` | none | Pwd reset email |
| POST | `/api/reset-password` | `market_api.py:1915` | reset token | Apply reset |
| GET | `/api/csrf` | `market_api.py:2231` | none | CSRF token issue. **TODO comment to remove (`market_api.py:2230`)** |
| GET, POST | `/api/files` | `market_api.py:2085` | session | File upload |
| GET | `/api/payment-status/<int:transaction_id>` | `market_api.py:2486` | session | Payment status poll |
| GET | `/api/page/home` | `market_api.py:2196` | none | Home-page CMS |
| GET | `/api/page/categories/<slug>` | `market_api.py:2190` | none | Category CMS |
| GET | `/api/page/customizable-products/<slug>` | `market_api.py:2211` | none | PDP CMS |
| GET | `/api/stores` | `market_api.py:2130` | none | Store locator |
| GET | `/api/search` | `market_api.py:2116` | none | **STUB — returns 2 hardcoded items (`:2117-2127`)** |

### Webhooks (`hooks_bp`)

| Method | Path | Handler | Auth | Notes |
|---|---|---|---|---|
| POST | `/hooks/razorpay-hooks` | `hooks.py:423` | webhook signature | Razorpay PG events |
| PUT | `/hooks/erp_status` | `hooks.py:545` | API key | **Estimator → Printo.in callback** |
| POST | `/hooks/pia_webhook` | `hooks.py:619` | API key | PIA inbound |
| POST | `/hooks/aftership` | `hooks.py:132` | webhook signature | Shipment events |
| POST | `/hooks/exotel` | `hooks.py:` `[UNVERIFIED]` line | webhook | Voice / SMS callbacks |

### Hosted-PG redirects (`core_pages_bp`)

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET, POST | `/paytm-redirect/<id>` | `core_pages.py:1247` | session |
| GET, POST | `/epaylater-redirect/<id>` | `core_pages.py:1262` | session |

### Internal / ops blueprints (sample)

| Blueprint | Mount path | Notes |
|---|---|---|
| `ops_manager_api_bp` | `/ops-api/*` | 1,900 LOC — internal ops dashboard |
| `sales_manager_api_bp` | `/sales-api/*` | 1,068 LOC — sales-team CRM |
| `seller_account_api_bp` | `/seller-api/*` | 943 LOC — seller-side |
| `buyer_account_api_bp` | `/buyer-api/*` | 598 LOC — buyer-side |
| `v3_admin_api_bp` | `/admin-api/v3/*` | versioned admin API |

### Deprecated / dead

- Whole `webapp/deprecated/` directory.
- `/api/search` stub.
- Commented `# @hooks_bp.route('/mandrill', ...)` at `hooks.py:45`.
- `views/store.py` is a 16-line stub.

## B. Printose (`printo_se_api`)

All routes prefixed `/api/v1/`. Auth = simplejwt Bearer unless noted. Handler line numbers in `apiserver/gifting/views.py` unless explicitly otherwise.

### Auth

| Method | Path | Handler | Notes |
|---|---|---|---|
| POST | `/login/` | `gifting.views.AuthenticateLogin` (`urls.py:9`) | JWT login |
| POST | `/refresh-token/` | simplejwt `TokenRefreshView` (`urls.py:13`) | Refresh JWT |

### Gifting (`gifting/urls.py`)

| Method | Path | Handler | Auth | Notes |
|---|---|---|---|---|
| GET, PATCH | `/gift/<slug>/` | `GiftRecipientRetrieveUpdateView` (`views.py:133`) | **none — public by slug** | Recipient picks gifts + uploads photo |
| POST | `/remove-bg/` | `RemoveBgAPIView` (`views.py:105`) | JWT | remove.bg proxy |
| GET | `/campaigns/` | `CampaignListView` (`urls.py:23`) | JWT | List campaigns |
| GET, PATCH | `/campaigns/<pk>/` | `CampaignRetrieveUpdateView` (`urls.py:26`) | JWT | One campaign |
| GET | `/campaigns/<pk>/summary/` | `CampaignSummaryView` (`urls.py:27`) | JWT | Analytics |
| POST | `/campaigns/<pk>/generate/` | `GenerateGiftRecipientsView` (`urls.py:41`) | JWT | Bulk-create recipients |
| POST | `/recipients/tracking_update/` | `GiftRecipientTrackingUpdateView` (`urls.py:65`) | JWT | Bulk AWB update |
| GET | `/products/` | `ProductListView` (`urls.py:32`) | JWT | List |
| POST | `/products/create/` | `ProductCreateAPI` (`urls.py:34`) | JWT | Create |
| POST | `/grievances/` | (`urls.py:86`) | JWT | Post-delivery issue |
| POST | `/replacement-requests/` | (`urls.py:89`) | JWT | Replacement |
| POST | `/reverse-pickup/` | (`urls.py:93`) | JWT | Pickup request |

### Wallet

| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | `/wallet/` | `wallet.views.WalletListAPIView` (`wallet/urls.py:6`) | List wallets |
| GET, POST | `/wallet/transactions/` | `TransactionListCreateView` (`wallet/views.py:63`) | Ledger entries |
| POST | `/wallet/upload_csv/` | `UploadTransactionFile` (`wallet/views.py:208`) | CSV ingestion |
| GET, POST | `/wallet/invoice/` | `InvoiceListCreateView` (`wallet/views.py:189`) | Department invoices |

### Tickets (Zoho passthrough)

| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | `/tickets/` | `TicketsView` (`urls.py:69`) | List tickets via Zoho Desk |
| GET | `/tickets/threads/` | `ThreadsView` (`urls.py:75`) | Ticket threads |

### Landing page

| Method | Path | Handler | Notes |
|---|---|---|---|
| GET | `/landing-page/casestudies/` | `landing_page.views.CaseStudyList` | Marketing CMS |

### Notably absent

- No payment-gateway endpoint (orders are funded via Wallet ledger, not real-time PG).
- No GST e-invoicing endpoint.
- No store-location endpoint.
- No quote/estimate endpoint despite the name.

## C. Product Editor

Already documented in detail in [CLAUDE.md](../CLAUDE.md). Key endpoints:

### Public

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/health` | `HealthView` | none |
| GET | `/api/layouts` | `ListLayoutsView` | API key |
| GET | `/api/layouts/<name>` | layout fetch | API key |
| GET | `/api/sku-layouts/` | `SKULayoutView` | none (public read) |
| GET | `/api/sku-layouts/<sku>/` | `SKULayoutView` | none (public read) |

### Embed flow

| Method | Path | Handler | Auth |
|---|---|---|---|
| POST | `/api/embed/session` | `EmbedSessionView` | API key |
| POST | `/api/embed/proxy/[...path]` | proxy | X-Embed-Token |

### Editor + render

| Method | Path | Handler | Auth |
|---|---|---|---|
| POST | `/upload/init` | `ChunkedUploadInitView` | session / token |
| PUT | `/upload/<upload_id>/chunk?index=N` | `ChunkedUploadChunkView` | session / token |
| POST | `/upload/<upload_id>/complete` | `ChunkedUploadCompleteView` | session / token |
| POST | `/api/editor/render` | `EditorRenderView` | session / token |
| GET | `/api/render-status/<job_id>/` | `RenderStatusView` | session / token |
| GET | `/api/jobs/<job_id>/download/` | `RenderJobDownloadView` | Bearer api_key |
| GET, PUT | `/api/canvas-state/<order_id>` | `CanvasStateView` | session / token |
| POST | `/api/layout/generate` | `GenerateLayoutView` (legacy direct API) | API key |

### Ops

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET, PUT | `/api/fonts` | `FontsView` | ops API key |
| GET, PUT | `/api/sku-layouts/` | `SKULayoutView` | ops for PUT |
| GET, POST, PUT, DELETE | `/api/ops/layouts/<name>` | `LayoutManagementView` | ops API key |

### Webhooks (outbound)

| Method | Target | Auth | Notes |
|---|---|---|---|
| POST | `EmbedSession.callback_url` | `X-Signature: sha256=<HMAC>` | `notify_caller_webhook_task` |

## D. Estimator (`cs.printo.in`) — surface only

Source not in scope; documented from caller code only.

| Method | Path | Caller | Notes |
|---|---|---|---|
| POST | `/api_create_session.php` | `webapp/.../printo_integration.py`; `Printose/.../estimator/api.py:24` (dormant) | Order push; takes `order_ref_id` |

Plus presumably:
- POS UI endpoints (likely server-rendered PHP, not REST).
- Inventory read/write endpoints.
- GST e-invoicing endpoints.
- Customer creation endpoints.

All `[UNVERIFIED]` — see `09-open-questions.md` #1.

## E. PIA (`pia.printo.in`) — surface only

Source not in scope.

| Method | Path | Caller | Notes |
|---|---|---|---|
| POST | `/api/v1/auth/` | Printose `tasks.py:31`, Product Editor `pia-auth.ts:29` | Username/password login |
| POST | `/api/v1/auth/refresh-token/` | Printose `tasks.py:49` | Refresh JWT |
| POST | `/api/v1/auth/token/refresh/` | Product Editor `pia-auth.ts:109` | Refresh JWT (different path?) `[UNVERIFIED]` |
| POST | `/api/v1/deliveryq/request-bulk/delivery/` | Printose `tasks.py:943` | Bulk shipment booking |

## Cross-references

- For data behind these endpoints, see `11-appendix-data-model.md`.
- For end-to-end flows that chain endpoints across systems, see `03-cross-system-analysis.md` § "End-to-end traces".
