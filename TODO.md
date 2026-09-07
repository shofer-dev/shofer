- **A child's dangerous-tool APPROVAL has no audience on a remotely driven host.**
  A child's `tool` / `command` / `use_mcp_server` approval asks are published only
  on the child's own stream, which a controller subscribed to the conversation's
  root does not consume, so a child that reaches for a gated tool parks. Unlike a
  QUESTION — which reaches its parent's mailbox as a `request` and is answered
  with `reply` — an approval has a different audience (whoever holds that
  authority on the project, not the parent), so it cannot inherit the question
  path: a controller's approval surface has to be part of the same change. Not
  urgent while deployed worker bundles auto-approve their declared groups; it is
  the first thing to break when one does not.

- **Three per-task shaping options have no caller.** `agentRole`,
  `agentToolGroups` and `agentContext` on `CreateTaskOptions` (and their
  `Task` fields) are live plumbing with nothing that sets them:
  `agentRole` prepends an `# Agent Role` block to the task's custom
  instructions, `agentToolGroups` narrows the assembled tool list to the
  declared groups (`restrictToolsToDeclaredGroups` in `build-tools.ts`), and
  `agentContext` is the first layer of the system-prompt section gates
  (`docs/system_prompt.md`). All three are threaded into the system-prompt cache
  key, so they work — nobody asks. Their sibling `completionSchema` is the
  exception: it IS driven, through `ctx.agent.spawn({ completionSchema })`
  (`docs/output_contract_enforcement.md`), which is also the shape of the fix.
  They were kept rather than deleted because they are general per-task shaping
  options and the plugin / agent-spawn seam is where a caller would want them.
  Two ways out, and one must be picked rather than left: **(a)** expose all
  three on `PluginAgentSpawnOptions` beside `completionSchema`, so one caller
  can describe a spawned task's role, tool surface and prompt sections through a
  single seam; or **(b)** delete them along with their prompt-assembly and
  build-tools threading. Leaving them is the status quo, which reads to the next
  reader as a supported feature.

- **Index identity is controller-scoped, not globally unique.** `_resolveIndexKeyPath`
  prefers the controller-assigned `codebaseIndexKey`, which fixes the case that bit us
  (executor pods all running `--workspace /home/node/workspace` colliding on one Qdrant
  collection despite unshared filesystems). It does NOT cover two _independent
  controllers_ that both sit at an identical path and share one Qdrant — they still
  derive the same collection name from different content. Closing that means deriving
  the key from something globally stable (git remote URL + repo root, or an explicit
  operator-assigned index id) rather than a path. Deferred: today every deployment has
  one controller per Qdrant, so the collision is unreachable.

- **The RAG indexer is transient.** The controller being the sole indexer is a
  consequence of the indexer living in-process. When it moves to a standalone k3s
  service that everyone queries, the plugin's `searchOnly` mode collapses — the controller
  becomes just another query client and the sole-writer invariant moves into the
  service. Don't build more machinery on top of "the controller is special" than the
  sole-writer rule already requires.

- **One dependency advisory left open**, and it is the only one: `pnpm audit`
  residue is 0 critical / 0 high / 0 moderate / 1 low.

    - `@ai-sdk/provider-utils` (via `sambanova-ai-provider`, runtime):
      GHSA-866g-f22w-33x8, low. There is genuinely no fixed release — the
      advisory covers `<=3.0.97` and the 3.x line stops at 3.0.31, so no
      patched 3.x exists. Escaping it means `@ai-sdk/provider-utils` 4.x/5.x,
      which belongs to AI SDK v6, while `sambanova-ai-provider` 1.2.2 pins
      `@ai-sdk/provider-utils` at exactly `3.0.5` against `@ai-sdk/provider`
      `2.0.0`. Forcing the jump would break the provider's API contract, so
      this waits on `sambanova-ai-provider` moving. Revisit when it does.

