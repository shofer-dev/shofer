#!/bin/bash
# Run all Shofer test suites sequentially, report wall-clock time per suite.
# Used by the pre-push git hook to gate pushes on all tests passing.
# Cap per-suite parallelism to avoid hanging the laptop (vitest defaults to all CPU cores).
set -euo pipefail

# WS is the repo root (where this script is located, one level up from scripts/)
WS="$(cd "$(dirname "$0")/.." && pwd)"

VITEST_OPTS="--maxConcurrency=2"

run_suite() {
    local label="$1" dir="$2" extra="${3:-}" max_retries="${4:-1}" ts0 ts1 elapsed rc attempt
    local tmpfile="/tmp/shofer-suite-${label//\//-}.log"
    printf '%-12s ' "${label}:" >&2
    rc=1
    for ((attempt=1; attempt <= max_retries + 1; attempt++)); do
        ts0=$(date +%s)
        set +e
        (cd "${WS}/${dir}" && npx vitest run ${VITEST_OPTS} ${extra}) > "${tmpfile}" 2>&1
        rc=$?
        set -e
        ts1=$(date +%s)
        elapsed=$((ts1 - ts0))
        if [[ $rc -eq 0 ]]; then
            local retry_note=""
            [[ $attempt -gt 1 ]] && retry_note=" (retry ${attempt})"
            printf '%3ds  OK%s\n' "${elapsed}" "${retry_note}" >&2
            rm -f "${tmpfile}"
            return 0
        fi
        if [[ $attempt -le $max_retries ]]; then
            printf '%3ds  FAIL (retrying...)\n' "${elapsed}" >&2
        fi
    done
    printf '%3ds  FAIL (exit %d, %d attempts)\n' "${elapsed}" "$rc" "$((max_retries + 1))" >&2
    # Dump the tail of vitest output so the developer can see what failed.
    echo "--- ${label} test output (last 60 lines) ---" >&2
    tail -60 "${tmpfile}" >&2 || true
    echo "--- end of ${label} output ---" >&2
    printf 'Full output saved: %s\n' "${tmpfile}" >&2
    return $rc
}

total_start=$(date +%s)

# Warm up vitest graph once
(cd "${WS}/src" && npx vitest run ${VITEST_OPTS} --exclude '**/e2e/**') > /dev/null 2>&1 || true

FAILURES=0
set +e
# src is flaky under load — allow one retry.
run_suite "types"       "packages/types"     || ((FAILURES++))
run_suite "src"         "src"                "--exclude **/e2e/**" 1 || ((FAILURES++))
run_suite "cli"         "apps/cli"           || ((FAILURES++))
run_suite "core"        "packages/core"      || ((FAILURES++))
run_suite "telemetry"   "packages/telemetry" || ((FAILURES++))
run_suite "webview-ui"  "webview-ui"         || ((FAILURES++))
set -e

total_end=$(date +%s)
total_elapsed=$((total_end - total_start))
printf '\n%-12s %3ds\n' "TOTAL:" "${total_elapsed}" >&2

if [[ $FAILURES -gt 0 ]]; then
    printf '%d suite(s) FAILED\n' "$FAILURES" >&2
fi

exit $FAILURES
