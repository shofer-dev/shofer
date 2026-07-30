---
name: second-brain-forget
description: Drop the Second Brain's task ledger — one task's, or all of them. A ledger is derived state (goal, compaction notes, advisories, suppressions), so deleting one is always safe; a running task rebuilds from its next observations.
---

# Second Brain — Forget

Call the plugin request `forget` (plugin `second-brain`, params `{ taskId? }` —
omit taskId to drop EVERY ledger). Confirm with the user before the drop-all
variant; per-task deletion needs no confirmation, it is always safe.

What is lost: the task-scoped judgment (goal, notes distilled from window
compactions, delivered advisories and their outcomes, suppressed advice keys,
budget spend). What is NOT lost: nothing else — the Second Brain holds no
workspace-scoped state by design.
