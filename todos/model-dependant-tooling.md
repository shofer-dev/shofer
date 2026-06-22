# Design: Model-Dependent Tooling ("speak the model's language")

> **Status:** Draft / proposal — 2026-06-19
> **Owner:** TBD
> **Scope:** How Shofer presents and accepts native tool calls, adapted to the
> model handling each Task/turn. Source paths below are relative to this file
> (repo root), i.e. under `../extensions/shofer/`.

---

## 1. Problem

Every model is given Shofer's tool schemas explicitly each turn, yet models still
emit **foreign tool names and argument shapes** drawn from their training prior —
Claude-lineage models reach for `Bash`/`Edit`/`Grep`/`Glob`, Codex-lineage for
`shell`/`apply_patch`, Gemini-CLI-lineage for `replace`/`run_shell_command`, etc.
We know this empirically: we already maintain
[`CROSS_ASSISTANT_ALIASES`](../extensions/shofer/packages/types/src/tool.ts)
(`bash → execute_command`, `search_file → find_files`, …) and
[`PATH_ARG_ALIASES`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts)
(`file_path`/`directory` → `path`) precisely because priors leak through
function-calling.

That leakage costs tokens and turns: malformed calls, wrong-tool selection,
mis-filled args, parse failures, retries. A single canonical schema cannot be
"native" to every model at once because Shofer is multi-model (Claude, GPT,
Gemini, Qwen, DeepSeek, local, …).

**Thesis:** adjust the tool surface to the model handling each turn so we _speak
its dialect_ — reducing friction at the source rather than cleaning up after.

---

## 2. Goals / Non-Goals

**Goals**

- Reduce wrong-name / wrong-arg / mis-selected tool calls for the highest-traffic
  tools, per model.
- Do it incrementally and **measurably** (every adaptation justified by telemetry
  showing fewer failures).
- Reuse the existing per-model customization plumbing rather than build a parallel
  system.

**Non-Goals**

- A wholesale rename of all tools to one vendor's convention. (Helps one family,
  hurts others, huge churn.)
- Re-skinning the long tail of rarely-used tools. The win is concentrated in
  ~7 hot operations (read / write / edit / exec / grep / glob / list).
- Strict-mode-everything (we intentionally keep advisory-param tools non-strict).

---

## 3. Key Design Decisions

### 3.1 Key on model **lineage**, not provider/transport

The natural-looking key — API provider (Anthropic vs OpenAI) — is **wrong**. A
Qwen-Coder model fine-tuned on Gemini-CLI/Claude traces wants those tools even
though it is served over an OpenAI-compatible endpoint; the same Claude model over
Bedrock / Vertex / OpenRouter changes "provider" but not its tool prior.

Adapt on the model's **tool-training lineage** — a property attached to the model
id/family, independent of API transport. The codebase already does ad-hoc
lineage-ish branching (e.g. `isGeminiModel` in
[`lite-llm.ts`](../extensions/shofer/src/api/providers/lite-llm.ts),
`modelId.includes("gemini-2.5-pro")` in
[`model-params.ts`](../extensions/shofer/src/api/transform/model-params.ts)); this
design **formalizes** that into a single `ToolDialect` resolver.

### 3.2 Two directions — leverage is on **presentation**, not acceptance

| Direction                 | What it controls                                                                             | Today                 | Per-lineage value                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Acceptance** (input)    | What the parser _accepts_: `CROSS_ASSISTANT_ALIASES`, `PATH_ARG_ALIASES`, coercion, recovery | Global                | **Low.** Being lenient on input is ~free and rarely collides; gating per-lineage only buys collision disambiguation. **Keep global & permissive.** |
| **Presentation** (output) | What names / descriptions / param shapes the model _sees_ in its schema                      | One canonical surface | **High.** Matching the prior prevents the wrong call from happening at all. **This is the lever.**                                                 |

### 3.3 Param **shapes** matter more than names

