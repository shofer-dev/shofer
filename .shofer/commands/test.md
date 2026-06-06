# Running Tests Safely

## The Problem

Running `pnpm test` from the monorepo root (`extensions/shofer/`) triggers
Turbo, which executes **all 13 packages' test suites concurrently**. This
includes:

- A 29-second Vite build for the webview (~16 MB source maps)
- A 35-second esbuild bundle for the extension (700K+ line CJS file)
- Multiple vitest worker pools (up to `os.cpus().length` workers each)

On a machine also running LLM inference (Ollama with DeepSeek models), this
saturates CPU cores and can **hang the system entirely**.

Turbo has no concurrency cap on `test` tasks — all 13 packages compete for all
CPU cores simultaneously.

## The Safe Approach

Run vitest **per-package, sequentially**, targeting only the packages affected
by your changes. Use `--exclude '**/e2e/**'` to skip end-to-end tests that
require a live VSCode runtime.

### Step 1: Types package (`packages/types`)

```bash
cd extensions/shofer/packages/types
npx vitest run
```

Covers: IPC schemas, event types, history types, mode types, tool types,
provider settings, global settings, CLI types, etc.

### Step 2: Main extension (`src`)

```bash
cd extensions/shofer/src
npx vitest run --exclude '**/e2e/**'
```

Covers: API, logging, tools, core, webview, providers, config, ignore, workflow,
etc. (~400 test files, ~5600 tests).

### Step 3 (if needed): CLI (`apps/cli`)

```bash
cd extensions/shofer/apps/cli
npx vitest run
```

### Step 4 (if needed): Core, IPC, Telemetry, Eval packages

```bash
cd extensions/shofer/packages/core && npx vitest run
cd extensions/shofer/packages/ipc && npx vitest run
cd extensions/shofer/packages/telemetry && npx vitest run
cd extensions/shofer/packages/evals && npx vitest run
```

### Step 5 (if needed): Webview UI

```bash
cd extensions/shofer/webview-ui
npx vitest run
```

### Optional: Targeted file runs

For quick iteration, run only the files you changed:

```bash
cd extensions/shofer/src
npx vitest run path/to/test1.spec.ts path/to/test2.spec.ts
```

## What NOT to do

- ❌ `pnpm test` from the monorepo root — hangs the machine
- ❌ `turbo test` — same as above
- ❌ Running e2e tests without a VSCode instance

## Current State (last verified 2026-06-06)

- `@shofer/types`: **166 tests, 0 failures**
- `shofer` (main extension): **5554 passed, 69 pre-existing failures** (none in
  our changed files)
