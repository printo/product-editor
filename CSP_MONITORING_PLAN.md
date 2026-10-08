# CSP enforcement plan

**Status: report-only.** Violations are reported to `/api/csp-report` but nothing is blocked. The one directive already enforced is `frame-ancestors` on `/editor/layout/*`, which limits who may embed the editor. The current state and the next step are in [CLAUDE.md](CLAUDE.md) under "Open follow-ups".

> This file first said enforcement was "production-ready" (2026-09-10). It was not. That test run missed that Google Fonts were blocked (fixed 2026-09-29, PR #168), and the switch it described flipped only one of the policy's two halves. Corrected 2026-10-08.

## Two halves, one flag

The same policy is emitted by two separate apps, and `CSP_REPORT_ONLY` has to reach both:

| Half | Serves | Where | When the flag is read |
|---|---|---|---|
| Django (django-csp) | API/JSON responses and the Scalar docs page (`/docs/api/`) | `CSP_*` in `backend/django/product_editor/settings.py` | at runtime |
| Next.js | every page, including the customer editor and the embed iframe | `headers()` in `frontend/nextjs/next.config.mjs` | **at image build time** (docker-compose passes it as a build arg) |

Change a directive in both files. The policy needs `'unsafe-eval'` for Fabric.js, and Google's domains for the `/login` sign-in and the web fonts.

## Where violations show up

The browser POSTs each report to `/api/csp-report` (`CSPReportView`). It writes a `CSP violation: directive=… blocked=…` warning to the backend log and sends a Sentry message. **Sentry is the history**: the backend log is lost whenever the container is recreated, which every `./deploy.sh` does.

`GET /api/celery/monitor/` does not carry CSP reports. An earlier version of this plan checked it and recorded "no violations"; that check could not have found any.

## Before flipping to enforcement

- Exercise every page enforcement would affect, in a browser with the console open: the editor with an embed token (upload a photo, edit on the canvas, submit), the embed inside an iframe on an allowed origin, the dashboard, `/editor/layouts` and the calendar and book ops editors, `/login` including "Sign in with Google", and `/docs/api/`.
- Search Sentry for CSP violation messages and let a few quiet days of real traffic go by. A short manual pass is not proof: the 2026-09-10 one found nothing while Google Fonts were being blocked.

## Flipping it

1. Set `CSP_REPORT_ONLY=False` in the production `.env` (back it up first, as for any `.env` edit; see "Deployment" in CLAUDE.md).
2. Run `./deploy.sh`. It rebuilds the frontend image, which is what carries the flag into the page headers. `docker-compose up -d` or a backend restart flips the Django half only and leaves the editor pages in report-only.
3. Check both halves. The header name should now be `Content-Security-Policy`, not `Content-Security-Policy-Report-Only`:
   ```bash
   curl -sI https://product-editor.printo.in/login | grep -i security-policy
   curl -sI https://product-editor.printo.in/api/config | grep -i security-policy
   ```
4. Watch Sentry. To roll back, set the flag to `True` and run `./deploy.sh` again.

## History: the 2026-09-10 test run

Run against the local stack in report-only mode: Django's headers present on `/api/config` and `/api/embed/session/validate`, the Next.js headers present on `/editor/layout/[name]`, the Fabric.js canvas rendering, the embed iframe loading under `frame-ancestors`, the `pe:render_job` message arriving, and the dashboard and ops pages loading, all with no console violations. It did not exercise Google Fonts.
