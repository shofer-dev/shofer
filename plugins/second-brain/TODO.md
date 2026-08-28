# Second Brain — known gaps and accepted trade-offs

What is knowingly not done. Nothing in README/DESIGN implies a control that only this
file knows is missing.

## Not implemented yet

- **Phase-0 live verification of the two delivery seams — attempted, delivery still
  unverified.** A first live session ran on staging (2026-08-01, shofer 2.41.0 in a
  code-server workspace against llm-router). What it PROVED: the observer attaches
  and digests a real task; the fork fan-out executes against a real provider and
  returns real verdicts (`silent`, `timeout`); per-pass `debug` capture and provider
  cache accounting work (a later pass showed `cacheRead=1024`); the dimmed
  **turn-end report row renders in chat** and the 🧠 badge live-updates
  (watching/passes/cost). What it could NOT reach: no advisory ever cleared the
  gate, so neither the advisory delivery nor the finish gate's `wake: true` re-trigger
  was observed. Blockers
  found, and where they stand:

    1. **FIXED — `ForkLlmClient` resolves the handler per call.** Empty `profileRef`
       means the host's _current_ default profile; the client used to build the
       handler once and pin it (a keyless org profile made every pass die on the
       Anthropic SDK's "Could not resolve authentication method" until a plugin
       reload). `getHandler` no longer caches.
    2. **FIXED — the catalogue override rides `pluginConfigs`, not a file.** The old
       `catalogueReader` passed a workspace-relative `CATALOGUE_PATH` to
       `host.fs.readFile`, which resolves against the extension host's cwd rather
       than the workspace, so the only override surface was unusable exactly where
       a deterministic always-advise detector was needed. Both are gone:
       `loadCatalogue(raw, warn)` now takes the already-resolved
       `pluginConfigs["second-brain"].detectors` value (`CATALOGUE_CONFIG_KEY`) and
       is synchronous, so the override arrives through the same layered-config path
       as every other plugin setting and needs no filesystem access at all.
    3. **FIXED — streamed tool-call arguments were dropped by the fork client.**
       Confirmed, not just suspected: OpenAI-compatible providers stream a call as
       `tool_call_partial` fragments keyed by `index` (id/name on the first
       fragment only, arguments as append-fragments), and `tool_call_delta`
       carries its fragment in `delta` — the client keyed by id and REPLACED
       arguments, scattering fragments into nameless entries, so every feedback
       call arrived empty and coerced to silent. `llm.ts` now accumulates
       index-keyed fragments (llm.spec.ts covers the observed shapes).

    All three blockers are now fixed, but **no advisory has yet been observed
    clearing the gate end-to-end**, so the mailbox delivery and the finish gate's
    `wake: true` re-trigger remain unverified against a live host. Keep treating the finish gate as
    experimental until a live session shows one; it degrades to user-only surfaces
    by design.

- **Digest-overflow fallback.** The digest is the complete conversation and is never
  truncated (owner directive); past `DIGEST_HARD_CAP_CHARS` passes skip with a visible
  "(digest exceeds the observer's practical context)" verdict. A graceful fallback for
  very long tasks (e.g. switching to a larger-context profile) is not built.
- **A resumed/reloaded task's digest starts at attach.** Hooks only fire live, and no
  plugin seam reads a task's persisted messages, so "the complete conversation" means
  everything since the observer attached — a task resumed from history (or a plugin
  reload) loses the earlier stretch. Rebuilding the digest from the task's persisted
  conversation would need a read seam that does not exist today.
- **`second-brain-run` with a detector argument spawning the private mode** is
  documented in the skill as `new_task` guidance; there is no dedicated handleRequest
  that spawns via `ctx.agent.spawn(prompt, { mode })` yet.
- **Per-detector KV-cache read/write accounting** (the reference design's
  per-detector stats columns): the ApiHandler usage chunks don't expose cache
  read/write splits uniformly, so stats carry tokens + cost only.
- **Turn-end pass on idle asks fires at most one report per idle boundary**, but a
  task that idles without any new observation runs no pass (nothing to judge) — same
  as the reference design's empty-episode rule, just stated here.

- **A very large system prompt is unusual.** The digest rides the system block (that is
  what makes the fan-out cache-cheap), so on a long task the system prompt grows into
  the hundreds of KB. A few OpenAI-compatible endpoints rewrite or reject system
  messages (converting them to user/developer turns); that degrades gracefully — the
  content stays at the front of the token stream and implicit prefix caching still
  works — but it has not been exercised against a real non-Anthropic endpoint yet.
- **Cache measurement is wired but unproven against a live provider.** `stats` and the
  panel report the provider's own `cacheReadTokens`/`cacheWriteTokens` and a hit ratio,
  and `debug: true` writes each pass's digest and per-fork usage — but no real session
  has been run against a billed provider yet, so the predicted shape (pilot writes,
  the rest read) is pinned only by tests with scripted usage. A provider that reports
  no cache split shows as all-uncached rather than as an error.

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
- **A plugin reload (any Settings edit) drops in-memory digests** — the ledger
  survives in storage, so a reload costs the warm prefix, not judgment. Same trade as
  the reference design's worker restart (and see the resumed-task item above).
- **Cross-HOST collision awareness is out of scope**: one plugin instance sees one
  host's tasks; tasks running on other hosts are invisible to the index.
- **Uptake is self-reported** (evidence-required, `no_evidence` default) — it measures
  whether the primary acted, never whether acting helped.

## Calibration debt

The nine detector prompts are ported from the reference implementation but none are
calibrated against real Shofer sessions; the three enabled ones are the tool-less,
cheapest-to-be-wrong ones deliberately.
