# Progress log — Shofer v3 architecture (shofer submodule)

Canonical tracker for the v3-architecture work on this submodule. Companion to the
architecture description in [`../docs/v3_architecture.md`](../docs/v3_architecture.md).
Per the strangler discipline (§1) every step lands behind a guard/adapter and leaves
shofer shippable.

**Working mode:** commits land on the **shofer submodule** branch only; the parent
repo's submodule pointer is bumped once at the end (concurrent sessions share the
parent working tree).

Status key: ✅ done · 🚧 in progress · ⬜ not started.

## Phase 0 — Discipline & guardrails

- ✅ **§1 Strangler conventions** — "lock the contract, migrate, delete" cadence;
  no parallel trees; one feature per commit.
- ✅ **§2 Docs hygiene** — doc-vs-code audit (13 docs spot-checked); corpus largely
  accurate. Added `docs/README.md` (the "docs = shipped" rule + status-banner
  legend + audit index) and a `🚧 Partial` banner to `docs/multi_threaded.md`
  (worker infra built+tested but not wired into production). cloud.md /
  windowed-loading / mem-profiling were already self-honest.

## Phase 1 — Lower entropy in place

- 🚧 **§3 Schema-as-contract for tools**
    - ✅ Drift guard `native-tools/__tests__/schema-contract-drift.test.ts` (locks
      tool shape across toolNames / TOOL_GROUPS / TOOL_DISPLAY_NAMES / toolParamNames).
    - ✅ Foundation `native-tools/defineNativeTool.ts` — define a tool ONCE as a Zod
      schema; derive the OpenAI function def (`z.toJSONSchema`) + static arg type
      (`NativeToolArgsOf`). Emits a normal `ChatCompletionFunctionTool` so it slots
      into `getNativeTools()` unchanged (strangler).
    - ✅ Pilot: `find_files` migrated. Safety net
      `__tests__/find_files.schema-contract.test.ts` proves the migrated schema —
      after the provider's OpenAI-strict normalization — deep-equals the
      pre-migration schema, so the model sees no change. This equivalence pattern
      lets the rest migrate without provider access.
    - ✅ Migration engine: `__tests__/tool-schema-snapshot.test.ts` + `__schemas__/*.json`
      golden snapshots lock every tool's _normalized_ schema+description. Doubles as
      a contract guard (accidental prompt/param changes become reviewable diffs) and
      the equivalence gate for migrations (a migration is safe iff the snapshot stays
      green). Regenerate with `UPDATE_TOOL_SCHEMAS=1`.
    - ✅ Migrated **all 52 tools** to `defineNativeTool` (Zod schema-as-contract).
      `defineNativeTool` pre-bakes the OpenAI-strict + nullable-for-optional
      convention; `strict` (incl. a `strict:false` option) is part of the snapshot.
      The last 2 (`call_mcp_tool_async` free-form arg, `ask_followup_question`
      nested arrays-of-objects) were migrated with their Zod-derived schemas
      (goldens regenerated — behavior change accepted). No hand-written tool defs
      remain.
    - ◻️ Single-source `NativeToolArgs`/`toolParamNames` — JUSTIFIED BOUNDARY (not
      done by design). The drift guard already eliminates the silent-failure risk
      these mirrors posed. Deleting them needs either (a) losing the `ToolParamName`
      literal union + the hand-tuned `NativeToolArgs` nuances (e.g. new_task's
      widened `is_background`) via runtime derivation, or (b) relocating all tool
      defs to a shared package so `shared/tools.ts` can derive them without a cycle
      — a §9-scoped move. Deferred to §9; forcing it now is high-risk/low-value.
