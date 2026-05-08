# Private Tool Registration Interface

## Overview

Roo-Code discovers extension-provided tools through a **private command channel**
instead of `vscode.lm.tools` (which is GitHub Copilot's interface). This keeps
extension tools invisible to Copilot while remaining fully available to Roo-Code.

## Provider Registration

An extension registers as a tool provider by adding an entry to the VS Code
configuration `arkware.privateToolProviders` in its `package.json`:

```jsonc
{
	"contributes": {
		"configuration": {
			"properties": {
				"arkware.privateToolProviders": {
					"type": "object",
					"default": {},
					"description": "Private tool providers for Roo-Code.",
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
	"arkware.privateToolProviders": {
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
	group?: "read" | "write" | "execute" | "mcp" | "mode" | "browser" | "uncategorized"
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
2. **Provider-level config** — `arkware.<providerId>.toolGroups.<toolName>` maps tool names to groups.
3. **Default** — `"uncategorized"`.

Example provider config in `settings.json`:

```json
{
	"arkware.vscodeTools.toolGroups": {
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
4. Register the provider in `arkware.privateToolProviders` config.
