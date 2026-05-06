# Current State — Estimator (and Printose, the system Printo calls "se")

> ⚠️ **Naming surprise.** The repo at `/Users/kannaperumal/Code/Printose/` — which from its name and existence in the audit list looked like the in-store POS — is **not** a POS. It is a **corporate-gifting / SWAG fulfillment platform** ("se" — possibly "swag enabler" or "soft estimate" — `[UNVERIFIED]` what the abbreviation stands for). The actual in-store retail POS that Printo calls "Estimator" is a separate **legacy PHP service at `cs.printo.in`** whose source was not in the inspected repos.
>
> This file documents both: §A is **Printose** (audited from source); §B is the **real Estimator** (documented from its API surface only, since source is not available).

---

## §A — Printose (corporate gifting)

**Repo path:** `/Users/kannaperumal/Code/Printose/` · 3 separate git repos that deploy independently. · **Last commits:** `printose` 2026-02-23, `printose_admin_ui` 2025-12-20, `printo_se_api` 2025-02-14.

### What it actually does

A B2B gifting platform. Corporate customers (e.g. HR teams) create campaigns with a points wallet, generate a unique slug per recipient, and send each recipient a personal URL like `https://se.printo.in/g/<slug>`. Recipients pick their gifts (mug, t-shirt, etc.), upload selfies for personalisation, and Printo prints + ships. There's also a feedback flow at `/f/<slug>` post-delivery.

It is **not** related to retail walk-in orders, POS billing, GST e-invoicing, or store inventory. The skill brief's premise was incorrect.

### At a glance

| Subfolder | Role | Stack | LOC |
|---|---|---|---|
| `printose/` | Recipient-facing customer site | Next.js **10.0.6** + React 17 + Bootstrap 4 + Ant Design 5 + theme-ui (`package.json:22`) | mid-size |
| `printose_admin_ui/` | Internal ops console | Next.js **10.0.8** + React 17 + Reactstrap + MUI + Argon Dashboard template (`package.json:53`) | mid-size |
| `printo_se_api/` | Backend API | Django **2.2.18** + DRF 3.12.2 + Celery 5.2.7 + PostgreSQL 11 (Postgis image, but plain `postgresql` engine) + Redis 6 (`requirements.txt:18,30,16`; `docker-compose.yml:5,20`) | mid-size |

**Combined LOC** (across all 3 subfolders, excluding `node_modules`/`.next`/`.git`): ~62,962.

### Service topology

- All three are **separate git repos**, each with its own `.gitlab-ci.yml`, README, and deployment target.
- Both Next.js apps proxy `/api` and `/media` to Django (`printose/server.js:11-27`).
- All client-server calls are **REST/JSON** with **JWT cookie auth** via simplejwt (`apiserver/apiserver/settings.py:174-214`).
- Neither GraphQL nor WebSocket.

| Subfolder | Public URL | Entry point |
|---|---|---|
| `printose/` | `se.printo.in/g/<slug>`, `/f/<slug>`, `/landing-page/*` | `server.js:34-49` (custom Express + Next), `pages/g/[giftid].js`, `pages/f/[feedbackid].js` |
| `printose_admin_ui/` | `se.printo.in/admin-ui/*` `[UNVERIFIED]` | `pages/login.js`, `pages/admin-ui/dashboard.js` |
| `printo_se_api/` | `se.printo.in/api/v1/*` | `apiserver/apiserver/urls.py:38-43` |

### API surface (sample)

All routes mounted under `/api/v1/`. Auth = simplejwt Bearer; recipient slug endpoints intentionally unauthenticated (looked up by slug). Handler line numbers in `apiserver/gifting/views.py` unless noted.