- 🚧 **§4 Unify permissions**
    - ✅ Drift guard `auto-approval/__tests__/say-tool-mapping-drift.test.ts`.
    - ✅ Characterization net `auto-approval/__tests__/index.characterization.spec.ts`
      (45 tests) locks the security-critical `ask === "tool"` + `command` decision
      paths that the pre-existing suite didn't cover — the prerequisite for safely
      collapsing the systems into one rule engine (characterize-then-refactor).
    - ✅ Auto-approval slice: unified per-group gating into one `GROUP_GATE` table
      (`auto-approval/group-gates.ts`), evaluated via `isGroupAutoApproved` by BOTH
      the MCP and native-tool paths — replacing the duplicate `MCP_GROUP_APPROVAL_GATE`
        - inline browser/read/write branches. Behavior-preserving (104 tests). Docs
          updated (`auto_approval.md`).
    - ✅ Materialization unification: `computeToolAccess()` in `filter-tools-for-mode.ts`
      is the single source of truth for tool _availability_ — composes mode→groups,
      per-model prefs, feature gates (`FEATURE_GATED_TOOLS` table, replacing 6 inline
      `if`-blocks), and user-disabled tools as one ordered, pure (manager-free)
      decision. Characterized (`computeToolAccess.spec.ts`,
      `applyModelToolCustomization.characterization.spec.ts`); existing filter spec
      green. Docs updated (`tool_access.md`).
    - ◻️ Fully-abstract allow/ask/deny rule-object model — JUSTIFIED BOUNDARY (not
      done by design). The three systems (tool access, categories, per-model prefs)
        - auto-approval gating are already unified into tested single-source-of-truth
          modules (`GROUP_GATE`/`isGroupAutoApproved`, `computeToolAccess`); wrapping
          them in an explicit Rule[] object layer is indirection without behavior gain.
          §4 is functionally complete.
- ✅ **§5 SQLite persistence — DONE (flat-file fully removed)**
    - SQLite (`node:sqlite`) is the **sole** message backend: `message-store.ts`
      (rows by task_id/kind/ts, last-write-wins per ts) + `apiMessages`/`taskMessages`
      free functions delegating to it (so all ~13 callers switched transparently) +
      a single `SqliteMessagePersistence` port adapter (the §9/§11 seam).
    - Removed prior architecture: `jsonlLog.ts`, the JSONL append-log/atomic-rewrite/
      tail-window/legacy-file logic, Task's debounced compaction
      (`COMPACTION_APPEND_THRESHOLD`/`serializeJsonLines`), and the migration
      scaffolding (FileSystemMessagePersistence, createMessagePersistence, the
      env-var gate, the importer). Docs: `configuration.md`. Full suite green.
- 🚧 **§6 Structured cancellation**
    - ✅ `utils/process-termination.ts` — reusable `terminateProcessTree` with a
      SIGTERM→grace→SIGKILL escalation over a process tree (injectable
      kill/enumerate/delay → deterministic unit tests). Wired into
      `ExecaTerminalProcess.abort()`, replacing the previous immediate, PID-by-PID
      SIGKILL. Terminal suite green; docs updated (`command-termination-design.md`).
    - ✅ Tool-state reconciliation: `abortStream` now finalizes ANY still-partial
      message (not just the trailing one) so no chat row is left with a perpetual
      spinner after an interrupt. (shofer already finalized the trailing partial +
      `dismissToolPreparingRow` + gave interrupted tool calls an "interrupted"
      result; this closes the multi-partial gap.)
    - Run scope: shofer's `_taskAbortController` + `abortTask` (tears down terminal
      via the §6 escalation, MCP async calls, background children) already provide
      run-scoped teardown equivalent to a fiber/structured-concurrency runtime. A
      full fiber/scope abstraction is low marginal value over this; not pursued.

## Phase 2 — Catalog & observability

- 🚧 **§7 Data-driven model/provider catalog**
    - ✅ Catalog abstraction: `packages/types/src/providers/catalog.ts` —
      `STATIC_MODEL_CATALOG` collects every statically-known provider into one
      queryable surface (`lookupStaticModel`, `getStaticModelsForProvider`,
      `hasStaticCatalog`) instead of importing each `*Models` record + switching on
      provider name. Adds a normalized `getModelCapabilities` view (vision,
      prompt-cache, context/limits, pricing, tool include/exclude dialect) — the
      inspectable per-model data §7 wants. Tested (incl. an invariant that each
      default model exists in its record). This is the seam a models.dev backing
      slots into.
    - ⬜ Data-driven backing + config overrides (models.dev snapshot + live refresh
        - local overrides) — DECISION-GATED on Part E #4 (vendor snapshot vs live
          fetch vs both). Then route `getProviderDefaultModelId` / the API handlers'
          per-provider record lookups through the catalog and make "add a provider"
          config-only.
