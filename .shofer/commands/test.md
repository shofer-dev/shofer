# test

Run unit tests. Do NOT run `pnpm test` or `turbo test` — both spawn all
13 packages concurrently and saturate the CPU alongside the locally-running
LLM inference (Ollama), hanging the machine.

Instead, run vitest per-package, sequentially:

```bash
# Types package — IPC schemas, event types, history, modes, settings, etc.
cd extensions/shofer/packages/types
npx vitest run

# Main extension — API, logging, tools, core, webview, providers, etc.
# Skip e2e tests that require a live VSCode runtime.
cd extensions/shofer/src
npx vitest run --exclude '**/e2e/**'

# CLI
cd extensions/shofer/apps/cli
npx vitest run

# Other packages (only when their files changed)
cd extensions/shofer/packages/core   && npx vitest run
cd extensions/shofer/packages/ipc   && npx vitest run
cd extensions/shofer/packages/telemetry && npx vitest run

# Webview UI
cd extensions/shofer/webview-ui
npx vitest run
```

For quick iteration on a single file:

```bash
cd extensions/shofer/src
npx vitest run path/to/test.spec.ts
```
