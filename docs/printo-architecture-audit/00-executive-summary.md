# Executive Summary

**Audience:** Manish (final approver), CEO/Leadership · **Date:** May 6, 2026 · **Status:** Draft v1 — **not revised since**

> **Scope note (added 2026-08-14).** This 12-part audit covers the **wider Printo
> estate** — the Flask storefront, Printose, the PHP Estimator at `cs.printo.in`,
> PIA — and only touches Product Editor in passing. It lives in this repo for
> convenience, not because it describes this codebase.
>
> It therefore **cannot be re-verified from this checkout**: those systems aren't
> here. Treat every claim about them as a May 2026 observation, and re-confirm
> against the actual system before acting. The Product Editor references are
> pinned at v1.10 and are simply out of date — the product is at v1.13 and has
> since gained a calendar product type, server-side overlay rendering, colour
> management, an API audit trail, and split download URLs. None of that changes
> the audit's conclusions, which are about the *other* four systems.
>
> The recommendation below (extract one bounded context behind a gateway, run it
> dual-mode, migrate the storefront over 12–18 months) has **not** been actioned
> as far as this repo can tell.

## TL;DR

Printo runs five distinct systems across two channels. Three of them are old, two are new. The two newest (Product Editor v1.10, PIA) are healthy. The flagship — **Printo.in (Flask 1.0.2 + Next.js 12)** — is **functionally healthy but technically EOL** at every infrastructure layer: Flask 1.x, Werkzeug 0.15, Boto 2.x, Ubuntu 18.04 base image, Node 11. The "Printose" repo is **not the in-store POS** as originally scoped — it is a corporate-gifting / SWAG fulfillment platform built on Django 2.2 (also EOL). The actual in-store retail POS — the system Printo calls "Estimator" — is a **legacy PHP service at `cs.printo.in`** whose source was not in scope; we know it only by its API surface (`api_create_session.php`).

There is **no shared customer/product/order/inventory plane** across these systems. Each has its own database; cross-system sync is point-to-point and brittle.

**Recommendation:** stop bolting features onto the Flask 1.x monolith; extract one bounded context behind an API gateway, run it dual-mode against both legacy systems, and use that bridge to migrate the storefront to a modern commerce engine over 12–18 months. Concrete plan in `08-migration-roadmap.md`.

## The five Printo systems

| # | System | Role | Stack | Health |
|---|---|---|---|---|
| 1 | **Printo.in** | Public e-commerce + ops back-office | Flask 1.0.2 monolith + Next.js 12.3.4 storefront | 🔴 **Critical** — every layer EOL |
| 2 | **Printose** *(corporate-gifting, NOT POS)* | B2B SWAG / per-recipient gift selection | Django 2.2.18 + 2× Next.js 10 | 🔴 **High risk** — Django 2.2 EOL April 2022 |
| 3 | **Estimator** *(real in-store POS)* | In-store quoting + order-creation | PHP service at `cs.printo.in` | ⚪ **Out of scope for this audit** — source not in inspected repos |
| 4 | **PIA** | Internal auth + delivery dispatcher | Unknown stack — known only by API surface | ⚪ **Black-boxed** — central but undocumented here |
| 5 | **Product Editor** *(this repo)* | Print-file generator (300 DPI, async) | Next.js 16 + Django 5 + Celery | 🟢 **Healthy** — v1.10 May 6, 2026 |

## The five biggest risks

