# Audit: Tool-Call Defensive Layers ("did our fixes make it worse?")

> **Status:** Partially implemented — 2026-06-23 (audit drafted 2026-06-19)
> **Purpose:** Inventory every _silent_ recovery / alias / coercion / default-fill
> in the native tool-calling path, ranked by **blast radius**, so we can
> instrument-then-ablate the risky ones instead of trusting or fearing them
> wholesale. Companion to [`model-dependant-tooling.md`](./model-dependant-tooling.md).
> Source paths are relative to this file (repo root), under `../extensions/shofer/`.

> ## Implementation log (2026-06-21)
>
> Landed the by-construction-safe, non-data-gated work; the deletions stay
> deferred until the new telemetry accrues (exactly as the phases below gate them).
>
> - **Silent self-healing on mutating paths → loud reject-with-feedback (2026-06-23).**
>   The investigation found the real risk is in the tool HANDLERS, not the §2.1/§2.2
>   parser aliases. Converted the heuristic _guesses that mutate files_: (1) the
>   `apply_diff` XML-leak path recovery now rejects instead of applying to a guessed
>   file; (2) `edit_file` is exact-match-only (dropped whitespace-tolerant + token
>   regex fallbacks); (3) `sed` no longer silently reinterprets a regex as a literal
>   (compile-fail or zero-match) — fails with a hint to set `isRegex:false`;
>   (4) `insert_edit` rejects out-of-range line/column instead of clamping to EOF.
>   **KEPT (designed/high-value, not wild guesses):** `apply_patch` fuzzy matching
>   (`seek-sequence.ts` — part of the Codex apply_patch contract) and
>   `write_to_file` fence-stripping (correct ~always). The `insert_edit` HTML-entity
>   decode is left in place (borderline, legacy-protocol safety net).
> - **DEFERRED — alias/coercion → loud (separate effort, scope TBD).** Decision: the
>   deterministic name/arg aliases (`bash→execute_command`, `filePath→path`,
>   `"True"→true`, `search_and_replace→edit`) and coercions should become loud
>   reject+hint, BUT the right long-term fix is `includedTools` so models see their
>   familiar tools from the start (see [`../docs/tool_preferences.md`]). Tackle as its
>   own change after agreeing exactly which tables to remove vs gate.
> - **Phase 1 — done, then REVERTED (2026-06-23).** `sed` and `insert_edit` were
>   demoted from `TOOL_GROUPS.write.tools` to `.customTools`, then restored to the
>   default write set on 2026-06-23 ([`tool.ts`](packages/types/src/tool.ts)). They
>   are again available by default in write modes (no `includedTools` opt-in);
>   `customTools` is back to `[edit, search_replace, edit_file, apply_patch]` and the
>   two `modes.spec` cases are back to their original form. **Net change to the
>   default surface: none.** Rationale: per-turn "which editor?" cost is better
>   handled via per-model tool preferences (next bullet) than by shrinking the
>   global default.
> - **Per-model tool preferences plumbed end-to-end (2026-06-23).** The
>   integrator-owned `includedTools`/`excludedTools` mechanism (availability +
>   dialect/naming) now flows through ALL three model-access paths: (a) llm-router
>   emits `included_tools`/`excluded_tools` on `/v1/models` → OpenRouter fetcher; (c)
>   shofer-router carries them in its registry → capabilities side-channel →
>   `vscode-lm.ts`; (b) the curated provider files already did. Both new paths seed
>   the known `openai → apply_patch` family default. See
>   [`../docs/tool_preferences.md`](../docs/tool_preferences.md) — this is the proper
>   home for the model-specific tuning Phase 1 was a blunt proxy for.
> - **Phases 2–3 instrumentation + cross-cutting removal loop — done (the keystone).**
>   Two telemetry events: `TOOL_CALL_RESOLVED` (fires on _every_ parse — canonical,
>   aliased, unknown — carrying `{ modelId, emittedName, resolvedName, wasAliased,
wasUnknown, argKeys }`) and `TOOL_RECOVERY_FIRED` (`{ modelId, layerId, tool, … }`).
>   `NativeToolCallParser` now records silent recovery firings via a `consumeRecoveries()`
>   drain (mirrors `lastParseError`); the `apply_diff` XML-leak recovery records
>   `{ layerId: "apply_diff_xml_leak", recoveredPath, appliedToFile }`. `Task` emits both
>   at all three parse sites where `modelId`/`taskId` exist. **Instrumentation only —
>   no behavior change.**
> - **Still deferred (data-gated, unchanged from below):** converting the `apply_diff`
>   recovery from silent → reject-with-feedback (Phase 2 step 2); pruning zero-hit
>   aliases / coercions (Phase 4); collapsing the 25 per-tool `?? filePath` fallbacks
>   into `normalizeArgAliases` (Phase 4 — verified behavior-preserving since
>   `normalizeArgAliases` already runs before the switch, but held until telemetry
>   confirms the central layer covers real traffic). `generate_image` demotion still
>   a separate task-relevance call.

