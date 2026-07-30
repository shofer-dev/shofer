---
description: "Second Brain: run one observer pass now and print every detector's verdict."
---

Invoke the `second-brain` plugin's `run` request (no params — the most recent
observed task). Print each detector's verdict line verbatim, plus any advisory
text. If the result is an error ("no observed task"), say so plainly.