| # | Risk | Likelihood | Business impact |
|---|---|---|---|
| 1 | Flask 1.0.2 + Werkzeug 0.15 in production. **No upstream security patches since 2019.** A new Werkzeug RCE = no fix path. | Certain over time | Very High — site down, PII exposure |
| 2 | Hardcoded `SECRET_KEY` for JWT signing in **Printose's `apiserver/settings.py:24`** (committed to git). Anyone with repo read access can mint admin JWTs. | Certain | Very High — full auth bypass |
| 3 | No unified customer record. A Printo.in buyer placing a corporate gifting order on Printose is a different person to the system. **No CLV/LTV view exists.** | Certain | High — revenue/marketing blind spots |
| 4 | Order routing for **store-pickup** is not traceable end-to-end. Cart → Estimator handoff goes through `printo_integration.py` calling `cs.printo.in` PHP endpoints; a breakage here delays every store-pickup order. | Certain over time | High — TAT misses, customer cancellations |
| 5 | DPDP Act 2023 compliance: no documented data inventory across the five systems; PII spread across Flask MySQL + Django Postgres + S3 buckets in **Singapore** (`ap-southeast-1`, not Mumbai). | Currently non-compliant | Regulatory + brand |

## What's working

- **Product Editor v1.10** is the cleanest system in the portfolio — fully containerised, tested, observability hooks (gunicorn metrics, Celery queue stats, Cloudflare WAF), TypeScript strict, recent perf hardening (Redis split, log rotation, Service Worker, smartcrop cache, cover-mode bug fixed). It is the **template** for what new Printo services should look like.
- **PIA is the de-facto integration backbone**. Both Printose and Product Editor authenticate against `pia.printo.in/api/v1/auth/`. Printose dispatches deliveries through `pia.printo.in/api/v1/deliveryq/request-bulk/delivery/`. **PIA is the right place to host the eventual unified identity / fulfillment service** — but it is currently un-audited from a code perspective (source repo not inspected).
- **CI/CD exists** on Printo.in (8 GitHub Actions workflows) and Printose (GitLab CI). Velocity is real — `webapp` has 40,487 commits, recent activity through April 2026.

## What we recommend (board-level)

1. **Foundation phase (4 weeks, ~₹0 incremental cost):** add observability + secret rotation + dependency-freshness reporting across all 5 systems. No customer-visible change.
2. **Bridge phase (3 months):** extract a unified Customer service behind an API gateway. Printo.in, Printose, and Product Editor all read from it; legacy customer tables become write-only mirrors. SaaS pick: **Auth0** (Mumbai region) for identity, **Segment** for the customer 360.
3. **Storefront modernisation (6 months, parallel):** new Next.js 15 storefront on **Saleor** or **Medusa.js** behind a feature flag (GrowthBook). 5% → 25% → 100% traffic over the quarter. Saves ~12 months vs. rewriting the Flask monolith in place.
4. **POS modernisation (6 months, parallel):** pilot **Shopify POS** at one store. Estimator's `api_create_session.php` becomes a translation layer. Saves an estimated 6 months of build effort vs. custom POS at ~₹2.5K/store/month.
5. **Decommission (3 months):** retire the Flask monolith and Estimator PHP backend.

**Total runway: 12–18 months. Total cost: estimated ₹40–60L in SaaS subscriptions over the period (Auth0 + Segment + GrowthBook + Shopify POS) plus existing engineering capacity. The cost of *not* doing it is unbounded — first Werkzeug RCE = production fire drill with no patch path.**

## How to read this document

| File | Use it when… |
|---|---|
| `01-current-state-printo-in.md` | You need to know what's actually running today on the storefront |
| `02-current-state-estimator.md` | You need to know what Printose vs. real-Estimator do today |
| `03-cross-system-analysis.md` | You need to see how the systems integrate (or don't) |
| `04-diagrams-current.md` | You need pictures (C4, sequence, ER) — Mermaid, copy-pasteable |
| `05-gaps-and-risks.md` | You need a prioritised risk register |
| `06-target-architecture.md` | You need the proposed end-state stack |
| `07-diagrams-target.md` | You need the end-state pictures |
| `08-migration-roadmap.md` | You need the strangler-fig phasing with effort estimates |
| `09-open-questions.md` | You want to know what we couldn't verify |
| `10-appendix-api-inventory.md` | You need a per-endpoint reference |
| `11-appendix-data-model.md` | You need the cross-system ER picture |

— *End of summary —*
