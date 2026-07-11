# Open Questions

Everything in this audit marked `[UNVERIFIED]` lands here. Resolving these tightens the roadmap; some block specific phases.

## High-impact (blocking)

### 1. Where is the Estimator source?

- **Symptom:** the system at `cs.printo.in` (referenced in `webapp/inkmonkweb/erp_integration/printo_integration.py:33-35`) is a PHP service that receives `api_create_session.php` calls, but the source isn't in `/Users/kannaperumal/Code/`.
- **Why it matters:** Phase 4 of the migration roadmap depends on understanding it. Walk-in retail flow, GST e-invoicing, and inventory write-path all live there.
- **Action:** locate the repo. Likely candidates: a separate GitLab/GitHub org, a server-only deploy with no local clone, or a discontinued repo. Ask the Estimator team.

### 2. Does Printose prod actually run with `DEBUG=True`?

- **Symptom:** committed `apiserver/settings.py:29` has `DEBUG = True` and `:31` has `ALLOWED_HOSTS = ["*"]`. There's no `.env` machinery in the deploy script.
- **Why it matters:** if prod uses these defaults, every error page leaks PII + stack traces; host-header attacks become possible.
- **Action:** SSH to `se.printo.in`, inspect the running process's env / `localsettings.py`. Confirm or deny in 10 minutes.

### 3. How is Python 2 vs Python 3 actually deployed in Printo.in?

- **Symptom:** `webapp/inkmonkweb/erp_integration/printo_integration.py:28` uses `from urlparse import urlparse` (Python 2). `webapp/requirements.txt` has Py3 fences. `Dockerfile` doesn't pin a Python image version explicitly (`Dockerfile:1-3` uses Ubuntu 18.04 system pip).
- **Why it matters:** if Py2 is actually running anywhere, the upgrade path is much harder.
- **Action:** SSH to a webapp container, run `python --version` and check whether `urlparse` import succeeds.

### 4. Walk-in customer record creation — where does it live?

- **Symptom:** Trace D in `04-diagrams-current.md` (walk-in retail) is mostly unverified. We don't know if walk-in customers go into `Printo.in.PlatformUser`, into Estimator's own DB, or both.
- **Why it matters:** Customer service backfill in Phase 1 of the roadmap can't be planned without knowing.
- **Action:** depends on resolving #1.

### 5. GST e-invoicing — which system generates IRNs?

- **Symptom:** `gst_percent` exists on Printose `wallet/Item`, but no IRN, e-invoice, or HSN code generation in any inspected repo.
- **Why it matters:** B2B orders > ₹500cr aggregate turnover trigger mandatory e-invoicing under GST law. Printo crosses this threshold.
- **Action:** locate the IRN-generating code. Likely in Estimator. If not present anywhere, this is a regulatory gap.

## Medium-impact (clarify before Phase 1)

### 6. Are Printose's `printose` and `printose_admin_ui` deployed to separate URLs?

- **Symptom:** `printose_admin_ui` has its own GitLab CI, but the deploy target is unclear from the script.
- **Action:** ask the Printose team or check DNS for `admin.se.printo.in`.

### 7. Does Printo.in have a mobile app?

- **Symptom:** OneSignal SDK is wired (`OneSignalSDKWorker.js`), which is web-push. No iOS/Android repo found at `/Users/kannaperumal/Code/`.
- **Why it matters:** target architecture mentions "BFF per channel — web, mobile, POS"; if there's no mobile app, that's one less BFF to plan.

### 8. PIA — what stack is it?

- **Symptom:** referenced as `pia.printo.in/api/v1/auth/` and `…/deliveryq/request-bulk/delivery/`. No source seen.
- **Why it matters:** PIA is the integration backbone; modernising it is implicit in the target architecture but not scoped here.
- **Action:** add PIA to the next audit cycle.

### 9. How much of `static/clients/MarketV2` (legacy React SPA) is still live?

- **Symptom:** Printo.in has both `printo-nextjs` (modern) and 6 in-repo legacy React SPAs. Routes like `/cart` and `/checkout` exist in both.
- **Why it matters:** decommissioning order in Phase 3.
- **Action:** read web server access logs for 7 days to see which paths actually serve from each.

