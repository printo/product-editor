#!/usr/bin/env bash
#
# Smoke-test the book/booklet/photobook ops surface end-to-end against a
# running stack. Covers BOOK_LAYOUT_PRD.md §6 Phase 9 acceptance: ops can
# list, validate, create, and delete book layouts via the same
# /api/ops/layouts/* + /api/layouts endpoints that already exist for
# standard and calendar layouts — distinguished by `productType: 'book'`.
#
# Usage:
#   API_KEY=<real-api-key> ./scripts/smoke-test-book.sh             # localhost:5004
#   API_KEY=<key> BASE=https://product-editor.printo.in ./scripts/smoke-test-book.sh
#
#   # From the prod server, against the nginx edge — needs CURL_INSECURE
#   # because the origin cert is not publicly trusted:
#   API_KEY=<key> BASE=https://localhost CURL_INSECURE=1 ./scripts/smoke-test-book.sh
#
# Exits 0 if every check passes, 1 otherwise.
#
# Unlike smoke-test-calendar.sh's write step, this one does NOT need an
# OPS_COOKIE: /api/ops/layouts/<name> is a Django DRF view gated by
# `IsAuthenticatedWithAPIKey, IsOpsTeam` — an ops-flagged Bearer API key
# (DIRECT_API_KEY on a dev stack) authenticates it directly, verified live
# against the running stack while building this script. The session-cookie
# requirement only applies to the *frontend* ops route
# (/api/internal/proxy/ops/layouts/<name>, used by the ops authoring UI at
# /editor/layouts/book/<name>), not the backend endpoint this script hits
# straight through nginx's catch-all /api/ → backend:8000 routing.
# The write step is still opt-in (ENABLE_OPS_WRITE=1) because it creates
# and deletes a real layout file on disk.

set -u
BASE="${BASE:-http://localhost:5004}"
API_KEY="${API_KEY:-}"
PASS=0
FAIL=0
TEST_LAYOUT="${TEST_LAYOUT:-smoke_book_$(date +%s)}"

if [ -z "$API_KEY" ]; then
  echo "✗ API_KEY env var is required (a real Printo API key)"
  exit 2
fi

# ── TLS verification ─────────────────────────────────────────────────────────
# Same reasoning as smoke-test-calendar.sh: the origin cert is a Cloudflare
# Origin certificate, not publicly trusted, so curl aborts before sending and
# every check reports 000 — indistinguishable from the stack being down.
# Enable with CURL_INSECURE=1; auto-enabled for an HTTPS localhost base.
CURL_OPTS=""
case "$BASE" in
  https://localhost*|https://127.0.0.1*) CURL_OPTS="-k" ;;
esac
[ "${CURL_INSECURE:-0}" = "1" ] && CURL_OPTS="-k"
curl() { command curl ${CURL_OPTS} "$@"; }
[ -n "$CURL_OPTS" ] && printf "\033[33m!\033[0m TLS verification disabled for %s\n" "$BASE"

# Pretty step printer ────────────────────────────────────────────────────────
step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }
skip() { printf "  \033[33m⊘\033[0m %s\n" "$1"; }

