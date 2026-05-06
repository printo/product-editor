# Current State — Printo.in (E-commerce monolith)

**Repo path:** `/Users/kannaperumal/Code/Printo.in/` · **Last commit:** 2026-04-30 · **Activity:** very high (40,487 commits on `feat/per-job-review-collection`).

## At a glance

- **Backend:** Flask **1.0.2** monolith (`webapp/requirements.txt:1`), ~25 blueprints, ~146,662 LOC Python.
- **Frontend (modern):** Next.js **12.3.4** + React **17.0.2** (`printo-nextjs/package.json:46, 22`), ~40,676 LOC, Express custom server.
- **Frontend (legacy):** **6 in-repo React SPAs** under `webapp/inkmonkweb/static/clients/` (MarketV2, CatalogManager, OpsManager, SalesManager, SellerManager, DesignResourceManager, SellerV2) — each with its own webpack/yarn build, totalling ~19,788 LOC.
- **DB:** MySQL **8.0.42** primary (`docker-compose.yml:5-19`); 203 SQLAlchemy models; **3,108** Alembic migrations.
- **Async:** Celery + RabbitMQ (`celeryconfig.py:6` `amqp://guest:guest@localhost:5672//`).
- **Search:** Algolia + Typesense (dual-mode, mid-migration per `webapp/CLAUDE.md:142`).
- **Cache + sessions:** Redis with `flask-kvsession`.
- **Cloud:** AWS **`ap-southeast-1`** (Singapore) — bucket `s3-ap-southeast-1.amazonaws.com/inkmonk-files` (`default_config.py:320`).

## Service topology

Modular Flask monolith + a Next.js presentation layer. Single Flask process registers ~25 blueprints in `webapp/inkmonkweb/app_factory.py:9-26`.

| Entry point | File:line | Purpose |
|---|---|---|
| `app.py:1-4` | local | factory bootstrap |
| `wsgi.py:1-7` | prod | gunicorn entry, NewRelic loaded before factory import |
| `printo-nextjs/server.js:1-32` | edge | Express → Next; proxies `/api/*` and `/buyer-api/*` to Flask |

The Next.js custom Express server is a **major upgrade-blocker** — Next.js 13+ recommends moving away from custom servers; doing so requires re-architecting the proxy layer.

## Top blueprints (by LOC)

| Blueprint | File | LOC | Purpose |
|---|---|---|---|
| `market_api_bp` | `views/market_api.py` | **2,738** | Public storefront API — entity router (jobs, carts, products) + custom routes |
| `core_pages_bp` | `views/core_pages.py` | **2,268** | Server-rendered legacy pages + payment-gateway redirects |
| `ops_manager_api_bp` | `views/ops_manager_api.py` | 1,900 | Internal ops dashboard API |
| `tasks.py` | (Celery) | **1,889** | All async jobs (analytics, fulfillment, mailers) |
| `metrics_bp` | `views/metrics_bp.py` | 1,149 | Metrics + analytics endpoints |
| `sales_manager_api_bp` | `views/sales_manager_api.py` | 1,068 | Sales-team CRM API |
| `hooks_bp` | `views/hooks.py` | 937 | Inbound webhooks (razorpay, aftership, exotel, pia) |
| `seller_account_api_bp` | `views/seller_account_api.py` | 943 | Seller-side account API |
| `buyer_account_api_bp` | `views/buyer_account_api.py` | 598 | Buyer-side account API |

Plus: `social_login_bp`, `catalogue_manager_*`, `design_resources_manager_*`, `seller_manager_*`, `v3_admin_api_bp`, `graphql_view`, `monitor_bp`, `debug_templates`, `uimocks`, `seller_account_dashboard_bp`, `buyer_account_dashboard_bp`.

> **Anti-pattern flag:** four files >1,800 LOC. Business logic, payment-gateway signature verification, and template rendering all coexist in `core_pages.py`. Refactoring is high-leverage but risky given test coverage signals (see Code health).

## API surface (sample, ~25 of ~200+ endpoints)

