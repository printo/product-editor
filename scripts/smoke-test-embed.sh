#!/usr/bin/env bash
#
# Smoke-test the embed integration end-to-end against a running stack.
#
# Usage:
#   API_KEY=<real-api-key> ./scripts/smoke-test-embed.sh                       # localhost:5004
#   API_KEY=<key> BASE=https://product-editor.printo.in ./scripts/smoke-test-embed.sh
#
#   # From the prod server, against the nginx edge (the path prod actually
#   # serves). Needs CURL_INSECURE — see the TLS note below:
#   API_KEY=<key> BASE=https://localhost CURL_INSECURE=1 ./scripts/smoke-test-embed.sh
#
# Optional:
#   CURL_INSECURE=1  skip TLS verification (see below)
#   SMOKE_RENDER=1   also submit a real render and poll it to completion (step
#                    12). Off by default: it occupies a Celery worker slot and
#                    writes 300-DPI output to EXPORTS_DIR, which on the 2-core
#                    prod box competes with live customer renders.
#   RENDER_LAYOUT=<name>  layout for step 12 (default: circle_48mm, 1 frame)
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

# ── TLS verification ─────────────────────────────────────────────────────────
# The origin cert is a Cloudflare Origin certificate — signed by CF's origin
# CA, not a public one — so curl refuses it and aborts BEFORE sending the
# request. Every check then reports 000, which reads as "the whole stack is
# down" rather than "the cert isn't publicly trusted", and sends you debugging
# the wrong thing. Enable with CURL_INSECURE=1, and do it automatically for an
# HTTPS localhost base, which is only ever an operator testing the edge from
# the box itself. Never auto-relaxed for a real remote host.
CURL_OPTS=""
case "$BASE" in
  https://localhost*|https://127.0.0.1*) CURL_OPTS="-k" ;;
esac
[ "${CURL_INSECURE:-0}" = "1" ] && CURL_OPTS="-k"

# Shadow curl so all ~25 call sites pick this up without edits; `command curl`
# stops the function recursing into itself. Unquoted $CURL_OPTS is deliberate —
# it must vanish entirely when empty rather than pass an empty argument.
curl() { command curl ${CURL_OPTS} "$@"; }

[ -n "$CURL_OPTS" ] && printf "\033[33m!\033[0m TLS verification disabled for %s\n" "$BASE"

# Pretty step printer ────────────────────────────────────────────────────────
step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }
# Neutral: a step that could not run here (missing optional dep, empty
# environment). Counts as neither pass nor fail — matches smoke-test-calendar.sh.
skip() { printf "  \033[33m⊘\033[0m %s\n" "$1"; }

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

# ── 2d. Create embed session with qty ----------------------------------------
# qty moved off the iframe URL onto the session so it can actually be enforced;
# a caller sending it in this body is the supported path. The token minted here
# is reused by step 9b to prove the render endpoint honours it.
step "2d. Create embed session with qty"
status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
  -X POST "$BASE/api/embed/session" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"order_id\":\"$ORDER_ID-qty\",\"qty\":2}")
QTY_TOKEN=""
if [ "$status" = "201" ]; then
  q=$(python3 -c 'import json; print(json.load(open("/tmp/se.body"))["qty"])')
  QTY_TOKEN=$(python3 -c 'import json; print(json.load(open("/tmp/se.body"))["token"])')
  [ "$q" = "2" ] \
    && ok "qty accepted and round-tripped as $q" \
    || bad "qty returned wrong value: $q"
else
  bad "POST /api/embed/session with qty → $status (expected 201)"
fi

# ── 2e. Reject nonsense qty ---------------------------------------------------
# 0 must be refused rather than stored: NULL means "no quantity, do not check",
# and a 0 in the column would cap every order at nothing.
step "2e. Reject nonsense qty (0 / negative / fractional / non-numeric)"
for bad_qty in 0 -3 1.5 '"abc"' 99999; do
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$BASE/api/embed/session" \
    -H "Authorization: Bearer $API_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"order_id\":\"$ORDER_ID-q\",\"qty\":$bad_qty}")
  [ "$status" = "400" ] && ok "qty=$bad_qty rejected with 400" || bad "qty=$bad_qty → $status (expected 400)"
