---
description: Clear the Live Memory agent's in-flight context window (keeps the accumulated observation/Q&A log).
---

Clear the **Live Memory** memory agent's context window for this workspace. This
resets the agent's working conversation and loaded file contexts and rebuilds the
workspace directory tree, **without** wiping the accumulated observation/Q&A log —
the plugin analogue of the built-in `liveMemory.clearContext` command.

Use this when the memory agent's context has drifted or is nearly full (see the
context-usage indicator in the Live Memory panel or the prompt's `Live Memory`
section) and you want the next `ask_live_memory` question to start from a clean
working context while retaining what Live Memory has learned.

Trigger it from the **Clear context** control in the Live Memory chat panel (it
sends a `clear` message on the plugin's scoped UI channel). To wipe the accumulated
memory entirely instead, use `/live-memory:empty`.
