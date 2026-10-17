#!/usr/bin/env bash
#
# Smoke-test layout templates against a running stack: the customer reads, the
# embed session's template_id / template_flow, the editor's init call, the
# embed proxy allowlist, and (opt-in) the ops write path and a real render of
# a sticker design through to the print file.
#
# Usage:
#   API_KEY=<key> ./scripts/smoke-test-templates.sh                       # localhost:5004, read-only
#   API_KEY=<key> BASE=https://localhost ./scripts/smoke-test-templates.sh
#   ENABLE_OPS_WRITE=1 API_KEY=<ops key> ./scripts/smoke-test-templates.sh             # + create/publish/hide
#   ENABLE_OPS_WRITE=1 SMOKE_RENDER=1 API_KEY=<ops key> ./scripts/smoke-test-templates.sh  # + sticker render
#
#   TEMPLATE_LAYOUT=<name>   layout to put the test template on (default: the
#                            first single-surface, non-calendar, non-book layout)
#
# Read-only by default, like the calendar and book scripts: the only rows it
# writes are embed sessions (as smoke-test-embed.sh does).
#
# ENABLE_OPS_WRITE=1 needs an ops-flagged key (DIRECT_API_KEY on a dev stack).
# It uploads a small sticker PNG, creates a draft template, publishes it, and
# hides it again at the end. Stickers are stored under their content
# fingerprint and never deleted, and this script always uploads the same
# 64×64 image, so repeated runs add no files after the first.
#
# SMOKE_RENDER=1 (with ENABLE_OPS_WRITE=1) does what the editor does when a
# customer submits a template design: uploads a photo and the sticker image,
# submits a render whose overlays are the template's decoration (the sticker
# by its upload id, as the editor's print raster sends it), waits for the
# worker, downloads the print archive and checks the sticker's colour at its
# place in the 300-DPI file. It queues a real Celery job and writes output, so
# it stays off on production deploys. The test order is purged afterwards.
#
# Exits 0 if every check passes, 1 otherwise.

set -u
BASE="${BASE:-http://localhost:5004}"
API_KEY="${API_KEY:-}"
STAMP="$(date +%s)"
TEMPLATE_ID="smoke-tpl-${STAMP}"
ORDER_ID="SMOKE-TPL-${STAMP}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/smoke-tpl.XXXXXX")"
CREATED=0
HIDDEN=0
# Never leave a published test template behind, even on Ctrl-C or a failure.
cleanup() {
  if [ "$CREATED" = "1" ] && [ "$HIDDEN" != "1" ]; then
    command curl -s ${CURL_OPTS:-} -o /dev/null -X DELETE "$BASE/api/ops/templates/$TEMPLATE_ID" \
      -H "Authorization: Bearer $API_KEY" || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ -z "$API_KEY" ]; then
  echo "✗ API_KEY env var is required (a real Printo API key)"
  exit 2
fi
command -v python3 >/dev/null || { echo "✗ python3 is required"; exit 2; }

CURL_OPTS=""
case "$BASE" in
  https://localhost*|https://127.0.0.1*) CURL_OPTS="-k" ;;
esac
[ "${CURL_INSECURE:-0}" = "1" ] && CURL_OPTS="-k"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/smoke.sh"
[ -n "$CURL_OPTS" ] && printf "\033[33m!\033[0m TLS verification disabled for %s\n" "$BASE"

AUTH=(-H "Authorization: Bearer $API_KEY")
json() { python3 -c "import json,sys; d=json.load(open('$1')); print($2)" 2>/dev/null; }

# A solid-colour RGB PNG, stdlib only (Pillow is not installed on the prod host).
make_png() {  # make_png <path> <w> <h> <r> <g> <b>
  python3 - "$@" <<'PY'
import struct, sys, zlib
path, w, h, r, g, b = sys.argv[1], *map(int, sys.argv[2:])
def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
raw = b''.join(b'\x00' + bytes((r, g, b)) * w for _ in range(h))
open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                       + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
PY
}

# ── 0. Pick the layout ────────────────────────────────────────────────────────
step "0. Layout to test against"
curl -s -o "$TMP/layouts.json" "$BASE/api/layouts" "${AUTH[@]}"
LAYOUT="${TEMPLATE_LAYOUT:-$(python3 - "$TMP/layouts.json" <<'PY'
import json, sys
try:
    items = json.load(open(sys.argv[1])).get('layouts') or []