done

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

# ── 10. SKU-layouts endpoint is gone ------------------------------------------
# Removed 2026-09-04: printo.in resolves SKU → layout on its own side, so this
# service no longer carries the mapping. Asserted rather than deleted, so a
# stray re-introduction is caught.
# ── 9b. Render submit is capped by the session qty ---------------------------
# The point of storing qty server-side: this bypasses the editor entirely and
# still cannot exceed the ordered count. The upload_ids are deliberately bogus
# — the qty gate runs before they are resolved, so an over-count submission
# answers with the qty message and an at-count one falls through to the
# upload-not-found 400. Two different 400s, and which one you get is the test.
step "9b. Render submit honours the session qty (over → 400, at-count → passes the gate)"
if [ -z "$QTY_TOKEN" ]; then
  skip "no qty session token from step 2d"
else
  render_body() { python3 -c '
import json, sys
n = int(sys.argv[1])
print(json.dumps({"layout_name": sys.argv[2], "canvases": [
    {"canvas_index": i, "surface_key": "default",
     "frames": [{"frame_index": 0, "upload_id": "00000000-0000-4000-8000-%012d" % i}]}
    for i in range(n)]}))' "$1" "${RENDER_LAYOUT:-circle_48mm}"; }

  # 3 photos on a qty=2 session → rejected, and the message must name the cap.
  status=$(curl -s -o /tmp/qty.over -w '%{http_code}' \
    -X POST "$BASE/api/embed/proxy/editor/render" \
    -H "X-Embed-Token: $QTY_TOKEN" -H 'Content-Type: application/json' \
    -d "$(render_body 3)")
  if [ "$status" = "400" ] && grep -q "order is for 2" /tmp/qty.over; then
    ok "3 photos on a qty=2 session → 400 over-quantity"
  else
    bad "Expected a 400 naming the qty cap, got $status: $(head -c 200 /tmp/qty.over)"
  fi

  # 1 photo on a qty=2 session (UNDER) must NOT be blocked — the asymmetry is
  # deliberate, so a wrong qty from the caller cannot strand a real order.
  status=$(curl -s -o /tmp/qty.under -w '%{http_code}' \
    -X POST "$BASE/api/embed/proxy/editor/render" \
    -H "X-Embed-Token: $QTY_TOKEN" -H 'Content-Type: application/json' \
    -d "$(render_body 1)")
  if grep -q "order is for" /tmp/qty.under; then
    bad "Under-quantity was blocked — it must warn and proceed, never block"
  else
    ok "1 photo on a qty=2 session → not quantity-blocked (got $status)"
  fi
fi

step "10. SKU-layouts endpoint no longer exists"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/sku-layouts/")
[ "$status" = "404" ] && ok "/api/sku-layouts/ → 404 (removed)" || bad "Expected 404, got $status"

# ── 11. Chunked upload round-trip (raw-body PUT) ------------------------------
# The chunk PUT endpoint must accept arbitrary Content-Type (browsers send the
# original File's MIME, e.g. image/png). Regression test for the 415/500 bug
# fixed when the view switched to a custom *-accepting parser.
step "11. Chunked upload init → chunk PUT (image/png) → complete"

# Build a real 100×100 PNG. Two constraints, both learned the hard way:
#   - /complete runs PIL open-and-verify, so it must be a genuinely valid PNG.
#   - validators.py rejects anything below MIN_IMAGE_DIMENSION (50px), so a 1×1
#     placeholder is NOT usable. (A 1×1 PNG_HEX constant used to sit here,
#     unreferenced; it would have been rejected had anyone wired it up.)
# Written with stdlib zlib+struct rather than Pillow: python3 is already
# required above for JSON parsing, but Pillow is NOT installed on the prod
# server, which silently skipped this whole step there.
python3 -c "
import zlib, struct
def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
W = H = 100
ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)   # 8-bit, colour type 2 = RGB
raw = b''.join(b'\x00' + bytes((200, 50, 50)) * W for _ in range(H))
open('/tmp/se-chunk.png', 'wb').write(
    b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
    + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
" 2>/dev/null || {
  skip "python3 required to build the test PNG (skipping upload)"
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

    # Complete. X-Order-ID is what the embed proxy injects in the real flow;
    # /complete uses it to file the upload under the order's directory, which
    # is how DPDP erasure finds a customer's photos from the path alone
    # (migration 0011 / docs/DPDP_ERASURE_GAP_PRD.md). Without it the upload
    # lands in _no_order and that linkage goes untested.
    status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
      -X POST "$BASE/api/upload/$UPLOAD_ID/complete" \
      -H "X-Order-ID: $ORDER_ID" \
      -H "Authorization: Bearer $API_KEY")
    [ "$status" = "201" ] && ok "POST /complete → 201" || bad "POST /complete → $status"
  fi

  rm -f /tmp/se-chunk.png
