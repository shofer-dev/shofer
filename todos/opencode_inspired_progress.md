# Progress log — opencode-inspired evolution (shofer submodule)

Canonical tracker for work on the `opencode-inspired-evolution` branch of this
submodule. Companion to the roadmap in the parent repo
(`../../todos/opencode_inspired_work.md`). Per the strangler discipline (§1) every
step lands behind a guard/adapter and leaves shofer shippable.

**Working mode:** commits land on the **shofer submodule** branch only; the parent
repo's submodule pointer is bumped once at the end (concurrent sessions share the
parent working tree).

Status key: ✅ done · 🚧 in progress · ⬜ not started · order follows Part D.

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
      the run-scoped teardown opencode gets from fibers. A full fiber/scope
      abstraction is low marginal value over this; not pursued.

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
    - ✅ Core extraction — config seam + first vscode-free core files: added
      `HostConfig` (`get<T>(section, key, default)`; VS Code + `InMemoryConfig`
      adapters). Made **`Task.ts` (the core's heart) fully vscode-free**, plus
      `ExecuteCommandTool`, `AttemptCompletionTool`, `NewTaskTool`, `timeout-config`
      (config seam) and `modes.ts` (type-only `import type`). 7 core files now carry
      zero `vscode` import.
    - ⬜ Remainder (structural, multi-session): the editor/LSP/VS-Code-LM-coupled
      core files need richer host seams before they can be decoupled — editor +
      diff + selection, file/symbol search (`FindFilesTool`, `LspSearchTool`,
      `ListCodeUsagesTool`, `RenameSymbolTool`), diagnostics (`GetErrorsTool`),
      workspace FS (`ReadProjectStructureTool`), the VS Code LM provider/format +
      `build-tools` private-tools command, and `system.ts`'s `vscode.env.language`.
      Then shrink the shim and carve out the `vscode`-free core package. Gates §11
      (API/SDK) and §12 (ACP).
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
    - ✅ Transport boundary: `src/server/http-server.ts` — dependency-free
      `node:http` HTTP+SSE server (`createHttpServer`/`createRequestHandler`)
      exposing task control (`POST /api/v1/task`, `/message`, `/cancel`) + an SSE
      event stream (`GET /api/v1/event`), driven by an injected `AgentApi`. 6 tests;
      docs (`public_api.md`).
    - ✅ Live adapter: `ShoferApiAgent` (`src/server/shofer-api-agent.ts`) implements
      `AgentApi` over the in-process `ShoferAPI` (createTask→startNewTask,
      sendMessage→resume+send, cancel→cancelCurrentTask, subscribe→forward
      ShoferAPI events). `new ShoferApiAgent(api)` makes `createHttpServer`
      drivable. 4 tests.
    - ⬜ Add a `shofer serve` entrypoint (`server.listen`) — running fully headless
      is gated on §9; generate a typed SDK from the route set so clients can't drift.
- 🚧 **§12 ACP agent adapter**
    - ✅ Mapping foundation: `src/acp/acp-mapping.ts` — the pure shofer↔ACP mapping
      (auto-approval decision → `requestPermission` outcome; mode ↔ ACP session
      mode; stream events → `sessionUpdate` variants with passthrough fallback) +
      `ACP_METHOD_MAP` documenting the full agent method set. 5 tests; doc
      `docs/acp.md`. Reuses §3 (events), §4 (permissions/modes), §6 (cancel).
    - ⬜ Add `@agentclientprotocol/sdk`, implement the service over it, ship a
      `shofer acp` stdio entrypoint. Gated on §9 (agent must run vscode-free).