Models pick the wrong _tool_ occasionally; they fill _args_ wrong far more often.
The highest-yield adaptation is accepting/presenting the lineage's param
names/types (`old_str`↔`old_string`, `cmd`↔`command`, `query`↔`pattern`,
`file_path`↔`path`). Much of this needs no per-lineage gating — just a wider,
bidirectional, **global** arg-alias layer.

### 3.4 Telemetry-driven, phased — measure before mapping

Don't guess dialects. We already record per-tool `attempts`/`failures`
([`toolUsageSchema`](../extensions/shofer/packages/types/src/tool.ts)), capture
unknown-tool errors via `NativeToolCallParser.lastParseError` + the "Did you mean?"
suggestion, and compute `originalName` (the emitted-vs-canonical name) at parse
time — but we **discard** `originalName` and do not attribute any of this per model.
We therefore do **not yet know** what each model prefers; §4 is a hypothesis.
**Phase 0 (§6) closes that gap**: it derives the real per-model dialect from
production traffic, and every later phase is gated on a measured failure-rate drop,
per lineage.

---

## 4. Provider Dialect Map (the concrete mapping to build & maintain)

> ⚠️ **Epistemic status — this table is a HYPOTHESIS, not a measurement.** It is
> derived from the _public harness schemas_ (Claude Code, Gemini CLI, Codex,
> Qwen-Code) — i.e. what each model was _trained against_, a strong prior _source_
> — plus a handful of anecdotal observations (the existing `CROSS_ASSISTANT_ALIASES`
> were added from real misfires). We do **not** yet have per-model data on what
> each model actually emits _in Shofer's harness_. "Preference" is also not an
> intrinsic model property: it is an interaction with the schema **and** system
> prompt we provide. Treat §4 as the starting map to **validate against Phase 0
> telemetry** (§6) and against each tool's _current_ upstream schema — not as gospel.
> Qwen-Code is a fork of Gemini CLI, so Qwen ≈ the Gemini dialect; DeepSeek (and
> most open "generic" models) ship **no distinctive proprietary tool set** — they
> follow the provided schema (coder variants often mimic Claude/Gemini-CLI traces)
> and map to `generic` until telemetry says otherwise.

### 4.1 Tool **name** mapping (canonical operation → name per lineage)

| Operation              | Shofer canonical      | Anthropic (Claude Code)     | OpenAI Codex CLI                  | Gemini CLI / Qwen-Code | DeepSeek / generic |
| ---------------------- | --------------------- | --------------------------- | --------------------------------- | ---------------------- | ------------------ |
| Read file              | `read_file`           | `Read`                      | `read_file` / via `shell` (`cat`) | `read_file`            | schema-driven      |
| Write file             | `write_to_file`       | `Write`                     | `apply_patch` (Add File)          | `write_file`           | schema-driven      |
| Edit in place          | `edit` / `apply_diff` | `Edit`, `MultiEdit`         | `apply_patch` (Update File hunks) | `replace`              | schema-driven      |
| Run command            | `execute_command`     | `Bash`                      | `shell`                           | `run_shell_command`    | schema-driven      |
| Content search (grep)  | `grep_search`         | `Grep`                      | via `shell` (ripgrep)             | `search_file_content`  | schema-driven      |
| Filename search (glob) | `find_files`          | `Glob`                      | via `shell`                       | `glob`                 | schema-driven      |
| List directory         | `list_files`          | `LS`                        | via `shell` (`ls`)                | `list_directory`       | schema-driven      |
| Patch (multi-file)     | `apply_patch`         | — (uses `Edit`/`MultiEdit`) | `apply_patch` (V4A format)        | —                      | schema-driven      |

### 4.2 Param **name / shape** mapping for the hot tools

