#!/bin/bash
# Run all Shofer test suites sequentially, report wall-clock time per suite.
# Used by the pre-push git hook to gate pushes on all tests passing.
# Cap per-suite parallelism to avoid hanging the laptop (vitest defaults to all CPU cores).
set -euo pipefail

# Sanitize git environment variables that leak from husky-submodule context.
# Without this, GIT_DIR points to the shofer submodule's git directory
# (.git/modules/shofer), and test code that calls simpleGit(tempDir).init()
# operates on the submodule repo instead of tempDir — corrupting the
# submodule config (e.g. setting core.bare=true).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES

# WS is the repo root (where this script is located, one level up from scripts/)
WS="$(cd "$(dirname "$0")/.." && pwd)"

VITEST_OPTS="--maxConcurrency=2"

run_suite() {
    local label="$1" dir="$2" extra="${3:-}" max_retries="${4:-1}" ts0 ts1 elapsed rc attempt
    local tmpfile="/tmp/shofer-suite-${label//\//-}.log"
    # Globals written for the caller: SUITE_TEST_COUNT (test count on success).
    SUITE_TEST_COUNT=0
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
            # Extract total test count from the vitest summary line
            # (e.g. "Tests  172 passed (172)" → 172).
            local test_count
            test_count=$(sed -nE 's/^[[:space:]]*Tests[[:space:]]+.*\(([0-9]+)\).*/\1/p' "${tmpfile}" | tail -1)
            SUITE_TEST_COUNT="${test_count:-0}"
            if [[ -n "${test_count}" ]]; then
                printf '%3ds  OK%s  (%s tests)\n' "${elapsed}" "${retry_note}" "${test_count}" >&2
            else
                printf '%3ds  OK%s\n' "${elapsed}" "${retry_note}" >&2
            fi
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
TOTAL_TESTS=0
set +e
# src is flaky under load — allow one retry.
# Each run_suite sets SUITE_TEST_COUNT on success; accumulate into TOTAL_TESTS.
run_suite "types"       "packages/types"     || ((FAILURES++));  TOTAL_TESTS=$((TOTAL_TESTS + SUITE_TEST_COUNT))
run_suite "src"         "src"                "--exclude **/e2e/**" 1 || ((FAILURES++));  TOTAL_TESTS=$((TOTAL_TESTS + SUITE_TEST_COUNT))
run_suite "cli"         "apps/cli"           || ((FAILURES++));  TOTAL_TESTS=$((TOTAL_TESTS + SUITE_TEST_COUNT))
run_suite "core"        "packages/core"      || ((FAILURES++));  TOTAL_TESTS=$((TOTAL_TESTS + SUITE_TEST_COUNT))
run_suite "telemetry"   "packages/telemetry" || ((FAILURES++));  TOTAL_TESTS=$((TOTAL_TESTS + SUITE_TEST_COUNT))
run_suite "webview-ui"  "webview-ui"         || ((FAILURES++));  TOTAL_TESTS=$((TOTAL_TESTS + SUITE_TEST_COUNT))
set -e

total_end=$(date +%s)
total_elapsed=$((total_end - total_start))
printf '\n%-12s %3ds  (%d tests)\n' "TOTAL:" "${total_elapsed}" "${TOTAL_TESTS}" >&2

if [[ $FAILURES -gt 0 ]]; then
    printf '%d suite(s) FAILED\n' "$FAILURES" >&2
fi

exit $FAILURES