except Exception:
    items = []
ok = sorted(d['name'] for d in items
            if isinstance(d, dict) and d.get('name')
            and d.get('productType') not in ('calendar', 'book')
            and not d.get('surfaces'))
print(ok[0] if ok else '')
PY
)}"
if [ -z "$LAYOUT" ]; then
  bad "no single-surface layout on $BASE (set TEMPLATE_LAYOUT=<name>)"
else
  ok "using layout '$LAYOUT'"
fi
if python3 -c "
import json,sys
items=json.load(open('$TMP/layouts.json')).get('layouts') or []
sys.exit(0 if items and all(isinstance(d.get('templateCount'), int) for d in items) else 1)" 2>/dev/null; then
  ok "GET /api/layouts carries templateCount on every layout"
else
  bad "GET /api/layouts is missing templateCount"
fi

# ── 1. Customer reads ─────────────────────────────────────────────────────────
step "1. Customer template reads"
status=$(curl -s -o "$TMP/list.json" -w '%{http_code}' "$BASE/api/templates?layout=$LAYOUT" "${AUTH[@]}")
if [ "$status" = "200" ] && [ "$(json "$TMP/list.json" "isinstance(d.get('templates'), list)")" = "True" ]; then
  ok "GET /api/templates?layout=$LAYOUT → 200 with a templates list"
else
  bad "GET /api/templates?layout=$LAYOUT → $status"
fi
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/templates" "${AUTH[@]}")
[ "$status" = "400" ] && ok "no layout → 400" || bad "no layout → $status (expected 400)"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/templates?layout=no_such_layout_$STAMP" "${AUTH[@]}")
[ "$status" = "404" ] && ok "unknown layout → 404" || bad "unknown layout → $status (expected 404)"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/templates/no-such-template-$STAMP" "${AUTH[@]}")
[ "$status" = "404" ] && ok "unknown template → 404" || bad "unknown template → $status (expected 404)"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/templates/assets/not-a-png.txt")
[ "$status" = "400" ] && ok "sticker address that is not a PNG name → 400" || bad "bad sticker name → $status (expected 400)"

# ── 2. Embed session and editor init ─────────────────────────────────────────
step "2. Embed session template fields"
status=$(curl -s -o "$TMP/s.json" -w '%{http_code}' -X POST "$BASE/api/embed/session" "${AUTH[@]}" \
  -H 'Content-Type: application/json' -d "{\"order_id\":\"$ORDER_ID\",\"template_flow\":true}")
TOKEN=$(json "$TMP/s.json" "d.get('token','')")
if [ "$status" = "201" ] && [ "$(json "$TMP/s.json" "d['embed_url_template'].endswith('&template_flow=1') and d['editor_url'] is None")" = "True" ]; then
  ok "template_flow: true → embed_url_template ends in &template_flow=1, no editor_url"
else
  bad "template_flow session → $status $(head -c 200 "$TMP/s.json")"
fi
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/embed/session" "${AUTH[@]}" \
  -H 'Content-Type: application/json' -d "{\"order_id\":\"$ORDER_ID\",\"template_id\":\"Not A Slug\"}")
[ "$status" = "400" ] && ok "malformed template_id → 400" || bad "malformed template_id → $status (expected 400)"
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/embed/session" "${AUTH[@]}" \
  -H 'Content-Type: application/json' -d "{\"order_id\":\"$ORDER_ID\",\"template_id\":\"no-such-template-$STAMP\"}")
[ "$status" = "400" ] && ok "unpublished/unknown template_id → 400" || bad "unknown template_id → $status (expected 400)"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/editor/init?layout=$LAYOUT&template=Bad%20Id" "${AUTH[@]}")
[ "$status" = "400" ] && ok "editor/init with a malformed template → 400" || bad "editor/init bad template → $status (expected 400)"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/editor/init?layout=$LAYOUT&template=no-such-template-$STAMP" "${AUTH[@]}")
[ "$status" = "404" ] && ok "editor/init with an unknown template → 404" || bad "editor/init unknown template → $status (expected 404)"

step "3. Embed proxy: templates are readable, never writable"
if [ -z "$TOKEN" ]; then
  skip "no embed token from step 2"