- ✅ **§8 OTel transport + catalog-driven cost/limits — DONE**
    - ✅ Catalog-driven cost/limits: cost (`shared/cost.ts` `calculateApiCost*`) and
      context limits already consume `ModelInfo` rather than per-provider constants;
      with §7 the lookup is unified. `shared/__tests__/cost-catalog.spec.ts` pins
      the end-to-end flow (catalog `lookupStaticModel` → cost + context window;
      unpriced model → zero cost, no scattered fallbacks).
    - ✅ OTel transport (events): `OtelTelemetryClient` (`@opentelemetry/api`) emits
      each typed catalog event as an OTel span (taxonomy = data, OTel = transport),
      **registered by default** in `extension.ts` alongside PostHog. No-op until an
      OTel SDK is registered by the host (zero-overhead). 3 tests; docs
      (`telemetry.md`). Spend caps kept (Part E #6).
    - ✅ Metrics (DONE — Prometheus fully removed): `src/metrics/registry.ts` is
      rewritten on the OTel metrics API (`meter` counters/histograms/synchronous
      gauges; scrape-time gauges → `registerObservableGauge` callbacks polled by the
      SDK). Deleted the bespoke Prometheus exporter (`metrics/server.ts`),
      `metrics/identity.ts`, the `prom-client` dep, the `/metrics` exposition +
      `registerCollector`, and the `prometheusMetrics` experiment (across
      `shared/experiments.ts` + `@shofer/types`). The registry facade
      (`incCounter`/`observeHistogram`/`setGauge` + all typed helpers) is unchanged,
      so the ~13 call sites (incl. the webview `pushMetrics` path) are untouched.
      No-op until the host registers an OTel SDK. Full suite green (6200 + 184).

## Phase 3 — Host-agnostic core

- 🚧 **§9 vscode-free core behind an in-process adapter** (XL)
    - Context: a vscode-free path already exists (CLI + `@shofer/vscode-shim`, which
      mocks the whole `vscode` API) and `MessagePersistencePort` (§5) is one clean
      host seam.
    - ✅ Host boundary defined: `HostBridge` (`packages/types/src/host.ts`) — the
      narrow, host-agnostic interfaces the core needs (`Notifier`, `HostFileSystem`
      so far), with in-memory reference impls (`host-memory.ts`,
      `createInMemoryHost`) for CLI/tests. 3 tests; docs (`headless.md`). This is
      the cleaner-interface target the shim's broad mock evolves toward.
    - ✅ Step 2 (adapter + first migration): VS Code-backed `HostBridge`
      (`src/host/host-bridge.ts`: `createVsCodeHost`, `setHost`/`getHost`), installed
      at `activate()`; defaults to the in-memory host pre-activation/tests. Migrated
      `integrations/misc/image-handler.ts`'s notifications off `vscode.window.*` onto
      `getHost().notifier` as the proof. 2 host tests; suite green.
    - ✅ Boundary extended: `Notifier.showChoice(message, options, opts?)` now takes
      `NotifyChoiceOptions` (severity info/warn/error, modal, detail) so it faithfully
      covers the rich vscode dialog sites; VS Code + in-memory adapters updated.
    - ✅ Notification migration — batch 1 (core/util files): `storage.ts`,
      `autoImportSettings.ts`, `open-file.ts`, `importExport.ts`,
      `CustomModesManager.ts`, `checkpoints/index.ts` (+ the earlier `image-handler.ts`)
      now route notifications through `getHost().notifier`. Added the
      `installVsCodeForwardingHost()` test helper (routes the host notifier to the
      mocked `vscode.window.show*` so migrated-code tests keep their spy assertions).
      Full suite green.
    - ✅ Notification sweep COMPLETE: all remaining ~135 sites migrated onto
      `getHost().notifier` (`webviewMessageHandler`, `McpHub`, `registerCommands`,
      `ShoferProvider`, `MarketplaceManager`, `skillsMessageHandler`,
      `diagnosticsHandler`, `checkpointRestoreHandler`, `registerTerminalActions`).
      Button/confirm dialogs use `notifier.showChoice` (severity/modal). **Zero
      direct `vscode.window.show*Message` calls remain outside the host adapter.**
    - ✅ Core extraction — seams + 12 vscode-free core files:
        - Seams added to `HostBridge`: `HostConfig` (`get<T>(section, key, default)`)
          and `HostEnv` (`language`, `appRoot`), each with VS Code + in-memory
          adapters; `Notifier` extended with `NotifyChoiceOptions`.
        - Config seam: `Task.ts` (**the core's heart**), `ExecuteCommandTool`,
          `AttemptCompletionTool`, `NewTaskTool`, `timeout-config`.
        - Env seam: `GrepSearchTool` (`appRoot`), `system.ts` (`language`).
        - node-stdlib swaps (no new seam): `RagSearchTool` (`path.relative`),
          `ReadProjectStructureTool` (`node:fs` readdir), `GenerateImageTool`
          (`pathToFileURL`).
        - type-only `import type`: `modes.ts`, `system.ts` (`vscode.ExtensionContext`).
          **12 core files now carry zero runtime `vscode` import.** Each migrated file's
          tests pass via `installVsCodeForwardingHost()` (now forwards notifier + config
        * env).
    - ✅ Core extraction — LSP/editor + file-glob seams (17 core files vscode-free):
        - `HostLsp` seam (read + write language-service ops, DTO-based, headless =
          empty/no-op): `getDiagnostics`, `findReferences`, `workspaceSymbols`,
          `computeRename`, `applyWorkspaceEdit`. VS Code adapter maps to
          `languages.getDiagnostics` + the `executeXProvider` commands +
          `workspace.applyEdit`.
        - `HostFileSystem.findFiles(pattern, {cwd, exclude, maxResults})` seam (VS Code
          adapter → `workspace.findFiles`/`RelativePattern`; in-memory → `[]`).
        - Migrated all 5 remaining tool files onto these seams — `GetErrorsTool`,
          `ListCodeUsagesTool`, `LspSearchTool` (+ its text fallback via
          `fs.findFiles`/`fs.readFile`), `RenameSymbolTool`, `FindFilesTool` — each now
          carries zero runtime `vscode` import.
          **17 core files vscode-free** across 5 seams (notifier, fs+findFiles, config, env,
          lsp). `installVsCodeForwardingHost()` forwards notifier + config + env.
    - ✅ Core extraction — workspace + dispatch seams (23 core files vscode-free):
        - `HostWorkspace` seam: `openFolder` (→ `vscode.openFolder`; headless no-op) +
          `executeCommand<T>` (→ `commands.executeCommand`; headless throws). Migrated
          `CreateNewWorkspaceTool` (open folder) and `presentAssistantMessage`'s
          private-tools invoke.
        - Dropped unused/type-only vscode imports: `NativeToolCallParser`,
          `validateToolUse`, `AskLiveMemoryTool`, `ProviderSettingsManager`.
          **23 core files vscode-free** across 6 seams (notifier, fs+findFiles, config, env,
          lsp, workspace).
    - ✅ Core extraction — `HostWatcher` seam (25 core files vscode-free):
        - `HostWatcher.watch(baseDir, pattern)` → `HostFileWatcher`
          (`onCreate`/`onChange`/`onDelete`/`dispose`; VS Code adapter →
          `createFileSystemWatcher` + `RelativePattern`; headless → no-op).
        - `ShoferIgnoreController` + `FileContextTracker` register watchers through it
          (the latter resolves cwd via `getWorkspacePath`); both now carry zero runtime
          `vscode` import.
          **25 core files vscode-free** across 7 seams (notifier, fs+findFiles, config, env,
          lsp, workspace, watcher). `installVsCodeForwardingHost()` forwards all of them.
    - ✅ Package enabler — host registry moved to `@shofer/types`: `getHost`/`setHost`
      (the Category I registry) now live in the vscode-free `@shofer/types` package
      (`host-registry.ts`), not in the VS Code adapter. The 32 core files that call
      `getHost()` import it from `@shofer/types`, so the portable core no longer
      transitively imports the VS Code adapter at the module level. `host-bridge.ts`
      re-exports for adapter-side callers. This is the structural unlock for the
      `@shofer/core` package carve-out.
    - ✅ Architecture doc: `docs/v3_architecture.md` is the canonical description of the
      Category I (host APIs) vs Category II (front-end adapters: VS Code, CLI, headless)
      boundary, the registry seam, and the package plan.
    - ⬜ Remainder — **the architectural boundary is now reached.** The files still
      importing `vscode` are not "core logic leaking vscode" — they are:
        1. **ExtensionContext-bound config managers** (`ContextProxy`,
           `CustomModesManager`) — they take a `vscode.ExtensionContext`, so they are
           inherently extension-scoped, not portable-core.
        2. **Editor/diff UI** (`getEnvironmentDetails` tabs, `checkpoints`/`mentions`
           diff + diagnostics commands, `importExport`/`process-images` dialogs) —
           entangled with the diff view + dialogs, i.e. the **`integrations/*` adapter
           layer**, the correct home for vscode coupling (like `host/host-bridge.ts`).
        3. **Intrinsic VS Code** — the VS Code LM provider/format
           (`api/providers/vscode-lm.ts`, `api/transform/vscode-lm-format.ts`) IS the
           VS Code Language Model API; `build-tools`' `vscode.lm` private-tools path.
           Carving the headless core package draws the line _around_ buckets 1–3. The
           portable agent core — `Task`, all tool implementations, prompts, the
           assistant-message dispatch loop, context-tracking, the ignore controller — is
           vscode-free. Gates §11 (API/SDK) and §12 (ACP).
- 🚧 **§10 Typed plugin API**
    - ✅ Foundation: `ShoferPlugin` contract (`packages/types/src/plugin.ts`) — a
      host-agnostic typed object with optional hooks (`registerTools`,
      `transformSystemPrompt`, `onEvent`, `initialize`) — and `PluginRegistry`
      (`packages/core/src/plugins/plugin-registry.ts`) that runs the hooks
      (tool collection, ordered prompt-transform threading, event dispatch) with
      failure isolation. Generalizes the tool-only `CustomToolRegistry`. 5 tests;
      docs (`marketplace.md`).
    - ✅ Wired (step 2a): `SYSTEM_PROMPT` now threads the assembled prompt through
      `pluginRegistry.applySystemPromptTransforms` (no-op while no plugins
      registered → behavior-preserving; 11 system-prompt tests green). The
      `transformSystemPrompt` hook is now load-bearing.
    - ⬜ Wire `collectTools` into tool assembly + `dispatchEvent` into the telemetry
      path; make the marketplace install/curate plugins (strangler step 2b).

## Phase 4 — Externalize the boundary

- 🚧 **§11 Public API (HTTP + SSE) + SDK**
    - ✅ Transport boundary: `http-server.ts` — dependency-free `node:http` HTTP+SSE
      server (`createHttpServer`/`createRequestHandler`) driven by an injected
      `AgentApi`; live adapter `ShoferApiAgent` over `ShoferAPI`. Now in
      `@shofer/core/transport`. 10 tests; docs (`public_api.md`).
    - ✅ Session transport (`@shofer/types/session-transport.ts`): the
      controller↔executor protocol unifying the **agent channel** (`AgentApi` over the
      wire) and the **Category I host-callback channel** (`HostRpcChannel`).
      `serveSession` (executor) exposes an `HostRpcChannel` for `createSplitHost`;
      `connectSession` (controller) proxies the remote `AgentApi` + serves callbacks
      via `dispatchHostCall`. Also moved `AgentApi`/`ServerEvent` to `@shofer/types`.
      4 round-trip tests.
    - ⬜ Add a `shofer serve` entrypoint (`server.listen`); generate a typed SDK from
      the route set so clients can't drift.
- 🚧 **@shofer/core package carve-out**
    - ✅ Step 1 — transport layer: moved `server/*` + `acp/*` from the extension into
      `@shofer/core/transport` (self-contained: `@shofer/types` + node only). Repointed
      shared types, added nodenext `.js` specifiers, satisfied core's stricter
      tsconfig/lint. `extension.ts` re-exports `runAcpAgentOverShoferApi` from
      `@shofer/core`. A headless front-end can now link the server/ACP transport
      without the extension. build+lint+check-types green (core/shofer/cli).
    - ⬜ Step 2 (large) — extract the agent core (`Task`, tool impls, prompts,
      dispatch) into `@shofer/core`; needs untangling its reaches into
      `integrations/`/`services/`. This is what lets §10–§12 run fully headless.
- 🚧 **§12 ACP agent adapter**
    - ✅ Mapping foundation: `src/acp/acp-mapping.ts` — the pure shofer↔ACP mapping
      (auto-approval decision → `requestPermission` outcome; mode ↔ ACP session
      mode; stream events → `sessionUpdate` variants with passthrough fallback) +
      `ACP_METHOD_MAP` documenting the full agent method set. 5 tests; doc
      `docs/acp.md`. Reuses §3 (events), §4 (permissions/modes), §6 (cancel).
    - ✅ ACP adopted end-to-end: `acp-connection.ts` (JSON-RPC 2.0 over NDJSON),
      `acp-agent-server.ts` (`AcpAgentServer` — initialize/session.new/session.prompt/
      session.set_mode/session.cancel over the transport-agnostic `AgentApi` via the
      mapping; event stream → `session/update`; turn resolves on Task terminal events),
      `runAcpAgentOverShoferApi` (bundle export → `ShoferApiAgent`), and a `shofer acp`
      CLI entrypoint (headless host, `disableOutput` to keep stdout clean). 19 tests;
      typecheck/lint/build (CLI + extension) green. Wire framing implemented directly
      (SDK absent from the registry), swappable for `@zed-industries/agent-client-protocol`.
    - ⬜ Remaining: swap in the upstream SDK when available; wire
      `session/request_permission` onto the approval flow; validate against a live ACP
      client (Zed).

## Phase 5 — Horizontal scaling

- 📐 **§13 Distributed execution (controllers/executors)** — DESIGN. See
  `docs/v3_architecture.md` → _Distributed execution_. The portable core can run on a
  different machine from the UI: a **controller** (front-end: UI, executor registry,
  task routing, sole index-writer) drives one or more **executors** (core + host
  adapter; Local in-process or Remote). Two seams: the **session transport**
  (controller↔executor = the §11/§12 headless protocol) and a **Category I
  host-callback channel** (front-end-bound capabilities — notifications/approvals,
  `HostLsp`, editor context, private-tool commands — RPC'd back to the controller;
  DTO-based Category I serializes for free). Root-task-level routing keeps in-process
  coordination tools unchanged; single-owner-per-tree + per-task worktrees keep state
  unshared.
    - ✅ Category I-over-RPC substrate (`packages/types/src/host-rpc.ts`):
      `createSplitHost({ local, channel })` (executor side — notifier/lsp/workspace
      proxied over an `HostRpcChannel`; fs/config/env/watcher local) +
      `dispatchHostCall(host, …)` (controller side). Made `HostLsp.getDiagnostics`
      async so the whole front-end-bound surface is transport-agnostic. 6 tests
      (round-trip via an in-memory channel). This is the executor-side foundation of
      the split host adapter; remaining = bind an `HostRpcChannel` onto the session
      transport.
    - Prototype: a single-node, same-host relay exists on `feat/remote-agents` (it
      relays the UI message protocol and runs the whole platform mock remotely). The
      v3-native refinement is to make **Category I** the distribution seam instead, so
      a remote executor runs the portable core + a split host adapter rather than the
      full shim.
    - Gated on §9 (the `@shofer/core` carve-out) + §11/§12 (the session transport).
      New work on top: the split (local + RPC-back) host adapter, the controller-side
      executor registry + root-task routing + unified multi-executor task view, and
      shared-resource reconciliation (single-writer index, serialized shared-repo
      mutations).
