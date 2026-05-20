# Tool Access Control in Shofer Modes

This document describes how a mode's available toolset is computed at runtime
from its configuration. It is the authoritative reference for the three
mode-level fields that govern tool access:

- `groups`
- `tools_allowed`
- `tools_denied`

## Schema

Defined in [`packages/types/src/mode.ts`](../packages/types/src/mode.ts):

```ts
export const modeConfigObjectSchema = z.object({
	slug: z.string().regex(/^[a-zA-Z0-9-]+$/),
	name: z.string().min(1),
	roleDefinition: z.string().min(1),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
	groups: groupEntryArraySchema.optional(),
	tools_allowed: z.array(z.string()).optional(),
	tools_denied: z.array(z.string()).optional(),
	source: z.enum(["global", "project"]).optional(),
	provider: z.string().optional(),
})

export const modeConfigSchema = modeConfigObjectSchema.refine(
	(data) => data.groups !== undefined || data.tools_allowed !== undefined,
	{ message: "Either 'groups' or 'tools_allowed' must be provided" },
)
```

All three access-control fields are individually optional. The only structural
constraint is that **at least one of `groups` or `tools_allowed` must be
present** — `tools_denied` alone is not a valid configuration because there
would be no allow source for it to subtract from.

## Decision rule

For any tool `t` and any mode `m`, the runtime decision (in
[`src/core/tools/validateToolUse.ts`](../src/core/tools/validateToolUse.ts))
is:

```
allowed(t, m)  ⇔  ( t ∈ groups(m)  ∨  t ∈ tools_allowed(m) )  ∧  t ∉ tools_denied(m)
```

Where `groups(m)` includes per-group scoping: if a group entry uses the
scoped form `{ "groupName": { allowed: [...], denied: [...] } }`, only
tools matching the scope are included.

Equivalently, `tools_denied` is an unconditional veto applied on top of the
union of the two allow sources. The check order in code is:

1. **Deny check first.** If `t ∈ tools_denied`, return `false` immediately.
   The deny-list always wins; there is no override.
2. **Explicit allow.** If `t ∈ tools_allowed`, return `true`.
3. **Group allow.** Otherwise, walk `groups` and return `true` if `t` is in
   any allowed group (subject to per-group scoping and options such as the
   `edit` group's `fileRegex` restriction).
4. If none of the above match, return `false`.

So for the ultimate decision, allow sources combine with **OR** semantics
(union), and the deny-list combines with **AND-NOT** semantics (set difference).

## Field-by-field reference

### `groups`

A list of broad capability groups (e.g. `read`, `write`, `execute`, `mcp`,
`browser`). Each entry can be one of three forms:

1. **Bare group name** (string): grants all tools in the group.

    ```yaml
    groups: [read, mcp]
    ```

2. **Tuple `[name, options]`**: group with metadata such as `fileRegex`.

    ```yaml
    groups: [["write", { fileRegex: "\\.md$" }]]
    ```

3. **Scoped group object** `{ name: { allowed?, denied? } }`: narrows the
   tool set the group normally provides.
    - `allowed`: exclusive list — only these tools from the group are available.
      Must be a subset of what the group normally registers.
    - `denied`: removes the listed tools from the group's normal set.
    ```yaml
    groups:
        - browser
        - mcp
        - read:
              allowed:
                  - mcp--shofer--web_search
    ```
    In this example the mode gets ALL `browser` and `mcp` tools, but from the
    `read` group it gets ONLY `mcp--shofer--web_search` — not `read_file`,
    `grep_search`, etc.

Group definitions are in [`packages/types/src/tool.ts`](../packages/types/src/tool.ts) as
`TOOL_GROUPS`, which maps each group name to the concrete tool IDs it grants,
and are re-exported from [`src/shared/tools.ts`](../src/shared/tools.ts).

### `tools_allowed`

A flat list of tool IDs that are explicitly granted, independently of any
group membership. Use this when:

- you want fine-grained tool selection without pulling in a whole group, or
- you want to add a single tool to a mode whose other permissions come from
  groups (the two compose with OR).

A mode may declare access purely through `tools_allowed` and omit `groups`
entirely — this is what project-level read-only modes such as `reviewer` and
`search` in `.shofermodes` do.

### `tools_denied`

A flat list of tool IDs that are unconditionally forbidden, regardless of
whether `groups` or `tools_allowed` would otherwise grant them. This is the
right field for "subtract one tool from an otherwise broad permission set"
patterns — e.g. grant the `execute` group but deny `execute_command`.

## Worked examples

### Example 1: groups only (built-in modes)

```yaml
- slug: code
  name: 💻 Code
  groups: [read, write, execute, mcp, browser]
```

Result: every tool in any of those five groups is allowed. No
`tools_allowed` overlay, no denials.

### Example 2: tools_allowed only (read-only project modes)

```yaml
- slug: reviewer
  name: 👀 Reviewer
  tools_allowed: [read_file, grep_search, list_files, lsp_search]
```

Result: only those four tool IDs are allowed. The mode has no `groups` array,
which is valid because `tools_allowed` is present.

### Example 3: groups + tools_allowed (additive)

```yaml
- slug: architect
  groups: [read]
  tools_allowed: [new_task]
```

Result: every tool in `read`, plus `new_task`. The two sources are unioned.

### Example 4: groups + tools_denied (subtractive)

```yaml
- slug: safe-coder
  groups: [read, write, execute]
  tools_denied: [execute_command]
```

Result: every tool in `read`, `write`, and `execute` **except**
`execute_command`. The deny-list applies on top of the union and cannot be
overridden.

### Example 5: deny wins over allow

```yaml
- slug: paranoid
  tools_allowed: [read_file, execute_command]
  tools_denied: [execute_command]
```

Result: `read_file` is allowed, `execute_command` is denied. Even though
`execute_command` appears in `tools_allowed`, the deny check runs first and
short-circuits.

## Where this is enforced

- **Runtime enforcement (per tool call):**
  [`src/core/tools/validateToolUse.ts`](../src/core/tools/validateToolUse.ts)
  — the source of truth for the decision rule above.
- **System-prompt tool listing:**
  [`src/core/prompts/tools/filter-tools-for-mode.ts`](../src/core/prompts/tools/filter-tools-for-mode.ts)
  — uses the same union/difference logic to compute the tool list rendered
  into the model's system prompt, so the model only sees tools it can call.
- **Schema validation:**
  [`packages/types/src/mode.ts`](../packages/types/src/mode.ts) and the
  exported JSON schema in
  [`schemas/shofermodes.json`](../schemas/shofermodes.json).

## Related tests

- [`src/core/tools/__tests__/validateToolUse.spec.ts`](../src/core/tools/__tests__/validateToolUse.spec.ts)
  pins the decision rule, including:
    - allows from `tools_allowed` whitelist alone (no `groups`),
    - additive OR semantics when both `groups` and `tools_allowed` are set,
    - `tools_denied` priority over `tools_allowed`.