| Method+Path | Handler | Purpose |
|---|---|---|
| POST `/login/` | `gifting.views.AuthenticateLogin` (`urls.py:9`) | JWT login |
| POST `/refresh-token/` | simplejwt `TokenRefreshView` (`urls.py:13`) | Refresh JWT |
| GET/PATCH `/gift/<slug>/` | `GiftRecipientRetrieveUpdateView` (`views.py:133`) | Recipient picks products + uploads photos |
| POST `/remove-bg/` | `RemoveBgAPIView` (`views.py:105`) | Background removal proxy |
| GET/PATCH `/campaigns/<pk>/` | `CampaignRetrieveUpdateView` (`urls.py:26`) | One campaign |
| POST `/campaigns/<pk>/generate/` | `GenerateGiftRecipientsView` (`urls.py:41`) | Bulk-create recipients |
| POST `/recipients/tracking_update/` | `GiftRecipientTrackingUpdateView` (`urls.py:65`) | Bulk AWB / courier update |
| GET `/wallet/` | `wallet.views.WalletListAPIView` (`wallet/urls.py:6`) | Department wallets |
| GET/POST `/wallet/transactions/` | `TransactionListCreateView` (`wallet/views.py:63`) | Ledger entries |
| POST `/wallet/upload_csv/` | `UploadTransactionFile` (`wallet/views.py:208`) | CSV ledger ingestion |
| GET/POST `/wallet/invoice/` | `InvoiceListCreateView` (`wallet/views.py:189`) | Department invoices |
| GET `/tickets/` | `TicketsView` (`urls.py:69`) | Zoho-Desk passthrough |

**There is NO Quote/Estimate, NO GST e-invoicing endpoint, NO payment-gateway endpoint, NO store-location/POS endpoint.** The only "GST" present is a `gst_percent` float on `wallet.Item` (`wallet/models.py:107`); no IRN, no e-invoice, no HSN lookup. The `HSNSAC` constant appears only in commented-out code (`estimator/api.py:83`).

### Data layer

- **Postgres 11** via `mdillon/postgis:11-alpine` (`docker-compose.yml:5`). Postgis available but unused — `settings.py:99-106` uses plain `postgresql` engine; GIS settings commented out at `:108-116`.
- **152 migrations** in `gifting/` alone. Very high churn for a relatively small app.
- **Cache:** `LocMemCache` (`settings.py:186-191`) — process-local, **not Redis** despite django-redis being in `requirements.txt:27`. Redis is broker-only.
- **No search.**

Central models (all in `apiserver/gifting/models.py` unless noted):

| Model | Line | Role |
|---|---|---|
| `Department` / `CostCenter` | 19 / 26 | Tenant grouping |
| `GiftCampaign` | 42 | Campaign w/ products, template, expiry, BG-removal mode |
| `Product` / `ProductOptions` / `ProductImage` | 190 / 256 / 243 | Catalog + options tree |
| `GiftRecipient` | 328 | Per-person record; **19-state machine** via `GiftRecipientState` (line 284) |
| `SelectedProducts` / `SelectedProductImage` | 485 / 504 | Recipient choices + uploaded photos |
| `Grievance` / `ReversePickup` / `ReplacementRequest` | 588 / 632 / 676 | Post-delivery flows |
| `FeedbackResponse` | 747 | Star + image feedback |
| `Wallet` / `Transaction` / `Item` / `Invoice` (`wallet/models.py`) | 21 / 48 / 95 / 120 | Department points-ledger |
| `accounts.User` (`accounts/models.py:53`) | — | Custom user, M2M to Department |

### External integrations

| Service | File:line | What it does |
|---|---|---|
| **PIA** (Printo internal auth) | `gifting/tasks.py:31, 49` | Login + token refresh against `pia.printo.in/api/v1/auth/` |
| **PIA** (delivery dispatch) | `gifting/tasks.py:943` | `pia.printo.in/api/v1/deliveryq/request-bulk/delivery/` — bulk shipment booking |
| **Estimator** (legacy PHP — see §B) | `estimator/api.py:24, 62, 85` | `<base_url>/api_create_session.php`; pushes `PSWR-<id>` orders. **All callsites in `gifting/views.py:146-152` are commented out — integration is currently dormant.** |
| **remove.bg** | `gifting/views.py:111-115` | Background removal w/ `X-Api-Key`; falls back to MediaPipe locally |
| **MediaPipe / TensorFlow** | `printose/package.json:13-16` | Browser-side selfie segmentation as remove.bg fallback |
| **Zoho Desk** | `gifting/tickets.py:14-101` | OAuth + ticket search/threads at `desk.zoho.in/api/v1/*` |
| **AWS S3** | `requirements.txt:7,29`; `settings.py:159-172` | django-storages + boto3 — **all settings commented out**; local `MEDIA_ROOT` filesystem in use today |
| **SMTP** | `settings.py:25` (`django_smtp_ssl`) | Transactional email; ops alerts to `printose@printo.in`, `bopanna.kt@printo.in`, `logistics@printo.in` |

### Code health signals

