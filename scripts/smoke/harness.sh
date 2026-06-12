#!/usr/bin/env bash
#
# Shofer CLI test harness — the single entry point for all CLI test suites.
#
# Runs THREE parts:
#
#   Part 1 — CLI scenarios (docs/test_harness.md §1-25).
#            Sequential by design (some scenarios share session/filesystem state).
#
#   Part 2 — Integration protocol cases (apps/cli/scripts/integration/cases/*.ts,
#            excluding workflow-conformance). Stream-protocol cases for
#            cancellation, follow-ups, queue ordering and process lifecycle.
#            Parallelised via xargs (process-per-case). They drive genuinely slow
#            multi-turn tool flows, so they need a real provider and are skipped
#            on the hermetic `mock` preset.
#
#   Part 3 — Workflow conformance (23 _-prefixed .slang fixtures).
#            Parallelised via xargs (process-per-flow isolation) to keep total
#            wall-clock time reasonable against real providers. Uses the MATCH=
#            knob so each child process runs exactly one fixture.
#
# Presets:
#   mock    Hermetic mock provider — no network, no credentials, deterministic.
#   ds      DeepSeek via the local llm-router (http://localhost:30081/v1).
#
# Override knobs (env):
#   PROVIDER        provider flags (e.g. "--provider mock --api-key x")
#   MODEL           model flag    (e.g. "--model mock-model")
#   ROUTER_URL      base URL for the `ds` preset (default http://localhost:30081/v1)
#   DS_MODEL        model for the `ds` preset    (default deepseek/deepseek-v4-pro)
#   TIMEOUT         per-scenario timeout seconds, Part 1 (default 120)
#   TIMEOUT_INT     per-case timeout seconds, Part 2    (default 180)
#   TIMEOUT_WF      per-workflow timeout seconds, Part 3 (default 600)
#   INT_PARALLEL    max concurrent integration cases (default 4)
#   WF_PARALLEL     max concurrent workflow processes (default 4)
#   MATCH           substring filter for Part 2 case names / Part 3 fixture names
#   SKIP_CLI        skip Part 1 (default 0)
#   SKIP_INTEGRATION skip Part 2 (default 0)
#   SKIP_WORKFLOW   skip Part 3 (default 0; legacy alias: SKIP_PART2)
#
# Exit code: 0 if all scenarios in every part pass, 1 otherwise.
set -u

PRESET="${1:-mock}"

# Resolve the CLI app dir relative to this script so the harness is runnable
# from anywhere (the CLI is launched via `tsx src/index.ts`).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"          # extensions/shofer
CLI_DIR="${EXT_DIR}/apps/cli"
WS_ROOT="$(cd "${EXT_DIR}/../.." && pwd)"             # repo root

ROUTER_URL="${ROUTER_URL:-http://localhost:30081/v1}"
DS_MODEL="${DS_MODEL:-deepseek/deepseek-v4-pro}"
TIMEOUT="${TIMEOUT:-120}"
TIMEOUT_INT="${TIMEOUT_INT:-180}"
TIMEOUT_WF="${TIMEOUT_WF:-600}"
INT_PARALLEL="${INT_PARALLEL:-4}"
WF_PARALLEL="${WF_PARALLEL:-4}"
SKIP_CLI="${SKIP_CLI:-0}"
SKIP_INTEGRATION="${SKIP_INTEGRATION:-0}"
# SKIP_PART2 is the legacy name for the workflow-conformance skip.
SKIP_WORKFLOW="${SKIP_WORKFLOW:-${SKIP_PART2:-0}}"

# Provider/model presets (override via env to use any other provider).
case "${PRESET}" in
	mock)
		PROVIDER="${PROVIDER:---provider mock --api-key x}"
		MODEL="${MODEL:---model mock-model}"
		;;
	ds)
		PROVIDER="${PROVIDER:---provider shofer --api-key shofer --base-url ${ROUTER_URL}}"
		MODEL="${MODEL:---model ${DS_MODEL}}"
		;;
	*)
		# Unknown preset: fall back to whatever PROVIDER/MODEL the caller exported.
		if [[ -z "${PROVIDER:-}" || -z "${MODEL:-}" ]]; then
			echo "Unknown preset '${PRESET}' and no PROVIDER/MODEL env override given." >&2
			echo "Usage: $0 [mock|ds]  (or set PROVIDER and MODEL)" >&2
			exit 2
		fi
		;;