---

## 1. Why this audit

Each past tool-call failure spawned a local patch (an alias, a fallback param, a
recovery regex, a coercion, a default). Every patch was locally justified, but the
_aggregate_ can go net-negative for three reasons:

1. **Wrong metric.** Most patches reduce _visible failures_ (parse errors,
   retries). The goal is _correct actions_. A layer that **silently does something
   instead of failing** improves the error graph while it _degrades_ quality — a
   loud failure makes the model retry and self-correct; a silent mis-recovery makes
   it proceed **confidently wrong**.
2. **No removal loop.** Fixes are only added, never retired. Once an alias exists
   the model keeps emitting the foreign form silently, the signal disappears, and
   the patch lives forever. Complexity ratchets up monotonically.
3. **Interaction blindness.** Each patch is local; nobody owns the sum.

**The filter that matters is blast radius — what happens when the layer fires
_wrong_:**

| Class                                             | Example                                             | When it misfires                 | Verdict                                       |
| ------------------------------------------------- | --------------------------------------------------- | -------------------------------- | --------------------------------------------- |
| **Silent transform on a mutating/executing path** | recover a path from corrupted text → _apply a diff_ | confidently-wrong edit / command | 🔴 highest risk — audit first                 |
| **Silent transform on a read/search path**        | broaden a glob, alias a search tool                 | too many results; model filters  | 🟢 cheap to keep                              |
| **Loud feedback (reject + hint)**                 | "Unknown tool 'x'. Did you mean…?"                  | model retries correctly          | ✅ the _good_ kind — keep/expand              |
| **Output-surface accretion**                      | 3 identical edit tools                              | taxes every turn                 | 🟡 net-negative by default (separate concern) |

This audit lists the silent layers and assigns each a class.

---

## 2. Inventory

Legend — **Silent?** = does it transform without surfacing an error to the model.
**Masks signal?** = does it hide the fact that the model emitted something
non-canonical (so we never learn / never fix the root).

### 2.1 🔴 Mutating / executing path (audit first)

| #   | Layer                                        | Location                                                                                                                                                                     | What it does                                                                                                                                              | Silent | Masks signal | Recommendation                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`apply_diff` XML-leak path recovery**      | `NativeToolCallParser.extractPathFromXMLLeak` ([`:367`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts)); used streaming `~:730` and final `~:1385` | Regex-guesses a `path` from a corrupted `<parameter name="path">` suffix inside the diff string, strips it, then **applies the diff to the guessed file** | ✅     | ✅           | **Top priority.** Instrument false-recovery rate (fires? resulting edit correct?). Strongly consider converting to **reject-with-feedback** ("your diff looks corrupted, re-send") so the model retries cleanly instead of mutating a _guessed_ path. A wrong guess here = silent wrong edit. |
| 2   | **`search_and_replace → edit`** (name alias) | `TOOL_ALIASES` ([`tool.ts:268`](../extensions/shofer/packages/types/src/tool.ts))                                                                                            | Routes a foreign name to a **write** tool with different param semantics                                                                                  | ✅     | ✅           | Instrument hit-rate + correctness. If a model meant something other than `edit`, this silently mis-routes a mutation. Verify it's still earning its keep.                                                                                                                                     |
| 3   | **`bash → execute_command`** (name alias)    | `CROSS_ASSISTANT_ALIASES` ([`tool.ts:280`](../extensions/shofer/packages/types/src/tool.ts))                                                                                 | Routes to **command execution**                                                                                                                           | ✅     | ✅           | Semantically aligned (both run shell), but high-consequence surface. Instrument hit-rate; keep if used, but it should be _visible_ in telemetry, not invisible.                                                                                                                               |
| 4   | **`is_background` → `false`** default        | `NewTaskTool` ([`:57`](../extensions/shofer/src/core/tools/NewTaskTool.ts)) via `parseToolBoolean`                                                                           | Unparseable value → foreground task                                                                                                                       | ✅     | partial      | Low-medium: wrong async mode, not a wrong mutation. Instrument how often the input is non-boolean.                                                                                                                                                                                            |

### 2.2 🟢 Read / search path (low risk — cheap to keep, but prune the dead ones)

