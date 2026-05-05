#!/usr/bin/env bash
#
# Smoke-test the embed integration end-to-end against a running stack.
#
# Usage:
#   API_KEY=<real-api-key> ./scripts/smoke-test-embed.sh                       # localhost:5004
#   API_KEY=<key> BASE=https://product-editor.printo.in ./scripts/smoke-test-embed.sh
#
# Exits 0 if every check passes, 1 otherwise.

set -u
BASE="${BASE:-http://localhost:5004}"
API_KEY="${API_KEY:-}"
ORDER_ID="${ORDER_ID:-SMOKE-$(date +%s)}"
PASS=0
FAIL=0

if [ -z "$API_KEY" ]; then
  echo "✗ API_KEY env var is required (a real Printo API key)"
  exit 2
fi

# Pretty step printer ────────────────────────────────────────────────────────
step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }

# ── 1. Health -----------------------------------------------------------------
step "1. Backend health"
status=$(curl -s -o /tmp/se.body -w '%{http_code}' "$BASE/api/health" || echo 000)
[ "$status" = "200" ] && ok "/api/health → 200" || bad "/api/health → $status"

# ── 2. Create embed session with valid order_id -------------------------------
step "2. Create embed session (valid order_id)"
status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
  -X POST "$BASE/api/embed/session" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"order_id\":\"$ORDER_ID\"}")
if [ "$status" = "201" ]; then
  TOKEN=$(python3 -c 'import json,sys; print(json.load(open("/tmp/se.body"))["token"])')
  ok "POST /api/embed/session → 201, token=${TOKEN:0:8}…"
else
  bad "POST /api/embed/session → $status (expected 201)"
  cat /tmp/se.body; exit 1
fi

# ── 2b. Create embed session with callback_url -------------------------------
step "2b. Create embed session with valid HTTPS callback_url"
status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
  -X POST "$BASE/api/embed/session" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"order_id\":\"$ORDER_ID-cb\",\"callback_url\":\"https://printo.in/webhook/test\"}")
if [ "$status" = "201" ]; then
  cb=$(python3 -c 'import json; print(json.load(open("/tmp/se.body"))["callback_url"])')
  [ "$cb" = "https://printo.in/webhook/test" ] \
    && ok "callback_url accepted and round-tripped" \
    || bad "callback_url returned wrong value: $cb"
else
  bad "POST /api/embed/session with callback_url → $status (expected 201)"
fi

# ── 2c. Reject http:// callback_url -------------------------------------------
step "2c. Reject http:// callback_url"
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/api/embed/session" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"order_id\":\"$ORDER_ID-bad\",\"callback_url\":\"http://printo.in/webhook\"}")
[ "$status" = "400" ] && ok "http:// callback_url rejected with 400" || bad "Got $status (expected 400)"

# ── 3. Reject invalid order_id ------------------------------------------------
step "3. Reject malformed order_id"
status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
  -X POST "$BASE/api/embed/session" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"order_id":"bad order with spaces!@#"}')
[ "$status" = "400" ] && ok "Malformed order_id rejected with 400" || bad "Got $status (expected 400)"

# ── 4. Embed proxy — allowed path ---------------------------------------------
step "4. Embed proxy passes allowed path (layouts)"
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "X-Embed-Token: $TOKEN" \
  "$BASE/api/embed/proxy/layouts")
# 200 (success) or 404 (no layouts visible to this key) both prove path-allowed
case "$status" in
  200|404) ok "/api/embed/proxy/layouts → $status (allowed)" ;;
  *)       bad "/api/embed/proxy/layouts → $status (expected 200/404)" ;;
esac

# ── 5. Embed proxy — blocked path (ops) ---------------------------------------
step "5. Embed proxy blocks /ops/* (path allowlist)"
status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
  -H "X-Embed-Token: $TOKEN" \
  "$BASE/api/embed/proxy/ops/layouts")
[ "$status" = "403" ] && ok "/api/embed/proxy/ops/layouts → 403 (blocked)" || bad "Got $status (expected 403)"

# ── 6. Embed proxy — blocked path (admin) -------------------------------------
step "6. Embed proxy blocks unknown path"
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "X-Embed-Token: $TOKEN" \
  "$BASE/api/embed/proxy/admin/users")
[ "$status" = "403" ] && ok "/api/embed/proxy/admin/users → 403 (blocked)" || bad "Got $status (expected 403)"

# ── 7. Embed proxy — missing token --------------------------------------------
step "7. Embed proxy rejects missing token"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/embed/proxy/layouts")
[ "$status" = "401" ] && ok "missing X-Embed-Token → 401" || bad "Got $status (expected 401)"

