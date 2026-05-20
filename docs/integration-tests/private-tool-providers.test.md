# Integration Test Scenarios — Private Tool Providers

## Overview

These scenarios cover the end-to-end behavior of the private tool provider
system: discovery, group resolution, invocation, mode filtering, and error
handling. Tests should run against a real Shofer installation with a
mock or real provider extension activated.

Related files:

- [`build-tools.ts`](../src/core/task/build-tools.ts) — discovery pipeline
- [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts) — invocation
- [`tool-registration-interface.md`](../docs/tool-registration-interface.md) — contract spec

## Scenario 1: Provider Discovery — Single Provider

**Given** a provider extension is installed and activated, registering one
`getDefinitionsCommand` returning two tools `A` and `B`, and a matching
`shofer.privateToolProviders` entry in `settings.json`

**When** Shofer starts a new task

**Then**:

- [`getPrivateLmToolMeta()`](../src/core/task/build-tools.ts:106) returns
  two `PrivateToolMeta` entries
- Both tools appear in the task's tool set
- Both tools are assigned group `"uncategorized"` (no explicit group)

## Scenario 2: Provider Discovery — Multiple Providers

**Given** two provider extensions are installed (e.g., `vscode-tools` with
3 tools, `browser-tools` with 2 tools)

**When** Shofer starts a new task

**Then**:

- All 5 tools are discovered
- The `_privateToolInvokeMap` contains entries for all 5
- `isPrivateLmTool(name)` returns `true` for all 5 names

## Scenario 3: Group Resolution — Tool-Level Group

**Given** a provider whose `getDefinitionsCommand` returns a tool with
`group: "read"` in the definition

**When** Shofer discovers the tool

**Then**:

- The tool is assigned `ToolGroup = "read"`
- The provider-level `toolGroups` config is not consulted

## Scenario 4: Group Resolution — Provider-Level Config

**Given** a provider whose `getDefinitionsCommand` returns a tool _without_
a `group` field, and `settings.json` has:

```json
{
	"shofer.my-provider.toolGroups": {
		"my_tool": "execute"
	}
}
```

**When** Shofer discovers the tool

**Then**:

- `resolvePrivateToolGroup("my-provider", def)` returns `"execute"`
- The tool is assigned `ToolGroup = "execute"`

## Scenario 5: Group Resolution — Invalid Group in Config

**Given** `settings.json` has:

```json
{
	"shofer.my-provider.toolGroups": {
		"my_tool": "not_a_real_group"
	}
}
```

**When** Shofer discovers the tool

**Then**:

- The invalid group is rejected by `(toolGroupsSchema.options as readonly string[]).includes(declared)`
- Falls through to default `"uncategorized"`
- No error thrown, log written

## Scenario 6: Group Resolution — Default Fallback

**Given** a tool with no `group` field and no `toolGroups` config entry

**When** Shofer discovers the tool

**Then**:

- Assigned `ToolGroup = "uncategorized"`

## Scenario 7: Mode Filtering — Tool Group Not Allowed

**Given** a tool assigned to group `"write"`, and the current mode
(e.g., Reviewer) does not include `"write"` in its allowed groups

**When** Shofer builds the tool set via [`filterPrivateToolsForMode`](../src/core/prompts/tools/filter-tools-for-mode.ts)

**Then**:

- The tool is excluded from the mode's available tools
- The model cannot call it

## Scenario 8: Invocation — Successful Tool Call

**Given** a discovered tool named `"ide_file_read"` with
`invokeCommand = "arkware.vscodeTools.invokeTool"`

**When** the model issues a tool call for `"ide_file_read"` with
`{ "path": "src/index.ts" }`

**Then**:

- [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts)
  calls `vscode.commands.executeCommand("arkware.vscodeTools.invokeTool", "ide_file_read", { path: "src/index.ts" })`
- The result `{ content: "...file contents..." }` is rendered in chat
- The result is included in the API conversation history

## Scenario 9: Invocation — Tool Returns Error

**Given** a discovered tool whose invoke command returns
`{ content: "File not found", is_error: true }`

**When** the model calls the tool

**Then**:

- The `is_error` flag is propagated
- The chat row shows the error styling
- The model receives the error in its next turn

## Scenario 10: Invocation — Unknown Tool Name

