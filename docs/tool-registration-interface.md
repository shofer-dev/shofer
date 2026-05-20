# Private Tool Registration Interface

## Overview

Shofer discovers extension-provided tools through a **private command channel**
instead of `vscode.lm.tools` (which is GitHub Copilot's interface). This keeps
extension tools invisible to Copilot while remaining fully available to Shofer.

## Provider Registration

An extension registers as a tool provider by adding an entry to the VS Code
configuration `shofer.privateToolProviders` in its `package.json`:

```jsonc
{
	"contributes": {
		"configuration": {
			"properties": {
				"shofer.privateToolProviders": {
					"type": "object",
					"default": {},
					"description": "Private tool providers for Shofer.",
					"additionalProperties": {
						"type": "object",
						"properties": {
							"getDefinitionsCommand": {
								"type": "string",
								"description": "VS Code command that returns all tool definitions.",
							},
							"invokeToolCommand": {
								"type": "string",
								"description": "VS Code command that invokes a tool by name.",
							},
						},
					},
				},
			},
		},
	},
}
```

Alternatively, providers can be set in `settings.json`:

```json
{
	"shofer.privateToolProviders": {
		"vscode-tools": {
			"getDefinitionsCommand": "arkware.vscodeTools.getDefinitions",
			"invokeToolCommand": "arkware.vscodeTools.invokeTool"
		},
		"browser-tools": {
			"getDefinitionsCommand": "arkware.browserTools.getDefinitions",
			"invokeToolCommand": "arkware.browserTools.invokeTool"
		}
	}
}
```

## Command Contract

### `getDefinitionsCommand`

**Returns:** `Array<ToolDefinition>`

```typescript
interface ToolDefinition {
	/** Unique tool name (e.g., "ide_file_open", "browser_navigate"). */
	name: string
	/** Human-readable description shown to the LLM. */
	description: string
	/** JSON Schema for the tool's input parameters. */
	inputSchema: object
	/** Optional tool group for mode filtering. Falls back to provider-level config. */
	group?: "read" | "write" | "execute" | "browser" | "mcp" | "mode" | "subtasks" | "questions" | "uncategorized"
}
```

### `invokeToolCommand`

**Arguments:** `(name: string, input: Record<string, unknown>)`

**Returns:** `ToolResult`

```typescript
interface ToolResult {
	/** The tool's text output. */
	content: string
	/** If true, the result is treated as an error. */
	is_error?: boolean
}
```

## Tool Group Assignment

Tools are assigned a group for mode filtering. Resolution order:

1. **Tool-level `group`** — if the definition has a valid group, use it.
2. **Provider-level config** — `shofer.<providerId>.toolGroups.<toolName>` maps tool names to groups.
3. **Default** — `"uncategorized"`.

Example provider config in `settings.json`:

```json
{
	"shofer.vscode-tools.toolGroups": {
		"ide_file_read": "read",
		"ide_file_open": "read",
		"ide_file_reveal_in_explorer": "read"
	}
}
```

## Example: vscode-tools

See [`extensions/vscode-tools/src/tools/registry.ts`](../../vscode-tools/src/tools/registry.ts)
for the reference implementation.

1. Tools are stored in a private registry (`registerIdeTool()`).
2. Two VS Code commands expose them:
    - `arkware.vscodeTools.getDefinitions` → returns `getAllDefinitions()`
    - `arkware.vscodeTools.invokeTool` → calls `invokeTool(name, input)` and returns `{ content, is_error? }`
3. The provider is registered via config.

## Migration: vscode.lm.tools → Private Channel

Extensions currently using `vscode.lm.registerTool()` should migrate to the private
channel:

1. **Do NOT call `vscode.lm.registerTool()`** — this publishes to Copilot.
2. Store tools in a private registry.
3. Expose two commands: `getDefinitions` and `invokeTool`.
4. Register the provider in `shofer.privateToolProviders` config.

## Gaps, Issues & Improvements

### Config namespace mismatch between shofer and vscode-tools

The [`vscode-tools` `package.json`](../../vscode-tools/package.json) contributes its
private-tool-provider defaults under the `arkware.privateToolProviders` config key, but
[`build-tools.ts`](../src/core/task/build-tools.ts:107-108) reads from
`shofer.privateToolProviders`. Since these are different VS Code configuration
namespaces, the defaults set in `vscode-tools/package.json` are never visible to
shofer's discovery loop. The user must set `shofer.privateToolProviders` explicitly in
their `settings.json` (as shown in the example above). vscode-tools and shofer should
agree on one standard config key.

### `getAllDefinitions()` does not include `group`

The reference implementation's [`getAllDefinitions()`](../../vscode-tools/src/tools/registry.ts:52)
returns `IdeToolDefinition[]` which has no `group` field. The Tool Group Assignment
resolution order places "Tool-level `group`" first, but no vscode-tools definitions
will ever carry a group. The three-tier resolution therefore always falls through to
provider-level config for vscode-tools. Either `IdeToolDefinition` should be extended
with an optional `group`, or the documentation should clarify that tool-level `group`
is an optional contract extension that providers can opt into.

### `browser-tools` provider is hypothetical

The `settings.json` example includes a `"browser-tools"` provider entry with
`arkware.browserTools.*` commands. No such extension exists in the codebase, and no
matching commands (`arkware.browserTools.getDefinitions`, `arkware.browserTools.invokeTool`)
are registered anywhere. The example should be replaced with a real second provider, or
annotated as hypothetical.

### No built-in `shofer.privateToolProviders` schema contribution

The shofer extension does not contribute a `shofer.privateToolProviders` schema
definition in its own `package.json` (under `contributes.configuration`). This means
VS Code cannot provide IntelliSense / autocomplete for the `getDefinitionsCommand` and
`invokeToolCommand` properties when the user edits `settings.json`. The schema shown
in the first code block (lines 14–41) is aspirational — shofer should contribute it so
that users get editor assistance.

### Missing coverage of external tool invocation in [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts)

The document describes the discovery pipeline (`getDefinitionsCommand` → `getPrivateLmToolMeta()`
→ `resolvePrivateToolGroup()` → `_privateToolInvokeMap`) but does not cover how
invocations flow at execution time. The execution path (`isPrivateLmTool()` →
`getPrivateToolInvokeCommand()` → `vscode.commands.executeCommand(...)`) in
`presentAssistantMessage.ts` is the second half of the contract and should be
documented alongside discovery.

### Error handling in `getPrivateLmToolMeta()`

[`getPrivateLmToolMeta()`](../src/core/task/build-tools.ts:106) silently catches and
discards errors from `vscode.commands.executeCommand(providerCfg.getDefinitionsCommand)`
(line 140). A provider whose command throws (extension not installed, activation
failed) is silently skipped with no user feedback or telemetry. This makes
misconfiguration invisible. Consider surfacing a warning or logging to the output
channel when a configured provider fails discovery.
