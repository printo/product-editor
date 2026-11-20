#!/usr/bin/env bash
# Known-vulnerability report for the versions that are actually installed.
#
# Report only: this script always exits 0, and deploy.sh calls it after the
# smoke tests, so a finding or an outage of the advisory databases can never
# fail or delay a deploy. Read the output as a to-do list for the next
# dependency round.
#
#   ./scripts/dependency-audit.sh [backend|frontend|both]
#
# Nothing is installed on the host. Each audit runs in a throwaway container:
#   backend   `pip freeze` of the running backend image, checked by pip-audit
#             (PyPI advisory data) in a python:3.12-slim container
#   frontend  `pnpm audit --prod` against pnpm-lock.yaml in a node:22 container
set -uo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/print.sh
source scripts/lib/print.sh

TARGET="${1:-both}"
LIMIT="${AUDIT_TIMEOUT:-180}"
BACKEND_IMAGE="${AUDIT_BACKEND_IMAGE:-product-editor-backend:latest}"
PNPM_VERSION="9.15.9"   # keep equal to frontend/nextjs/Dockerfile
FOUND=0

with_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout "$LIMIT" "$@"; else "$@"; fi
}

audit_backend() {
  print_action "Python packages (pip-audit)"
  local frozen
  frozen=$(docker run --rm --entrypoint /opt/venv/bin/pip "$BACKEND_IMAGE" freeze 2>/dev/null) || frozen=""
  if [[ -z "$frozen" ]]; then
    print_warning "Could not read the packages of $BACKEND_IMAGE — backend audit skipped"
    return 0
  fi
  local out rc
  out=$(printf '%s\n' "$frozen" | with_timeout docker run --rm -i python:3.12-slim sh -c \
    'pip install -q --disable-pip-version-check pip-audit >/dev/null 2>&1 \
     && cat > /tmp/req.txt \
     && pip-audit -r /tmp/req.txt --no-deps --disable-pip --progress-spinner off' 2>&1)
  rc=$?
  if [[ $rc -eq 0 ]]; then
    print_status "pip-audit: no known vulnerabilities in the installed Python packages"
  elif [[ $rc -eq 1 ]]; then
    FOUND=1
    print_warning "pip-audit found vulnerable Python packages:"
    printf '%s\n' "$out" | sed 's/^/    /'
  else
    print_warning "pip-audit did not complete (exit $rc) — advisory service unreachable or timed out"
    printf '%s\n' "$out" | tail -5 | sed 's/^/    /'
  fi
}

audit_frontend() {
  print_action "JavaScript packages (pnpm audit, production dependencies)"
  if [[ ! -f frontend/nextjs/pnpm-lock.yaml ]]; then
    print_warning "frontend/nextjs/pnpm-lock.yaml not found — frontend audit skipped"
    return 0
  fi
  local out rc
  out=$(with_timeout docker run --rm -v "$PWD/frontend/nextjs/package.json:/a/package.json:ro" \
    -v "$PWD/frontend/nextjs/pnpm-lock.yaml:/a/pnpm-lock.yaml:ro" -w /a node:22-alpine sh -c \
    "corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate >/dev/null 2>&1 \
     && pnpm audit --prod --audit-level=moderate" 2>&1)
  rc=$?
  if [[ $rc -eq 0 ]]; then
    print_status "pnpm audit: no known vulnerabilities (moderate or above) in production dependencies"
  elif printf '%s' "$out" | grep -qiE 'vulnerabilit|Severity'; then
    FOUND=1
    print_warning "pnpm audit found vulnerable JavaScript packages:"
    printf '%s\n' "$out" | grep -E 'vulnerabilities found|Severity:' | sed 's/^/    /'
    printf '%s\n' "$out" | grep -E '^[[:space:]│]*Package[[:space:]]' | awk -F'│' '{gsub(/^ +| +$/, "", $3); print $3}' \
      | sort | uniq -c | sort -rn | head -15 | sed 's/^/    advisories in /'
    print_info "Full list with paths: cd frontend/nextjs && pnpm audit --prod"
  else
    print_warning "pnpm audit did not complete (exit $rc) — registry unreachable or timed out"
    printf '%s\n' "$out" | tail -5 | sed 's/^/    /'
  fi
}

case "$TARGET" in
  backend)  audit_backend ;;
  frontend) audit_frontend ;;
  both)     audit_backend; audit_frontend ;;
  *) print_warning "Unknown target '$TARGET' (use backend, frontend or both)" ;;
esac

if [[ $FOUND -eq 1 ]]; then
  print_info "Findings above do not fail the deploy. Bring them to the next dependency round."
fi
exit 0
