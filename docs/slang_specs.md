# Slang Language Specification (Shofer)

Reference for authoring Shofer workflow `.slang` files. This documents the
**Shofer implementation** — the vendored parser, static resolver, and the
`WorkflowTask` interpreter — not the upstream `@riktar/slang` reference language.
Where the two differ, this document wins.

> **Source of truth**
>
> - Lexer: [`src/core/workflow/slang-lexer.ts`](../src/core/workflow/slang-lexer.ts)
> - Parser: [`src/core/workflow/slang-parser-upstream.ts`](../src/core/workflow/slang-parser-upstream.ts)
> - AST types: [`src/core/workflow/slang-ast.ts`](../src/core/workflow/slang-ast.ts)
> - Public API: [`src/core/workflow/slang-parser.ts`](../src/core/workflow/slang-parser.ts) (`parseSlang`, `validateSlangAST`)
> - Static analysis: [`src/core/workflow/slang-resolver.ts`](../src/core/workflow/slang-resolver.ts)
> - Interpreter VM (compiler + `advanceAgent` + `MAX_CONTROL_FLOW_STEPS`): [`src/core/workflow/slang-interpreter.ts`](../src/core/workflow/slang-interpreter.ts)
> - Runtime types (`FlowState`, `AgentState`, `FlowStatus`): [`src/core/workflow/slang-types.ts`](../src/core/workflow/slang-types.ts)
> - Round-based orchestrator: [`src/core/workflow/WorkflowTask.ts`](../src/core/workflow/WorkflowTask.ts)
> - Worked examples: [`.shofer/workflows/`](../../../.shofer/workflows/) (`hello-world.slang`, `test-slang-basics.slang`)

## Table of Contents