| Canonical tool    | Canonical params                                       | Anthropic                                              | OpenAI Codex                                     | Gemini CLI / Qwen                                                | Shape gotchas to handle                                                                                                                              |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`       | `path`, `offset`, `limit`                              | `file_path`, `offset`, `limit`                         | `path`                                           | `absolute_path`, `offset`, `limit`                               | Gemini wants **absolute** paths; Claude/Gemini use `file_path`/`absolute_path` not `path`.                                                           |
| `write_to_file`   | `path`, `content`                                      | `file_path`, `content`                                 | (patch body)                                     | `file_path`, `content`                                           | Codex has no plain write — it's an `apply_patch` "Add File" hunk.                                                                                    |
| `edit`            | `file_path`, `old_string`, `new_string`, `replace_all` | `file_path`, `old_string`, `new_string`, `replace_all` | (patch hunks, no old/new)                        | `file_path`, `old_string`, `new_string`, `expected_replacements` | Codex edits via **patch format**, not search/replace — route to `apply_patch`. Gemini's `replace` ≈ our `edit`.                                      |
| `execute_command` | `command` (string), `cwd`, `timeout`                   | `command` (string), `timeout`, `description`           | `command` (**argv array**), `workdir`, `timeout` | `command` (string), `directory`, `description`                   | **Codex `shell.command` is a string[] argv, not a string** — biggest shape diff; must join/normalize. `cwd` is `workdir`(Codex)/`directory`(Gemini). |
| `grep_search`     | `query`, `path`, `fileTypes`, `caseSensitive`, …       | `pattern`, `path`, `glob`, `-i`, `output_mode`, `-n`   | (via shell)                                      | `pattern`, `path`, `include`                                     | Needle is `query`(us) vs `pattern`(everyone else). Flag names differ (`-i` vs `caseSensitive`, `glob`/`include` vs `fileTypes`).                     |
| `find_files`      | `pattern`, `maxResults`                                | `pattern`, `path`                                      | (via shell)                                      | `pattern`, `path`, `case_sensitive`                              | Claude/Gemini Glob take a **separate `path`** scope; we currently fold it into the glob via `composeFindFilesPattern()`.                             |
| `list_files`      | `path`, `recursive`                                    | `path`, `ignore`                                       | (via shell)                                      | `path` (`list_directory`)                                        | Claude `LS` has `ignore[]`; no `recursive` flag (Glob is used instead).                                                                              |

### 4.3 Reading the map

- **Names** (4.1) feed the _presentation_ rename channel (`aliasRenames`) and the
  _acceptance_ `CROSS_ASSISTANT_ALIASES`.
- **Params** (4.2) feed the bidirectional arg-alias layer (presentation schema +
  parser `normalizeArgAliases`). The non-obvious, must-handle shape diffs:
    1. **Codex `shell` command is an argv array**, not a string.
    2. **Codex edits are V4A patches**, not old/new strings → map Codex "edit"
       intent onto `apply_patch`, not `edit`.
    3. **Gemini expects absolute paths** for file tools.
    4. **Glob/Grep carry a separate `path` scope** (Claude/Gemini) that our
       `find_files`/`grep_search` fold differently.
    5. The grep needle is `query` for us, `pattern` for everyone else.

---

## 5. Architecture

### 5.1 What already exists (reuse, don't rebuild)

- [`applyModelToolCustomization()`](../extensions/shofer/src/core/prompts/tools/filter-tools-for-mode.ts)
  already takes `ModelInfo` and returns `{ allowedTools, aliasRenames }` — i.e.
  **per-model tool include/exclude and rename is already wired**, driven by
  `ModelInfo.includedTools` / `excludedTools`. Today it is manual (per model-id),
  name-only, and does not touch descriptions, param shapes, or the parser.
- [`buildNativeToolsArray()`](../extensions/shofer/src/core/task/build-tools.ts)
  assembles the final `ChatCompletionTool[]` for the turn — the single
  presentation choke point.
- [`filterNativeToolsForMode()` / `resolveToolAlias()`](../extensions/shofer/src/core/prompts/tools/filter-tools-for-mode.ts)
  produce the per-mode list.
- The system prompt + tool list is **already cached keyed by `getModel().id`**
  (see `getSystemPrompt` in
  [`Task.ts`](../extensions/shofer/src/core/task/Task.ts)), so a per-lineage
  surface is cache-compatible with no new invalidation axis.
- [`NativeToolCallParser`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts)
  is the acceptance side: `CROSS_ASSISTANT_ALIASES`, `PATH_ARG_ALIASES`,
  `normalizeArgAliases()`, `composeFindFilesPattern()`, XML-leak recovery,
  `lastParseError`.

### 5.2 Proposed additions

1. **`ToolDialect` resolver** — `resolveToolDialect(modelId, modelInfo) →
"claude" | "openai" | "gemini" | "generic"`. Single source of truth for
   lineage; folds in the scattered `isGeminiModel`-style checks over time.
2. **Dialect descriptors** — a declarative table (literally §4) per lineage,
   covering ONLY the hot tools: `presentName`, `descriptionHint`, `paramAliases`,
   `paramShape` (e.g. argv-array normalization for Codex `shell`).
3. **Wire into `buildNativeToolsArray`** (presentation) and into
   `NativeToolCallParser` (acceptance). The parser is currently a **static/global**
   class — per-turn acceptance means threading the resolved dialect (or a per-Task
   context) into `parseToolCall`/`normalizeArgAliases`. This is the main
   structural cost (see §7).
4. **Observability** — record the resolved dialect alongside the existing tool
   attempt/failure + `lastParseError` stats so each adaptation's effect is
   measurable.

### 5.3 Data flow (target)

```
turn → resolveToolDialect(model) ─┬─ presentation: buildNativeToolsArray applies
                                  │     dialect descriptor (rename + description hint
                                  │     + param schema) → schema the model sees
                                  └─ acceptance: NativeToolCallParser uses dialect +
                                        global aliases → canonical ToolUse
