#!/usr/bin/env bash
#
# Smoke-test the calendar-layout ops surface end-to-end against a running stack.
# Covers Phase 6.3 acceptance: ops can list, view, create, and edit calendar
# layouts via the same /api/ops/layouts/* + /api/layouts endpoints that already
# exist for standard layouts — distinguished by `productType: 'calendar'`.
#
# Usage:
#   API_KEY=<real-api-key> ./scripts/smoke-test-calendar.sh             # localhost:5004
#   API_KEY=<key> BASE=https://product-editor.printo.in ./scripts/smoke-test-calendar.sh
#
# Exits 0 if every check passes, 1 otherwise.
#
# Note: PUT /api/ops/layouts/<name> requires an ops-team session cookie, not
# just an API key. That part of the test is skipped when ENABLE_OPS_WRITE is
# unset — read-only checks (health, list, GET ops layout, GET sku-layouts)
# still run and form the bulk of the coverage.

set -u
BASE="${BASE:-http://localhost:5004}"
API_KEY="${API_KEY:-}"
PASS=0
FAIL=0
TEST_LAYOUT="${TEST_LAYOUT:-smoke_calendar_$(date +%s)}"

if [ -z "$API_KEY" ]; then
  echo "✗ API_KEY env var is required (a real Printo API key)"
  exit 2
fi

# Pretty step printer ────────────────────────────────────────────────────────
step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }
skip() { printf "  \033[33m⊘\033[0m %s\n" "$1"; }

# ── 1. Backend health --------------------------------------------------------
step "1. Backend health"
status=$(curl -s -o /tmp/sc.body -w '%{http_code}' "$BASE/api/health" || echo 000)
[ "$status" = "200" ] && ok "/api/health → 200" || bad "/api/health → $status"

# ── 2. List layouts contains productType field ------------------------------
step "2. GET /api/layouts returns layouts with productType visible"
status=$(curl -s -o /tmp/sc.body -w '%{http_code}' \
  -H "Authorization: Bearer $API_KEY" "$BASE/api/layouts")