**Given** a provider is registered but the model calls a tool name not in
`_privateToolInvokeMap`

**When** the tool call is dispatched

**Then**:

- `isPrivateLmTool(name)` returns `false`
- The tool call falls through to other handlers (native, MCP)
- If no handler matches, returns an error

## Scenario 11: Invocation — Invoke Command Throws

**Given** a provider whose `invokeToolCommand` throws (e.g., extension
crashes, unhandled error)

**When** the model calls a tool from that provider

**Then**:

- The error is caught at the [`invokeTool` wrapper](../vscode-tools/src/main.ts:99-102)
  (returns `{ content: "Error: ...", is_error: true }`)
- If the invoke command itself is unreachable (extension deactivated), the
  `vscode.commands.executeCommand` call throws — this should be caught in
  `presentAssistantMessage.ts` and surfaced as a visible error row

## Scenario 12: Discovery — Provider Extension Not Installed

**Given** `settings.json` has a `shofer.privateToolProviders` entry for a
provider whose extension is not installed

**When** Shofer calls `vscode.commands.executeCommand(providerCfg.getDefinitionsCommand)`

**Then**:

- The call throws (or returns `undefined`)
- The `catch` block at [`build-tools.ts:140`](../src/core/task/build-tools.ts:140) silently skips the provider
- No tools from that provider are added
- Currently: **no user-facing warning** (see Gaps section in
  [`tool-registration-interface.md`](../docs/tool-registration-interface.md))
  — this should eventually surface a warning

## Scenario 13: Discovery — Provider Returns Non-Array

**Given** a provider's `getDefinitionsCommand` returns a non-array value
(e.g., `null`, `undefined`, a plain object)

**When** Shofer processes the result

**Then**:

- `!definitions || !Array.isArray(definitions)` guard at
  [`build-tools.ts:120`](../src/core/task/build-tools.ts:120) triggers
- Provider is skipped (no tools added)
- No error thrown

## Scenario 14: Discovery — Config Key Absent

**Given** `settings.json` has **no** `shofer.privateToolProviders` key

**When** Shofer starts a task

**Then**:

- `config.get<...>("privateToolProviders", {})` returns `{}`
- `Object.entries(providers)` is empty
- `getPrivateLmToolMeta()` returns `[]`
- No private tools in the task — only native and MCP tools available

## Scenario 15: Discovery — Empty Provider Config

**Given** `settings.json` has:

```json
{
	"shofer.privateToolProviders": {}
}
```

**When** Shofer starts a task

**Then**:

- Same as Scenario 14 — no private tools discovered

## Scenario 16: Auto-Approval — Toggle Gated by Group

**Given** a tool assigned to group `"browser"`, and the user has the
`browser` auto-approval toggle **OFF**

**When** the model calls the tool

**Then**:

- The tool call is NOT auto-approved
- The user sees the Approve/Reject UI in chat
- After manual approval, the tool executes

## Scenario 17: Auto-Approval — Toggle Enabled

**Given** a tool assigned to group `"read"`, and the user has the `read`
auto-approval toggle **ON**

**When** the model calls the tool

**Then**:

- The tool call IS auto-approved
- No Approve/Reject UI shown
- Tool executes immediately

## Scenario 18: Complex Input Schema

**Given** a provider tool with a complex `inputSchema` (nested objects,
arrays, enums, `$ref` references)

**When** Shofer discovers the tool

**Then**:

- The `inputSchema` is passed through to the model's tool definition
  without modification
- The model generates arguments conforming to the schema
- The arguments are passed to `invokeToolCommand` as-is

## Scenario 19: Concurrent Task — Separate Provider Instances

**Given** two parallel tasks running simultaneously, both using tools from
the same provider

**When** Task A and Task B both call the provider's tools

**Then**:

- Each tool call is routed through `vscode.commands.executeCommand`
  independently
- No shared state corruption between tasks
- Tool results are delivered to the correct task

## Scenario 20: Task Resume — Tools Re-Discovered

**Given** a task was started with private tools available, the user
closed VS Code, and reopens it

**When** The task is resumed from history

**Then**:

- Private tools are **re-discovered** (not restored from history)
- If the provider extension is still installed, tools are available
- If the provider extension was uninstalled, the tools silently disappear