| Method | Path | Handler | Purpose |
|---|---|---|---|
| GET/POST/PUT/DELETE/PATCH | `/jobs` | `market_api.py:1425` | Core domain object — printable line item |
| GET/PUT | `/carts/mine` | `market_api.py:1505,1535` | Session-bound cart |
| POST | `/cart-payment-attempts` | `market_api.py:1538` | Create payment attempt |
| POST | `/api/login` | `market_api.py:2456` | Username/password login |
| POST | `/api/google` | `market_api.py:2396` | Google OAuth |
| POST | `/api/facebook` | `market_api.py:2423` | Facebook OAuth |
| POST | `/api/request-password-reset` | `market_api.py:1867` | Pwd reset email |
| POST | `/api/reset-password` | `market_api.py:1915` | Apply reset |
| GET | `/api/csrf` | `market_api.py:2231` | CSRF token issue (`# TODO: Remove when add token auth`) |
| GET/POST | `/api/files` | `market_api.py:2085` | File upload |
| GET | `/api/payment-status/<int>` | `market_api.py:2486` | Payment status poll |
| GET | `/api/page/home` | `market_api.py:2196` | Home-page CMS |
| GET | `/api/page/categories/<slug>` | `market_api.py:2190` | Category CMS |
| GET | `/api/page/customizable-products/<slug>` | `market_api.py:2211` | PDP CMS |
| GET | `/api/stores` | `market_api.py:2130` | Store locator |
| GET | `/api/search` | `market_api.py:2116` | **Stub returning 2 hardcoded items** — zombie |
| GET/POST | `/product-categories` | `market_api.py:1198` | Catalog entity |
| GET/POST | `/sellers` | `market_api.py:1290` | Seller entity |
| GET/POST | `/customizable-products` | `market_api.py:1398` | PDP entity |
| GET/POST | `/customized-layouts` | `market_api.py:1367` | Per-job design data entity |
| GET/POST | `/seller-reviews-and-ratings` | `market_api.py:1294` | Reviews entity |
| POST | `/hooks/razorpay-hooks` | `views/hooks.py:423` | Razorpay webhook |
| PUT | `/hooks/erp_status` | `views/hooks.py:545` | Estimator/PIA ERP callback |
| POST | `/hooks/pia_webhook` | `views/hooks.py:619` | PIA inbound |
| POST | `/hooks/aftership` | `views/hooks.py:132` | Shipment events |

**Auth mix:** Flask-Login session cookie + `flask-kvsession` (Redis) + Flask-Security 3.0.0 (abandoned upstream). API-key alt auth in `inkmonkweb/authenticators.py:85, 107, 135`. CSRF via flask-wtf. Token auth is on a TODO list (`market_api.py:2230` `# TODO: Remove when add token auth`).

Full endpoint inventory in `10-appendix-api-inventory.md`.

## Data layer

- **MySQL 8.0.42** primary, defined in `docker-compose.yml:5-19`.
- **ORM:** SQLAlchemy ≥1.3.2 + flask-sqlalchemy + custom `flask-sqlalchemy-booster==0.6.31` (auto-CRUD).
- **Models:** ~203 files in `webapp/inkmonkweb/models/`. Central god-models:

| Model | File | LOC | Role |
|---|---|---|---|
| `Job` | `models/job/__init__.py` | **1,981** | The "printable order line item" — god model |
| `Cart` | `models/cart.py` | 912 | Cart with payment-split logic baked in |
| `PlatformUser` | `models/platform_user.py` | 482 | Buyers + sellers + ops in **one table** |
| `CustomizableProduct` | `models/customizable_product.py` | 478 | Catalog entry |
| `CustomizedLayout` | `models/customized_layout.py` | 375 | Per-job design data |
| `SellerOrder` | `models/seller_order.py` | 340 | Cart split by seller |
| `Payment` | `models/payment.py` | 150 | Payment record (Razorpay/Paytm/PayU/Epaylater multiplexed via `pg_type`) |

