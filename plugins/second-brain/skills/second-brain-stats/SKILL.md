---
name: second-brain-stats
description: Show what the Second Brain has observed, spent and said — observed volume per segment, pass latency, window fill, token use and cost, advisories generated / gated / delivered, and uptake per detector. Use when the user asks whether the Second Brain is watching, what it has cost, or whether its advice is being taken.
---

# Second Brain — Stats

The Second Brain is the `second-brain` plugin's background observer: one cheap
model per root task, watching the task's emissions and occasionally injecting a
one-way gated advisory. Silence is its success metric.

To answer, call the plugin request `stats` (plugin `second-brain`) and relay the
result readably:

- **consent / muted** — whether it can run at all, and whether the user silenced it.
- **per task** — passes run, window/spool sizes, advisories delivered, cost in USD.
- **uptake per detector** — `adopted/delivered`: whether advice is being acted on.
  A detector whose advice is persistently ignored is a detector to disable in
  `.shofer/second-brain/catalogue.json`.

The badge (🧠 in the chat toolbar) and the Second Brain sidebar panel show the
same numbers continuously, without spending a model turn.