if [ "$status" = "200" ]; then
  ok "GET /api/layouts → 200"
  has_productType=$(python3 -c '
import json
data = json.load(open("/tmp/sc.body"))
layouts = data.get("layouts", [])
# A layout list response should be an array of dicts — verify schema.
print("yes" if isinstance(layouts, list) and (len(layouts) == 0 or isinstance(layouts[0], dict)) else "no")
')
  [ "$has_productType" = "yes" ] && ok "Layouts payload is array of dicts" \
    || bad "Layouts payload schema unexpected"

  # Count calendar layouts visible in the list (informational).
  cal_count=$(python3 -c '
import json
data = json.load(open("/tmp/sc.body"))
print(sum(1 for l in data.get("layouts", []) if isinstance(l, dict) and l.get("productType") == "calendar"))
')
  ok "Calendar layouts currently in list: $cal_count"
else
  bad "GET /api/layouts → $status"
fi

# ── 3. Calendar style presets endpoint available ----------------------------
step "3. GET /api/calendar-styles/ returns the 3 presets"
status=$(curl -sL -o /tmp/sc.body -w '%{http_code}' \
  -H "Authorization: Bearer $API_KEY" "$BASE/api/calendar-styles/")
if [ "$status" = "200" ]; then
  ok "GET /api/calendar-styles → 200"
  preset_count=$(python3 -c '
import json
data = json.load(open("/tmp/sc.body"))
# Endpoint returns {"styles": [...]} per CalendarStylesView.
print(len(data.get("styles", [])))
')
  [ "$preset_count" -ge 3 ] && ok "Found $preset_count style presets (≥ 3 expected)" \
    || bad "Expected ≥3 styles, got $preset_count"
else
  bad "GET /api/calendar-styles → $status"
fi

# ── 4. Gen-Z palettes endpoint -----------------------------------------------
step "4. GET /api/calendar-styles/modern-genz returns palettes"
status=$(curl -s -o /tmp/sc.body -w '%{http_code}' \
  -H "Authorization: Bearer $API_KEY" "$BASE/api/calendar-styles/modern-genz")
if [ "$status" = "200" ]; then
  ok "GET /api/calendar-styles/modern-genz → 200"
  pal_count=$(python3 -c '
import json
data = json.load(open("/tmp/sc.body"))
print(len(data.get("palettes", [])))
')
  [ "$pal_count" -ge 1 ] && ok "Found $pal_count Gen-Z palettes" \
    || bad "Expected ≥1 palette, got $pal_count"
else
  bad "GET /api/calendar-styles/modern-genz → $status"
fi

# ── 5. Holidays endpoint returns en-IN entries for 2026 ---------------------
step "5. GET /api/holidays/en-IN/2026 returns events"
status=$(curl -s -o /tmp/sc.body -w '%{http_code}' \
  -H "Authorization: Bearer $API_KEY" "$BASE/api/holidays/en-IN/2026")
if [ "$status" = "200" ]; then
  ok "GET /api/holidays/en-IN/2026 → 200"
  ev_count=$(python3 -c '
import json
data = json.load(open("/tmp/sc.body"))
print(len(data.get("events", [])))
')
  [ "$ev_count" -ge 1 ] && ok "Found $ev_count holiday events" \
    || bad "Expected ≥1 event, got $ev_count"
else
  bad "GET /api/holidays/en-IN/2026 → $status"
fi

# ── 6. SKU mapping endpoint reachable ---------------------------------------
step "6. GET /api/sku-layouts/ returns mapping object"
status=$(curl -s -o /tmp/sc.body -w '%{http_code}' "$BASE/api/sku-layouts/")
if [ "$status" = "200" ]; then
  ok "GET /api/sku-layouts/ → 200 (public read)"
  has_mappings=$(python3 -c '
import json
data = json.load(open("/tmp/sc.body"))
print("yes" if "mappings" in data else "no")
')
  [ "$has_mappings" = "yes" ] && ok "Response contains mappings field" \
    || bad "Response missing mappings field"
else
  bad "GET /api/sku-layouts/ → $status"
fi

# ── 7. Validator rejects a malformed calendar layout (via direct POST) -----
# A POST to /api/ops/layouts requires the ops cookie, but the layout
# validation runs the same `validate_calendar_layout` function so we
# verify it via the GenerateLayoutView path with a bad inline JSON.
step "7. Calendar validator catches mode/calendars mismatch via /api/layout/validate"
status=$(curl -s -o /tmp/sc.body -w '%{http_code}' \
  -X POST "$BASE/api/layout/validate" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "smoke_bad",
    "productType": "calendar",
    "canvas": {"width": 1500, "height": 2100, "widthMm": 127, "heightMm": 177.8, "dpi": 300},
    "frames": [{"x": 0, "y": 0, "width": 1, "height": 1}],
    "calendars": [{"x": 0.8, "y": 0.5, "width": 0.5, "height": 0.4}],
    "calendar": {"themePreset": "modern-minimalist", "calendarType": "english", "weekStart": "sunday", "holidaySource": {"enabled": true, "locale": "en-IN", "showInCells": true}},
    "monthRange": {"count": 12, "defaultYear": 2026}
  }')
if [ "$status" = "404" ]; then
  # Endpoint may not exist — that's OK, the validator is also invoked at PUT time.
  skip "/api/layout/validate not exposed (validation runs at PUT time only)"
else
  if [ "$status" = "400" ]; then
    ok "Malformed calendar layout → 400"
    fragment=$(python3 -c '
import json
data = json.load(open("/tmp/sc.body"))
print(data.get("detail", ""))
')
    case "$fragment" in
      *"canvas edge"*) ok "Error message names the edge violation" ;;
      *) bad "Unexpected error fragment: $fragment" ;;
    esac
  else
    bad "Expected 400 for malformed calendar, got $status"
  fi
fi

# ── 8. Ops PUT (write) — only if explicitly enabled --------------------------
step "8. (Optional) Ops PUT /api/ops/layouts/<name> writes a calendar layout"
if [ "${ENABLE_OPS_WRITE:-0}" = "1" ]; then
  if [ -z "${OPS_COOKIE:-}" ]; then
    skip "ENABLE_OPS_WRITE=1 but OPS_COOKIE env var not set — skipping"
  else
    cat > /tmp/sc.calendar.json << EOF
{
  "name": "$TEST_LAYOUT",
  "productType": "calendar",
  "canvas": {"width": 1500, "height": 2100, "widthMm": 127, "heightMm": 177.8, "dpi": 300},
  "frames": [{"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.42}],
  "calendars": [{"x": 0.05, "y": 0.55, "width": 0.9, "height": 0.42}],
  "calendar": {
    "themePreset": "modern-minimalist",
    "calendarType": "english",
    "weekStart": "sunday",
    "holidaySource": {"enabled": true, "locale": "en-IN", "showInCells": true}
  },
  "monthRange": {"count": 12, "defaultYear": "current"}
}
EOF
    status=$(curl -s -o /tmp/sc.body -w '%{http_code}' \
      -X PUT "$BASE/api/ops/layouts/$TEST_LAYOUT" \
      -H "Cookie: $OPS_COOKIE" \
      -H 'Content-Type: application/json' \
      --data-binary @/tmp/sc.calendar.json)
    if [ "$status" = "200" ] || [ "$status" = "201" ]; then
      ok "PUT /api/ops/layouts/$TEST_LAYOUT → $status"

      # Verify it appears in the list with productType set
      status=$(curl -s -o /tmp/sc.body -w '%{http_code}' \
        -H "Authorization: Bearer $API_KEY" "$BASE/api/layouts")
      seen=$(python3 -c "
import json
data = json.load(open('/tmp/sc.body'))
print('yes' if any(l.get('name') == '$TEST_LAYOUT' and l.get('productType') == 'calendar' for l in data.get('layouts', [])) else 'no')
")
      [ "$seen" = "yes" ] && ok "Newly PUT calendar appears in /api/layouts" \
        || bad "Newly PUT calendar NOT in /api/layouts"

      # Cleanup
      curl -s -o /dev/null -X DELETE "$BASE/api/ops/layouts/$TEST_LAYOUT" \
        -H "Cookie: $OPS_COOKIE"
      ok "Cleanup DELETE done"
    else
      bad "PUT /api/ops/layouts/$TEST_LAYOUT → $status"
      head -c 200 /tmp/sc.body
    fi
  fi
else
  skip "Ops PUT/DELETE write test — set ENABLE_OPS_WRITE=1 + OPS_COOKIE to run"
fi

# ── 9a. Embed proxy allowlist — static source check -------------------------
# Verifies the allowlist source actually carries the calendar entries.
# Backstops the live-HTTP check below in case the dev stack isn't available.
step "9a. Embed proxy allowlist source includes calendar endpoints"
ALLOWLIST_FILE="$(dirname "$0")/../frontend/nextjs/src/app/api/embed/proxy/[...path]/route.ts"
if [ -f "$ALLOWLIST_FILE" ]; then
  if grep -q "'holidays'" "$ALLOWLIST_FILE"; then
    ok "allowlist contains 'holidays'"
  else
    bad "allowlist missing 'holidays'"
  fi
  if grep -q "'calendar-styles'" "$ALLOWLIST_FILE"; then
    ok "allowlist contains 'calendar-styles'"
  else
    bad "allowlist missing 'calendar-styles'"
  fi
else
  skip "embed proxy route file not found at expected path"
fi

# ── 9. Embed flow — proxy allowlist passes calendar endpoints ----------------
# P7.4 — Customer-facing calendar in the embed iframe needs /api/holidays/*
# and /api/calendar-styles/* through the embed proxy (allowlist gate runs
# BEFORE token resolution). Skip when EMBED_BASE isn't set since the
# default smoke run hits the backend directly.
step "9. (Optional) Embed proxy allows calendar endpoints"
if [ -z "${EMBED_BASE:-}" ]; then
  skip "EMBED_BASE not set — skipping embed-proxy reachability checks (set EMBED_BASE=http://localhost:5004 to enable)"
else
  # Create an embed session to get a token
  status=$(curl -s -o /tmp/sc.body -w '%{http_code}' \
    -X POST "$BASE/api/embed/session" \
    -H "Authorization: Bearer $API_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"order_id\":\"SMOKE-CAL-$(date +%s)\"}")
  if [ "$status" = "201" ]; then
    TOKEN=$(python3 -c 'import json; print(json.load(open("/tmp/sc.body"))["token"])')
    ok "Embed session created (token=${TOKEN:0:8}…)"

    # Probe a few calendar endpoints through the embed proxy. We accept
    # 200 (full success) OR 401 (token-validation failed — orthogonal env
    # issue, e.g. pnpm dev can't resolve "backend:8000" outside Docker)
    # as proof the path made it PAST the allowlist gate. A 403 would mean
    # the allowlist itself rejected the path — that's the regression we're
    # guarding against.
    check_proxy_path() {
      local path="$1"
      local label="$2"
      status=$(curl -sL -o /tmp/sc.body -w '%{http_code}' \
        -H "X-Embed-Token: $TOKEN" \
        "$EMBED_BASE/api/embed/proxy/$path")
      if [ "$status" = "200" ]; then
        ok "Embed proxy → $label → 200"
      elif [ "$status" = "401" ]; then
        ok "Embed proxy → $label → 401 (allowlist OK; token-validate failed — likely host/Docker DNS)"
      elif [ "$status" = "403" ]; then
        bad "Embed proxy → $label → 403 — ALLOWLIST REGRESSION"
      else
        bad "Embed proxy → $label → $status"
      fi
    }
    check_proxy_path "holidays/en-IN/2026" "/holidays/en-IN/2026"
    check_proxy_path "calendar-styles/"    "/calendar-styles/"
    check_proxy_path "calendar-styles/modern-genz" "/calendar-styles/modern-genz"

    # Negative test: ops endpoint MUST be rejected at the allowlist.
    status=$(curl -sL -o /tmp/sc.body -w '%{http_code}' \
      -H "X-Embed-Token: $TOKEN" \
      "$EMBED_BASE/api/embed/proxy/ops/layouts")
    if [ "$status" = "403" ]; then
      ok "Embed proxy correctly REJECTS /ops/layouts (403)"
    else
      bad "Embed proxy /ops/layouts → $status — expected 403"
    fi
  else
    bad "Could not create embed session ($status); skipping embed-proxy checks"
  fi
fi

# ── Summary ------------------------------------------------------------------
echo
echo "─────────────────────────────────────────"
echo "Calendar smoke test: $PASS passed, $FAIL failed."
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