### 10. What's the ratio of online to retail revenue?

- **Symptom:** business context, not in code.
- **Why it matters:** roadmap phasing — if retail is 80% of revenue, Phase 4 becomes priority 1 instead of priority 4.

### 11. What's the `DesignResourceManager` SPA actually used for?

- **Symptom:** lives at `webapp/inkmonkweb/static/clients/DesignResourceManager/`, has 4 hardcoded Zoho webhook URLs (`*.js:132`).
- **Why it matters:** security risk #17 in the gap register.
- **Action:** ask if it's still in use; if yes, refactor; if no, delete.

### 12. Is the Estimator integration retry-equipped?

- **Symptom:** `printo_integration.py` lacks visible retry/backoff in the read I did.
- **Why it matters:** risk #15 in the gap register.
- **Action:** read the full file end-to-end, plus the Celery task definitions that wrap it.

## Low-impact (note, don't block)

### 13. Why two parallel React frontends in Printo.in?

- **Symptom:** see #9. The presence is observed; the *reason* (historical migration mid-flight) is plausible but unconfirmed.

### 14. Why is `printose_admin_ui` on Argon Dashboard template?

- **Symptom:** `package.json:53` references `argon-dashboard-pro-react`. Pinned commercial template.
- **Action:** licence audit; confirm the team has the right licence.

### 15. What does "se" stand for in Printose / `se.printo.in`?

- **Plausible:** "swag enabler", "sales enabler", "soft estimate", "service enablement". `[UNVERIFIED]`.

### 16. Why are `accounts/` views in Printose not wired through `urls.py`?

- **Symptom:** Printose has `accounts/views.py` but `apiserver/urls.py:38-43` doesn't include it.
- **Likely explanation:** dead code from a feature that was moved to `gifting/`. Confirm before relying on routing assumptions.

### 17. Is RabbitMQ in Printo.in clustered?

- **Symptom:** `celeryconfig.py:6 amqp://guest:guest@localhost:5672//` is a localhost reference with default credentials.
- **Action:** in production, almost certainly overridden by env. Confirm.

### 18. Are 3,108 Alembic versions on Printo.in slowing CI?

- **Symptom:** observation; no measured timing.
- **Action:** measure `flask db upgrade` time on a fresh DB. If > 5 min, schedule a baseline-reset.

### 19. Does Printo.in's Celery actually use `gevent` or `prefork`?

- **Symptom:** not stated in `celeryconfig.py:6`. Concurrency model affects task throughput.
- **Action:** check the supervisor / systemd file.

### 20. What are Printo.in's actual SLOs / SLAs today?

- **Symptom:** business context, not in code.
- **Why it matters:** target architecture should preserve or improve them.

## Open questions about the audit itself

### 21. Is `printopro/` a relevant 6th system?

- **Symptom:** `/Users/kannaperumal/Code/printopro/` exists. Has `Dockerfile`, `Jenkinsfile`, `docker-compose.yml`. Not yet audited.
- **Action:** quick once-over to determine whether it's a Printo system, internal tooling, or an old prototype.

### 22. Is `printo-imagine/` relevant?

- **Symptom:** `/Users/kannaperumal/Code/printo-imagine/` exists. Mentioned in user-memory as a sibling repo.
- **Action:** same — read the README, decide whether to add to the audit.

### 23. What was the Printo.in `feat/per-job-review-collection` branch about?

- **Symptom:** observed during agent discovery — current branch in active dev.
- **Action:** read commit messages; understand what's in flight.

### 24. Compose vs Kubernetes?

- **Symptom:** Product Editor uses docker-compose. Other systems unclear from inspected files.
- **Action:** confirm production deployment topology; the migration plan assumes ArgoCD + k8s for new services, which may be a leap from current ops practice.

## Summary

We have **24 open questions**. **5 are blocking** (1, 2, 3, 4, 5) — they block the migration roadmap and should be resolved in the first 2 weeks. The rest can be answered in parallel as the migration unfolds.

The single most actionable open question — and the cheapest to resolve — is **#2** (Printose `DEBUG=True` in prod?). 10 minutes of SSH work, potentially uncovers a critical security gap.