esac

cd "${CLI_DIR}" || exit 2

CLI="pnpm --filter @shofer/cli exec tsx src/index.ts"
WS="-w ${WS_ROOT}"

# shellcheck disable=SC2086  # intentional word-splitting of flag strings
SL() { timeout "${TIMEOUT}" $CLI $PROVIDER $MODEL $WS "$@" 2>/dev/null; }

PASS=0
FAIL=0
TOTAL_PASS=0
TOTAL_FAIL=0
declare -a RESULTS
ok() {
	RESULTS+=("  PASS  $1")
	PASS=$((PASS + 1))
	TOTAL_PASS=$((TOTAL_PASS + 1))
}
no() {
	RESULTS+=("  FAIL  $1  -- $2")
	FAIL=$((FAIL + 1))
	TOTAL_FAIL=$((TOTAL_FAIL + 1))
}

echo "Shofer CLI smoke harness — preset='${PRESET}'"
echo "  PROVIDER: ${PROVIDER}"
echo "  MODEL:    ${MODEL}"
echo "  WS:       ${WS_ROOT}"
echo ""

if [[ "${SKIP_CLI}" == "1" ]]; then
	echo ""
	echo "Part 1 (CLI scenarios) — SKIPPED (SKIP_CLI=1)"
else
echo "============================================"
echo " Part 1: CLI scenarios (sequential)"
echo "============================================"

echo "=== 1 basic print ==="
out=$(SL --print "Reply with exactly: DEEPSEEK_OK")
echo "$out" | grep -qa "DEEPSEEK_OK" && ok "1 basic-print" || no "1 basic-print" "no DEEPSEEK_OK"

echo "=== 2 missing model (error) ==="
# shellcheck disable=SC2086
out=$(timeout 60 $CLI $PROVIDER $WS --print "Hello" 2>&1)
rc=$?
echo "$out" | grep -qia "no model" && [ $rc -ne 0 ] && ok "2 missing-model" || no "2 missing-model" "rc=$rc (needs real provider)"

echo "=== 3 text 2+2 ==="
out=$(SL --print --output-format text "What is 2+2? Reply with just the number.")
echo "$out" | grep -qa "4" && ok "3 text-2+2" || no "3 text-2+2" "no 4"

echo "=== 4 json output ==="
out=$(SL --print --output-format json "What is 2+2? Reply with just the number.")
echo "$out" | python3 -c "import sys,json
try:
 d=json.load(sys.stdin); print('OK' if d.get('success') and d.get('content') else 'BAD')
except Exception as e: print('BAD',e)" | grep -qa "^OK" && ok "4 json-output" || no "4 json-output" "bad json"

echo "=== 5 stream-json ==="
out=$(SL --print --output-format stream-json "What is 2+2? Reply with just the number.")
echo "$out" | python3 -c "import sys,json
t=[json.loads(l)['type'] for l in sys.stdin if l.strip()]
print('OK' if 'system' in t and 'result' in t else 'BAD')" | grep -qa "^OK" && ok "5 stream-json" || no "5 stream-json" "missing events"

echo "=== 6 stdin stream single ==="
# Close stdin (no `shutdown`) so the in-flight task DRAINS and emits its `result`
# event. `shutdown` cancels the active task mid-flight, which a slower real model
# never survives — stdin-close is the supported graceful-drain path.
# shellcheck disable=SC2086
out=$(printf '{"command":"start","requestId":"r1","prompt":"Reply with exactly: STREAM_OK"}\n' | timeout "${TIMEOUT}" $CLI $PROVIDER $MODEL $WS --print --output-format stream-json --stdin-prompt-stream 2>/dev/null)
echo "$out" | python3 -c "import sys,json
res=None
for l in sys.stdin:
 if not l.strip():continue
 d=json.loads(l)
 if d['type']=='result':res=d