# ── 8. Embed proxy — invalid token --------------------------------------------
step "8. Embed proxy rejects invalid token"
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'X-Embed-Token: not-a-real-token' \
  "$BASE/api/embed/proxy/layouts")
[ "$status" = "401" ] && ok "invalid token → 401" || bad "Got $status (expected 401)"

# ── 9. Canvas state round-trip via embed proxy --------------------------------
# Use -L to follow redirects: Next.js's default trailingSlash=false issues a
# 308 redirect from /api/embed/proxy/canvas-state/<id>/ → without trailing
# slash. Real browsers follow this automatically; curl needs -L to match.
# The proxy then re-adds the slash internally to hit Django's
# `path("canvas-state/<order_id>/", ...)`.
step "9. Canvas-state PUT/GET round-trip via embed proxy"
status=$(curl -s -L -o /dev/null -w '%{http_code}' \
  -X PUT \
  -H "X-Embed-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"layout_name":"smoke_test","editor_state":{"surfaces":[]}}' \
  "$BASE/api/embed/proxy/canvas-state/$ORDER_ID/")
case "$status" in
  200|201) ok "PUT canvas-state → $status" ;;
  *)       bad "PUT canvas-state → $status" ;;
esac

status=$(curl -s -L -o /tmp/se.body -w '%{http_code}' \
  -H "X-Embed-Token: $TOKEN" \
  "$BASE/api/embed/proxy/canvas-state/$ORDER_ID/")
[ "$status" = "200" ] && ok "GET canvas-state → 200" || bad "GET canvas-state → $status"

# ── 10. SKU-layouts public read -----------------------------------------------
step "10. SKU-layouts endpoint public read"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/sku-layouts/")
[ "$status" = "200" ] && ok "/api/sku-layouts/ → 200" || bad "Got $status"

# ── 11. Chunked upload round-trip (raw-body PUT) ------------------------------
# The chunk PUT endpoint must accept arbitrary Content-Type (browsers send the
# original File's MIME, e.g. image/png). Regression test for the 415/500 bug
# fixed when the view switched to a custom *-accepting parser.
step "11. Chunked upload init → chunk PUT (image/png) → complete"

# Build a real 100×100 PNG (PIL's open-and-verify in /complete needs a valid image).
PNG_HEX='89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63600100000005000164b25c80000000049454e44ae426082'
python3 -c "
from PIL import Image
import io
img = Image.new('RGB', (100, 100), (200, 50, 50))
img.save('/tmp/se-chunk.png', 'PNG')
" 2>/dev/null || {
  bad "Python3 + Pillow required for upload smoke test (skipping)"
  PASS=$((PASS - 1))
  FAIL=$((FAIL - 1))
  goto_summary=1
}

if [ "${goto_summary:-0}" != "1" ]; then
  CHUNK_SIZE=$(stat -c%s /tmp/se-chunk.png 2>/dev/null || stat -f%z /tmp/se-chunk.png)

  status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
    -X POST "$BASE/api/upload/init" \
    -H "Authorization: Bearer $API_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"filename\":\"se-chunk.png\",\"file_size\":$CHUNK_SIZE,\"total_chunks\":1}")
  if [ "$status" = "201" ]; then
    UPLOAD_ID=$(python3 -c 'import json; print(json.load(open("/tmp/se.body"))["upload_id"])')
    ok "POST /api/upload/init → 201, upload_id=${UPLOAD_ID:0:8}…"
  else
    bad "POST /api/upload/init → $status (expected 201)"
    UPLOAD_ID=""
  fi

  if [ -n "$UPLOAD_ID" ]; then
    # PUT with image/png — replicates the browser flow exactly
    status=$(curl -s -o /dev/null -w '%{http_code}' \
      -X PUT "$BASE/api/upload/$UPLOAD_ID/chunk?index=0" \
      -H "Authorization: Bearer $API_KEY" \
      -H 'Content-Type: image/png' \
      -H "Content-Range: bytes 0-$((CHUNK_SIZE - 1))/$CHUNK_SIZE" \
      --data-binary @/tmp/se-chunk.png)
    [ "$status" = "200" ] && ok "PUT chunk (image/png raw body) → 200" || bad "PUT chunk → $status"

    # Complete
    status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
      -X POST "$BASE/api/upload/$UPLOAD_ID/complete" \
      -H "Authorization: Bearer $API_KEY")
    [ "$status" = "201" ] && ok "POST /complete → 201" || bad "POST /complete → $status"
  fi

  rm -f /tmp/se-chunk.png
fi

# ── Summary -------------------------------------------------------------------
echo
echo "─────────────────────────────────────────"
printf "Passed: \033[32m%d\033[0m   Failed: \033[31m%d\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
