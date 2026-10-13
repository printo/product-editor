# Shared helpers for scripts/smoke-test-*.sh. Sourced after CURL_OPTS is set.

PASS=0
FAIL=0

# Shadow curl so every call site picks up CURL_OPTS without edits; `command
# curl` stops the function recursing into itself. Unquoted $CURL_OPTS is
# deliberate — it must vanish entirely when empty rather than pass an empty
# argument. Expanded at call time, so it reads whatever CURL_OPTS is then.
curl() { command curl ${CURL_OPTS} "$@"; }

# Pretty step printer ────────────────────────────────────────────────────────
step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }
# Neutral: a step that could not run here (missing optional dep, empty
# environment). Counts as neither pass nor fail.
skip() { printf "  \033[33m⊘\033[0m %s\n" "$1"; }