# A minimal but complete book layout — mirrors
# services/tests/test_book_validator.py's `_good_layout()` shape.
good_book_json() {
  local name="$1"
  cat <<EOF
{
  "name": "$name",
  "productType": "book",
  "book": {
    "bleedMm": 3,
    "gutterMm": 12,
    "paperThicknessMm": 0.12,
    "pageCount": {"min": 20, "max": 60, "step": 4, "default": 24},
    "cover": {
      "canvas": {"width": 3579, "height": 2551, "widthMm": 303, "heightMm": 216},
      "frames": [{"id": "c0", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}]
    },
    "innerPage": {
      "canvas": {"width": 3508, "height": 2480, "widthMm": 297, "heightMm": 210},
      "frames": [{"id": "p0", "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}]
    }
  }
}
EOF
}

# ── 1. Backend health --------------------------------------------------------
step "1. Backend health"
status=$(curl -s -o /tmp/sb.body -w '%{http_code}' "$BASE/api/health" || echo 000)
[ "$status" = "200" ] && ok "/api/health → 200" || bad "/api/health → $status"

# ── 2. List layouts contains productType field -------------------------------
step "2. GET /api/layouts returns layouts with productType visible"
status=$(curl -s -o /tmp/sb.body -w '%{http_code}' \
  -H "Authorization: Bearer $API_KEY" "$BASE/api/layouts")
if [ "$status" = "200" ]; then
  ok "GET /api/layouts → 200"
  schema_ok=$(python3 -c '
import json
data = json.load(open("/tmp/sb.body"))
layouts = data.get("layouts", [])
print("yes" if isinstance(layouts, list) and (len(layouts) == 0 or isinstance(layouts[0], dict)) else "no")
')
  [ "$schema_ok" = "yes" ] && ok "Layouts payload is array of dicts" \
    || bad "Layouts payload schema unexpected"

  book_count=$(python3 -c '
import json
data = json.load(open("/tmp/sb.body"))
print(sum(1 for l in data.get("layouts", []) if isinstance(l, dict) and l.get("productType") == "book"))
')
  ok "Book layouts currently in list: $book_count"
else
  bad "GET /api/layouts → $status"
fi

# ── 3. Validator rejects a page-count grid the max can't reach from min -----
step "3. validate_book_layout rejects an unreachable pageCount grid"
bad_grid=$(good_book_json "smoke_bad_grid" | python3 -c '
import json, sys
d = json.load(sys.stdin)
d["book"]["pageCount"] = {"min": 20, "max": 61, "step": 4, "default": 24}
print(json.dumps(d))
')
status=$(curl -s -o /tmp/sb.body -w '%{http_code}' \
  -X POST "$BASE/api/ops/layouts/smoke_bad_grid" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"name\": \"smoke_bad_grid\", \"layout_data\": $bad_grid}")
if [ "$status" = "400" ]; then
  ok "Unreachable pageCount grid → 400"
  detail=$(python3 -c 'import json; print(json.load(open("/tmp/sb.body")).get("detail",""))')
  case "$detail" in
    *"reachable"*) ok "Error message names the step-grid violation" ;;
    *) bad "Unexpected error fragment: $detail" ;;
  esac
else
  bad "Expected 400 for unreachable pageCount grid, got $status"
fi

# ── 4. Validator rejects a half-specified backCover canvas -------------------
step "4. validate_book_layout rejects a half-specified backCover canvas"
bad_back=$(good_book_json "smoke_bad_back" | python3 -c '
import json, sys
d = json.load(sys.stdin)
d["book"]["backCover"] = {"canvas": {"width": 3579}, "frames": []}
print(json.dumps(d))
')
status=$(curl -s -o /tmp/sb.body -w '%{http_code}' \
  -X POST "$BASE/api/ops/layouts/smoke_bad_back" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"name\": \"smoke_bad_back\", \"layout_data\": $bad_back}")
[ "$status" = "400" ] && ok "Half-specified backCover canvas → 400" \
  || bad "Expected 400 for half-specified backCover, got $status"

# ── 5. Validator rejects overlay coords given as 0..1 fractions -------------
step "5. validate_book_layout rejects fraction-style overlay coords (must be percent)"
bad_overlay=$(good_book_json "smoke_bad_overlay" | python3 -c '
import json, sys
d = json.load(sys.stdin)
d["book"]["innerPage"]["overlays"] = [{"type": "text", "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.05}]
print(json.dumps(d))
')
status=$(curl -s -o /tmp/sb.body -w '%{http_code}' \
  -X POST "$BASE/api/ops/layouts/smoke_bad_overlay" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"name\": \"smoke_bad_overlay\", \"layout_data\": $bad_overlay}")
if [ "$status" = "400" ]; then
  ok "Fraction-style overlay coords → 400"
  detail=$(python3 -c 'import json; print(json.load(open("/tmp/sb.body")).get("detail",""))')
  # Lowercase via tr, not bash 4's ${var,,} — macOS ships bash 3.2.
  detail_lower=$(printf '%s' "$detail" | tr '[:upper:]' '[:lower:]')
  case "$detail_lower" in
    *"percent"*) ok "Error message names the percent-coordinate requirement" ;;
    *) bad "Unexpected error fragment: $detail" ;;
  esac
else
  bad "Expected 400 for fraction-style overlay coords, got $status"
fi

# ── 6. Ops POST (write) — only if explicitly enabled -------------------------
step "6. (Optional) Ops POST /api/ops/layouts/<name> writes a book layout"
if [ "${ENABLE_OPS_WRITE:-0}" = "1" ]; then
  good=$(good_book_json "$TEST_LAYOUT")
  status=$(curl -s -o /tmp/sb.body -w '%{http_code}' \
    -X POST "$BASE/api/ops/layouts/$TEST_LAYOUT" \
    -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
    -d "{\"name\": \"$TEST_LAYOUT\", \"layout_data\": $good}")
  if [ "$status" = "200" ] || [ "$status" = "201" ]; then
    ok "POST /api/ops/layouts/$TEST_LAYOUT → $status"

    # Verify it appears in the list with productType set.
    status=$(curl -s -o /tmp/sb.body -w '%{http_code}' \
      -H "Authorization: Bearer $API_KEY" "$BASE/api/layouts")
    seen=$(python3 -c "
import json
data = json.load(open('/tmp/sb.body'))
print('yes' if any(l.get('name') == '$TEST_LAYOUT' and l.get('productType') == 'book' for l in data.get('layouts', [])) else 'no')
")
    [ "$seen" = "yes" ] && ok "Newly created book layout appears in /api/layouts" \
      || bad "Newly created book layout NOT in /api/layouts"

    # Verify the round-tripped JSON preserves the book block.
    status=$(curl -s -o /tmp/sb.body -w '%{http_code}' \
      -H "Authorization: Bearer $API_KEY" "$BASE/api/layouts/$TEST_LAYOUT")
    has_book=$(python3 -c '
import json
data = json.load(open("/tmp/sb.body"))
book = data.get("book") or {}
print("yes" if book.get("pageCount", {}).get("default") == 24 and "innerPage" in book else "no")
')
    [ "$has_book" = "yes" ] && ok "GET round-trips the book block (pageCount, innerPage intact)" \
      || bad "GET /api/layouts/$TEST_LAYOUT missing expected book fields"

    # Cleanup.
    status=$(curl -s -o /dev/null -w '%{http_code}' \
      -X DELETE "$BASE/api/ops/layouts/$TEST_LAYOUT" \
      -H "Authorization: Bearer $API_KEY")
    [ "$status" = "200" ] || [ "$status" = "204" ] \
      && ok "Cleanup DELETE → $status" \
      || bad "Cleanup DELETE → $status (test layout may still be on disk)"
  else
    bad "POST /api/ops/layouts/$TEST_LAYOUT → $status"
    head -c 200 /tmp/sb.body
  fi
else
  skip "Ops POST/DELETE write test — set ENABLE_OPS_WRITE=1 to run"
fi

# ── 7. (Optional) Embed proxy still rejects the ops namespace ----------------
# Books use no book-specific embed-proxy prefixes (CLAUDE.md's touch list) —
# the customer editor reaches books through the same layouts/editor/render/
# upload/render-status/jobs paths every other product already uses. The one
# regression worth guarding is that /ops/layouts (which now also serves book
# layouts) still cannot be reached from a customer-facing embed token.
step "7. (Optional) Embed proxy still rejects /ops/layouts"
if [ -z "${EMBED_BASE:-}" ]; then
  skip "EMBED_BASE not set — skipping embed-proxy reachability check (set EMBED_BASE=http://localhost:5004 to enable)"
else
  status=$(curl -s -o /tmp/sb.body -w '%{http_code}' \
    -X POST "$BASE/api/embed/session" \
    -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
    -d "{\"order_id\":\"SMOKE-BOOK-$(date +%s)\"}")
  if [ "$status" = "201" ]; then
    TOKEN=$(python3 -c 'import json; print(json.load(open("/tmp/sb.body"))["token"])')
    ok "Embed session created (token=${TOKEN:0:8}…)"
    status=$(curl -sL -o /tmp/sb.body -w '%{http_code}' \
      -H "X-Embed-Token: $TOKEN" \
      "$EMBED_BASE/api/embed/proxy/ops/layouts")
    [ "$status" = "403" ] && ok "Embed proxy correctly REJECTS /ops/layouts (403)" \
      || bad "Embed proxy /ops/layouts → $status — expected 403"
  else
    bad "Could not create embed session ($status); skipping embed-proxy check"
  fi
fi

# ── Summary ------------------------------------------------------------------
echo
echo "─────────────────────────────────────────"
echo "Book smoke test: $PASS passed, $FAIL failed."
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
