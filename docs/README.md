# Shofer design docs — conventions

This directory holds Shofer's design/feature docs. To keep them trustworthy
(see the v3-architecture evolution, `docs/v3_architecture.md` §2:
"docs running ahead of code erode trust and create phantom maintenance"), follow
one rule:

> **A feature doc describes shipped behavior. Anything not yet built is marked as
> such — a status banner and/or a clearly-labeled "Proposed"/"Future work"
> section — never prose that reads as if it already runs.**

Future work belongs in a TODO (`todos/`) or an explicitly-labeled section, not as
a spec masquerading as current state.

## Status banner convention

When a doc describes anything other than fully-shipped, behavior, put a banner
immediately under the H1 title. Use one of:

- `> **✅ Shipped.**` — describes current behavior (the default; banner optional).
- `> **🚧 Partial.** <what exists vs. what doesn't>` — some of it is built/wired,
  some isn't. State precisely which.
- `> **📐 Proposed.** <not yet built>` — a design for future work; no shipping code.
- `> **⛔ Reverted / inherited.** <what was removed or never ported>` — describes
  something that does not exist in the current codebase. `cloud.md` is the model.

Per-section status tables (e.g. `mem-utilization-profiling.md`,
`performance_optimizations.md`) are also fine for docs that mix shipped and
proposed items — keep the "Not started" / "Implemented" column honest.

## Accuracy audit (2026-06-28)

A doc-vs-code audit was run as part of the docs-hygiene initiative. Spot-checked
docs and their verdicts:

| Doc                                                                        | Verdict                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v3_architecture.md`                                                       | ✅ Active — the single canonical host-agnostic (Category I/II) architecture + implementation status                                                                                 |
| `parallelism.md`, `message_queue.md`, `task-export.md`, `summarization.md` | ✅ Shipped                                                                                                                                                                          |
| `performance_optimizations.md`, `public_api.md`, `headless.md`             | ✅ Shipped                                                                                                                                                                          |
| `worktrees.md`, `worktree-shell-sandboxing.md`                             | ✅ Shipped                                                                                                                                                                          |
| `chatview-windowed-message-loading.md`                                     | ✅ Shipped (H2 reverted, re-shipped as H24/T1.B — doc already explains this)                                                                                                        |
| `mem-utilization-profiling.md`                                             | 🚧 §5.2 on-demand snapshot shipped; §5.3 watermark auto-snapshot is proposed (status table is honest)                                                                               |
| `multi_threaded.md`                                                        | 🚧 Phase 0–1 worker infrastructure built + unit-tested but **not wired into production** (no task currently runs in a worker); the four-runtime architecture is desired, not active |
| `cloud.md`                                                                 | ⛔ Inherited from upstream; the described cloud package/services do not exist (doc already carries this banner)                                                                     |

The corpus was found largely accurate; only `multi_threaded.md` lacked a clear
status banner and has been given one. New/changed docs should keep this index and
their own banners current.
