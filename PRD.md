# PRD: Product Editor — End-to-End Production Automation
## Printo.in Product & Tech Alignment Document

---

| Field | Details |
|---|---|
| **Document Owner** | Kanna |
| **Product Manager** | Kanna |
| **Business Lead** | Viji |
| **Production Lead** | Mohan |
| **Final Approver** | Manish |
| **Date** | April 4, 2026 |
| **Status** | *Draft — Awaiting Alignment* |
| **Version** | v1.3 |
| **Product URL** | product-editor.printo.in |

---

## 1. Executive Summary

Printo's internal production workflow for personalised photo products or single surface printable products currently requires **~1 hour per order** for store pickup and express delivery orders, and **2–3 hours per order** for standard delivery for print file preparations. Store pickup and express delivery receive first priority because they carry same-day or 4–6 hour delivery SLAs. Standard delivery orders are batched and shipped via courier by 3 PM daily.

The bottleneck is not image generation or print execution — it is the manual design preflight review that sits between a customer uploading files and production receiving the job. Every order today must pass through the design preflight team, who manually check file quality, verify that the number of uploaded files matches the ordered quantity, and flag mismatches, cx uploaded images quality issue back to the customer. When the customer is slow to respond, the order stalls — leading to delayed closures and, in the worst cases, cancellations.

**The Product Editor aims to eliminate this entire manual checkpoint. The target is under 5 minutes from file upload to production-ready output for a single order** — fully automated, zero human intervention. The customer uploads files, sees an accurate preview before checkout, and post-checkout the job is pushed directly to the estimator for production, the user just prints the file and move for post press then quality check and dispatches it.

This document defines the current-state problem, quantifies its business impact, describes the proposed automation solution, and lays out the decision framework for alignment.

---

## 2. Problem Statement

### 2.1 Current Production Workflow (As-Is)

Today, every personalised product order follows this sequential flow:

| # | Step | Actor | Method |
|---|---|---|---|
| 1 | Customer uploads design files | Customer | **Printo.in** and Inkmonk.com website |
| 2 | Design preflight team reviews files for print-readiness | Preflight team | Manual review |
| 3 | Preflight checks file count against ordered quantity | Preflight team | Manual count |
| 4 | If file issue or count mismatch → contact customer for correction | Preflight team | Email / phone |
| 5 | Wait for customer response (unbounded delay) | Customer | Passive wait |
| 6 | Files cleared → pushed to production estimator | Preflight team | Manual handoff |
| 7 | Production + dispatch | Production | Print workflow |

### 2.2 Observed Problems

- Store pickup and express delivery orders take ~1 hour each to clear preflight, despite having same-day / 4–6 hour delivery SLAs. Every minute of delay directly threatens the delivery promise.
- Standard delivery orders take 2–3 hours in preflight. Since the courier cutoff is 3 PM daily, late-cleared orders miss the dispatch window entirely and are delayed by a full day.
- File count mismatches (e.g., customer ordered 10 fridge magnets but uploaded 8 images), Cx expects digital preview or Cx upload image is of poor quality which causes the order to be placed on hold pending to customer response. Response times range from hours to days as it depends on cx response.
- Delayed preflight pushes orders into a backlog that compounds across the day, creating a cascading effect on TAT completing of that order and other subsequent orders.
- In the worst case, customers who are unreachable or frustrated by the back-and-forth simply cancel the order — resulting in lost revenue and a negative brand experience.
- The preflight team is a fixed-capacity bottleneck. As order volume grows, the team cannot scale linearly, making the manual process unsustainable.

### 2.3 Root Cause

The root cause is the manual design preflight checkpoint between customer upload and production. This checkpoint exists because the legacy system had no way for the customer to preview the final product or for the system to automatically validate file quality and quantity. Every order, regardless of complexity, passes through the same manual gate.

### 2.4 TAT Breakdown (Current vs Target)

| Order Type | Current TAT | Target TAT | Notes |
|---|---|---|---|
| Store Pickup | ~1 hour | < 5 min | Same-day SLA; highest priority |
| Express Delivery | ~1 hour | < 5 min | 4–6 hour delivery SLA |
| Standard Delivery | 2–3 hours | < 5 min | Courier cutoff 3 PM daily |

---

## 3. Business Impact

### 3.1 Customer Experience

- Customers placing store pickup or express delivery orders expect near-instant confirmation that their order is in production. A 1-hour delay between upload and production start erodes trust in the "express" promise.
- For standard delivery, the 3 PM courier cutoff means any order that clears preflight after 3 PM is automatically delayed by a full business day. Customers see longer delivery dates than necessary.
- File mismatch hold-ups create a frustrating back-and-forth experience. Customers who uploaded the wrong count do not understand why their order is stuck.
- Cancellations due to delayed preflight directly damage repeat purchase likelihood and brand perception.

