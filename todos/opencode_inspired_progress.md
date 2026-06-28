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
    - ✅ Migrated **48 of 52** tools to `defineNativeTool`. It pre-bakes the
      OpenAI-strict + nullable-for-optional convention so the RAW schema stays
      byte-compatible with the hand-written originals for ALL providers; `strict`
      (incl. a `strict:false` option) is part of the snapshot.
    - ✅ 4 tools intentionally hand-written (snapshot still guards them) — each
      would change model-visible behavior or carry Zod-output artifacts:
      `attempt_completion` (`applyCompletionSchema` reads its source `required`;
      strict widening would make `feedback` required in the contract variant);
      `call_mcp_tool_async` (free-form object arg — no clean Zod equivalent);
      `ask_followup_question` (deeply-nested per-field nullable unions incl. a
      4-type `default`); `read_file` (factory; `z.int()` injects ±9e15
      min/max sentinels + the optional `mode` enum gains `null` — not worth it on
      the most-used tool).
    - ⬜ Single-source `NativeToolArgs`/`toolParamNames` and delete those mirrors.
      BLOCKED on a layering fix: `shared/tools.ts` (low-level) can't import the
      native-tools graph without a cycle — relocate tool defs to a shared package,
      dovetailing with §9. The drift guard already makes the current mirrors safe.
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
    - §4 high-value core complete. (Remaining: a fully-abstract allow/ask/deny rule
      object model + per-agent rulesets — purity polish, low marginal value.)
- 🚧 **§5 SQLite/event-sourced persistence** (XL; live user-data path — staged)
    - ✅ Step 1: `MessagePersistencePort` interface + `FileSystemMessagePersistence`
      adapter (`task-persistence/PersistencePort.ts`) — the swap seam over the
      existing JSONL functions, behavior-preserving (round-trip test). Also the
      seam §9's host-agnostic core needs.
    - ⬜ Step 2: route Task.ts's ~23 persistence call sites through an injected port
      (deferred — Task.ts is a concurrent-edit collision hotspot; do when the tree
      is quiet).
    - ⬜ Step 3: `SqliteMessagePersistence` (event-sourced) + one-time importer +
      retire the flat-file perf machinery. NEEDS the Part E #5 decision (one-time
      importer vs dual-read) and real-data testing before it touches user data.
- 🚧 **§6 Structured cancellation**
    - ✅ `utils/process-termination.ts` — reusable `terminateProcessTree` with a
      SIGTERM→grace→SIGKILL escalation over a process tree (injectable
      kill/enumerate/delay → deterministic unit tests). Wired into
      `ExecaTerminalProcess.abort()`, replacing the previous immediate, PID-by-PID
      SIGKILL. Terminal suite green; docs updated (`command-termination-design.md`).
    - ⬜ Run-scoped cancellation: bind all spawned processes/tools to a single
      cancellation scope so cancelling a run deterministically tears down
      everything (the broader fiber/scope abstraction); reconcile tool state on
      interrupt (`failInterruptedTools`).

## Phase 2 — Catalog & observability

- ⬜ **§7 Data-driven model/provider catalog**.
- ⬜ **§8 OTel transport + catalog-driven cost/limits**.

## Phase 3 — Host-agnostic core

- ⬜ **§9 vscode-free core behind an in-process adapter**.
- ⬜ **§10 Typed plugin API**.

## Phase 4 — Externalize the boundary

- ⬜ **§9 server adapter (HTTP + SSE)** · **§11 Public API + SDK** · **§12 ACP adapter**.
