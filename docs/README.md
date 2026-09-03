# Product Editor — documentation index

**Last reviewed: 2026-08-14** (`main` @ `79104d0`, migration `0014`).

The single most useful thing to know about this folder: **most of it is not
current-state reference.** Two files describe how the system behaves today; four
are shipped-feature design records kept for the *why*; two are unstarted plans;
one is an audit of other systems. Reading a shipped PRD as if it were
documentation is the main way to get a wrong answer here.

**For how the system works right now, read [`../CLAUDE.md`](../CLAUDE.md), not
this folder.** It is the maintained architectural reference and wins over
anything below on any disagreement.

**Every project doc lives here** (consolidated 2026-09-04). Four markdown files
remain outside on purpose, and none of them are project documentation:
`../CLAUDE.md`, `../AGENTS.md` and `../README.md` must sit at the repo root for
the tooling and for GitHub to find them, and
`../backend/django/api/static/scalar/README.md` is provenance for a vendored
third-party bundle — it belongs beside the bundle it describes. If you add a
doc, add it here and give it a row below.

## Current — safe to act on

| Doc | What it is |
|---|---|
| [`INTEGRATION.md`](INTEGRATION.md) | **The one doc with an external audience.** Drop-in webhook handler for printo.in's storefront team (Node + Python), the payload contract, HMAC verification, and the four download URLs. Source of truth is `notify_caller_webhook_task`; if they disagree, the task wins. |
| [`DATA_LIFECYCLE.md`](DATA_LIFECYCLE.md) | What personal data is stored, where, and how it is deleted. The DPDP answer sheet — retention clock, the erasure endpoint, audit-trail retention, and the two gaps still open. |
| [`AI_GUARDRAILS.md`](AI_GUARDRAILS.md) | Short list of rules that exist because breaking them has already cost us something. Companion to CLAUDE.md, not a replacement. |
| [`LOAD_BASELINE.md`](LOAD_BASELINE.md) | Append-only log of web-tier load measurements. Add runs, never edit old ones. |
| [`BUNDLED_FONTS.md`](BUNDLED_FONTS.md) | What the server-side renderer's bundled `.ttf` files are and how to add one. Moved here 2026-09-04 from `backend/django/services/fonts_assets/README.md`; the fonts themselves still live there. |
| [`CALENDAR_S3_READINESS.md`](CALENDAR_S3_READINESS.md) | Audit of calendar storage paths for a future move off local disk — all env-driven, no hardcoded local paths. Moved here 2026-09-04 from `backend/django/services/`. |

## Shipped — historical design records

Retained for the reasoning, not the requirements. Where these disagree with the
code, **the code is right**.

| Doc | Status |
|---|---|
| [`PRD.md`](PRD.md) | The business/product PRD — problem statement, TAT targets, success metrics, and the rollout decision framework. Now at v1.13. **§8.0 is the live open-items list**; §8.1 and §8.2 are history and are not re-verified per revision. |
| [`CALENDAR_FEATURE_PRD.md`](CALENDAR_FEATURE_PRD.md) | ✅ Shipped (foundation v1.12, calendar v1.13). Two things shipped differently from the proposal — flat ISO-date cell map instead of 12-slot arrays, and a 12-month photo cap — both flagged at the top of the file. For working on calendars, read CLAUDE.md → "Calendar product type (v1.13)". |
| [`DPDP_ERASURE_GAP_PRD.md`](DPDP_ERASURE_GAP_PRD.md) | ✅ Closed 2026-07-26 (migration `0011`). Worth reading anyway: §7 records why a "delete rows with blank `order_id`" cleanup would destroy valid uploads, and the failure mode where erasure reported success while 6.4 GB of photos stayed on disk. |

## Not started — plans

| Doc | Status |
|---|---|
| [`API_SURFACE_SEPARATION_PRD.md`](API_SURFACE_SEPARATION_PRD.md) | 🟡 Open, not started; re-verified 2026-08-14. Its **Core Product Invariant** section *is* current policy regardless — dashboard and embed access must render byte-equivalent output — and is restated in CLAUDE.md as the "access-mode invariant". |
| [`BOOK_LAYOUT_PRD.md`](BOOK_LAYOUT_PRD.md) | 🔵 Draft, unscheduled, nothing built. Covers any bound page-ordered product (photobook, booklet, brochure), not just photobooks. Updated 2026-08-14: **D2, D2a and D4 answered** (customer-entered page count auto-populates inner pages; author one cover + one inner-page template; covers sit outside the count). **D1, D3, D5, D6 and the new D7** (cover and inner pages may differ in size) still open. |

## Adjacent

| Doc | Notes |
|---|---|
| [`printo-architecture-audit/`](printo-architecture-audit/) | 12-part May 2026 audit of the **wider Printo estate** — the Flask storefront, Printose, the PHP Estimator, PIA — not this repo. Start at [`00-executive-summary.md`](printo-architecture-audit/00-executive-summary.md). Ages independently of this codebase and cannot be verified from here, since those repos aren't in this checkout; its Product Editor references are pinned at v1.10. |

## Conventions

- **Give every doc a status line.** A PRD with no status gets read as a
  description of the present, which is how `CALENDAR_FEATURE_PRD.md` spent a
  month claiming "Proposal" for a shipped feature.
- **Don't rewrite history to match the present.** Mark it superseded and say what
  replaced it. Version-history tables and completed action items are an audit
  trail; the correction belongs in a new row.
- **Name the source of truth** when a doc restates something the code enforces,
  and say explicitly that the code wins.
- Docs are not in CI. Nothing checks these claims, so re-verify against the code
  before relying on a number — and update the "last reviewed" line when you do.
