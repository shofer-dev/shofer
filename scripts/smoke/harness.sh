#!/usr/bin/env bash
#
# Shofer CLI smoke-test harness.
#
# Runs the Part-1 CLI scenarios documented in docs/test_harness.md against a
# chosen provider and reports a PASS/FAIL summary. The scenarios exercise the
# headless CLI end-to-end: provider routing, output formats, the stdin NDJSON
# stream protocol, session persistence, tool use (read_file / execute_command /
# write_to_file / new_task), mode switching, and signal handling.
#
# Two presets are provided:
#
#   mock    Hermetic mock provider — no network, no credentials, deterministic.
#           This is the gating preset: every scenario must PASS.
#
#   ds      DeepSeek via the local llm-router (http://localhost:30081/v1).
#           Requires the router to be reachable. Free-text scenarios are matched
#           leniently because a real model's exact wording is not guaranteed.
#
# Usage:
#   scripts/smoke/harness.sh [mock|ds]            # default: mock
#   PROVIDER="--provider …" MODEL="--model …" scripts/smoke/harness.sh   # custom
#
# Override knobs (env):
#   PROVIDER   provider flags (e.g. "--provider mock --api-key x")
#   MODEL      model flag    (e.g. "--model mock-model")
#   ROUTER_URL base URL for the `ds` preset (default http://localhost:30081/v1)
#   DS_MODEL   model for the `ds` preset    (default deepseek/deepseek-v4-pro)
#   TIMEOUT    per-scenario timeout seconds (default 120)
#
# Exit code: 0 if all scenarios pass, 1 otherwise.
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
declare -a RESULTS
ok() {
	RESULTS+=("PASS  $1")
	PASS=$((PASS + 1))
}
no() {
	RESULTS+=("FAIL  $1  -- $2")
	FAIL=$((FAIL + 1))
}

echo "Shofer CLI smoke harness — preset='${PRESET}'"
echo "  PROVIDER: ${PROVIDER}"
echo "  MODEL:    ${MODEL}"
echo "  WS:       ${WS_ROOT}"
echo ""

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
# that combo, run.ts:105). Deliver the follow-up turn through the stdin NDJSON
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
# shellcheck disable=SC2086
timeout 60 $CLI $PROVIDER $MODEL $WS --print "Count slowly to 100, one number per line." >/dev/null 2>&1 &
PID=$!
sleep 5
kill -INT $PID 2>/dev/null
wait $PID
rc=$?
[ $rc -ne 0 ] && ok "21 sigint" || no "21 sigint" "rc=$rc"

echo "=== 22 list sessions ==="
SL --print "Reply with: SESSION_MARKER" >/dev/null
# shellcheck disable=SC2086
out=$(timeout 60 $CLI $PROVIDER $MODEL $WS list sessions 2>/dev/null | head -5)
[ -n "$out" ] && ok "22 list-sessions" || no "22 list-sessions" "empty"

echo ""
echo "================= SUMMARY (${PRESET}) ================="
for r in "${RESULTS[@]}"; do echo "$r"; done
echo "------------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"

[ "$FAIL" -eq 0 ]