### 3.2 Revenue & Conversion

- Every order that misses the 3 PM courier cutoff costs Printo a day of delivery speed — speed that competitors like Vistaprint and Printstop already advertise.
- Cancelled orders due to preflight delays are direct revenue loss. Even a 2–3% cancellation rate on a high-volume personalised products line represents significant monthly revenue impact.
- The preflight team's capacity ceiling means that during peak periods (festivals, corporate event seasons), order processing slows further, compounding missed shipments.

### 3.3 Operational Risk

- The preflight team is a single point of failure. If the team is understaffed (leave, attrition), the entire order pipeline stalls.
- Manual file validation is inherently inconsistent. Two different preflight operators may make different judgement calls on the same file, leading to quality inconsistency.
- As Printo scales order volume, the current process cannot keep pace without proportional headcount increases, making the unit economics of personalised products worse over time.

---

## 4. Proposed Solution

The Product Editor replaces the entire manual preflight checkpoint with an automated, customer-facing preview and validation system. The solution operates across two tracks: the immediate automation (what exists today) and the full end-to-end flow (the target state).

### 4.1 Solution Track A — Automated Preview & Validation (Built)

#### A1 — Customer-Facing Preview Before Checkout

- Customer uploads images into the Product Editor canvas, which is embedded directly in the Printo.in product page or order flow.
- The editor auto-generates a print-ready preview using the correct layout template for the product SKU. The customer sees exactly what will be printed — including frame positioning, bleed, and paper mask.
- File count validation is automatic: if the customer uploads fewer images than the layout requires, the editor visually shows empty frames. If more are uploaded, excess files are handled gracefully.
- No preflight operator is involved. The customer self-validates the output by approving the visual preview before proceeding to checkout.

#### A2 — Direct-to-Production Push (Post-Checkout)

- Once the customer completes checkout, the approved canvas data (images + layout + overlays) is pushed directly to the production estimator via the existing OMS integration API (Ops Manager).
- No manual handoff step. The production team receives a print-ready file that has already been validated by the customer's own preview approval.
- CMYK soft-proof export with ISOcoated_v2 ICC profile is available for products that require colour-accurate press output, eliminating a separate colour validation step.
- The target latency from checkout to production-ready is under 5 minutes for a single order — down from the current 1–3 hours.

### 4.2 Solution Track B — Remaining Gaps for Full Automation

#### B1 — Canvas State Persistence

- Currently the editor state is lost on page refresh. For the end-to-end flow to work, the customer's canvas must be persisted (either localStorage or backend JSON) so the approved design survives the checkout transition.
- Priority: P0 — blocks the direct-to-production push for any session that navigates away before checkout.

#### B2 — Async Image Generation Queue

- Synchronous image generation holds a Gunicorn worker thread for the duration of rendering. Under sustained load (e.g., festival peak), this causes timeouts.
- Celery + Redis async queue needed so that post-checkout generation is non-blocking and can handle concurrent orders at scale.
- Priority: P0 — blocks reliable operation at >50 concurrent orders.

#### B3 — SKU-to-Layout Mapping

- For the embed flow to work seamlessly on printo.in, each product SKU must auto-resolve to the correct layout template. Currently this mapping is manual.
- A product catalogue integration (via Catalog Manager or OMS) that maps SKU → layout is required for zero-touch automation.
- Priority: P1 — can be worked around with manual configuration initially.

---

## 5. Current vs Automated Flow Comparison

| Dimension | Current (Manual Preflight) | Automated (Product Editor) |
|---|---|---|
| File validation | Manual review by preflight team | Automatic — visual preview validates layout |
| Qty mismatch | Preflight contacts customer; order held | Editor shows empty frames; customer self-corrects before checkout |
| Time to production | 1–3 hours per order | < 5 minutes per order |
| Scalability | Linear with headcount | Scales with server capacity (horizontal) |
| Error rate | Inconsistent across operators | Deterministic — same input always produces same output |
| Customer experience | No preview; blind trust | Full preview before payment |
| Colour accuracy | No pre-checkout colour check | CMYK soft-proof with gamut warnings |
| Order hold risk | High — cx response delay | Eliminated — no post-checkout hold |
| Cancellation risk | Moderate — frustrated cx cancel | Minimal — cx approved before paying |

---

## 6. Recommended Path Forward

### Phase 1 — Immediate (0–2 weeks)