- **Three `pnpm.overrides` force a version outside the dependent's declared
  range.** Each replaces a transitive-only advisory the dependent has not
  picked up, and each was checked for module-format and API compatibility
  against the actual call site rather than assumed safe. Drop the override once
  the dependent's own range covers the fix:

    - `serialize-javascript@<7.0.5 → >=7.0.5` — `mocha` declares `^6.0.2` and
      no 6.x fix exists. 7.x is still CommonJS (`main: index.js`) with
      `engines.node >=20`, and `apps/vscode-e2e` (the only consumer, dev-only)
      runs mocha serially, where serialize-javascript is not even loaded — it
      is mocha's parallel-worker serializer.
    - `sharp@<0.35.0 → >=0.35.0` — `next` 16.2.12 (the newest) declares
      `sharp: ^0.34.5` as an _optional_ dep, used only by its image optimizer.
      The advisory is inherited libvips CVEs. `apps/web-evals` only, dev-only.
    - `uuid@<11.1.1 → >=11.1.1 <12` — `gaxios` 6.7.1 (under
      `google-auth-library` 9.15.1, a **runtime** dep of `packages/core` and
      also pulled by `@anthropic-ai/vertex-sdk` 0.7.0) declares `uuid ^9.0.1`
      and calls `require("uuid").v4()` for a multipart boundary;
      `@azure/msal-node` 3.5.3 (packaging-time, under `@vscode/vsce`) does
      `import { v4 } from "uuid"`. uuid 11 keeps both the CJS and ESM `v4`
      named exports, and both call sites were smoke-tested against it.
      Clearing this properly needs `google-auth-library` 10 (whose `gaxios` 7
      dropped `uuid` entirely), which in turn needs
      `@anthropic-ai/vertex-sdk` ≥0.19 and therefore `@anthropic-ai/sdk`
      `>=0.50.3` against the pinned `^0.37.0` — a real provider-code migration,
      not a version bump.

- **`undici` is capped at `>=6.27.0 <7` and that cap is correct, not debt.**
  6.27.0 is the _patched_ release; there is no open undici advisory. The cap is
  not silencing anything, and moving to 7 or 8 would be churn with no security
  benefit. (For the record, the Node floor is not what holds undici back:
  undici 7 needs only Node `>=20.18.1`, below the declared `>=20.19.2`. Only
  undici **8** needs Node `>=22.19.0`.)

- **A headless host's seeded approval posture is still persisted, and can shadow
  a policy added later.** `ExtensionHost` omits every approval key a `.shofer/`
  scope supplies, so an operator's config is authoritative and is never
  overwritten. But a key **no** scope supplies is still seeded, and the seed
  travels through `ContextProxy.setValue`, which write-throughs to the user
  scope's `~/.shofer/settings.json`. So a node with a persistent home that first
  ran with no approval config materialises `autoApprovalEnabled: true` (etc.)
  into its _user_ scope; if the operator later sets that key in the **global**
  scope without locking it, the unlocked merge (project > user > global) keeps
  the persisted seed winning. The workaround exists and is the intended one —
  name the key in the global scope's `locked.json`, which inverts the merge and
  makes the global value final — but "an unlocked global policy can be shadowed
  by a value the host itself wrote" is a sharp edge worth removing. The clean fix
  is an ephemeral settings-delivery path (a seed that populates `globalState`
  without write-through), which does not exist today; adding one touches every
  CLI-seeded setting, not just approvals, so it was left out of scope.

- **`packages/core`: `McpHub.updateServerConnections` RESTARTS EVERY MCP SERVER
  ON EVERY RECONCILE.** It compares the VALIDATED config held on the connection
  — which carries the schema's defaults (`timeout: 60`, `disabledTools: []`, a
  defaulted `cwd`) — against the RAW config read from the file, so for a normal
  entry the two can never be `deepEqual` and the "changed config" branch always
  fires: `deleteConnection` + `connectToServer`. Every stdio server's child
  process is killed and respawned whenever `mcp.json` is written, a workspace
  folder changes, or `refreshProjectMcpServers` runs after a plugin change. The
  no-change branch is reachable only if the caller feeds back the validated
  shape. The comparison has to be like-for-like — validate the incoming config
  before diffing it, or diff against the raw config the connection was built
  from.

- **`packages/core`: `Task._cleanupOrphanedToolUses` throws `TypeError` (reading
  `'role'`).** Its backward pass nulls a message, and a later message's scan
  then dereferences the nulled slot. It runs immediately before an API request,
  so the whole turn fails instead of the history being cleaned — and it is
  reachable whenever truncation leaves a leading unanchored `tool_result`,
  which is the exact situation the function exists to repair.