1. [File Structure](#file-structure)
2. [Lexical Elements](#lexical-elements)
3. [Reserved Keywords](#reserved-keywords)
4. [Flow Declaration](#flow-declaration)
5. [Agent Declaration](#agent-declaration)
6. [Operations](#operations)
7. [Control Flow](#control-flow)
8. [Expressions](#expressions)
9. [Recipients & Sources](#recipients--sources)
10. [Built-in State](#built-in-state)
11. [Flow Constraints](#flow-constraints)
12. [Structured Output Contracts](#structured-output-contracts)
13. [Static Analysis (Warnings)](#static-analysis-warnings)
14. [Runtime Semantics](#runtime-semantics)
15. [Parsed-but-Not-Executed Constructs](#parsed-but-not-executed-constructs)
16. [Common Pitfalls](#common-pitfalls)
17. [Complete Grammar (EBNF)](#complete-grammar-ebnf)

---

## File Structure

A `.slang` file contains exactly one top-level construct: a `flow`. The flow body
holds (in any order) optional `title`/`description`/`icon` meta fields,
an optional `import`, one or more `agent` declarations, optional `param` metadata
blocks, and the flow constraints (`converge`, `budget`) plus optional
`deliver`/`expect` statements.

```slang
flow "my-flow" (param: "string") {
  title: "My Flow"
  description: "A simple example workflow."
  icon: "rocket"

  import "shared/common.slang" as common   -- optional, inside the flow body

  agent Worker {
    mode: "code"
    role: "Does the work."
    stake do_it(input: param) -> @out
    commit
  }

  converge when: @Worker.committed
  budget: rounds(10), tokens(50000)
}
```

> **Important:** `import` is a **flow-body item** — it must appear _inside_ the
> `flow { ... }` block, not before it. There is no top-level/module scope above
> the flow.

---

## Lexical Elements

| Element    | Form                                                 | Notes                                                         |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Comment    | `-- text to end of line`                             | Single-line only. No block comments.                          |
| String     | `"double quoted"`                                    | The only string form. Used for params, roles, args, etc.      |
| Number     | `42`, `3.14`                                         | Integer or float.                                             |
| Boolean    | `true`, `false`                                      | Keywords.                                                     |
| Identifier | `myVar`, `do_work`, `Agent1`                         | Agent names, bindings, function names, variables.             |
| Agent ref  | `@Architect`, `@out`, `@all`, `@any`, `@*`, `@Human` | `@` prefix. `@*` is a wildcard agent ref for `await` sources. |
| Arrow      | `->`                                                 | Stake recipient.                                              |
| Back-arrow | `<-`                                                 | Await source.                                                 |

There are **no arithmetic operators** (`+`, `-`, `*`, `/`). Counters and loop
state are expressed with boolean flags and the built-in `round` / `committed_count`.

---

## Reserved Keywords

These cannot be used as identifiers (agent names, bindings, function names,
variables). Using one as a `stake func(...)` name is a common parse error.

```
flow  agent  stake  await  commit  escalate  import  as
when  if  else  otherwise  converge  budget
role  model  tools  retry  output
tokens  rounds  time  count  reason
let  set  repeat  until  deliver  expect
contains  true  false  title  description  icon  param
```

> Keywords _are_ allowed as **dot-access property names** (e.g.
> `result.count` parses), because the parser accepts keyword tokens after a `.`.

---

## Flow Declaration

```slang
flow "<name>" (<param>: "<type>", ...) {
  title: "<UI title>"
  description: "<markdown description>"
  icon: "<icon key>"

  <body>
}
```

- `<name>` is a **string literal** (quoted).
- Parameters are optional. Each is `name: "type"` where `type` is an advisory
  annotation (`"string"` | `"number"` | `"boolean"`) — **not enforced at runtime**.
- Parameters are referenced by bare identifier inside agent bodies (e.g. `feature`).

### Optional Flow Meta Fields

These appear **after** the opening `{` but **before** any `agent`, `import`, `converge`, or `budget` statements. All are optional strings.

| Field         | Syntax                 | Description                                                                                                         |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `title`       | `title: "My Workflow"` | Human-readable UI title. Distinct from the machine name.                                                            |
| `description` | `description: "..."`   | Markdown description of the workflow. Rendered in the UI. Can be multiline (use `\n` escapes in the quoted string). |
| `icon`        | `icon: "rocket"`       | Icon key for the workflow (e.g. `"rocket"`, `"gear"`, `"search"`). Rendered next to the title in the UI.            |

```slang
flow "feature-test" (topic: "string", threshold: "number", verbose: "boolean") {
  title: "Feature Tester"
  description: "Tests every Slang feature:\nstake routing, await, escalate, repeat-until,\nwhen-otherwise, let/set, converge, budget,\noutput schemas, and multi-agent coordination."
  icon: "beaker"

  ...
}
```

### Param Metadata

Each flow input parameter can have an optional metadata block inside the flow body.
Besides a description, the block controls **which input widget** the workflow's
param-collection form renders for that parameter:

```slang
param <name> {
  description: "<markdown description>"   -- shown beneath the label
  options: ["a", "b", "c"]               -- fixed set of allowed values
  widget: "dropdown" | "radio" | "checkbox"  -- how to present `options`
  min: <number>                          -- slider lower bound (number params)
  max: <number>                          -- slider upper bound (number params)
  step: <number>                         -- slider step (default 1)
  default: <literal>                     -- value used when left blank
}
```

| Field         | Applies to            | Effect on the rendered widget                                                                                     |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `description` | any                   | Markdown description shown beneath the field label.                                                               |
| `options`     | string                | Fixed set of allowed values. Renders a **dropdown** (single-select) by default.                                   |
| `widget`      | params with `options` | `"dropdown"` (default), `"radio"` (single-select bullets), or `"checkbox"` (**multi-select**; value is an array). |
| `min` + `max` | number                | Renders a **slider** (range) instead of a number box. `step` tunes granularity (default `1`).                     |
| `default`     | any                   | Pre-fills the control; used when the field is left blank. Use a list literal for a multi-select default.          |

**Widget resolution** (when no `param` block overrides it):

| Declared type | `param` metadata | Rendered as                                 | Submitted value |
| ------------- | ---------------- | ------------------------------------------- | --------------- |
| `"string"`    | _none_           | **multiline, resizable textarea**           | string          |
| `"string"`    | `options`        | dropdown (or radio / checkbox via `widget`) | string / array  |
| `"number"`    | _none_           | number input                                | number          |
| `"number"`    | `min` + `max`    | **slider**                                  | number          |
| `"boolean"`   | _none_           | single checkbox                             | boolean         |

The `options` / `widget` / `min` / `max` / `step` annotations are advisory: they
only affect presentation and are not enforced at the language level.

```slang
flow "report" (format: "string", sections: "string", verbosity: "number", notes: "string") {
  title: "Report Generator"

  param format {
    description: "Output format."
    options: ["pdf", "html", "markdown"]   -- dropdown
    default: "markdown"
  }
  param sections {
    description: "Sections to include."
    options: ["summary", "details", "appendix"]
    widget: "checkbox"                      -- multi-select; value is an array
  }
  param verbosity {
    description: "Detail level (0–5)."
    min: 0
    max: 5
    step: 1                                 -- slider
    default: 2
  }
  -- notes (plain string, no options) → multiline resizable textarea

  agent Generator {
    ...
  }
}
```

---

## Agent Declaration

```slang
agent <Name> {
  mode: "<slug>"          -- Shofer mode slug (Shofer extension)
  model: "<profile>"      -- optional: override API/model profile
  role: "<description>"   -- optional: system-prompt role definition
  tools: [group_a, ...]   -- optional: ToolGroup names, comma-separated
  retry: <number>         -- optional: max LLM-call retries
  peers: [@Agent1, ...]   -- optional: declared direct-message peers (see below)
  context: {              -- optional: controls what project context the agent receives
    include_agents_md: <boolean>   -- inject AGENTS.md rules into the agent's system prompt
  }

  <operations...>
}
```

| Meta field                  | Required | Wire status              | Value form              | Notes                                                                                                                                                                                                                                                                                               |
| --------------------------- | -------- | ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                      | no\*     | ✅ wired                 | string                  | Shofer mode slug. Shofer extension (`mode: "code"`). Defaults to `"code"` at spawn if omitted.                                                                                                                                                                                                      |
| `tools`                     | no       | ⚙️ parsed, not yet wired | list of ToolGroup names | **Only valid values are the 9 ToolGroup names:** `read`, `write`, `execute`, `browser`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized`. Each maps to its corresponding `TOOL_GROUPS` entry. When wired, restricts the spawned Task to only those groups. Bare identifiers, **not quoted.** |
| `model`                     | no       | parsed, not consumed     | string                  | Would select the API-configuration profile by name.                                                                                                                                                                                                                                                 |
| `role`                      | no       | parsed, not consumed\*\* | string                  | Would become the agent Task's role/system prompt. Currently used only for peer resource descriptions in dispatch prompts.                                                                                                                                                                           |
| `retry`                     | no       | parsed, not consumed     | number                  | Would set max retries for the agent's LLM calls per stake.                                                                                                                                                                                                                                          |
| `context`                   | no       | ❌ not parsed            | object                  | (Planned) Controls what project context the agent receives. Currently not recognized by the parser — using it causes a parse error.                                                                                                                                                                 |
| `context.include_agents_md` | no       | planned                  | boolean                 | (Planned) When `true`, injects the project's AGENTS.md rules into the agent's system prompt. Useful for agents that need to follow project-specific conventions.                                                                                                                                    |

\* `mode` is technically optional in the grammar but will default to `"code"` at spawn.
\*\* `role` is consumed in `getPeerResources()` for peer listings but does NOT override the mode's `roleDefinition`.

### `peers:` — Declared Direct-Message Peers

`peers:` declares which other agents this agent may message **directly** via
`send_message_to_task`, bypassing the executor and mailbox. It is the explicit
grant that least-privilege peer scoping (default-deny) requires.

```slang
agent Worker {
  peers: [@Reviewer, @Coordinator]
  stake do_work(...) -> @Reviewer
  commit
}
```

| Property                    | Detail                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Value form                  | Comma-separated list of bare `@AgentRef` identifiers inside `[…]`.                                                                                                                                                                                 |
| Default                     | Absent ⇒ no sibling grant (parent + own children only, per least-privilege).                                                                                                                                                                       |
| Wildcards                   | `@out`, `@all`, `@any`, `@Human`, `*` are **not** valid in `peers:`. The resolver emits an error on wildcard peers.                                                                                                                                |
| Unknown refs                | The resolver emits an error for `@Name` refs that don't resolve to a declared agent.                                                                                                                                                               |
| Back-fill                   | If peer B is spawned after agent A, A's `knownPeers` is updated at B's spawn time.                                                                                                                                                                 |
| Relationship to stake/await | `peers:` governs only the **direct-message** (`send_message_to_task`) permission. The executor-mediated stake/await plane (mailbox) is unaffected — an agent may declare a `peers:` grant for an agent it also stakes to, and both planes coexist. |

### `context:`

(Planned) Controls what project context the agent receives. Currently not recognized by the parser — using it causes a parse error.

By convention, meta fields appear **before** the operations. Note this is **not
enforced** by the parser — the agent-body loop in
[`slang-parser-upstream.ts`](../src/core/workflow/slang-parser-upstream.ts)
accepts meta fields and operations interleaved in any order — but writing them
first is strongly recommended for readability.

---

## Operations

The agent body is a sequence of operations. The three core primitives:

| Primitive | Syntax                                                      | Semantics                                                             |
| --------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `stake`   | `stake func(args) [-> @R, ...] [if cond] [output: { ... }]` | Run a unit of work; optionally route the result to recipients.        |
| `await`   | `await <binding> <- @Source [, @Source2 ...]`               | Block until a matching message arrives; bind it to `<binding>`.       |
| `commit`  | `commit [value] [if cond]`                                  | Mark this agent committed (terminal). Optionally carry a value/guard. |

### `stake`

```slang
stake plan(goal: topic, depth: 3, urgent: true, labels: ["a", "b"]) -> @Worker if any_ok
  output: { plan: "string", confidence: "number" }
```

Ordering of the optional clauses is fixed: **call → recipients (`->`) →
condition (`if`) → `output:`**.

- **Arguments** may be named (`goal: topic`) or positional (`topic`), mixed, and
  may be any expression (string/number/bool/ident/list/agent-ref/dot-access).
- **Recipients** after `->` are comma-separated `@Agent` / `@out` / `@all`.
- **Condition** `if <expr>` gates whether the stake runs.
- **`output:`** declares the expected JSON shape of the result — see
  [Structured Output Contracts](#structured-output-contracts).

> There is **no** `let x = stake ...` form. A stake is an _operation_, not an
> expression, so it cannot appear on the right-hand side of `let`/`set`. To use a
> staked result later, route it (`-> @out` or to a peer) or `await` it back.

### `await`

```slang
await findings <- @Codebase
await kickoff  <- @any
```

- Binds the incoming message payload to `<binding>` in the agent's local scope.
- Multiple sources may be listed (`<- @A, @B`), satisfied by the first match.
- `@any` / `*` accept a message from any sender.
- `@Human` is the escalation reply source (see `escalate`).

### `commit`

```slang
commit                                  -- bare
commit "worker-complete"                -- carry a value (becomes @Agent.output)
commit if committed_count >= 1          -- guarded
```

A committed agent is terminal and stops participating in rounds.

### `escalate`

```slang
escalate @Human reason: "Please approve the design." if verbose
await guidance <- @Human
```

- Pauses the flow and asks the **user** (via the WorkflowTask's `ask`).
- `reason:` (optional) is the prompt text shown to the user.
- `if <cond>` (optional) gates the escalation.
- The user's reply is delivered as a message **from `@Human`**, consumed by a
  following `await ... <- @Human`. The agent itself is unaware it was escalated.

---

## Control Flow

| Construct      | Syntax                                  | Notes                                                   |
| -------------- | --------------------------------------- | ------------------------------------------------------- |
| `when`         | `when <expr> { ... }`                   | Runs the body when the condition is truthy.             |
| `when`/else    | `when <expr> { ... } otherwise { ... }` | The else branch keyword is **`otherwise`**, not `else`. |
| `repeat until` | `repeat until <expr> { ... }`           | Loops until the condition is truthy.                    |
| `let`          | `let <name> = <expr>`                   | Declare an agent-local variable.                        |
| `set`          | `set <name> = <expr>`                   | Reassign an existing variable.                          |

> **`otherwise`, not `else`.** Although `else` is a reserved keyword, the
> `when`-block parser only recognizes `otherwise` for the else branch. Writing
> `when c { } else { }` is a parse error.

```slang
let done = false
repeat until done {
  await signal <- @Worker
  when signal contains "DONE" {
    set done = true
  } otherwise {
    stake nudge(note: "keep going") -> @Worker
  }
}
```

The interpreter compiles `when`/`repeat` into conditional/unconditional jumps and
guards loop execution with `MAX_CONTROL_FLOW_STEPS = 10_000` per agent advance.

---

## Expressions

| Category    | Examples                                                 |
| ----------- | -------------------------------------------------------- | --- | --- |
| Literals    | `42`, `3.14`, `"text"`, `true`, `false`                  |
| Identifier  | `topic`, `done` (params, bindings, local variables)      |
| Agent ref   | `@Architect`                                             |
| List        | `["a", "b", "c"]`                                        |
| Dot access  | `@Agent.committed`, `result.confidence`, `verdict.notes` |
| Parenthesis | `(a                                                      |     | b)` |

### Operators (no arithmetic)

| Operator   | Meaning                                             |
| ---------- | --------------------------------------------------- |
| `==`       | Equality (strict).                                  |
| `!=`       | Inequality.                                         |
| `>` `>=`   | Greater-than / greater-or-equal (numeric coercion). |
| `<` `<=`   | Less-than / less-or-equal (numeric coercion).       |
| `&&`       | Logical AND (short-circuit on truthiness).          |
| `\|\|`     | Logical OR (short-circuit on truthiness).           |
| `contains` | Substring (string) / membership (list).             |

Precedence (lowest → highest): `||` → `&&` → comparison (`== != > >= < <=`) →
`contains` → dot-access → primary.

---

## Recipients & Sources

| Token        | Valid in         | Meaning                                              |
| ------------ | ---------------- | ---------------------------------------------------- |
| `@AgentName` | stake / await    | A specific agent.                                    |
| `@out`       | stake recipient  | Flow output — becomes part of the final result.      |
| `@all`       | stake recipient  | Broadcast to every other agent.                      |
| `@any`       | await source     | Accept a message from any single sender.             |
| `*`          | await source     | Wildcard — accept from anyone.                       |
| `@Human`     | escalate / await | The user, via `escalate`; reply consumed by `await`. |

---

## Built-in State

Accessible inside any expression (`when`, `converge`, `commit if`, etc.):

| Expression         | Type    | Description                                                 |
| ------------------ | ------- | ----------------------------------------------------------- |
| `@Agent.output`    | any     | The agent's last staked/committed output.                   |
| `@Agent.committed` | boolean | Whether the agent has committed.                            |
| `@Agent.status`    | string  | `idle` \| `running` \| `committed` \| `blocked` \| `error`. |
| `committed_count`  | number  | How many agents have committed.                             |
| `all_committed`    | boolean | True when **all** agents have committed.                    |
| `round`            | number  | Current round number (starts at 0).                         |

Bindings created by `await`/`let`/`set` and flow parameters are also referenceable
by bare identifier. Dot-access on a structured binding (e.g. `result.confidence`)
reads a field of the parsed JSON output.

---

## Flow Constraints

```slang
converge when: <expr>
budget: tokens(N), rounds(N) [, time(N)]
```

### `converge`

The flow terminates **successfully** when the condition becomes truthy. Common forms:

| Form                                  | Meaning                       |
| ------------------------------------- | ----------------------------- |
| `converge when: all_committed`        | Every agent has committed.    |
| `converge when: committed_count >= 1` | At least one agent committed. |
| `converge when: @Architect.committed` | A specific agent committed.   |

### `budget`

| Item        | Enforced? | Meaning                                          | Default         |
| ----------- | --------- | ------------------------------------------------ | --------------- |
| `tokens(N)` | ✅ yes    | Max aggregate tokens across all agent LLM calls. | `0` (unlimited) |
| `rounds(N)` | ✅ yes    | Max execution rounds.                            | `0` (unlimited) |
| `time(N)`   | ✅ yes    | Hard wall-clock seconds for the entire flow.     | `0` (unlimited) |

If no `budget` statement is present, all three limits (`tokens`, `rounds`,
`time`) default to **unlimited** (0). Exceeding an enforced budget terminates the
flow with `budget_exceeded`.

---

## Structured Output Contracts

```slang
stake review(draft: design) -> @Decider
  output: { approved: "boolean", score: "number", notes: "string" }
```

The contract is enforced at the **system-prompt level**, not via API JSON-schema.
At dispatch the WorkflowTask injects a directive into the agent prompt:

```
OUTPUT CONTRACT:
Your attempt_completion result MUST be ONLY a valid JSON object
(no markdown, no extra text) with exactly these fields:
  - approved: boolean
  - score: number
  - notes: string
Example: {"approved": ..., "score": ..., "notes": ...}
The result will be validated against this schema. Missing fields or
non-JSON will cause a retry (max 3 retries before the agent is
marked as error).
```

The interpreter parses the `completionResultSummary` field of the agent's
`HistoryItem` (populated from `attempt_completion`'s `result` parameter).
Validation proceeds in two steps:

1. **JSON parse** — string results are `JSON.parse()`d. Parse failure produces
   a validation error.
2. **Schema check** — parsed objects are checked against the `output:` field list.
   Missing fields produce a validation error.

On validation failure (max 3 retries):

- The agent's `retryCount` is incremented.
- The agent is re-prompted with the original dispatch + the validation error.
- The agent's `opIndex` is **not** advanced — it stays on the same `stake`.
- The check is `if (retryCount > MAX_RETRIES) status = "error"` with
  `MAX_RETRIES = 3`. Because `retryCount` is incremented **before** the
  comparison, the agent gets the initial attempt plus 3 re-prompts, and is marked
  `error` on the 4th consecutive failure (`retryCount === 4`).

On success:

- `retryCount` resets to 0.
- The parsed object becomes `agentState.output`, available for dot-access in
  `when` conditions (`review_result.approved`, `review_result.score`, etc.).
- The result is routed to the stake's recipients via the mailbox.

---

## Static Analysis (Warnings)

`validateSlangAST()` (→ `analyzeFlow()` in [`slang-resolver.ts`](../src/core/workflow/slang-resolver.ts))
returns human-readable diagnostics. None block execution, but a well-formed flow
should produce **zero** warnings. Checks:

| Diagnostic                                                             | Level   | Trigger                                                                            |
| ---------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `Flow has no converge statement …`                                     | warning | No `converge` in the flow body.                                                    |
| `Flow has no budget statement — default is unlimited (no enforcement)` | warning | No `budget` in the flow body.                                                      |
| `Agent "X" has no commit — it will never signal completion`            | warning | An agent with operations never commits.                                            |
| `Agent "X" stakes to unknown agent "@Y"`                               | error   | Stake recipient is not a declared agent (and not `@out`/`@all`).                   |
| `Agent "X" awaits from unknown agent "@Y"`                             | error   | Await source is not a declared agent (and not `@any`/`*`/`@Human`).                |
| `Agent "X" produces output but no agent awaits from it`                | warning | An agent stakes to peers that nobody awaits — including nested in `when`/`repeat`. |

The orphan/await scan recurses into `when`/`repeat`/`otherwise` blocks, and
`@Human` is recognized as a valid await source (the escalation pseudo-agent).

---

## Runtime Semantics

The `WorkflowTask` is the deterministic, non-LLM **interpreter**. It compiles each
agent's operation tree once into a flat instruction list and drives a round-based
loop. Per round:

1. **Advance** every non-running, non-terminal agent through its non-blocking
   instructions (`let`/`set`/jumps/branches/satisfied awaits) until it blocks on a
   `stake`, an unsatisfied `await`, an `escalate`, or it `commit`s / ends.
2. **Check converge** — on truthy condition, the flow completes successfully.
3. If no agent can make progress and none staked/escalated → **deadlock**.
4. **Handle escalations** synchronously (ask the user, deliver the reply as mail
   from `@Human`).
5. **Dispatch stakes** (spawn the agent Task on first stake, otherwise resume it),
   wait for `attempt_completion`, route the result to recipient mailboxes, and add
   the agent's token usage to the running total.
6. **Re-check converge** and **persist a checkpoint** to the `HistoryItem`.

Budgets (`rounds`, `tokens`, and wall-clock `time`) are enforced at the top of
each round (the round-loop condition checks all three) and again per-agent after
stake collection. A value of `0` means unlimited. An agent maps
to exactly one Shofer Task for its lifetime — resumed (not recreated) across
stakes, preserving conversation history.

Flow status values (the complete `FlowStatus` union in
[`slang-types.ts`](../src/core/workflow/slang-types.ts)): `running` | `converged` |
`budget_exceeded` | `escalated` | `deadlock` | `error` | `aborted`. (`aborted` is
set by `abortTask()` when the user stops the flow.)

---

## Parsed-but-Not-Executed Constructs

These are accepted by the grammar (and stored on the AST) but the current
interpreter does **not** act on them. They are safe to include for documentation
or forward-compatibility, but do not rely on runtime behaviour:

| Construct                | Status                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `import "..." as alias`  | Parsed and recorded on the flow; no module resolution is performed.                                                                        |
| `deliver func(args)`     | Flow-level statement; parsed, not executed.                                                                                                |
| `expect <expr>`          | Flow-level statement; parsed, not executed.                                                                                                |
| `await` trailing options | `await x <- @A, key: expr` — options are parsed but unused (and fragile; prefer a bare source list).                                       |
| `tools`                  | ⚙️ Parsed, stored on `AgentMeta.tools`, not yet consumed by `spawnAgentTask()`. Values are ToolGroup names.                                |
| `model`                  | Parsed, stored on `AgentMeta.model`, not consumed by WorkflowTask.                                                                         |
| `role`                   | Parsed, stored on `AgentMeta.role`, consumed only in `getPeerResources()` for descriptions. Does NOT override the mode's `roleDefinition`. |
| `retry`                  | Parsed, stored on `AgentMeta.retry`, not consumed by WorkflowTask.                                                                         |

### Planned (Not Yet Parsed)

These constructs appear in the design documents and the EBNF grammar but the
current lexer/parser does **not** recognize them. Using them today will cause a
parse error.

| Construct                   | Planned for                                                           |
| --------------------------- | --------------------------------------------------------------------- |
| `context: { ... }`          | Agent meta block controlling what project context the agent receives. |
| `context.include_agents_md` | When `true`, injects AGENTS.md rules into the agent's system prompt.  |

---

## Common Pitfalls

1. **`import` belongs inside the flow body**, not above the `flow` declaration.
2. **Use `otherwise`, not `else`**, for the negative branch of `when`.
3. **No `let x = stake ...`** — stakes are operations, not expressions. Route or
   `await` the result instead.
4. **Avoid reserved keywords as function/agent names** (e.g. `deliver`, `retry`,
   `expect`, `count`). `stake deliver(...)` fails to parse.
5. **No arithmetic** — model counters with `round` / `committed_count` and boolean
   flags, not `+`/`-`.
6. **Balance the topology** — every `await <- @X` needs a matching `stake -> @<the
awaiter>` somewhere, or the flow deadlocks. Recurse this reasoning through
   `when`/`repeat` blocks.
7. **Flow name and string args are double-quoted**; `tools` entries are **bare ToolGroup names** (`read`, `write`, `execute`, `browser`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized`), not individual tool names. Using individual tool names like `read_file` or `write_to_file` is invalid — those are not ToolGroup names.

---

## Complete Grammar (EBNF)

Informal EBNF of the Shofer-accepted grammar (`--` comments stripped by the lexer):

```ebnf
program        = flow ;
flow           = 'flow' string '(' [ params ] ')' '{' { flow_meta } { flow_item } '}' ;
params         = param { ',' param } ;
param          = ident ':' string ;

flow_meta      = 'title' ':' string
               | 'description' ':' string
               | 'icon' ':' string ;

flow_item      = import | agent | converge | budget | deliver | expect | param_meta ;
import         = 'import' string 'as' ident ;
converge       = 'converge' 'when' ':' expr ;
budget         = 'budget' ':' budget_item { ',' budget_item } ;
budget_item    = ( 'tokens' | 'rounds' | 'time' ) '(' expr ')' ;
deliver        = 'deliver' func_call ;
expect         = 'expect' expr ;
param_meta     = 'param' ident '{' { 'description' ':' string } '}' ;

agent          = 'agent' ident '{' { agent_meta } { operation } '}' ;
agent_meta     = 'role'  ':' string
               | 'model' ':' string
               | 'mode'  ':' string                          (* Shofer extension *)
               | 'tools' ':' '[' [ ident { ',' ident } ] ']'
               | 'peers' ':' '[' [ agentref { ',' agentref } ] ']'  (* Shofer extension *)
               | 'retry' ':' number ;

operation      = stake | await | commit | escalate | when | let | set | repeat ;
stake          = 'stake' func_call [ '->' recipient { ',' recipient } ]
                 [ 'if' expr ] [ 'output' ':' output_schema ] ;
await          = 'await' ident '<-' source { ',' source }
                 { ',' ident ':' expr } ;          (* options: parsed, unused *)
commit         = 'commit' [ expr ] [ 'if' expr ] ;
escalate       = 'escalate' agentref [ 'reason' ':' string ] [ 'if' expr ] ;
when           = 'when' expr '{' { operation } '}' [ 'otherwise' '{' { operation } '}' ] ;
repeat         = 'repeat' 'until' expr '{' { operation } '}' ;
let            = 'let' ident '=' expr ;
set            = 'set' ident '=' expr ;

func_call      = ident [ '(' [ argument { ',' argument } ] ')' ] ;
argument       = [ ident ':' ] expr ;
recipient      = agentref | ident ;           (* @Agent / @out / @all *)
source         = agentref | ident | '*' ;     (* @Agent / @any / * *)
output_schema  = '{' [ output_field { ',' output_field } ] '}' ;
output_field   = ident ':' string ;

expr           = or_expr ;
or_expr        = and_expr { '||' and_expr } ;
and_expr       = cmp_expr { '&&' cmp_expr } ;
cmp_expr       = contains_expr [ ( '==' | '!=' | '>' | '>=' | '<' | '<=' ) contains_expr ] ;
contains_expr  = dot_expr [ 'contains' dot_expr ] ;
dot_expr       = primary { '.' ident } ;
primary        = number | string | 'true' | 'false'
               | ident | agentref | list | '(' expr ')' ;
list           = '[' [ expr { ',' expr } ] ']' ;
agentref       = '@' ident ;
```

---

## Related Documents

- [`workflow_design.md`](workflow_design.md) — the Workflow abstraction design and `WorkflowTask` architecture.
- Worked examples in [`.shofer/workflows/`](../../../.shofer/workflows/):
  `hello-world.slang` (liveliness — one agent, one stake, one commit) and
  `test-slang-basics.slang` (exhaustive feature coverage — multi-agent stake
  routing, await, escalate, repeat-until, when-otherwise, let/set, output
  contracts, dot-access, `contains`, converge, budget, and sibling-peer
  messaging).

---

## Review Findings (2026-06-11)

Findings from a review of this specification against the live source. Unambiguous
factual errors have been corrected inline above; this section records the
rationale and a couple of items that are observations rather than fixes.

### Doc Inaccuracies Corrected Inline

| Location              | Was                                                                                           | Now                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source-of-truth links | all used `../../src/...` → resolves to nonexistent `extensions/src/...`                       | `../src/...` (the extension root is one level up from `docs/`)                                                                                                                                                       |
| Worked-examples path  | `../../../../.shofer/workflows/` (one `../` too many)                                         | `../../../.shofer/workflows/`                                                                                                                                                                                        |
| Worked-examples files | `feature-test.slang`, `implement-feature.slang` — neither exists in `.shofer/workflows/`      | the actual files are `hello-world.slang` and `test-slang-basics.slang`                                                                                                                                               |
| Flow status union     | listed 6 values, omitting `aborted`                                                           | full `FlowStatus` is 7 values incl. `aborted` ([`slang-types.ts`](../src/core/workflow/slang-types.ts))                                                                                                              |
| Runtime budget prose  | "Budgets (`rounds`, `tokens`) are enforced…" — omitted `time`, contradicting the budget table | all three (`tokens`, `rounds`, `time`) are enforced (round-loop condition + mid-round checks in [`WorkflowTask`](../src/core/workflow/WorkflowTask.ts))                                                              |
| Budget defaults prose | "both limits default to unlimited"                                                            | all **three** budget types default to unlimited (0)                                                                                                                                                                  |
| EBNF `agent_meta`     | omitted `peers:`                                                                              | added `peers : '[' agentref … ']'` (parsed at [`slang-parser-upstream.ts`](../src/core/workflow/slang-parser-upstream.ts) lines 304–324)                                                                             |
| Agent meta ordering   | "must appear **before** the operations"                                                       | convention only — the parser accepts meta/operations interleaved                                                                                                                                                     |
| Retry exhaustion      | "After `MAX_RETRIES` (3) consecutive failures, marked `error`"                                | check is `retryCount > MAX_RETRIES` after a pre-increment ⇒ error on the **4th** failure (3 re-prompts)                                                                                                              |
| Source-of-truth list  | attributed the whole runtime to `WorkflowTask.ts`                                             | added [`slang-interpreter.ts`](../src/core/workflow/slang-interpreter.ts) (the pure VM: `compileAgentProgram`, `advanceAgent`, `MAX_CONTROL_FLOW_STEPS`) and [`slang-types.ts`](../src/core/workflow/slang-types.ts) |

### Verified Correct (no change needed)

- **Reserved keywords** (§3) match the lexer's `KEYWORDS` map exactly (37 entries).
- **`AgentStatus`** values (`idle | running | committed | blocked | error`, §10) match
  [`slang-types.ts`](../src/core/workflow/slang-types.ts) exactly.
- **`MAX_CONTROL_FLOW_STEPS = 10_000`** (§7) matches the constant in
  [`slang-interpreter.ts`](../src/core/workflow/slang-interpreter.ts).
- **`context:` causes a parse error** (§5, §15) — confirmed: `context` is not a keyword
  and is not a recognized meta field, so the agent-body loop falls through to the
  `P203 "Expected an operation"` error.
- **Output-contract injection** is prompt-level and reads `completionResultSummary`
  from the agent's `HistoryItem` — confirmed in `WorkflowTask`.

### Observations / Possible Improvements (code, not doc)

| #   | Where                                                                       | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [`slang-resolver.ts`](../src/core/workflow/slang-resolver.ts) `analyzeFlow` | The orphan-output check (`stakesToAgents && !awaitedAgents.has(name) && !stakesToOut`) excludes `-> @all` from `stakesToAgents`, so an agent whose only output is a `@all` broadcast is **never** evaluated by this warning. A broadcast that no agent actually `await`s therefore goes unreported (a quiet false-negative gap), whereas the same dangling output via a concrete `-> @Peer` would warn. Consider treating `@all` as a producer for completeness. |
| 2   | Agent meta `tools` / `model` / `retry`                                      | Parsed and stored on `AgentMeta` but still **not consumed** at spawn (`spawnAgentTask` uses only `mode`, defaulting to `"code"`). §15 documents this correctly; flagged here so the gap stays visible. `role` is consumed only via `getPeerResources()` for peer descriptions.                                                                                                                                                                                   |
| 3   | `escalate` target                                                           | `EscalateOp.target` is the agent ref without `@`; the interpreter logs `target                                                                                                                                                                                                                                                                                                                                                                                   |     | "Human"`. The spec only shows `escalate @Human` — worth stating explicitly whether non-`@Human`escalation targets are meaningful, since the runtime always treats the reply as mail from`@Human`. |