fi

# ── 12. Real render: submit → poll to completion → download (opt-in) ----------
# Everything above stops at /complete, so until this step existed a fully green
# run proved the upload path and NOTHING about rendering. Opt-in via
# SMOKE_RENDER=1 because it queues a real Celery job and writes 300-DPI output
# to EXPORTS_DIR — on the 2-core prod box that competes with customer renders.
if [ "${SMOKE_RENDER:-0}" = "1" ] && [ -n "${UPLOAD_ID:-}" ]; then
  step "12. Render submit → poll → download"

  # Discover a layout that actually exists on the TARGET, rather than assuming
  # one. This step first shipped hardcoding `circle_48mm`, which exists only in
  # the repo's storage/layouts/ dev seed data — production carries a completely
  # different ops-authored catalogue (classic_prints_-_4x6_in, square_8x8, …),
  # so the render passed locally and failed on prod with
  #   FileNotFoundError: '/app/storage/layouts/circle_48mm.json'
  # after burning all 4 retries on a condition that could never resolve.
  #
  # Prefer single-surface + single-frame: the payload below sends one frame and
  # no surface_key, and a multi-surface layout needs the real key or it renders
  # blank (see CLAUDE.md, "Per-surface render grouping").
  if [ -z "${RENDER_LAYOUT:-}" ]; then
    curl -s -o /tmp/se.layouts "$BASE/api/layouts?fields=summary" \
      -H "Authorization: Bearer $API_KEY"
    RENDER_LAYOUT=$(python3 -c "
import json
try:
    items = json.load(open('/tmp/se.layouts')).get('layouts') or []
except Exception:
    items = []
ok = [d for d in items
      if isinstance(d, dict) and d.get('name')
      and d.get('productType') != 'calendar'
      and d.get('surfaceCount') == 1]
exact = [d for d in ok if d.get('frameCount') == 1]
print((exact or ok or [{}])[0].get('name', ''))
" 2>/dev/null || echo "")
  fi

  if [ -z "$RENDER_LAYOUT" ]; then
    skip "No single-surface layout found on $BASE (set RENDER_LAYOUT=<name> to force)"
  else
    ok "using layout '$RENDER_LAYOUT'"

    status=$(curl -s -o /tmp/se.body -w '%{http_code}' \
      -X POST "$BASE/api/editor/render" \
      -H "Authorization: Bearer $API_KEY" \
      -H 'Content-Type: application/json' \
      -d "{\"layout_name\":\"$RENDER_LAYOUT\",\"order_id\":\"$ORDER_ID\",\"export_format\":\"png\",\"canvases\":[{\"canvas_index\":0,\"frames\":[{\"frame_index\":0,\"upload_id\":\"$UPLOAD_ID\",\"offset_x\":0,\"offset_y\":0,\"scale\":1,\"rotation\":0,\"fit_mode\":\"cover\"}]}]}")
    if [ "$status" = "202" ]; then
      JOB_ID=$(python3 -c 'import json; print(json.load(open("/tmp/se.body"))["job_id"])')
      ok "POST /api/editor/render → 202, job=${JOB_ID:0:8}…"
    else
      bad "POST /api/editor/render → $status (expected 202)"
      JOB_ID=""
    fi

    if [ -n "$JOB_ID" ]; then
      # A 1-frame 100×100 render finishes in ~1-2s; 60s is generous headroom
      # without stalling the script if the worker is wedged.
      JOB_STATUS=""
      for _ in $(seq 1 30); do
        sleep 2
        curl -s -o /tmp/se.body "$BASE/api/render-status/$JOB_ID/" \
          -H "Authorization: Bearer $API_KEY"
        JOB_STATUS=$(python3 -c 'import json; print(json.load(open("/tmp/se.body")).get("status",""))' 2>/dev/null || echo "")
        case "$JOB_STATUS" in completed|failed) break ;; esac
      done

      if [ "$JOB_STATUS" = "completed" ]; then
        ok "render reached 'completed'"
        status=$(curl -s -o /tmp/se.zip -w '%{http_code}' \
          "$BASE/api/jobs/$JOB_ID/download/" -H "Authorization: Bearer $API_KEY")
        [ "$status" = "200" ] && ok "ZIP download → 200" || bad "ZIP download → $status"

        # The combined archive must keep its three numbered folders — printo.in
        # and any existing partner extracts by those paths.
        if [ "$status" = "200" ]; then
          if python3 -c '
