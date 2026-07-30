---
description: "Second Brain: drop a task ledger (or all)."
---

Invoke the `second-brain` plugin's `forget` request. With an argument, pass it
as `{ "taskId": "<argument>" }`; with none, ASK the user to confirm dropping all
ledgers first. Ledgers are derived state — deletion is always safe.
