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
    - ✅ Migrated **50 of 52** tools to `defineNativeTool` (incl. `read_file` — via
      stripping `z.int()` safe-int sentinels — and `attempt_completion` — via the
      `applyCompletionSchema` fix). It pre-bakes the OpenAI-strict +
      nullable-for-optional convention so the RAW schema stays byte-compatible with
      the hand-written originals for ALL providers; `strict` (incl. a `strict:false`
      option) is part of the snapshot.
    - ✅ 2 tools intentionally hand-written (snapshot still guards them) — Zod's JSON
      Schema output can't reproduce their shapes without artifacts:
      `call_mcp_tool_async` (free-form object arg, `additionalProperties:true`) and
      `ask_followup_question` (deeply-nested arrays-of-objects with per-field
      nullable unions incl. a 4-type `default`).
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
- 🚧 **§5 SQLite/event-sourced persistence** (XL; live user-data path — staged)
    - ✅ Step 1: `MessagePersistencePort` interface + `FileSystemMessagePersistence`
      adapter (`task-persistence/PersistencePort.ts`) — the swap seam over the
      existing JSONL functions, behavior-preserving (round-trip test). Also the
      seam §9's host-agnostic core needs.
    - ✅ Step 2: Task.ts now reads/writes all api/UI messages through the port (a
      lazy `this.persistence` getter), replacing the ~10 direct
      append/save/read/dispose call sites. Behavior-preserving (270 task/persistence
      tests pass; the two persistence specs updated to mock the port backend).
    - ✅ Step 3 (backend): `SqliteMessagePersistence` (`node:sqlite`, no native dep)
      implements the port — rows keyed by (task_id, kind, ts) with ts-dedupe
      matching the flat-file read path; tail/compaction supported. Includes the
      Part E #5 **one-time importer** (lazy per-task: first read of an empty DB
      imports existing flat-file history). `createMessagePersistence(path, backend)`
      feature-detects `node:sqlite` and **falls back to flat-file**, so opting in
      can't break a host that lacks it. 7 tests (round-trip/dedupe/tail/compact/
      import/factory) run on Node 22; skip where node:sqlite is absent.
    - ✅ Step 3 (wired, opt-in): Task resolves its backend via
      `createMessagePersistence` (async, cached). `SHOFER_MESSAGE_BACKEND=sqlite`
      opts in (feature-detect + flat-file fallback + lazy import); default stays
      flat-file. Docs: `configuration.md`. 277 task/persistence tests pass.
    - ⬜ Step 3 (rollout): make SQLite the default + retire the flat-file perf
      machinery (debounced saves / append logs / tail reads). DELIBERATELY not
      flipped — needs extension-host runtime verification (Electron Node may lack
      `node:sqlite` → may require bundling `better-sqlite3`) before it's the default
      on user data. A user-facing setting (vs the env var) is the thin follow-on.
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
- 🚧 **§8 OTel transport + catalog-driven cost/limits**
    - ✅ Catalog-driven cost/limits: cost (`shared/cost.ts` `calculateApiCost*`) and
      context limits already consume `ModelInfo` rather than per-provider constants;
      with §7 the lookup is unified. `shared/__tests__/cost-catalog.spec.ts` pins
      the end-to-end flow (catalog `lookupStaticModel` → cost + context window;
      unpriced model → zero cost, no scattered fallbacks).
    - ⬜ OTel transport: emit the existing typed telemetry catalog through
      OpenTelemetry spans/metrics (OTLP), retiring the bespoke Prometheus exporter.
      DECISION-GATED — needs an `@opentelemetry/*` dependency choice (api + SDK +
      OTLP exporter), the OTLP endpoint/opt-in config, and extension bundling. Like
      §5's SQLite-runtime call, this is a maintainer/infra decision, not made
      autonomously. Spend caps stay (a shofer advantage — Part E #6).

## Phase 3 — Host-agnostic core

- ⬜ **§9 vscode-free core behind an in-process adapter**.
- ⬜ **§10 Typed plugin API**.

## Phase 4 — Externalize the boundary

- ⬜ **§9 server adapter (HTTP + SSE)** · **§11 Public API + SDK** · **§12 ACP adapter**.
