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
    - ⬜ Define each tool as a single typed schema object; derive LLM def, arg
      validation, UI label, approval surface; delete the hand-maintained mirrors.
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