import sys, zipfile
names = zipfile.ZipFile("/tmp/se.zip").namelist()
sys.exit(0 if any(n.startswith("3_print/") for n in names) else 1)'; then
            ok "combined ZIP keeps 3_print/ layout"
          else
            bad "combined ZIP lost its 3_print/ folder"
          fi
        fi

        # Split archives — one part each, flat at the root, so the caller can
        # store mock and print in separate fields without unpacking one archive.
        for part in print mock uploads; do
          status=$(curl -s -o /tmp/se.zip -w '%{http_code}' \
            "$BASE/api/jobs/$JOB_ID/download/?content=$part" \
            -H "Authorization: Bearer $API_KEY")
          if [ "$status" != "200" ]; then
            bad "?content=$part → $status (expected 200)"
            continue
          fi
          if python3 -c '
import sys, zipfile
names = zipfile.ZipFile("/tmp/se.zip").namelist()
# non-empty, and nothing nested in a folder
sys.exit(0 if names and not any("/" in n for n in names) else 1)'; then
            ok "?content=$part → 200, flat non-empty archive"
          else
            bad "?content=$part → 200 but archive empty or foldered"
          fi
        done

        status=$(curl -s -o /dev/null -w '%{http_code}' \
          "$BASE/api/jobs/$JOB_ID/download/?content=bogus" \
          -H "Authorization: Bearer $API_KEY")
        [ "$status" = "400" ] && ok "?content=bogus → 400" || bad "?content=bogus → $status (expected 400)"
      else
        # Surface the server's own reason — the render-status payload carries an
        # `error` field, and without printing it the operator sees only "failed"
        # and has to go digging through worker logs.
        REASON=$(python3 -c 'import json; print(json.load(open("/tmp/se.body")).get("error","") or "")' 2>/dev/null || echo "")
        bad "render did not complete (status: ${JOB_STATUS:-unknown})${REASON:+ — $REASON}"
      fi
    fi
  fi
fi

# ── Summary -------------------------------------------------------------------
echo
echo "─────────────────────────────────────────"
printf "Passed: \033[32m%d\033[0m   Failed: \033[31m%d\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
