# Gap & Risk Analysis

Severity legend: 🔴 Critical (act now) · 🟠 High (act this quarter) · 🟡 Medium (act this year) · 🟢 Low (track, don't block).

## Risk register

| # | Area | Current State | Risk / Gap | Severity | Business Impact |
|---|---|---|---|---|---|
| 1 | **Security — auth** | Printose ships a hardcoded `SECRET_KEY` (`apiserver/settings.py:24`) used as the JWT signing key. Anyone with repo read access can mint admin JWTs. | Full auth bypass. | 🔴 | Customer data exposure, possible regulatory incident |
| 2 | **Security — debug** | Printose ships `DEBUG = True` and `ALLOWED_HOSTS = ["*"]` in committed `settings.py`. | If prod uses these defaults: stack traces and PII leak in error pages; host-header attacks. `[UNVERIFIED]` whether prod overrides. | 🔴 | PII exposure |
| 3 | **EOL infrastructure — Flask** | Flask 1.0.2 + Werkzeug 0.15.1, no security patches since 2019 | Next Werkzeug RCE = no fix path. | 🔴 | Site down with no remediation |
| 4 | **EOL infrastructure — Django** | Django 2.2.18 EOL April 2022; Python 3.8 EOL October 2024; Postgres 11 image EOL November 2023 (Printose) | Same — no upstream patches | 🔴 | Same |
| 5 | **EOL — abandoned auth lib** | Flask-Security 3.0.0 (`webapp/requirements.txt:4`) is **abandoned upstream**; replacement is `flask-security-too` | Cannot apply auth-related security fixes | 🔴 | Auth vulnerability with no fix |
| 6 | **Data residency / DPDP** | S3 bucket `s3-ap-southeast-1.amazonaws.com/inkmonk-files` is **Singapore**, not Mumbai (`webapp/inkmonkweb/default_config.py:320`) | DPDP Act 2023 cross-border transfer rules apply; documentation/consent obligations not visible in code | 🔴 | Regulatory risk |
| 7 | **No unified customer record** | Printo.in `PlatformUser`, Printose `accounts.User`, PE delegates to PIA — no FK, no ID match | No CLV/LTV; cross-channel retention impossible; DPDP "right to delete" hard | 🟠 | Marketing blind spot, regulatory risk |
| 8 | **No unified product catalog** | Printo.in 15+ catalog tables; Printose has its own `Product`/`ProductOptions` (`gifting/models.py:190, 256`); Estimator presumably yet another | Product changes need duplicating; pricing drift possible | 🟠 | Customer-facing pricing inconsistency |
| 9 | **No unified inventory** | Inventory presumably in Estimator. Printo.in's PDP cannot show real-time stock | Customer orders go through, inventory turns out to be zero, order cancelled or delayed | 🟠 | Cancellation revenue loss |
| 10 | **God-class monolith** | `models/job/__init__.py` 1,981 LOC; `views/market_api.py` 2,738; `views/core_pages.py` 2,268; `tasks.py` 1,889 | Hard to test, slow to change. Velocity decay over time. | 🟠 | Slow feature delivery |
| 11 | **Single-table-for-all-actors** | Printo.in `PlatformUser` mixes buyers + sellers + ops in one row | Auth extraction blocked until split; row-level access risk | 🟠 | Privilege confusion |
| 12 | **Tests near zero on Printose** | `accounts/tests.py` and `wallet/tests.py` are 3-line scaffolds. No frontend tests. CI runs no tests. | Every deploy is uncertain; refactors are dangerous | 🟠 | Production incidents |
| 13 | **152 + 3,108 migrations** | Printose `gifting/` has 152; Printo.in has 3,108 Alembic versions | New env bring-up takes minutes; baseline reset overdue | 🟡 | Slow CI, slow onboarding |
| 14 | **Custom Express server in Next.js** | `printo-nextjs/server.js` blocks Next 13/14/15 upgrade | Stuck on Next 12 | 🟡 | Slower TTI than necessary; React 17 limitations |
| 15 | **Estimator integration: no retry visible** | `printo_integration.py` lacks visible retry/backoff. Sync HTTP from Celery task | Estimator outage = silent stall in store-pickup orders | 🟠 | Store-pickup TAT misses |
| 16 | **Two parallel buyer UIs in Printo.in** | `printo-nextjs/` modern + `static/clients/MarketV2/` legacy SPA — both have `/cart` and `/checkout` | Duplicate code paths, drift between them, A/B-test fragility | 🟡 | Duplicate maintenance |
| 17 | **Hardcoded Zoho tokens client-side** | `static/clients/DesignResourceManager/.../*.js:132` has 4 hardcoded `flow.zoho.com` webhook URLs with API tokens | Browser-readable; rotation requires deploy | 🟠 | Token leak |
| 18 | **Cache-as-broker conflict (pre-v1.10)** | Was: cache + broker on same Redis db with `allkeys-lru`; Product Editor v1.10 fixed this with split (cache→db1, broker→db0) | Other services (`[UNVERIFIED]` Printo.in, Printose) likely have the same conflict | 🟡 | Lost task messages under cache pressure |
| 19 | **Three APMs simultaneously** | Sentry + NewRelic + Elastic-APM all enabled in Printo.in | Triple SaaS spend, alert fatigue | 🟢 | Cost waste |
| 20 | **Unbounded Docker logs (until v1.10)** | Default json-file driver, no rotation. Product Editor fixed this with `x-default-logging` 50 MB × 3 in v1.10. | Other repos `[UNVERIFIED]` | 🟡 | Disk fills, log loss |
| 21 | **No event bus** | All cross-system communication is point-to-point HTTP | New consumer = N callers to change | 🟡 | Slow integration delivery |
| 22 | **GST e-invoicing — opaque** | `gst_percent` exists on Printose `Item`; no IRN, no e-invoice generation in any inspected repo | Estimator presumably handles; for online B2B GST orders this is `[UNVERIFIED]` | 🟠 | Regulatory risk for B2B |
| 23 | **Search dual-mode** | Printo.in mid-migration from Algolia → Typesense; both registered in `app_factory.py:30` | Cost during overlap; correctness drift | 🟡 | SaaS cost |
| 24 | **PII in 4+ datastores** | Printo.in MySQL + Printose Postgres + S3 + cookies + `flask-kvsession`; no documented inventory | DPDP Act response (deletion / portability) requires manual joins across systems | 🟠 | Regulatory risk |
| 25 | **No CI test gate on Printose** | `printo_se_api/.gitlab-ci.yml:9-30` SSHes in, `git pull`, `migrate`, `systemctl restart`. **No test step, no migration safety.** | Bad migration = production breakage | 🟠 | Reliability |
| 26 | **`/api/search` is a stub** | Printo.in `market_api.py:2116` returns 2 hardcoded items. Comment + zombie. | Silent feature absence | 🟢 | Customer-facing quality |
| 27 | **Python 2 vestiges in Printo.in** | `from urlparse import urlparse` in `erp_integration/printo_integration.py:28` | Build straddles Py2/Py3 | 🟡 | Upgrade friction |
| 28 | **Estimator source not in scope** | We could not read `cs.printo.in` PHP code | Cannot audit walk-in flow, GST flow, inventory model | 🟠 | Audit incompleteness |
| 29 | **Storefront → Product Editor webhook handler not yet built** | `PRD.md:33` action item — Printo.in storefront team needs to add `POST /api/internal/pe-callback` | Until built, embed orders use polling (works but suboptimal UX) | 🟢 | Feature parity |
| 30 | **Zero observability across system boundaries** | Each system has its own APM. No distributed tracing across the 5 systems. A slow store-pickup order takes a half-day to debug. | High MTTR | 🟠 | Customer-facing TAT |

## Risk by category

### Security (🔴 dominant)

The biggest, most-actionable risks are security:
- Hardcoded JWT signing key in Printose's repo (#1) — **fix today**
- `DEBUG = True` and `ALLOWED_HOSTS = ["*"]` in committed defaults (#2)
- Flask 1.x and Flask-Security 3.0.0 — abandoned (#3, #5)
- Tokens leaking in client-side JS (#17)
- DPDP / data residency (#6, #24)

### Velocity (🟠)

- God classes in Printo.in (#10)
- Custom Express server blocking Next.js upgrades (#14)
- Near-zero tests on Printose (#12)
- 3,108 migrations to apply on every fresh env (#13)

### Reliability (🟠)

- No retry on Estimator integration (#15)
- No CI test gate on Printose (#25)
- No cross-system distributed tracing (#30)

### Strategic (🟠)

- No unified customer/product/order/inventory plane (#7, #8, #9)
- Walk-in retail completely outside the audit (#28)
- GST e-invoicing opaque (#22)

### Cost (🟢)

- Three APMs (#19)
- Algolia + Typesense overlap (#23)

## What to fix this week

1. **Rotate the Printose `SECRET_KEY`** and load it from env. Audit for similar hardcodes elsewhere.
2. **Confirm prod overrides for `DEBUG` / `ALLOWED_HOSTS` in Printose**; if prod actually uses `DEBUG=True`, fix immediately.
3. **Move Zoho webhook tokens out of client-side JS** in Printo.in DesignResourceManager.
4. **Add migration to Mumbai region S3** plan to the roadmap (DPDP).
5. **Inventory all PII-bearing tables** across the 5 systems (DPDP data-map).

## What to plan for this quarter

- Begin Foundation phase per `08-migration-roadmap.md`.
- Locate the Estimator source repo and add it to the audit.
- Pilot a unified Customer service behind an API gateway.
- Cap Docker log volumes on Printo.in and Printose (the v1.10 pattern).
- Split Printo.in's Redis (cache vs broker) — same v1.10 pattern.