| #   | Layer                                                                                                           | Location                                                                                                                                                      | What it does                                                         | Note                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **`search_file`/`search_files`/`find_file` → `find_files`** + `composeFindFilesPattern`                         | `CROSS_ASSISTANT_ALIASES`; `NativeToolCallParser.composeFindFilesPattern` ([`:453`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts)) | Foreign filename-search → our glob, anchored recursively under a dir | Read-broadening; worst case = extra results. Recently added — **no production data on misfire rate yet.**                                                      |
| 6   | **`search_content`/`iterative_search`/`internal_search` → `grep_search`**, **`codebase_search` → `rag_search`** | `CROSS_ASSISTANT_ALIASES` ([`tool.ts:280`](../extensions/shofer/packages/types/src/tool.ts))                                                                  | Foreign search names → ours                                          | Some (`iterative_search`, `internal_search`) are **unverified** — may be dead. Instrument; remove zero-hit entries.                                            |
| 7   | **`PATH_ARG_ALIASES`** (`directory`/`file_path`/`target_directory`/… → `path`) + `normalizeArgAliases`          | `NativeToolCallParser` ([`:401`, `:418`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts))                                            | Fills canonical `path` from a synonym when absent                    | Accepts a synonym (never clobbers) — low risk. But the list is partly speculative; prune zero-hit aliases. Also aliases `prompt→message`, `description→title`. |
| 8   | **23× per-tool `?? filePath` fallbacks**                                                                        | parser switch cases (`grep -c '?? .*\.filePath'` = 23)                                                                                                        | Each tool independently accepts `filePath` for `path`                | Redundant with #7 now that `normalizeArgAliases` centralizes it. **Consolidation candidate** — collapse to the central layer.                                  |
| 9   | **`coerceOptionalBoolean` / `coerceOptionalNumber`**                                                            | `NativeToolCallParser` ([`:113`, `:516`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts))                                            | `"True"`/`"1"` → bool, `"3"` → number                                | Low blast (wrong flag at worst). Instrument: if no model actually sends string-typed scalars, the coercion is dead weight.                                     |
| 10  | **`grep_search` `isRegex ?? regex`** etc.                                                                       | parser `~:806`                                                                                                                                                | Accepts alt arg name                                                 | Same as #7 — fine, but track usage.                                                                                                                            |

### 2.3 ✅ Loud feedback (keep / expand — _not_ the problem)

| #   | Layer                                                                            | Location                                                                                                                                                                | Note                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | **`findClosestToolName` + `lastParseError` "Did you mean?"**                     | `NativeToolCallParser` ([`:37`, `:1242`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts))                                                      | Rejects unknown tool, suggests nearest + full list. **No silent substitution** — exactly the right shape. Keep; prefer this pattern over silent recovery elsewhere. |
| 12  | **Rating defaults** (`wait_for_message`→`"well"`, `attempt_completion`→`"poor"`) | `WaitTool` ([`:15`](../extensions/shofer/src/core/tools/WaitTool.ts)), `AttemptCompletionTool` ([`:153`](../extensions/shofer/src/core/tools/AttemptCompletionTool.ts)) | Cosmetic (rating is self-assessment, not an action). Lowest priority; effectively harmless.                                                                         |

---

## 3. Remediation Plan (phased)

Ordered by confidence-of-harm. **Phase 1 needs no telemetry** (harmful by
construction — ship it). **Phases 2–4 are telemetry-gated**, so Phase 2 ships its
instrumentation alongside Phase 1 and the data accrues while Phase 1 lands.

### Phase 1 — Shrink the default mutator surface (🟡, no data needed)

**Goal:** cut the per-turn "which editor?" choice every model pays.

- **Demote `sed` and `insert_edit`** out of the default `write` group to opt-in
  `customTools` (move them from `TOOL_GROUPS.write.tools` to `.customTools` in
  [`tool.ts`](../extensions/shofer/packages/types/src/tool.ts)). They overlap
  `apply_diff` for the large majority of edits. Result: default edit surface is
  `apply_diff` (edit existing) + `write_to_file` (create/overwrite); both remain
  _allowed_ in write modes and reachable via a model's `includedTools`. (Verified
  this is a one-file change that keeps the filtering/modes/build-tools suites
  green — but **not yet applied**; this is a plan, not a landed change.)

> **Correction (from investigation).** The "redundant editor triplet"
> (`edit`/`search_replace`/`edit_file`) is **not** per-turn choice-overload as
> first claimed: all three are **opt-in `customTools`**, and each model is offered
> **at most one** — `search_replace` is in fact the **dialect editor for xAI/Grok**
> (`includedTools: ["search_replace"]` across [`providers/xai.ts`](../extensions/shofer/packages/types/src/providers/xai.ts)),
> `edit` is the Claude-shaped one, etc. So the three handlers/schemas are a _clumsy
> per-model dialect mechanism_, not standalone redundancy. **Deduping them to one
> handler + per-lineage rename belongs in [`model-dependant-tooling.md`](./model-dependant-tooling.md)**
> (one canonical editor, presented under the name each lineage prefers) — doing it
> here would regress Grok. Tracked there, not as a blind deletion.
>
> **`generate_image` deferred.** It's default-surface noise in a coding turn, but
> the fix is _not_ a `supportsImages` gate (that's vision-input, the wrong
> capability — image generation typically uses a separate backend). It's a
> task-relevance call (demote to opt-in?) — decide separately.

