# Code Quality Rules

1. Test Coverage:

    - Before attempting completion, always make sure that any code changes have test coverage
    - Ensure all tests pass before submitting changes
    - The vitest framework is used for testing; the `vi`, `describe`, `test`, `it`, etc functions
      are configured as globals (via each package's `vitest.config.ts`) and therefore don't need to
      be imported from `vitest`
    - This is a pnpm/turbo monorepo of separate packages, each with its own `vitest`. Never run
      `pnpm test` or `turbo test` — they fan out across every package at once and saturate the CPU
      alongside local LLM inference, hanging the machine (see `commands/test.md`).
    - Instead, run vitest per-package, from inside the package that owns the test (the dir with the
      `package.json` that lists `vitest`), with `npx vitest run <path-relative-to-that-package>`:
        - Types: `cd packages/types && npx vitest run`
        - Main extension: `cd src && npx vitest run --exclude '**/e2e/**'` (path excludes the `src/`
          prefix; e2e specs need a live VSCode runtime)
        - CLI: `cd apps/cli && npx vitest run`
        - Other packages, only when their files changed: `packages/core`, `packages/ipc`,
          `packages/telemetry`
        - Webview UI: `cd webview-ui && npx vitest run`
    - Do NOT run tests from the repo root — vitest is not installed there ("command not found")
    - Example: for `src/core/foo.spec.ts`, run `cd src && npx vitest run core/foo.spec.ts`

2. Lint Rules:

    - Never disable any lint rules without explicit user approval

3. Styling Guidelines:

    - Use Tailwind CSS classes instead of inline style objects for new markup
    - VSCode CSS variables must be added to webview-ui/src/index.css before using them in Tailwind classes
    - Example: `<div className="text-md text-vscode-descriptionForeground mb-2" />` instead of style objects
