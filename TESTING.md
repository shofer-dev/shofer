# Shofer — Test Runbook

## One command — full harness (Parts 1 + 2)

```bash
# Hermetic mock — no network, deterministic, all 40 scenarios pass in ~30s
cd extensions/shofer && bash scripts/smoke/harness.sh mock

# DeepSeek via local llm-router — needs router on :30081, ~5-10 min
cd extensions/shofer && bash scripts/smoke/harness.sh ds
```

Output goes to **stdout**: a per-scenario PASS/FAIL for Part 1 (CLI) and Part 2
(workflow conformance), then an overall summary. Exit code 0 = all passed.

## Knobs

| Env           | Default | Effect                                |
| ------------- | ------- | ------------------------------------- |
| `TIMEOUT`     | 120     | Part 1 per-scenario timeout (seconds) |
| `TIMEOUT_WF`  | 600     | Part 2 per-fixture timeout (seconds)  |
| `WF_PARALLEL` | 4       | Part 2 concurrency (`xargs -P N`)     |
| `SKIP_PART2`  | 0       | Set to 1 to skip workflow suite       |

## Harness — Part 2 (workflow conformance) standalone

Part 2 is a TypeScript runner that discovers all `_*.slang` fixtures and runs
them sequentially. You can invoke it directly for more control:

```bash
cd extensions/shofer/apps/cli

# All 23 fixtures — mock (~2s)
PROVIDER=mock API_KEY=x MODEL=mock-model WORKSPACE="$(pwd)/../../.." \
  pnpm --filter @shofer/cli exec tsx scripts/integration/cases/workflow-conformance.ts

# All 23 fixtures — DS (~5 min sequential)
PROVIDER=shofer MODEL=deepseek/deepseek-v4-pro BASE_URL=http://localhost:30081/v1 \
  WORKSPACE="$(pwd)/../../.." \
  pnpm --filter @shofer/cli exec tsx scripts/integration/cases/workflow-conformance.ts

# Single fixture — useful for isolating failures
MATCH=output-schema PROVIDER=mock API_KEY=x MODEL=mock-model \
  WORKSPACE="$(pwd)/../../.." \
  pnpm --filter @shofer/cli exec tsx scripts/integration/cases/workflow-conformance.ts

# Single fixture — DS
MATCH=output-schema PROVIDER=shofer MODEL=deepseek/deepseek-v4-pro \
  BASE_URL=http://localhost:30081/v1 WORKSPACE="$(pwd)/../../.." \
  pnpm --filter @shofer/cli exec tsx scripts/integration/cases/workflow-conformance.ts
```

### Parallel (process-per-flow) via `xargs`

The harness script does this internally, but you can run it by hand:

```bash
cd extensions/shofer/apps/cli
ls ./scripts/integration/fixtures/_*.slang | sed 's/.*/_//;s/\.slang//' | \
  xargs -P 4 -I{} sh -c \
    'MATCH={} PROVIDER=mock API_KEY=x MODEL=mock-model WORKSPACE="$(pwd)/../../.." \
     pnpm --filter @shofer/cli exec tsx scripts/integration/cases/workflow-conformance.ts \
     > /tmp/wf_{}.log 2>&1'
# Check results:
grep -l "✅" /tmp/wf_*.log | wc -l   # passed
grep -l "✗" /tmp/wf_*.log | wc -l   # failed
```

## Unit tests

Run from `extensions/shofer/src`:

```bash
cd extensions/shofer/src

# Lever 1 schema swap tests (8 tests)
npx vitest run core/workflow/__tests__/contract-to-json-schema.test.ts

# All workflow tests (6 files, 175 tests)
npx vitest run core/workflow/

# All attempt-completion tests (19 tests)
npx vitest run core/tools/__tests__/attemptCompletionTool.spec.ts

# Full core suite (workflow + tools + task — 61 files, 865 tests)
npx vitest run core/workflow/ core/tools/ core/task/

# Every test in the project
npx vitest run
```

## Logs

Each run prints per-fixture results inline to stdout:

```
[workflow-conformance] ✅ _output-schema: status=converged want=converged children=0 (114ms)
[workflow-conformance] ✗ _commit-if: status=budget_exceeded want=converged children=0 (60123ms)
```

### Harness Part 2 per-fixture logs

The harness script writes per-fixture logs to a temp dir (`mktemp -d`). The
dir is cleaned up on exit. To preserve logs for inspection:

```bash
TMPDIR=/tmp/shofer_logs bash scripts/smoke/harness.sh ds
ls /tmp/shofer_logs/          # _await-any.log, _output-schema.log, …
head -5 /tmp/shofer_logs/_output-schema.log
```

## Expected results

| Suite                                 | Mock                                 | DS                    |
| ------------------------------------- | ------------------------------------ | --------------------- |
| `harness.sh` Part 1 (CLI 1–14, 20–22) | 16/17 PASS (FAIL: #8 session-resume) | 16/17 PASS (FAIL: #8) |
| `harness.sh` Part 2 (23 fixtures)     | 23/23 PASS                           | 23/23 PASS            |
| Workflow unit tests                   | 175/175 PASS                         | N/A                   |
| CLI unit tests                        | 131/131 PASS                         | N/A                   |
| Full core suite (865)                 | 865/865 PASS                         | N/A                   |

Known issue: test #8 (session-resume) fails on both mock and DS. This is an
infrastructure limitation in CLI headless mode (`viewLaunched` is `false`),
not a regression.
