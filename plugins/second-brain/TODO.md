# Second Brain — known gaps and accepted trade-offs

What is knowingly not done. Nothing in README/DESIGN implies a control that only this
file knows is missing.

## Not implemented yet

- **Phase-0 live verification of the two delivery seams.** The unit/host specs prove
  the plumbing, but two behaviors need a live session before the finish gate is
  trusted: (a) `mode: "notify"` injection rendering beside a real request in both
  hosts, and (b) `mode: "queue"` re-triggering a just-completed task (the
  queue-after-abort path). Until verified, treat the finish gate as experimental; it
  degrades to user-only surfaces on failure by design.
- **Model-backed neutral compaction.** Window compaction currently distils the evicted
  span deterministically (kept lines: user prompts, pass verdicts, advisories) instead
  of a neutral model summary. Cheaper and replayable, but lossier than the design's
  summarization; revisit when real windows hit the threshold in practice.
- **`second-brain-run` with a detector argument spawning the private mode** is
  documented in the skill as `new_task` guidance; there is no dedicated handleRequest
  that spawns via `ctx.agent.spawn(prompt, { mode })` yet.
- **Per-detector KV-cache read/write accounting** (the reference design's
  per-detector stats columns): the ApiHandler usage chunks don't expose cache
  read/write splits uniformly, so stats carry tokens + cost only.
- **Turn-end pass on idle asks fires at most one report per idle boundary**, but a
  task that idles without any new observation runs no pass (nothing to judge) — same
  as the reference design's empty-episode rule, just stated here.

## Accepted trade-offs

- **No `tool_choice` forcing** on the final fork iteration (the ApiHandler surface has
  no such parameter); the last iteration nudges the feedback call in text, and a
  prose-only reply coerces to `silent` — never to an invented finding.
- **The window prefix is one growing user message**, not an alternating message array.
  Byte-prefix stability holds; whether a provider caches _within_ a growing block is
  handler-dependent. The handler owns breakpoint placement either way.
- **Exec runs via `child_process`** (exact-string allowlist, time-boxed, workspace
  root) because there is no governed host exec seam for plugins; live-memory's
  `runGit` set the precedent. A `ctx.host.exec` proposal is out of scope here.
- **Tool-result error detection is heuristic** (`looksLikeError` over the head):
  shofer tool results carry no is_error flag through `afterToolCall`. Ambiguity drops
  the result (a lost error costs an observation; a false error costs noise).
- **A plugin reload (any Settings edit) drops in-memory windows** — the ledger
  survives in storage, so a reload costs the warm prefix, not judgment. Same trade as
  the reference design's worker restart.
- **Cross-HOST collision awareness is out of scope**: one plugin instance sees one
  host's tasks; tasks on remote Shofer Nodes are invisible to the index.
- **Uptake is self-reported** (evidence-required, `no_evidence` default) — it measures
  whether the primary acted, never whether acting helped.

## Calibration debt

The nine detector prompts are ported from the reference implementation but none are
calibrated against real Shofer sessions; the three enabled ones are the tool-less,
cheapest-to-be-wrong ones deliberately.