```

---

## 6. Phased Plan (cheapest / highest-leverage first)

0. **Phase 0 — Measure first (prerequisite to everything below).** §4 is a
   _hypothesis_ from public harness schemas, **not** a per-model measurement.
   Before adapting anything, instrument the parser to learn what models actually
   emit _in our harness_. The signal already exists and is thrown away:
   `NativeToolCallParser` computes `originalName` (the emitted name when it differs
   from canonical) but discards it.

    - Emit one telemetry event per tool call —
      `{ modelId, emittedName, resolvedName, wasAliased, wasUnknown, argKeysSeen }` —
      fired on **every alias resolution (successes included)** and on every
      `lastParseError` / unknown-tool.
    - **Log on success, not just failure.** Once an alias exists, the foreign call
      succeeds silently, so failure-only metrics go blind to a real preference.
    - Aggregate per model → the actual foreign-name / arg-variant distribution and
      per-tool failure rate. This turns §4 from a guess into a validated map and
      gives every later phase a metric to gate on.
    - Optional offline eval: a fixed coding-task battery per candidate model, logging
      pre-resolution name + args, to compute a per-model "dialect distance" from
      canonical (reproducible, controllable).

1. **Global, telemetry-driven param aliasing** (acceptance, no per-lineage
   machinery, near-zero risk). Extend `PATH_ARG_ALIASES` → a general bidirectional
   arg-alias layer covering the §4.2 offenders. _Ship first; helps every model._
2. **Per-lineage description hints** (presentation, cheap). Append "(equivalent to
   Claude Code's `Edit`/`Bash`/`Grep`)" / "(Gemini CLI `replace`/`run_shell_command`)"
   to the relevant tool descriptions. Anchors the prior to our canonical tool
   **without** separate schemas. Captures most of the benefit at ~5% of the cost.
3. **`ToolDialect` resolver + descriptor table** (infra) — formalize lineage from §4.
4. **Narrow per-lineage renames** — only the 4–7 hot tools, only where telemetry
   shows a lineage still fighting after steps 1–2. Reuse the `aliasRenames` channel.
5. **Per-lineage param schemas / shape normalizers** for those hot tools (Codex
   argv-array `shell`, Gemini absolute paths, Codex-edit→`apply_patch`) — highest
   effort, last, only if data demands.

**Prerequisite:** consolidate the redundant mutators (we expose ~8 ways to change
a file: `apply_diff`, `edit`, `search_replace`, `edit_file`, `search_and_replace`,
`insert_edit`, `sed`, `write_to_file`) into a small orthogonal set. Per-lineage
tuning of a confusing surface just multiplies the confusion. (Tracked separately;
see [`native_tools.md`](../extensions/shofer/docs/native_tools.md).)

---

## 7. Costs & Risks

- **Maintenance multiplier.** N dialect surfaces to keep in sync; bugs multiply per
  surface (cf. the `search_file` recursion bug, ×N). _Mitigation:_ dialects cover
  the hot-tool table only; everything else falls back to canonical.
- **Static parser threading.** `NativeToolCallParser` is a global static; per-turn
  acceptance variation requires passing dialect/context through `parseToolCall`.
  Real refactor; design the context object once.
- **Combinatorial tests.** Parse + output-contract correctness per dialect.
  _Mitigation:_ table-driven tests over `(dialect × hot-tool)`.
- **Mid-task model switch.** A workflow agent that switches `api_configuration`
  re-skins its tools → prompt-cache invalidation on switch (inherent to switching).
- **Over-fitting.** Adapting to one model's quirks can regress when it updates.
  _Mitigation:_ telemetry gates; revisit periodically; the §4 table needs an owner.
- **Acceptance collisions.** A foreign name meaning different tools across lineages
  (e.g. `replace`). _Mitigation:_ keep global map for non-colliding aliases; scope
  only true collisions per-lineage.

---

## 8. Open Questions

- Granularity of `ToolDialect`: per-family vs per-model-id overrides — how much
  config do we expose to users vs ship as defaults?
- Where does lineage metadata live? On `ModelInfo`, a static registry, or inferred?
  (Aggregators / local models make inference unreliable.)
- Do description hints alone (Phase 2) close most of the gap, making renames
  (Phase 4) unnecessary? Decide from Phase-2 telemetry.
- How to A/B a dialect change safely in production to prove the failure-rate delta.
- Does anyone actually need the Codex `apply_patch` V4A path, or is `apply_diff`
  enough — i.e. is the Codex edit-shape mapping worth its complexity?

---

## 9. References

- Tool registry / aliases: [`packages/types/src/tool.ts`](../extensions/shofer/packages/types/src/tool.ts) (`toolNames`, `TOOL_GROUPS`, `TOOL_ALIASES`, `CROSS_ASSISTANT_ALIASES`, `TOOL_DISPLAY_NAMES`)
- Presentation choke point: [`build-tools.ts`](../extensions/shofer/src/core/task/build-tools.ts) (`buildNativeToolsArray`)
- Per-mode + per-model customization: [`filter-tools-for-mode.ts`](../extensions/shofer/src/core/prompts/tools/filter-tools-for-mode.ts) (`resolveToolAlias`, `applyModelToolCustomization`, `filterNativeToolsForMode`)
- Acceptance side: [`NativeToolCallParser.ts`](../extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts)
- Existing ad-hoc lineage checks to fold in: [`lite-llm.ts`](../extensions/shofer/src/api/providers/lite-llm.ts), [`model-params.ts`](../extensions/shofer/src/api/transform/model-params.ts)
- Tool schemas presented to the model: [`src/core/prompts/tools/native-tools/`](../extensions/shofer/src/core/prompts/tools/native-tools/)
- Tool docs: [`docs/native_tools.md`](../extensions/shofer/docs/native_tools.md), [`docs/adding-new-tools.md`](../extensions/shofer/docs/adding-new-tools.md)