Plus: `Address`, `Artwork`, `Voucher`, `RateCard`, `Quotation`, `RefundClaim`, `RetailOutlet`, `SellerReviewAndRating`, `Layout`, `UploadedFile`, `Consignment`.

- **Migrations:** 3,108 Alembic versions under `webapp/migrations/versions/`. Likely heavily redundant; compaction would be a 1-week project that pays back in `manage.py db upgrade` time.
- **Single-table-for-all-actors anti-pattern:** `PlatformUser` mixes buyers, sellers, and ops staff. Auth tier is decided by flags. Hard to extract auth without untangling.

## External integrations

| Category | Tool | Where | Status |
|---|---|---|---|
| Payments | Razorpay, PayU, Paytm, Epaylater | `core_pages.py:1232-1390`, `models/payment.py:3-7` | Live (multiplexed) |
| Logistics | aftership, aramex, clickpost, delhivery, dunzo, pickrr, porter, shipmile, shiprocket, shyplite, trackingmore | `webapp/inkmonkweb/shipping_integrations/` (11 modules) | Live |
| Default courier | DTDC | `default_config.py:215 DEFAULT_COURIER_PROVIDER = "dtdc"` | Live |
| Notifications | Plivo SMS, ZeptoMail (16 callsites) | `sms_messenger.py`, `zepto_mailer.py` | Live |
| Push | OneSignal | `OneSignalSDKWorker.js`, `OneSignalSDKUpdaterWorker.js` | Live |
| Media | Boto2 → S3 (Singapore region) | `utils.py:28-29, 733`; `default_config.py:320` | Live |
| Search | Algolia + Typesense (mid-migration) | `algolia_search.py`, `typesense_search.py` | In-flight |
| Analytics | Mixpanel, Heap, CleverTap, SendInBlue, GA Measurement Protocol | `tasks.py:31-37`; `analytics.py:301` | Live |
| APM | Sentry, NewRelic, Elastic-APM | `requirements.txt:86, 100, 92`; `app_factory.py:71` | All three live |
| ERP | Custom Estimator integration | `webapp/inkmonkweb/erp_integration/printo_integration.py:33-35` (test/live/cs.printo.in) | Live — calls Estimator PHP |
| CRM | Zoho via webhooks/SalesIQ — only in DesignResourceManager React app | `static/clients/DesignResourceManager/.../*.js:132` (4 hardcoded `flow.zoho.com` URLs) | ⚠️ Tokens exposed client-side |
| Inbound webhooks | razorpay, aftership, exotel, pia | `views/hooks.py` | Live |

**Not present:** CCAvenue, Stripe, MSG91, Gupshup, Twilio, SendGrid, Tally, Salesforce, Freshdesk, Segment, RudderStack, Hotjar, Amplitude. PayPal mentioned in `webapp/CLAUDE.md:140` but no greppable code — `[UNVERIFIED]` whether actually wired.

## Code health signals

| Signal | Value | Note |
|---|---|---|
| Python LOC | ~146,662 | First-party only |
| JS/TS LOC (modern) | ~40,676 | `printo-nextjs/` |
| JS/TS LOC (legacy SPAs) | ~19,788 | `static/clients/` |
| Last webapp commit | 2026-04-30 | Active |
| Last printo-nextjs commit | 2026-04-30 | Active |
| TODO/FIXME density | 137 (Python) + 8 (JS/TS) | Low — pain isn't tracked inline |
| God classes | 4 files >1,800 LOC | `market_api.py`, `core_pages.py`, `tasks.py`, `models/job/__init__.py` |
| Hardcoded secrets in repo | None spotted in views | `instance/application.cfg.py` is local-only. **But:** Zoho webhook URLs with API tokens hardcoded in client JS (`DesignResourceManager/.../*.js:132`) — exposed to browser |
| Migrations | 3,108 versions | Healthy in count, alarming in volume |
| CI/CD | 8 GitHub Actions workflows | `prod_workflow.yml`, `staging_deployment.yml`, `alpha_workflow.yml`, `test_workflow.yml`, plus self-hosted variants |
| Quality gates | SonarQube (`printo-nextjs/sonar-project.properties`) | Wired |

