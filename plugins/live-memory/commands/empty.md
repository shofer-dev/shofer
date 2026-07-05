---
description: Empty the Live Memory for this workspace — wipe the accumulated observation/Q&A log, the persisted conversation, and the cost ledger.
---

**Empty** the Live Memory for this workspace. This is destructive: it wipes the
plugin's persisted document — accumulated file-activity observations, retained
question/answer pairs, the memory agent's conversation window and loaded file
contexts, and the running cost ledger — by deleting the store through the plugin's
own storage sandbox (`ctx.storage.delete`), then drops any live memory agent so the
next `ask_live_memory` question re-initializes from a blank slate.

It affects only **this** workspace's memory; other workspaces are stored under
separate files and are untouched. This cannot be undone.

Trigger it from the **Empty memory** control in the Live Memory chat panel (it
sends an `empty` message on the plugin's scoped UI channel, which the plugin
handles). To reset only the working context while keeping what Live Memory has
learned, use `/live-memory:clear-context` instead.