**Exit criteria:** default edit mechanisms reduced to 2; demoted tools still
allowed when included; types + tool-filtering / modes / build-tools suites green.

### Phase 2 — De-risk the `apply_diff` XML-leak recovery (🔴, verify-or-convert)

**Goal:** stop a silent path _guess_ from producing a wrong mutation.

1. **Instrument first, no behavior change:** log every `extractPathFromXMLLeak`
   firing — `{ modelId, fired, recoveredPath, appliedToFile }`. Ship with Phase 1;
   collect.
2. **Decide from data:**
    - If false-recovery rate is provably ~0 **and** volume is meaningful → keep, but
      make it **visible/logged**, never silent.
    - Otherwise → **convert silent → loud**: reject with a tool error ("diff has a
      corrupted `<parameter>` suffix; re-send a clean `apply_diff`") and let the
      model retry. A clean retry beats a guessed-path mutation.
3. **Invariant:** never apply a diff to a _guessed_ path without confirmation.

**Exit criteria:** the recovery is either (a) instrumented + proven-correct + visible,
or (b) replaced by reject-with-feedback; a test asserts a corrupted diff yields a
retry-able error, not a guessed mutation.

### Phase 3 — Instrument + verify the suspect mutating/executing aliases (🟠)

**Goal:** confirm `search_and_replace→edit`, `bash→execute_command` (and other
write/exec aliases) earn their keep and aren't silently mis-routing.

- Emit the per-layer telemetry on the alias-resolution path — `originalName` is
  **already computed** ([`NativeToolCallParser:311`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts)),
  it just needs emitting with `modelId` and a downstream-success flag. **Log on
  successful resolution, not just failure** (else the alias hides its own usage).
- Verdict per alias: keep (non-zero hits, correct) or remove (zero-hit / mis-routes).

**Exit criteria:** every write/exec alias has a measured hit-rate; zero-hit ones
removed; survivors are visible in telemetry rather than invisible.

### Phase 4 — Prune the dead-weight cruft (🟢, after Phase 3 telemetry exists)

**Goal:** delete complexity that isn't earning its keep (not harmful, just cost).

- Remove zero-hit aliases (likely `iterative_search`, `internal_search`, speculative
  `PATH_ARG_ALIASES` entries).
- **Collapse the 23 per-tool `?? filePath` fallbacks** into the central
  `normalizeArgAliases` (single source of truth).
- Remove `coerceOptionalBoolean` / `coerceOptionalNumber` for params no model
  actually sends mistyped (per telemetry).

**Exit criteria:** alias/coercion maps contain only measured-nonzero entries;
per-tool `filePath` fallbacks gone; tests green.

### Cross-cutting — the removal loop (the discipline we never had)

Every silent layer carries a `layerId` + telemetry; a periodic review retires
zero-hit / low-correctness layers instead of grandfathering them. This is what lets
the next defensive patch be safe to add — because it can also be safely removed.

---

## 4. The honest summary

- The layers most likely to have **made things worse** are the **silent transforms on mutating/executing paths** (#1 apply_diff recovery above all) — they trade a loud, self-correcting failure for a quiet wrong action.
- The **read-side leniency and loud feedback are probably net-positive** — but the _unverified_ aliases/coercions are dead-weight complexity we can prune once telemetry confirms zero hits.
- We genuinely **don't know** today, because none of these layers is instrumented. The fix isn't "rip it out" (we proved we can remove cleanly — the legacy XML protocol is gone) nor "trust it" — it's **measure each, ablate the risky ones, and add the removal loop we never had.**

---

## 5. References

- Parser (recovery / coercion / normalization): [`NativeToolCallParser.ts`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts)
- Alias maps: [`packages/types/src/tool.ts`](../extensions/shofer/packages/types/src/tool.ts) (`TOOL_ALIASES`, `CROSS_ASSISTANT_ALIASES`), [`filter-tools-for-mode.ts`](../extensions/shofer/src/core/prompts/tools/filter-tools-for-mode.ts) (`resolveToolAlias`)
- Handler defaults: [`WaitTool.ts`](../extensions/shofer/src/core/tools/WaitTool.ts), [`AttemptCompletionTool.ts`](../extensions/shofer/src/core/tools/AttemptCompletionTool.ts), [`NewTaskTool.ts`](../extensions/shofer/src/core/tools/NewTaskTool.ts)
- Measurement design: [`model-dependant-tooling.md`](./model-dependant-tooling.md) §6 Phase 0