- **`packages/core`: `ExecuteCommandTool.onShellExecutionComplete` dereferences
  `details.exitCode` unguarded**, throwing inside the terminal callback — where
  the tool's own `try`/`catch` cannot see it, so the failure escapes the tool's
  error handling entirely.

- **`packages/core`: `ApplyPatchTool`'s per-file existence guards are dead
  code.** `processAllHunks` reads the file first and throws `ENOENT`, so the
  tailored per-file messages below it are unreachable and the model only ever
  sees the generic error.

- **`packages/core`: `CheckTaskStatusTool`'s completion-result transcript read
  is not wrapped in `try`/`catch`**, while the `include_activity` read of the
  same file is. So an unreadable transcript throws on the path that matters
  most — the one asking for the result.

- **`src/`: `PluginPanelManager.buildHtml` interpolates
  `JSON.stringify(config)` unescaped into a `<script>` block.**
  `JSON.stringify` does not escape `</script>`, so a plugin config value
  containing that sequence breaks out of the tag and the remainder is parsed as
  markup in the panel.

- **`src/`: `OpenAiCodexHandler`'s refresh-and-retry-once loop is DEAD CODE.**
  `executeRequest` catches every SDK error, 401 included, and falls back to the
  raw SSE transport — so the auth-retry arm is never reached, and the raw SSE
  path is what actually runs in production. Either the catch has to let 401
  through to the retry, or the retry arm should go.

- **`src/`: `mergeJson`'s catch handler re-reads the file it just failed on**,
  so a corrupt file is parsed twice and the second failure escapes the guard
  rather than being handled by it.

- **`src/`: `VsCodeLmHandler`'s constructor fires `initializeClient()`
  fire-and-forget**, so a `selectChatModels` that fails at construction becomes
  an unhandled rejection instead of a surfaced error the caller can report.

- **`src/`: `ShoferProvider.getState()` carries ~40 statements of dead
  cloud-surface code** — `try`/`catch` blocks wrapped around resolved constants
  for retired cloud / sharing / org surfaces, whose catch arms can never run.
  Removing them is the Dead Config/Code Rule applied to a function every state
  broadcast passes through.

- **`webview-ui`: `UpdateTodoListToolBlock` renders infinitely when given no
  todos.** The default `todos = []` is a fresh array on each render, so its
  `useEffect` keyed on `[todos]` re-fires forever. It is reachable from
  `ChatRow` via `say: "user_edit_todos"`, which renders the block with no
  todos — so this is a live hang, not a theoretical one. That case is
  **deliberately omitted** from `ChatRow.variants.spec.tsx`, with a comment
  saying why: including it hangs the test runner at collection. Whoever fixes
  the effect (a stable empty-array reference, or keying on contents) removes
  that omission in the same change.

- **`webview-ui`: `useScrollLifecycle`'s `SCROLL_DEBUG` is hard-false**, so the
  four `vscode.postMessage` diagnostic blocks behind it are dead code.

- **`apps/cli`, `packages/telemetry`: an EPIPE on stdout surfaces as an
  `unhandledRejection`.** `useGlobalInput`'s Ctrl+C double-press does
  `cleanup().finally()` with no `catch`, and `json-event-emitter`'s
  `writeToStdout` has the same shape. An EPIPE there is an ordinary
  driver-shutdown race for that transport — the reader going away first — so
  the normal ending of a piped session is reported as a crash.

- **`apps/cli`: `stdin-stream`'s `pendingQueuedMessageRequestIds` is only ever
  shifted, never pushed to.** The documented `taskCompleted` re-attribution of
  queued-message request ids therefore never happens; the array is always
  empty and the feature is dead code with a doc comment describing it as live.

- **`apps/cli`: `upgrade.ts`'s `getLatestCliVersion` bypasses `compareVersions`
  for the first candidate tag**, so a malformed `cli-v` tag becomes `'latest'`
  and `upgrade()` then dies on it. One bad tag in the listing is enough.

- **`apps/cli`: `run.ts` validates `--output-format` only when a TTY is
  present**, so an invalid value is silently accepted when the CLI is piped
  without `--print` — the case where a machine consumer is reading the output
  and least able to notice.