| Signal | Value | Severity |
|---|---|---|
| Combined LOC | ~62,962 | — |
| Last commits | api 2025-02-14, admin 2025-12-20, customer 2026-02-23 | — |
| Tests | **Nearly zero.** 3-line scaffolds (`accounts/tests.py`, `wallet/tests.py`); throwaway `estimator/test_api.py` | 🔴 Critical |
| TODO/FIXME density | 4 hits across all source | — (low because deferred work shows as commented code, not tagged) |
| Hardcoded `SECRET_KEY` | `apiserver/settings.py:24` `*@$erb$b7jh-f82d5b!k9$^j9m3q*o!d&-r^p+k+dbe5rq(1aq` — **and used as JWT signing key** (`settings.py:200`) | 🔴 **Critical — full auth bypass possible for anyone with repo read access** |
| `DEBUG = True` committed | `settings.py:29` | 🔴 Critical |
| `ALLOWED_HOSTS = ["*"]` | `settings.py:31` | 🔴 Critical |
| Anti-pattern: business logic in `Model.save()` | `GiftRecipient.save` 60+ lines (`models.py:419-480`); `Grievance.save` writes audit rows (`:602-608`); `Transaction.save` mutates wallet balance (`wallet/models.py:74-92`) | 🟠 High — hard to test, side-effects inside ORM |
| CI/CD | GitLab CI in all 3 repos. API pipeline SSHes into `beta-se.printo.in` / `se.printo.in`, `git pull`, `pip install`, `migrate`, `systemctl restart` (`printo_se_api/.gitlab-ci.yml:9-30`) | 🟠 High — **no tests run, no Docker push, no migration safety check** |
| Migrations | 152 in `gifting/` | — |

### EOL dependencies (Printose)

| Component | Pinned | Status |
|---|---|---|
| Django | 2.2.18 | EOL April 2022 |
| Python | 3.8 | EOL October 2024 |
| DRF | 3.12.2 | 2020 release |
| Next.js | 10.0.6 / 10.0.8 | 2021; React 17 |
| PostgreSQL image | 11 | EOL November 2023 |

---

## §B — The real Estimator (in-store POS, source not in scope)

**What we know about it:**

- **Hostnames** referenced in code: `cs.printo.in` (live), plus test/staging variants (`webapp/inkmonkweb/erp_integration/printo_integration.py:33-35`).
- **Tech:** PHP. Endpoint pattern `*.php` (e.g. `api_create_session.php` per `Printose/printo_se_api/apiserver/estimator/api.py:24`).
- **Role:** the system that takes an order push from upstream callers and creates a "session" / job in the production estimating system. Used by both **Printo.in** (live integration via `printo_integration.py`) and **Printose** (dormant — callsites commented).
- **Order ID format:** Printose pushes orders with `order_ref_id = "PSWR-<id>"` (`estimator/api.py:62`). Printo.in's format `[UNVERIFIED]`.
- **Auth:** unknown from outside; likely API key in header — `[UNVERIFIED]`.
- **Last activity:** unknown — source repo not in `/Users/kannaperumal/Code/`.

**What we don't know:**

- Database engine, schema, migration system.
- Internal architecture (single PHP file? Laravel? CodeIgniter?).
- Test coverage, CI/CD, deploy mechanism.
- Whether the in-store POS *terminal* (the cashier-facing screen) is part of this, or a separate system.
- Inventory model and how it syncs with Printo.in.
- GST e-invoicing implementation — `[UNVERIFIED]` whether it lives here or elsewhere.

> **Action needed:** locate the Estimator source repo (not at the default Windows path; not in `/Users/kannaperumal/Code/`). Without it, the audit cannot fully document the order-routing path for store-pickup or walk-in orders. Add to `09-open-questions.md`.

### Touch points with the rest of the ecosystem

- Printo.in calls Estimator on **every order with store-pickup or production routing** (live, via `printo_integration.py`).
- Printo.in receives callbacks from Estimator at `/hooks/erp_status` (`webapp/inkmonkweb/views/hooks.py:545`).
- Printose was wired to push orders to Estimator but currently **doesn't** (commented out).
- Product Editor does **not** integrate with Estimator (confirmed by grep — zero references in `product-editor/`).

---

## What this repo does NOT contain

- The in-store POS *terminal* / cashier UI.
- GST e-invoicing pipeline (likely lives in Estimator or a separate system).
- Inventory ledger.
- Walk-in order flow (this is in Estimator at `cs.printo.in`).

These belong to the system Printo calls "Estimator" — see §B. Until that source is located, those areas remain `[UNVERIFIED]`.
