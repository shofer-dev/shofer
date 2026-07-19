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
  zod-to-ts) and breaks them (TS 7 ships no classic compiler API). There is no
  distinctly-named stable wrapper to escape that collision: `@typescript/native`
  does not exist on npm (confirmed against the public registry — not a Nexus
  mirroring gap), and `@typescript/native-preview` has no non-`-dev` release yet.
  So `tsgo` (a pre-GA build of the same TS 7 engine) is the best available TS 7
  compiler with a non-colliding package name. Revisit when either a stable
  distinctly-named native package ships, or typescript-eslint + tsup gain TS 7 /
  API support — at which point the whole toolchain can collapse onto a single
  `typescript@7` and `check-types` can go back to `tsc`.

- Replace bare `console.log` in extension-host code (AGENTS.md Output Channel Logging Rule — use the shared output channel, not `console.log`): `src/integrations/diagnostics/index.ts` (3 calls), `src/api/providers/vscode-lm.ts` (1 call).

- Give `ask` messages a **typed per-category payload** instead of overloading
  `ShoferMessage.text`. Today an `ask`'s data is category-specific and untyped:
  `command` → raw shell string in `text`; `followup` → question/suggestions;
  `tool` → JSON-ish; `command_output` → empty. Every non-webview AgentApi consumer
  (user-console, ACP clients) re-parses this per category with ad-hoc heuristics
  that drift. Keep the `ask` discriminant but replace the free-text payload with a
  typed field per category in `@shofer/types` (a discriminated union —
  `commandAsk:{command}`, `toolAsk:{tool,args}`, `followupAsk:{question,suggestions}`,
  …) so consumers get one stable, testable contract. NOT a flat opaque envelope
  (that just relocates the per-category logic). Blast radius: the message contract +
  the webview `ChatRow` per-category rendering + the ACP mapping + tests — do it when
  a second non-webview consumer needs interactive approvals (L2 runs auto-approve, so
  it doesn't today).

- **Index identity is controller-scoped, not globally unique.** `_resolveIndexKeyPath`
  prefers the controller-assigned `codebaseIndexKey`, which fixes the case that bit us
  (executor pods all running `--workspace /home/node/workspace` colliding on one Qdrant
  collection despite unshared filesystems). It does NOT cover two *independent
  controllers* that both sit at an identical path and share one Qdrant — they still
  derive the same collection name from different content. Closing that means deriving
  the key from something globally stable (git remote URL + repo root, or an explicit
  operator-assigned index id) rather than a path. Deferred: today every deployment has
  one controller per Qdrant, so the collision is unreachable.

- **The RAG indexer is transient.** The controller being the sole indexer is a
  consequence of the indexer living in-process. When it moves to a standalone k3s
  service that everyone queries, `codebaseIndexSearchOnly` collapses — the controller
  becomes just another query client and the sole-writer invariant moves into the
  service. Don't build more machinery on top of "the controller is special" than the
  sole-writer rule already requires.