### EOL dependencies (ranked by severity)

| Component | Pinned | Status | Severity |
|---|---|---|---|
| Flask | 1.0.2 | EOL — current is 3.1, no security patches | 🔴 Critical |
| Werkzeug | 0.15.1 | EOL — current is 3.1 | 🔴 Critical |
| Flask-Security | 3.0.0 | **Abandoned upstream** (replacement is `flask-security-too`) | 🔴 Critical |
| Flask-Login | 0.3.2 | 2017 release | 🟠 High |
| Boto | 2.38.0 | boto3 superseded boto in 2014 | 🟠 High |
| Ubuntu base | 18.04 | EOL May 2023 | 🟠 High |
| Node | 11.13.0 | EOL April 2019 | 🟠 High |
| pandas | 0.24.2 | 2019 release, Python 2-era | 🟡 Medium |
| requests | 2.7.0 | 2015 release | 🟡 Medium |
| pyPdf | 1.13 | 2010, abandoned | 🟡 Medium |
| Next.js | 12.3.4 | ~3 majors behind (current 15) | 🟡 Medium |
| React | 17.0.2 | No automatic batching, no concurrent | 🟡 Medium |
| Bootstrap | 4.5 | Bootstrap 5 has been out since 2021 | 🟢 Low |
| jQuery | 3.5 | Still works; UI library churn | 🟢 Low |

### Python 2 vs 3

`webapp/inkmonkweb/erp_integration/printo_integration.py:28` still imports `from urlparse import urlparse` — a Python 2 module. `requirements.txt` has Py3 fences (`mysqlclient<2.0; python_version < "3"`), so the build straddles both. **`[UNVERIFIED]`** which interpreter actually serves prod traffic — most likely Py3 with a `urlparse → urllib.parse` shim, but not confirmed.

## What works well

- **CI/CD discipline.** 8 prod-/staging-/alpha-/test-workflow files in webapp; 8 in printo-nextjs. SonarQube wired. PM2 deploy config. The team clearly knows how to deploy.
- **Observability.** Three APM tools simultaneously (Sentry + NewRelic + Elastic-APM). Mostly redundant but generous.
- **Search migration.** Moving from Algolia to Typesense to cut SaaS spend — sensible direction.
- **Recent activity.** Both repos have commits within the last week — the platform is actively maintained even if the foundations are old.

## What needs immediate attention

1. **Flask 1.x → 3.x or replace.** No security patches since 2019; one Werkzeug RCE = production fire drill with no patch path.
2. **Flask-Security 3.0.0 → flask-security-too**. Abandoned upstream; this is the auth library — you cannot leave this on an unmaintained codebase.
3. **Custom Express server in `printo-nextjs/server.js`.** Blocks Next.js 13/14/15 upgrade. Replace with Next.js native API routes + middleware.
4. **3,108 Alembic versions.** Compact periodically (squash + reset baseline) to keep `db upgrade` runtime sane.
5. **Hardcoded Zoho webhook tokens in client JS.** `static/clients/DesignResourceManager/.../*.js:132` — anyone who views source can read these. Move to server-side proxy.
6. **`PlatformUser` mixing buyer + seller + ops.** Auth extraction to a unified identity service is impossible until this is split.

## Files read

- `webapp/CLAUDE.md`
- `printo-nextjs/package.json`
- `webapp/requirements.txt`
- `webapp/Dockerfile`, `docker-compose.yml`
- `webapp/wsgi.py`, `app.py`
- `webapp/inkmonkweb/app_factory.py`
- `webapp/inkmonkweb/views/market_api.py` (lines 1-120, 1190-1290, 1425-1545, 2110-2230)
- `webapp/inkmonkweb/models/cart.py`, `payment.py`
- `webapp/inkmonkweb/erp_integration/printo_integration.py` (header)
- `webapp/inkmonkweb/celeryconfig.py`
- `printo-nextjs/next.config.js`, `server.js`
