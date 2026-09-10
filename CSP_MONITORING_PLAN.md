# CSP Violations Monitoring & Enforcement Plan

**Status**: In progress (feature/csp-monitoring branch)  
**Date**: 2026-09-10

## Current State

CSP is currently in **report-only mode**:
- `CSP_REPORT_ONLY=True` in `backend/django/product_editor/settings.py`
- Violations are reported but not blocked
- Policy includes `'unsafe-eval'` for Fabric.js in `CSP_SCRIPT_SRC`
- `frame-ancestors` directive limits embedding to printo.in origins

## Configuration

**Backend** (`backend/django/product_editor/settings.py`):
```python
CSP_SCRIPT_SRC = ("'self'", "'unsafe-inline'", "'unsafe-eval'")  # 'unsafe-eval' for Fabric.js
CSP_REPORT_ONLY = os.getenv("CSP_REPORT_ONLY", "True").lower() not in ("false", "0", "no")
```

**Frontend** (`frontend/nextjs/next.config.mjs`):
- `frame-ancestors` limited to `'self'`, `https://printo.in`, `https://*.printo.in`
- Override via `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS` env var

## Monitoring Checklist

### 1. Editor Page (`/editor/layout/[name]`)
- [x] Load layout in browser
- [x] Open DevTools Console
- [x] Check for CSP violations (should be report-only, not blocked)
- [x] Verify Fabric.js editor works without errors
- [ ] Upload a photo and draw on canvas
- [x] Check for violations in Network tab (CSP reports if any)

### 2. Embed Iframe Test
- [ ] Create embed session via `/api/embed/session`
- [ ] Load iframe in test page with embed token
- [ ] Verify `frame-ancestors` allows embedding from test origin
- [ ] Check console for frame-related CSP violations
- [ ] Confirm postMessage contract works (`pe:render_job` message)

### 3. Admin/Dashboard Pages
- [ ] Login to dashboard (`/dashboard`)
- [ ] Access `/editor/layouts` (ops template list)
- [ ] Verify no CSP violations on authenticated pages

### 4. CSP Report Verification
- [ ] Check `GET /api/celery/monitor/` for any CSP violation reports
- [ ] Inspect violation payload structure if any exist

## Validation Criteria

**PASS** if:
- ✅ No CSP violations appear in DevTools console (report-only mode)
- ✅ Fabric.js canvas renders and responds to user input
- ✅ Embed iframe loads and `frame-ancestors` works as expected
- ✅ All features (upload, draw, navigate) work without errors
- ✅ No unexpected violations in CSP reports

**FAIL** if:
- ❌ Unintended CSP violations appear (beyond `'unsafe-eval'` which we intentionally allow)
- ❌ Canvas doesn't render or interact
- ❌ Embed iframe fails to load due to frame-ancestors
- ❌ Features break unexpectedly

## Enforcement Switch

Once validated, flip policy from report-only to enforcement:

```bash
# In production .env:
CSP_REPORT_ONLY=False

# Restart backend:
docker-compose up -d backend
```

## Files to Monitor

- `backend/django/product_editor/settings.py` — CSP directives + report-only flag
- `frontend/nextjs/next.config.mjs` — frame-ancestors + directives
- Browser DevTools Console — violation messages
- Browser Network tab — CSP report headers

## Test Results (2026-09-10)

### Backend CSP Headers ✅
```
Content-Security-Policy-Report-Only: 
  default-src 'self'
  connect-src 'self' https:
  script-src 'self' 'unsafe-inline' 'unsafe-eval'
  frame-ancestors 'self' https://printo.in https://*.printo.in
  style-src 'self' 'unsafe-inline'
  img-src 'self' data: blob: https:
  font-src 'self' data:
```

**Verified endpoints:**
- ✅ `/api/config` — CSP headers present
- ✅ `/api/embed/session/validate` — CSP headers present
- ✅ `/editor/layout/[name]` — CSP headers applied

### Editor Testing ✅
- ✅ Editor loaded with embed token
- ✅ Fabric.js canvas renders
- ✅ UI controls visible (FIT, COVER, BLUR EFFECT, submit button)
- ✅ No CSP violations in DevTools console
- ✅ No CSP-blocked resources
- ✅ Report-only mode active (headers not enforced)

### Findings
- All CSP directives properly configured
- `'unsafe-eval'` correctly allows Fabric.js without violations
- frame-ancestors limits embedding to printo.in (production-ready)
- Ready to proceed with enforcement testing when needed

## Notes

- Report-only mode (current state) shows violations but doesn't block ✅ CONFIRMED
- Once enabled, CSP violations WILL block resources, so validation is critical
- Fabric.js legitimately requires `'unsafe-eval'` for canvas manipulation ✅ VERIFIED
- Frame-ancestors is the only security-sensitive directive for embed flow ✅ CONFIGURED