else
  status=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Embed-Token: $TOKEN" "$BASE/api/embed/proxy/templates?layout=$LAYOUT")
  [ "$status" = "200" ] && ok "GET /api/embed/proxy/templates → 200" || bad "GET via embed proxy → $status (expected 200)"
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Embed-Token: $TOKEN" -H 'Content-Type: application/json' \
    -d '{}' "$BASE/api/embed/proxy/templates")
  [ "$status" = "403" ] && ok "POST /api/embed/proxy/templates → 403" || bad "POST via embed proxy → $status (expected 403)"
  status=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Embed-Token: $TOKEN" "$BASE/api/embed/proxy/ops/templates")
  [ "$status" = "403" ] && ok "GET /api/embed/proxy/ops/templates → 403" || bad "ops templates via embed proxy → $status (expected 403)"
fi

# ── 4. Ops write path (opt-in) ────────────────────────────────────────────────
if [ "${ENABLE_OPS_WRITE:-0}" != "1" ]; then
  step "4. Ops create → publish → hide"
  skip "ENABLE_OPS_WRITE=1 not set (read-only run)"
elif [ -z "$LAYOUT" ]; then
  step "4. Ops create → publish → hide"
  skip "no layout"
else
  step "4. Ops create → publish → hide"
  # Pure green so the render check in step 5 can find it in the print.
  make_png "$TMP/sticker.png" 64 64 0 200 0
  status=$(curl -s -o "$TMP/st.json" -w '%{http_code}' -X POST "$BASE/api/ops/templates/assets" "${AUTH[@]}" \
    -F "file=@$TMP/sticker.png;type=image/png")
  STICKER_URL=$(json "$TMP/st.json" "d.get('url','')")
  if [ "$status" = "201" ] && [ -n "$STICKER_URL" ]; then
    ok "sticker upload → 201 ($STICKER_URL)"
  else
    bad "sticker upload → $status $(head -c 200 "$TMP/st.json")"
  fi
  status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$STICKER_URL")
  case "$status" in 200|302) ok "sticker address serves → $status" ;; *) bad "GET $STICKER_URL → $status" ;; esac

  # A text line across the top and the sticker filling the middle fifth.
  DECORATION=$(python3 -c "
import json
print(json.dumps({'surfaces': {'default': {'bgColor': '#fff4e6', 'overlays': [
  {'type': 'text', 'id': 't1', 'text': 'Smoke test', 'x': 50, 'y': 10, 'fontSize': 60, 'color': '#64318e',
   'fontFamily': 'Inter', 'textAlign': 'center', 'rotation': 0},
  {'type': 'image', 'id': 's1', 'source': 'clipart', 'src': '$STICKER_URL', 'label': 'smoke sticker',
   'x': 40, 'y': 40, 'width': 20, 'height': 20, 'rotation': 0, 'opacity': 1},
]}}}))")

  status=$(curl -s -o "$TMP/bad.json" -w '%{http_code}' -X POST "$BASE/api/ops/templates" "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"id\":\"$TEMPLATE_ID\",\"layout\":\"$LAYOUT\",\"display_name\":\"Smoke\",\"decoration\":{\"surfaces\":{\"default\":{\"overlays\":[{\"type\":\"image\",\"id\":\"x\",\"source\":\"local\",\"fileId\":\"f\",\"src\":\"blob:x\",\"label\":\"x\",\"x\":1,\"y\":1,\"width\":1,\"height\":1,\"rotation\":0,\"opacity\":1}]}}}}")
  [ "$status" = "400" ] && ok "a decoration holding a customer file → 400" || bad "customer-file decoration → $status (expected 400)"

  status=$(curl -s -o "$TMP/t.json" -w '%{http_code}' -X POST "$BASE/api/ops/templates" "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"id\":\"$TEMPLATE_ID\",\"layout\":\"$LAYOUT\",\"display_name\":\"Smoke $STAMP\",\"decoration\":$DECORATION}")
  if [ "$status" = "201" ] && [ "$(json "$TMP/t.json" "d['status']")" = "draft" ]; then
    ok "create → 201 as a draft"
    CREATED=1
  else
    bad "create → $status $(head -c 200 "$TMP/t.json")"
  fi

  if [ "$CREATED" = "1" ]; then
    status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/templates/$TEMPLATE_ID" "${AUTH[@]}")
    [ "$status" = "404" ] && ok "a draft is not served to customers" || bad "draft detail → $status (expected 404)"

    status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ops/templates/$TEMPLATE_ID" "${AUTH[@]}" \
      -H 'Content-Type: application/json' -d '{"status":"published"}')
    [ "$status" = "200" ] && ok "publish → 200" || bad "publish → $status"

    curl -s -o "$TMP/list.json" "$BASE/api/templates?layout=$LAYOUT" "${AUTH[@]}"
    [ "$(json "$TMP/list.json" "any(t['id']=='$TEMPLATE_ID' for t in d['templates'])")" = "True" ] \
      && ok "published template is listed for its layout" || bad "published template not listed"

    status=$(curl -s -o "$TMP/s2.json" -w '%{http_code}' -X POST "$BASE/api/embed/session" "${AUTH[@]}" \
      -H 'Content-Type: application/json' -d "{\"order_id\":\"$ORDER_ID\",\"template_id\":\"$TEMPLATE_ID\"}")
    if [ "$status" = "201" ] && [ "$(json "$TMP/s2.json" "d['editor_url'].startswith('/editor/layout/$LAYOUT?token=') and d['editor_url'].endswith('&template=$TEMPLATE_ID')")" = "True" ]; then
      ok "template_id → editor_url on the template's layout"
    else
      bad "template_id session → $status $(head -c 300 "$TMP/s2.json")"
    fi

    status=$(curl -s -o "$TMP/init.json" -w '%{http_code}' "$BASE/api/editor/init?layout=$LAYOUT&template=$TEMPLATE_ID" "${AUTH[@]}")
    [ "$status" = "200" ] && [ "$(json "$TMP/init.json" "d['template']['id']")" = "$TEMPLATE_ID" ] \
      && ok "editor/init returns the template with the layout" || bad "editor/init with template → $status"

    # ── 5. Sticker design rendered to the print file (opt-in) ────────────────
    if [ "${SMOKE_RENDER:-0}" = "1" ]; then
      step "5. A sticker design renders into the print file"
      upload() {  # upload <file> <name> → prints the upload id
        local size id
        size=$(stat -c%s "$1" 2>/dev/null || stat -f%z "$1")
        curl -s -o "$TMP/up.json" -X POST "$BASE/api/upload/init" "${AUTH[@]}" -H 'Content-Type: application/json' \
          -d "{\"filename\":\"$2\",\"file_size\":$size,\"total_chunks\":1}"
        id=$(json "$TMP/up.json" "d.get('upload_id','')")
        [ -z "$id" ] && return 1
        curl -s -o /dev/null -X PUT "$BASE/api/upload/$id/chunk?index=0" "${AUTH[@]}" -H 'Content-Type: image/png' \
          --data-binary @"$1" || return 1
        [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/upload/$id/complete" "${AUTH[@]}" -H "X-Order-ID: $ORDER_ID")" = "201" ] || return 1
        echo "$id"
      }
      make_png "$TMP/photo.png" 300 300 200 50 50
      PHOTO_ID=$(upload "$TMP/photo.png" photo.png) && ok "photo uploaded" || bad "photo upload failed"
      # The editor rasterises a sticker and uploads it with the photos; same here.
      STICKER_UP=$(upload "$TMP/sticker.png" sticker.png) && ok "sticker uploaded as the editor's raster" || bad "sticker upload failed"

      if [ -n "${PHOTO_ID:-}" ] && [ -n "${STICKER_UP:-}" ]; then
        python3 - "$TMP/init.json" "$TMP/render.json" "$LAYOUT" "$ORDER_ID" "$PHOTO_ID" "$STICKER_UP" <<'PY'
import json, sys
init, out, layout, order, photo, sticker = sys.argv[1:]
tpl = json.load(open(init))['template']
side = tpl['decoration']['surfaces'].get('default') or next(iter(tpl['decoration']['surfaces'].values()))
overlays = []
for i, o in enumerate(side['overlays']):
    o = dict(o, id=f"tpl-{tpl['id']}-{i}", templateId=tpl['id'])
    if o['type'] == 'image':
        o['fileId'] = sticker
    overlays.append(o)
frames = json.load(open(init))['layout'].get('frames') or [{}]
json.dump({'layout_name': layout, 'order_id': order, 'export_format': 'png', 'canvases': [{
    'canvas_index': 0, 'surface_key': 'default',
    'bg_color': side.get('bgColor', '#ffffff'), 'paper_color': side.get('paperColor', '#ffffff'),
    'frames': [{'frame_index': i, 'upload_id': photo, 'offset_x': 0, 'offset_y': 0, 'scale': 1,
                'rotation': 0, 'fit_mode': 'cover'} for i in range(len(frames))],
    'overlays': overlays,
}]}, open(out, 'w'))
PY
        status=$(curl -s -o "$TMP/job.json" -w '%{http_code}' -X POST "$BASE/api/editor/render" "${AUTH[@]}" \
          -H 'Content-Type: application/json' -d @"$TMP/render.json")
        JOB_ID=$(json "$TMP/job.json" "d.get('job_id','')")
        [ "$status" = "202" ] && ok "render submitted → 202" || bad "render submit → $status $(head -c 200 "$TMP/job.json")"

        JOB_STATUS=""
        if [ -n "$JOB_ID" ]; then
          for _ in $(seq 1 45); do
            sleep 2
            curl -s -o "$TMP/st.json" "$BASE/api/render-status/$JOB_ID/" "${AUTH[@]}"
            JOB_STATUS=$(json "$TMP/st.json" "d.get('status','')")
            case "$JOB_STATUS" in completed|failed) break ;; esac
          done
        fi
        if [ "$JOB_STATUS" = "completed" ]; then
          ok "render completed"
          status=$(curl -s -o "$TMP/print.zip" -w '%{http_code}' "$BASE/api/jobs/$JOB_ID/download/?content=print" "${AUTH[@]}")
          [ "$status" = "200" ] && ok "print archive → 200" || bad "print archive → $status"
          # Decode the print PNG with the stdlib and read the middle pixel,
          # which the sticker covers (x/y 40%, size 20%).
          if RESULT=$(python3 - "$TMP/print.zip" <<'PY'
import struct, sys, zipfile, zlib
z = zipfile.ZipFile(sys.argv[1])
name = next(n for n in z.namelist() if n.lower().endswith('.png'))
data = z.read(name)
pos, idat, w = 8, b'', 0
while pos < len(data):
    n, tag = struct.unpack('>I4s', data[pos:pos + 8])
    body = data[pos + 8:pos + 8 + n]
    if tag == b'IHDR':
        w, h, depth, ctype = struct.unpack('>IIBB', body[:10])
    elif tag == b'IDAT':
        idat += body
    pos += 12 + n
assert depth == 8 and ctype in (2, 6), f"unexpected PNG format depth={depth} type={ctype}"
bpp = 3 if ctype == 2 else 4
raw, stride, prev, rows = zlib.decompress(idat), w * bpp, None, []
for y in range(h):
    f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
    for i in range(stride):
        a = line[i - bpp] if i >= bpp else 0
        b = prev[i] if prev else 0
        c = prev[i - bpp] if prev and i >= bpp else 0
        if f == 1: line[i] = (line[i] + a) & 255
        elif f == 2: line[i] = (line[i] + b) & 255
        elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
        elif f == 4:
            p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    rows.append(line); prev = line
mid = rows[h // 2][(w // 2) * bpp:(w // 2) * bpp + 3]
print(f"{name} {w}x{h} centre={tuple(mid)}")
sys.exit(0 if all(abs(v - want) <= 20 for v, want in zip(mid, (0, 200, 0))) else 1)
PY
); then
            ok "sticker is in the print file ($RESULT)"
          else
            bad "sticker not found at its place in the print file (${RESULT:-could not read the PNG})"
          fi
        else
          REASON=$(json "$TMP/st.json" "d.get('error','') or ''")
          bad "render did not complete (status: ${JOB_STATUS:-unknown})${REASON:+ — $REASON}"
        fi
      fi

      status=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/ops/orders/$ORDER_ID/purge?all_tenants=true" "${AUTH[@]}")
      case "$status" in 200|404) ok "test order purged → $status" ;; *) bad "purge test order → $status" ;; esac
    else
      step "5. A sticker design renders into the print file"
      skip "SMOKE_RENDER=1 not set"
    fi

    step "6. Hide the test template"
    status=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/ops/templates/$TEMPLATE_ID" "${AUTH[@]}")
    if [ "$status" = "204" ]; then ok "hide → 204"; HIDDEN=1; else bad "hide → $status"; fi
    status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/templates/$TEMPLATE_ID" "${AUTH[@]}")
    [ "$status" = "404" ] && ok "a hidden template is no longer served" || bad "hidden template detail → $status (expected 404)"
  fi
fi

echo
echo "─────────────────────────────────────────"
printf "Passed: \033[32m%d\033[0m   Failed: \033[31m%d\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1