print('OK' if res and res.get('success') else 'BAD')" | grep -qa "^OK" && ok "6 stdin-single" || no "6 stdin-single" "no result success"

echo "=== 7 stdin stream followup (BANANA) ==="
# shellcheck disable=SC2086
out=$(printf '{"command":"start","requestId":"r1","prompt":"Remember the word BANANA. Reply with OK."}\n{"command":"message","requestId":"r2","prompt":"What word did I ask you to remember? Reply with just the word."}\n' | timeout "$((TIMEOUT + 30))" $CLI $PROVIDER $MODEL $WS --print --output-format stream-json --stdin-prompt-stream 2>/dev/null)
echo "$out" | grep -qa "BANANA" && ok "7 stdin-followup" || no "7 stdin-followup" "no BANANA"

echo "=== 8 session persistence ==="
SID="018f7fc8-0000-7000-8000-0000000000$(printf '%02d' $((RANDOM % 100)))"
SL --print --create-with-session-id "$SID" "Remember the number 42. Reply with: STORED" >/dev/null
# Resume must NOT pass a positional prompt alongside --session-id (the CLI rejects
# that combo). Deliver the follow-up turn through the stdin NDJSON
# stream: --session-id resumes the task, then a `message` command drives the turn.
# shellcheck disable=SC2086
out=$(printf '{"command":"message","requestId":"r1","prompt":"What number did I tell you to remember? Reply with just the number."}\n' | timeout "${TIMEOUT}" $CLI $PROVIDER $MODEL $WS --print --output-format stream-json --stdin-prompt-stream --session-id "$SID" 2>/dev/null)
echo "$out" | grep -qa "42" && ok "8 session-resume" || no "8 session-resume" "no 42"

echo "=== 9 ephemeral ==="
BEFORE=$(ls ~/.shofer/tasks/ 2>/dev/null | wc -l)
SL --ephemeral --print "Reply with: EPHEMERAL_OK" >/dev/null
AFTER=$(ls ~/.shofer/tasks/ 2>/dev/null | wc -l)
[ "$BEFORE" = "$AFTER" ] && ok "9 ephemeral" || no "9 ephemeral" "before=$BEFORE after=$AFTER"

echo "=== 10 read_file ==="
out=$(SL --print "Read the file extensions/shofer/package.json and tell me the value of the 'name' field. Reply with just the value.")
echo "$out" | grep -qaiE "shofer" && ok "10 read_file" || no "10 read_file" "no name value"

echo "=== 11 execute_command ==="
out=$(SL --print "Run the shell command 'echo SHELL_OK' and report the output. Reply with just the output.")
echo "$out" | grep -qa "SHELL_OK" && ok "11 execute_command" || no "11 execute_command" "no SHELL_OK"

echo "=== 12 write_to_file ==="
TMP_FILE="/tmp/shofer_write_test.txt"
rm -f "$TMP_FILE"
out=$(SL --print "Write the text 'WRITE_OK' to the file $TMP_FILE, then read it back and confirm the content. Reply with: confirmed=<content>")
{ echo "$out" | grep -qa "WRITE_OK" || grep -qa "WRITE_OK" "$TMP_FILE" 2>/dev/null; } && ok "12 write_to_file" || no "12 write_to_file" "no WRITE_OK"
rm -f "$TMP_FILE"

echo "=== 13 mode architect ==="
out=$(SL --print --mode architect "Describe in one sentence what an architect agent does differently from a code agent.")
{ echo "$out" | grep -qaiE "architect|plan|design" && ! echo "$out" | grep -qia "error"; } && ok "13 mode-architect" || no "13 mode-architect" "no coherent desc"

