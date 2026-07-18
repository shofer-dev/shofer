- Parallel Live Memory

- "Global Settings (JSON-only, no settings UI)" expose these settings on the Settings UI. Move these out of settings.json:
  | Setting | Purpose | Default |
  | -------------------------------- | ---------------------------------------- | ----------------- |
  | `shofer.defaultCostLimit` | Per-task USD budget cap | `null` (disabled) |
  | `shofer.disabledTools` | Globally disable specific tools | `[]` |
  | `shofer.useAgentRules` | Load `AGENTS.md` rule files from project | `true` |
  | `shofer.commandExecutionTimeout` | Max seconds for command execution | `0` (no timeout) |
  | `shofer.commandTimeoutAllowlist` | Commands exempt from timeout | `[]` |

- DEV Simplify the Settings overlay (use VScode's own settings.json)

- DEV memories (copilot_memory, copilot_resolveMemoryFileUri) (filter by age)

- preemptive summarization (in the background)

- test the migration commands

- TypeScript 7 checker uses the **`@typescript/native-preview`** (`tsgo`) dev
  build, not stable `typescript@7`. Stable TS 7 can't be a devDep here: its
  package's real name is `typescript`, so under pnpm it hijacks the `typescript`
  peer of every TS 6-only consumer (typescript-eslint, tsup's `.d.ts` generator,
  zod-to-ts) and breaks them (TS 7 ships no classic compiler API). The clean fix
  is Microsoft's distinctly-named `@typescript/native` wrapper — **not mirrored
  in our Nexus npm proxy** (404). When it lands there, replace
  `@typescript/native-preview` (bin `tsgo`) with `@typescript/native` (bin `tsc`)
  and point the `check-types` scripts back at `tsc`.

- Replace bare `console.log` in extension-host code (AGENTS.md Output Channel Logging Rule — use the shared output channel, not `console.log`): `src/integrations/diagnostics/index.ts` (3 calls), `src/api/providers/vscode-lm.ts` (1 call).
