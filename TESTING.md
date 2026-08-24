# Shofer — Test Runbook

## One command — full harness (Parts 1 + 2)

```bash
# Hermetic mock — no network, no credentials, deterministic
cd extensions/shofer && bash scripts/smoke/harness.sh mock

# DeepSeek via local llm-router — needs the router on :30081
cd extensions/shofer && bash scripts/smoke/harness.sh ds
```

Output goes to **stdout**: a per-scenario PASS/FAIL for Part 1 (CLI scenarios)
and Part 2 (integration protocol cases), then an overall summary. Exit code 0 =
all passed.

Part 2 drives genuinely slow multi-turn tool flows, so it needs a real provider
and is **skipped under the `mock` preset**.

## Knobs

| Env                | Default                     | Effect                                              |
| ------------------ | --------------------------- | --------------------------------------------------- |
| `PROVIDER`         | per preset                  | Provider flags (e.g. `--provider mock --api-key x`) |
| `MODEL`            | per preset                  | Model flag (e.g. `--model mock-model`)              |
| `ROUTER_URL`       | `http://localhost:30081/v1` | Base URL for the `ds` preset                        |
| `DS_MODEL`         | `deepseek/deepseek-v4-pro`  | Model for the `ds` preset                           |
| `TIMEOUT`          | 120 (`ds`: 300)             | Part 1 per-scenario timeout (seconds)               |
| `TIMEOUT_INT`      | 180 (`ds`: 600)             | Part 2 per-case timeout (seconds)                   |
| `INT_PARALLEL`     | 4                           | Part 2 concurrency (`xargs -P N`)                   |
| `MATCH`            | —                           | Substring filter over Part 2 case names             |
| `SKIP_CLI`         | 0                           | Set to 1 to skip Part 1                             |
| `SKIP_INTEGRATION` | 0                           | Set to 1 to skip Part 2                             |

## Harness — Part 2 (integration cases) standalone

Each case in `apps/cli/scripts/integration/cases/` is a self-contained script
that drives the CLI as a subprocess over the stdin NDJSON stream protocol and
exits non-zero on an assertion failure. Run one directly for focused debugging:

```bash
cd extensions/shofer/apps/cli

PROVIDER=shofer API_KEY=shofer MODEL=deepseek/deepseek-v4-pro \
  BASE_URL=http://localhost:30081/v1 TIMEOUT_MS=180000 \
  pnpm --filter @shofer/cli exec tsx scripts/integration/cases/start-while-busy.ts
```

Or the whole part through the harness, skipping Part 1:

```bash
cd extensions/shofer
SKIP_CLI=1 bash scripts/smoke/harness.sh ds
# one case:
SKIP_CLI=1 MATCH=cancel-active-task bash scripts/smoke/harness.sh ds
```

The harness writes one log per case into a `mktemp -d` directory and prints the
path of any that failed. The directory persists after the run — clean it up by
hand.

## Unit tests

Never `pnpm test` or `turbo test` — both spawn every package concurrently and
saturate the machine. Run vitest per package, sequentially; the per-package
recipe is `.shofer/commands/test.md`. The two most common:

```bash
# Main extension (skip the e2e tests that need a live VS Code runtime)
cd extensions/shofer/src && npx vitest run --exclude '**/e2e/**'

# Core engine
cd extensions/shofer/packages/core && npx vitest run
```

For a single file:

```bash
cd extensions/shofer/packages/core
npx vitest run src/tools/__tests__/attemptCompletionTool.spec.ts
```

## Expected results

| Suite                                 | Mock                                 | DS                    |
| ------------------------------------- | ------------------------------------ | --------------------- |
| `harness.sh` Part 1 (CLI 1–14, 20–22) | 16/17 PASS (FAIL: #8 session-resume) | 16/17 PASS (FAIL: #8) |
| `harness.sh` Part 2                   | skipped (needs a real provider)      | all cases PASS        |

Known issue: scenario #8 (session-resume) fails on both presets. This is an
infrastructure limitation of CLI headless mode (`viewLaunched` is `false`), not
a regression.

## References

- [`docs/test_harness.md`](docs/test_harness.md) — the full L1 scenario and case
  catalog, plus the pointer to the L2 code-server E2E package.