echo "=== 14 exit-on-error ==="
# shellcheck disable=SC2086
out=$(timeout 60 $CLI --provider shofer --api-key shofer --base-url http://localhost:9999/v1 $MODEL $WS --print --exit-on-error "Hello" 2>&1)
rc=$?
[ $rc -ne 0 ] && ok "14 exit-on-error" || no "14 exit-on-error" "rc=0"

echo "=== 20 subtask ==="
out=$(SL --print "Spawn a subtask (using the new_task tool, is_background=false) with the prompt 'Reply with: SUBTASK_OK'. After it completes, report its result prefixed with: PARENT_GOT:")
echo "$out" | grep -qa "SUBTASK_OK" && ok "20 subtask" || no "20 subtask" "no SUBTASK_OK"

echo "=== 21 SIGINT ==="
# This test inherently requires a long-running provider turn so SIGINT
# lands while the agent is still working. The mock returns instantly for
# any prompt containing "number" (built-in scenario), so SIGINT arrives
# after rc=0. Guard the test behind a real provider only.
if [ "$PRESET" != "mock" ]; then
	# shellcheck disable=SC2086
	timeout 60 $CLI $PROVIDER $MODEL $WS --print "Count slowly to 100, one number per line." >/dev/null 2>&1 &
	PID=$!
	sleep 5
	kill -INT $PID 2>/dev/null
	wait $PID
	rc=$?
	[ $rc -ne 0 ] && ok "21 sigint" || no "21 sigint" "rc=$rc"
else
	echo "(skipped on mock — SIGINT lands after rc=0)"
	ok "21 sigint (skipped on mock)"
fi

echo "=== 22 list sessions ==="
SL --print "Reply with: SESSION_MARKER" >/dev/null
# shellcheck disable=SC2086
out=$(timeout 60 $CLI $PROVIDER $MODEL $WS list sessions 2>/dev/null | head -5)
[ -n "$out" ] && ok "22 list-sessions" || no "22 list-sessions" "empty"

echo ""
echo "================= PART 1 SUMMARY (${PRESET}) ================="
for r in "${RESULTS[@]}"; do echo "$r"; done
echo "------------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
fi

# ─────────────────────────────────────────────────────────────────────────
# Part 2 — Integration protocol cases (process-per-case parallel)
# ─────────────────────────────────────────────────────────────────────────
# These stream-protocol cases drive genuinely slow multi-turn tool flows
# (e.g. start-while-busy needs the first task to still be running), so they
# require a provider that actually executes tools and are skipped on `mock`
# — the same rule as the real-provider-only CLI scenarios in Part 1.
INT_DIR="${CLI_DIR}/scripts/integration/cases"
if [[ "${SKIP_INTEGRATION}" == "1" ]]; then
	echo ""
	echo "Part 2 (integration cases) — SKIPPED (SKIP_INTEGRATION=1)"
elif [[ "${PRESET}" == "mock" ]]; then
	echo ""
	echo "Part 2 (integration cases) — SKIPPED (need a real provider; preset='mock')"
else
	echo ""
	echo "============================================"
	echo " Part 2: Integration cases (parallel x${INT_PARALLEL})"
	echo "============================================"

	# Provider env each case inherits (stream-harness.ts reads these).
	INT_ENV="PROVIDER=shofer API_KEY=shofer MODEL=${DS_MODEL} BASE_URL=${ROUTER_URL}"

	# Discover case files, excluding workflow-conformance (its own Part 3).
	shopt -s nullglob
	CASES=()
	for f in "${INT_DIR}"/*.ts; do
		base="$(basename "$f" .ts)"
		[[ "$base" == "workflow-conformance" ]] && continue
		# Optional MATCH substring filter for single-case runs.
		if [[ -n "${MATCH:-}" && "$base" != *"${MATCH}"* ]]; then continue; fi
		CASES+=( "$base" )
	done

	INT_LOG_DIR="$(mktemp -d)"
	# Logs persist after exit for inspection; clean up manually (rm -rf /tmp/tmp.XXXX).
	INT_CLI_DIR="${CLI_DIR}"
	export INT_ENV INT_LOG_DIR TIMEOUT_INT INT_CLI_DIR

	INT_SCRIPT="${INT_LOG_DIR}/_int_worker.sh"
	cat > "${INT_SCRIPT}" <<'IWORKER_EOF'
#!/usr/bin/env bash
set -u
name="$1"
log="${INT_LOG_DIR}/${name}.log"
cd "${INT_CLI_DIR}" || exit 2
# Pass/fail is the case's own exit code; record a sentinel so the parent can
# collect results from the per-case log (xargs hides child exit codes).
if timeout "${TIMEOUT_INT}" \
	env ROO_CLI_ROOT="${INT_CLI_DIR}" TIMEOUT_MS="$((TIMEOUT_INT * 1000))" ${INT_ENV} \
	pnpm --filter @shofer/cli exec tsx "scripts/integration/cases/${name}.ts" \
	> "${log}" 2>&1
then
	echo "__CASE_PASS__" >> "${log}"
else
	echo "__CASE_FAIL__ rc=$?" >> "${log}"
fi
IWORKER_EOF
	chmod +x "${INT_SCRIPT}"

	INT_PASS=0
	INT_FAIL=0
	if [[ ${#CASES[@]} -gt 0 ]]; then
		if [[ "${INT_PARALLEL}" -gt 1 ]]; then
			printf '%s\n' "${CASES[@]}" | xargs -P "${INT_PARALLEL}" -I{} "${INT_SCRIPT}" "{}"
		else
			for name in "${CASES[@]}"; do "${INT_SCRIPT}" "${name}"; done
		fi
	fi

	for name in "${CASES[@]}"; do
		log="${INT_LOG_DIR}/${name}.log"
		if grep -qF "__CASE_PASS__" "$log" 2>/dev/null; then
			echo "  ✅ ${name}"
			INT_PASS=$((INT_PASS + 1))
			TOTAL_PASS=$((TOTAL_PASS + 1))
		else
			rc="$(grep -oE "__CASE_FAIL__ rc=[0-9]+" "$log" 2>/dev/null | grep -oE "[0-9]+")"
			echo "  ✗  ${name}  -- rc=${rc:-timeout/NO_OUTPUT}"
			echo "     log: ${log}"
			INT_FAIL=$((INT_FAIL + 1))
			TOTAL_FAIL=$((TOTAL_FAIL + 1))
		fi
	done

	echo ""
	echo "================= PART 2 SUMMARY (${PRESET}) ================="
	echo "PASS=${INT_PASS}  FAIL=${INT_FAIL}"
	echo "------------------------------------------------------"
fi

# ─────────────────────────────────────────────────────────────────────────
# Part 3 — Workflow conformance (process-per-flow parallel)
# ─────────────────────────────────────────────────────────────────────────
if [[ "${SKIP_WORKFLOW}" == "1" ]]; then
	echo ""
	echo "Part 3 (workflow conformance) — SKIPPED (SKIP_WORKFLOW=1)"
else
	echo ""
	echo "============================================"
	echo " Part 3: Workflow conformance (parallel x${WF_PARALLEL})"
	echo "============================================"

	WF_DIR="${CLI_DIR}/scripts/integration/fixtures"
	WF_RUNNER="pnpm --filter @shofer/cli exec tsx scripts/integration/cases/workflow-conformance.ts"
	WF_ENV="PROVIDER=shofer API_KEY=shofer MODEL=${DS_MODEL} BASE_URL=${ROUTER_URL}"
	if [[ "${PRESET}" == "mock" ]]; then
		WF_ENV="PROVIDER=mock API_KEY=x MODEL=mock-model"
	fi

	# Collect fixture names (without .slang extension).
	shopt -s nullglob
	FIXTURES=()
	for f in "${WF_DIR}"/_*.slang; do
		base="$(basename "$f" .slang)"
		# Optional MATCH substring filter for single-fixture runs.
		if [[ -n "${MATCH:-}" && "$base" != *"${MATCH}"* ]]; then continue; fi
		FIXTURES+=( "$base" )
	done

	WF_LOG_DIR="$(mktemp -d)"
	# Logs are NOT auto-cleaned — they persist after the script exits so
	# failures can be inspected.  Clean up manually when done:
	#   rm -rf /tmp/tmp.XXXX

	# Export env vars so xargs child processes can access them.
	# CLI_DIR is the absolute path to apps/cli, already computed at line ~40.
	WF_CLI_DIR="${CLI_DIR}"
	export WF_ENV WF_LOG_DIR TIMEOUT_WF WF_CLI_DIR

	WF_PASS=0
	WF_FAIL=0

	WF_SCRIPT="${WF_LOG_DIR}/_wf_worker.sh"
	cat > "${WF_SCRIPT}" <<'WORKER_EOF'
#!/usr/bin/env bash
set -u
name="$1"
log="${WF_LOG_DIR}/${name}.log"

# cd into the CLI directory — WF_CLI_DIR is exported by the parent
# (absolute path, already resolved from BASH_SOURCE up there).
cd "${WF_CLI_DIR}" || exit 2

env MATCH="${name}" TIMEOUT_MS="$((TIMEOUT_WF * 1000))" ${WF_ENV} \
	pnpm --filter @shofer/cli exec tsx scripts/integration/cases/workflow-conformance.ts \
	> "${log}" 2>&1
WORKER_EOF
	chmod +x "${WF_SCRIPT}"

	# Process-per-flow isolation: each fixture runs in its own child
	# process, avoiding the singleton collision and process.exit(0)
	# issues in the in-process concurrency path.  xargs -P N drives
	# the desired level of parallelism.
	#
	# Guard against the nullglob edge case where no _*.slang files exist
	# (the printf would trip set -u on bash < 4.4).
	if [[ ${#FIXTURES[@]} -gt 0 ]]; then
		if [[ "${WF_PARALLEL}" -gt 1 ]]; then
			printf '%s\n' "${FIXTURES[@]}" | \
				xargs -P "${WF_PARALLEL}" -I{} "${WF_SCRIPT}" "{}"
		else
			# Serial mode (WF_PARALLEL=0 or 1): run fixtures one at a time.
			for name in "${FIXTURES[@]}"; do
				"${WF_SCRIPT}" "${name}"
			done
		fi
	fi

	# Collect results.
	for name in "${FIXTURES[@]}"; do
		log="${WF_LOG_DIR}/${name}.log"
		# grep -F avoids regex interpretation of fixture names containing
		# special characters (currently all safe, but this is defensive).
		if grep -qF "✅ ${name}:" "$log" 2>/dev/null; then
			echo "  ✅ ${name}"
			WF_PASS=$((WF_PASS + 1))
			TOTAL_PASS=$((TOTAL_PASS + 1))
		else
			# Parse the per-flow result line for the actual terminal status.
			# The runner's summary block never executes under MATCH=<single>
			# because api-harness.ts dispose() calls process.exit(0) after
			# the first iteration.  So we extract from the per-flow line
			# (workflow-conformance.ts:217-219), which uses `status=` not `got=`.
			reason=""
			reason="$(grep -oE "✗ ${name}: status=[^ ]+" "$log" 2>/dev/null | grep -oE "status=[^ ]+" | sed 's/status=//')"
			# Fall back: timeout line carries no status= prefix (workflow-conformance.ts:201).
			# The actual timeout line is "✗ <name>: waitForCompletion timed out after …"
			# (workflow-conformance.ts:201 + api-harness.ts:365), not "✗ <name>: timed out".
			if [[ -z "${reason}" ]] && grep -q "✗ ${name}:.*timed out" "$log" 2>/dev/null; then
				reason="TIMEOUT"
			fi
			echo "  ✗  ${name}  -- status=${reason:-NO_OUTPUT}"
			echo "     log: ${log}"
			WF_FAIL=$((WF_FAIL + 1))
			TOTAL_FAIL=$((TOTAL_FAIL + 1))
		fi
	done

	echo ""
	echo "================= PART 3 SUMMARY (${PRESET}) ================="
	echo "PASS=${WF_PASS}  FAIL=${WF_FAIL}"
	echo "------------------------------------------------------"
fi

# ── Overall summary (runs unconditionally, even if Part 2 was skipped) ──
echo ""
echo "================= OVERALL SUMMARY (${PRESET}) ================="
echo "TOTAL  PASS=${TOTAL_PASS}  FAIL=${TOTAL_FAIL}"

[ "${TOTAL_FAIL}" -eq 0 ]