- Deploy Product Editor embed mode on printo.in for the top 5 personalised product SKUs (fridge magnets, photo prints, canvas prints, coasters, photo mugs).
- Enable customer-facing preview before checkout. This alone eliminates the file-quality and quantity-mismatch preflight steps.
- Keep the preflight team as a parallel safety net initially — they spot-check a random sample rather than reviewing 100% of orders.

### Phase 2 — Direct-to-Production (2–6 weeks)

- Implement canvas state persistence (backend JSON save) so approved designs survive the checkout flow.
- Build the post-checkout webhook that pushes the approved canvas directly to the production estimator.
- Implement Celery + Redis async queue for non-blocking image generation.
- Target: 100% of orders for enabled SKUs go directly to production with zero preflight involvement.

### Phase 3 — Full Catalogue Rollout (1–3 months)

- Extend SKU-to-layout mapping across the full personalised product catalogue.
- Retire the preflight team from the personalised products workflow entirely (reassign to quality auditing or new product onboarding).
- Implement S3/GCS cloud storage for horizontal scaling.

---

## 7. Decision & Alignment Framework

The following approvals are required before implementation proceeds:

| Stakeholder | Decision Required | Input Needed From Them |
|---|---|---|
| Kanna | Assess technical readiness of Product Editor for production embed; recommend rollout plan and effort estimate | Tech feasibility assessment, embed integration scope, infrastructure readiness review |
| Viji | Confirm which product SKUs to enable first; validate business case with conversion data from current preflight delays | SKU prioritisation, revenue impact data for delayed/cancelled orders, Catalog Manager integration scope |
| Mohan | Confirm production team readiness to receive orders directly from the automated system without preflight review | Production SLA per product category, quality check requirements, fallback process if automated output has issues |
| Manish | Final approval to proceed with phased rollout; sign off on preflight team transition plan | Consolidated recommendations from Kanna, Viji, and Mohan |

---

## 8. Next Steps & Action Items

| # | Action | Owner | Due By | Status |
|---|---|---|---|---|
| 1 | Validate embed integration on printo.in staging for top 5 SKUs | Kanna | Apr 11, 2026 | Open |
| 2 | Confirm SKU-to-layout mapping for fridge magnets, photo prints, canvas prints, coasters, mugs | Viji / Kanna | Apr 11, 2026 | Open |
| 3 | Production team readiness assessment — can they accept automated output without preflight? | Mohan | Apr 14, 2026 | Open |
| 4 | Implement canvas state persistence (backend JSON save) | Kanna | Apr 18, 2026 | Open |
| 5 | Build post-checkout → production estimator webhook | Kanna | Apr 25, 2026 | Pending |
| 6 | Celery + Redis async queue deployment | Kanna / DevOps | Apr 30, 2026 | Pending |
| 7 | Consolidate all inputs and schedule CEO alignment meeting | Kanna | May 2, 2026 | Pending |
| 8 | Manish to review and approve rollout plan | Manish | May 5, 2026 | Pending |

---

## 9. Open Questions

- Should the Product Editor embed completely replace the existing file upload flow on printo.in, or run in parallel (A/B test)?
- What is the fallback process if the automated output has a print-quality issue that preflight would have caught? Does production reject and notify, or does a post-print QC catch it?
- For products with variable quantity (e.g., customer orders 50 business cards but uploads 1 design), how should the editor handle the 1-to-many mapping?
- Is the production estimator API ready to accept the postMessage payload format that the Product Editor emits, or does an adapter need to be built?
- What SLA does production commit to for orders received via the automated pipeline vs the manual pipeline? Should they be identical?
- Can the Catalog Manager be extended to store the SKU-to-layout mapping, or does this need a new system?

---

## 10. Success Metrics (Post-Automation)

| Metric | Baseline (Current) | Target (Post-Fix) | How to Measure |
|---|---|---|---|
| Upload-to-production TAT (store pickup/express) | ~1 hour | < 5 min | OMS timestamp diff |
| Upload-to-production TAT (standard delivery) | 2–3 hours | < 5 min | OMS timestamp diff |
| Orders held due to file mismatch | TBD (estimate 10–15%) | < 1% | OMS hold report |
| Order cancellation rate (preflight-related) | TBD | < 0.5% | Zoho Desk + OMS |
| Preflight team hours per day on personalised products | TBD (full-time) | 0 hours (spot-check only) | Team capacity tracker |
| Orders meeting 3 PM courier cutoff | TBD | > 98% | Dispatch log |

---

*— End of Document —*
*For queries contact Kanna | Printo*
