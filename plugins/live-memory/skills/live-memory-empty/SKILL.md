---
name: live-memory-empty
description: Empty the Live Memory for this workspace — wipe its accumulated observation/Q&A log, its persisted conversation window, and its cost ledger so the next question starts from a blank slate. Use when the user wants to reset or clear Live Memory, discard what it has learned, or start fresh.
---

# Live Memory — Empty

Emptying **wipes** the Live Memory's persisted document for the current workspace:
the accumulated file-activity observations, the retained question/answer pairs,
the memory agent's conversation window and loaded file contexts, and the running
cost ledger. The store file is deleted through the plugin's own traversal-blocked
storage sandbox (`ctx.storage.delete`), and any live memory agent is dropped so
the next `ask_live_memory` question re-initializes from an empty state.

This is destructive and cannot be undone — the plugin keeps no history beyond the
current document. It only affects **this** workspace's memory; other workspaces
are stored under separate files and are untouched.

## How to empty

- **From the Live Memory chat panel** (the plugin's `sidebar-panel` UI): use the
  **Empty memory** control. It sends an `empty` message on the plugin's scoped UI
  channel, which the plugin handles by deleting the store and resetting the agent.
- **Via the `/live-memory:empty` command**, which documents this same action.

To clear only the in-flight _context window_ (keeping the accumulated
observation/Q&A log), use **Clear context** instead — that resets the agent's
working context and rebuilds the workspace directory tree without wiping memory.
