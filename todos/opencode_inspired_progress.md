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
    - ⬜ Migrate the remaining ~49 tools (each with an equivalence check), then
      single-source `NativeToolArgs`/`toolParamNames` and delete those mirrors.
      NOTE: deriving them in `shared/tools.ts` needs a layering fix (low-level
      module can't import the native-tools graph without a cycle) — likely relocate
      tool defs to a shared package, dovetailing with §9.
- 🚧 **§4 Unify permissions**
    - ✅ Drift guard `auto-approval/__tests__/say-tool-mapping-drift.test.ts`.
    - ⬜ Collapse tool-access + categories + per-model prefs + auto-approval into one
      ordered allow/ask/deny rule evaluator; migrate call sites; delete old paths.
- ⬜ **§5 SQLite/event-sourced persistence**.
- ⬜ **§6 Structured cancellation**.

## Phase 2 — Catalog & observability

- ⬜ **§7 Data-driven model/provider catalog**.
- ⬜ **§8 OTel transport + catalog-driven cost/limits**.

## Phase 3 — Host-agnostic core

- ⬜ **§9 vscode-free core behind an in-process adapter**.
- ⬜ **§10 Typed plugin API**.

## Phase 4 — Externalize the boundary

- ⬜ **§9 server adapter (HTTP + SSE)** · **§11 Public API + SDK** · **§12 ACP adapter**.
