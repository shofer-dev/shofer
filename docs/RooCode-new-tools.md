# Creating New Native Tools in RooCode

## Architecture Overview

Native tools in RooCode require changes in **up to 11 locations** depending on the tool's nature:

| #   | Location                                       | Always required?         |
| --- | ---------------------------------------------- | ------------------------ |
| 1   | Tool Schema (JSON for LLM)                     | ✅                       |
| 2   | ToolName Type                                  | ✅                       |
| 3   | Tool Groups / always-available list            | ✅                       |
| 4   | Tool Handler (`BaseTool` subclass)             | ✅                       |
| 5   | Message Router (`presentAssistantMessage.ts`)  | ✅                       |
| 6   | NativeToolArgs Type                            | ✅                       |
| 7   | NativeToolCallParser (2 switch cases)          | ✅                       |
| 8   | ClineSayTool type (`vscode-extension-host.ts`) | If tool shows UI         |
| 9   | ChatRow webview rendering                      | If tool shows UI         |
| 10  | Auto-approval registration                     | If tool is auto-approved |
| 11  | i18n strings (`chat.json`)                     | If tool shows UI         |

---

## Step 1: Tool Schema (`src/core/prompts/tools/native-tools/`)

Create a schema file (e.g., `my_tool.ts`) defining the OpenAI function calling format:

```typescript
import type OpenAI from "openai"

const myTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "my_tool",
		description: "Description shown to LLM",
		strict: true, // Required for OpenAI structured outputs
		parameters: {
			type: "object",
			properties: {
				param1: { type: "string", description: "..." },
				param2: { type: "number", description: "..." },
			},
			required: ["param1"], // All params must be listed here for strict mode
			additionalProperties: false,
		},
	},
}

export default myTool
```

Then add to `native-tools/index.ts`:

```typescript
import myTool from "./my_tool"
// ...
return [
	// ...existing tools...
	myTool,
]
```

---

## Step 2: ToolName Type (`packages/types/src/tool.ts`)

Add the tool name to the `toolNames` array:

```typescript
export const toolNames = [
	// ...existing tools...
	"my_tool",
] as const
```

This generates the `ToolName` union type used throughout the codebase.

---

## Step 3: Tool Groups (`src/shared/tools.ts`)

### 3a. Add to appropriate group in `TOOL_GROUPS`:

```typescript
export const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
    read: {
        tools: [
            // read-only tools
        ],
    },
    edit: {
        tools: [
            // file modification tools
            "my_tool",  // if it modifies files
        ],
    },
    command: {
        tools: ["execute_command", "read_command_output"],
    },
    mcp: {
        tools: ["use_mcp_tool", "access_mcp_resource"],
    },
    modes: {
        tools: ["switch_mode", "new_task", ...],
        alwaysAvailable: true,
    },
}
```

### 3b. Or add to `ALWAYS_AVAILABLE_TOOLS` if it should bypass mode filtering:

```typescript
export const ALWAYS_AVAILABLE_TOOLS: ToolName[] = [
	"ask_followup_question",
	"attempt_completion",
	// ...
	"my_tool", // Always available regardless of mode
] as const
```

### 3c. Add display name in `TOOL_DISPLAY_NAMES`:

```typescript
export const TOOL_DISPLAY_NAMES: Record<ToolName, string> = {
	// ...
	my_tool: "my custom tool",
}
```

---

## Step 4: Tool Handler (`src/core/tools/`)

Create handler class extending `BaseTool<TName>`:

```typescript
import * as vscode from "vscode"
import { type ClineSayTool } from "@roo-code/types"
import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"

interface MyToolParams {
	param1: string
	param2?: number
}

export class MyTool extends BaseTool<"my_tool"> {
	readonly name = "my_tool" as const

	async execute(params: MyToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { param1, param2 } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required params
			if (!param1) {
				task.consecutiveMistakeCount++
				task.recordToolError("my_tool")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("my_tool", "param1"))
				return
			}

			task.consecutiveMistakeCount = 0

			// For tools that modify files, show approval UI
			const sharedMessageProps: ClineSayTool = {
				tool: "editedExistingFile", // or other ClineSayTool type
				path: getReadablePath(task.cwd, param1),
				isOutsideWorkspace: isPathOutsideWorkspace(absolutePath),
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Doing something with ${param1}`,
			} satisfies ClineSayTool)

			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			// Tool implementation
			// ...

			pushToolResult(`Success: did something with ${param1}`)
		} catch (error) {
			await handleError("doing my tool action", error instanceof Error ? error : new Error(String(error)))
		}
	}

	// Optional: streaming UI feedback during partial tool calls
	override async handlePartial(task: Task, block: ToolUse<"my_tool">): Promise<void> {
		const param1: string | undefined = block.params.param1

		if (!this.hasPathStabilized(param1)) {
			return
		}

		// Show partial progress in UI (finalised in execute() via askApproval)
		const partialMessage = JSON.stringify({ tool: "myTool", content: "" })
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const myTool = new MyTool()
```

### Important: partial vs. complete UI messages

`handlePartial()` emits _streaming_ `task.ask("tool", ..., partial=true)` messages — these update the ChatRow in real time but are not persisted as complete entries.

`execute()` must emit the _final_ UI message by calling `askApproval("tool", completeMessage)`. This finalises the ChatRow entry and (depending on auto-approval settings) either blocks for user confirmation or returns immediately.

Without the `askApproval()` call in `execute()`, the partial message is never finalised and **the ChatRow shows nothing** once streaming ends.

---

## Step 5: Message Router (`src/core/assistant-message/presentAssistantMessage.ts`)

### 5a. Add import at top:

```typescript
import { myTool } from "../tools/MyTool"
```

### 5b. Add case in the switch block (before `default`):

```typescript
case "my_tool":
    // Add checkpointSaveAndMark for tools that modify files
    await checkpointSaveAndMark(cline)
    await myTool.handle(cline, block as ToolUse<"my_tool">, {
        askApproval,
        handleError,
        pushToolResult,
    })
    break
```

### 5c. Add toolDescription case (same file, `toolDescription()` function):

```typescript
case "my_tool":
    return `[${block.name} for '${block.params.param1}']`
```

---

## Step 6: NativeToolArgs Type (`src/shared/tools.ts`)

Add typed arguments for the native protocol. This enables proper TypeScript type checking for tool arguments:

```typescript
export type NativeToolArgs = {
	// ...existing tools...
	my_tool: { param1: string; param2?: number }
}
```

This type is used by:

- `NativeToolCallParser` to build typed `nativeArgs` objects
- `BaseTool<TName>` to infer the `execute()` params type
- The `ToolUse<TName>` interface for optional `nativeArgs` field

---

## Step 7: NativeToolCallParser (`src/core/assistant-message/NativeToolCallParser.ts`)

Add case statements in **two** methods to parse native API tool arguments:

### 7a. `createPartialToolUse()` — For streaming UI updates

Add after other case statements (around line ~600):

```typescript
case "my_tool":
    if (partialArgs.param1 !== undefined) {
        nativeArgs = {
            param1: partialArgs.param1,
            param2: this.coerceOptionalNumber(partialArgs.param2),
        }
    }
    break
```

### 7b. `parseToolCall()` — For final argument parsing

Add after other case statements (around line ~1100):

```typescript
case "my_tool":
    if (args.param1 !== undefined) {
        nativeArgs = {
            param1: args.param1,
            param2: this.coerceOptionalNumber(args.param2),
        } as NativeArgsFor<TName>
    }
    break
```

### Why both methods?

- `createPartialToolUse()` handles **streaming** — builds partial ToolUse objects as arguments arrive chunk by chunk
- `parseToolCall()` handles **final parsing** — constructs the complete ToolUse when the tool call ends

Both methods have parallel switch statements that must stay in sync. **Without cases in both, tool arguments are silently dropped** — `nativeArgs` will be `undefined`, and `BaseTool.handle()` will throw "Tool call is missing native arguments". This manifests as the tool not executing at all and returning an error tool_result to the LLM.

### Helper methods available:

```typescript
this.coerceOptionalNumber(value) // string|number|undefined → number|undefined
this.coerceOptionalBoolean(value) // string|boolean|undefined → boolean|undefined
```

---

## Step 8: ClineSayTool Type (`packages/types/src/vscode-extension-host.ts`)

**Required if the tool renders a ChatRow entry in the webview.**

Add the camelCase UI tool name to the `tool` union in `ClineSayTool`:

```typescript
export interface ClineSayTool {
	tool:
		| "editedExistingFile"
		// ...existing values...
		| "myTool" // camelCase version of the tool name
	// Add any extra fields the ChatRow renderer needs:
	task_id?: string
	timeout?: number
	tasks?: Array<{ task_id: string; status: string; created_at?: number }>
}
```

Note: the `tool` string here is the **camelCase name you pass as `tool:` in the JSON payload** inside `askApproval()` / `task.ask()`. It does **not** have to match the snake_case tool name — see `"newTask"` vs `"new_task"`, `"waitForTask"` vs `"wait_for_task"`.

---

## Step 9: ChatRow Webview Rendering (`webview-ui/src/components/chat/ChatRow.tsx`)

**Required if the tool renders a ChatRow entry in the webview.**

Add a `case` inside the `switch (tool.tool as string)` block:

```typescript
case "myTool":
    return (
        <>
            <div style={headerStyle}>
                {toolIcon("watch")}   {/* codicon name */}
                <span style={{ fontWeight: "bold" }}>
                    {t("chat:mySection.myToolLabel")}
                </span>
            </div>
            {tool.task_id && (
                <div className="pl-6 text-vscode-descriptionForeground">
                    <code>{tool.task_id}</code>
                </div>
            )}
        </>
    )
```

`toolIcon(name)` renders a VS Code codicon. Browse available icons at https://microsoft.github.io/vscode-codicons/dist/codicon.html.

The `tool` variable is typed as `ClineSayTool` (parsed from `message.text`), so any fields you added in Step 8 are available here.

---

## Step 10: Auto-Approval Registration (`src/core/auto-approval/index.ts`)

**Required only if the tool should be auto-approved without user interaction.**

Inside the `if (ask === "tool")` block, add a guard before the read/write checks:

```typescript
// Purely informational tools that query in-memory state owned by the parent task —
// no files touched, no side effects. Always auto-approve.
if (["myTool"].includes(tool?.tool)) {
	return { decision: "approve" }
}
```

This mirrors how `updateTodoList` and `skill` are handled. Without this, `askApproval()` in `execute()` will block waiting for the user to click "Approve" even though the tool does nothing dangerous.

---

## Step 11: i18n Strings (`webview-ui/src/i18n/locales/en/chat.json`)

**Required if the tool renders a ChatRow entry.**

Add your label strings under a logical section key:

```json
"mySection": {
    "myToolLabel": "Roo is doing my tool thing",
    "myToolDetail": "Some detail: {{param}}"
}
```

Reference them in the ChatRow with `t("chat:mySection.myToolLabel")`.

---

## Mode Filtering Logic

Tools are filtered per-mode in `src/core/prompts/tools/filter-tools-for-mode.ts`:

1. `getToolsForMode()` collects tools from groups listed in the mode's config
2. `ALWAYS_AVAILABLE_TOOLS` are always added regardless of mode
3. Additional filtering applies for feature-gated tools:
    - `codebase_search` — requires code index
    - `generate_image` — requires `experiments.imageGeneration`
    - `run_slash_command` — requires `experiments.runSlashCommand`
    - `access_mcp_resource` — requires MCP resources

---

## Default Mode Groups

From `packages/types/src/mode.ts`:

| Mode      | Groups                               |
| --------- | ------------------------------------ |
| code      | `["read", "edit", "command", "mcp"]` |
| architect | `["read", "edit", "command", "mcp"]` |
| ask       | `["read", "mcp"]`                    |

---

## Common Patterns

### Read-only tools (no approval needed)

- Don't call `askApproval()`
- Just execute and `pushToolResult()`
- Example: `ReadProjectStructureTool`, `GetErrorsTool`

### File-modifying tools

- Call `checkpointSaveAndMark(cline)` before handler in `presentAssistantMessage.ts`
- Call `askApproval()` with `ClineSayTool` message
- Example: `InsertEditTool`, `RenameSymbolTool`

### Informational tools (always auto-approved, shows UI)

- Add `ClineSayTool` entry (Step 8), ChatRow case (Step 9), i18n strings (Step 11)
- Call `askApproval("tool", completeMessage)` in `execute()` to finalize the ChatRow entry
- Register as auto-approved in `src/core/auto-approval/index.ts` (Step 10) so the call returns immediately
- `handlePartial()` emits streaming partial messages; `execute()` finalizes with the complete payload
- Example: `WaitForTaskTool`, `CheckTaskStatusTool`, `ListBackgroundTasksTool`

### VS Code API tools

- Use `vscode.workspace.fs` for file operations
- Use `vscode.workspace.findFiles()` instead of external deps like `globby`
- Use `vscode.languages.getDiagnostics()` for errors
- Use `vscode.commands.executeCommand()` for LSP features

### LSP-dependent tools

- Open document first: `await vscode.workspace.openTextDocument(uri)`
- Show in editor to activate language server: `await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })`
- Add delay for LSP initialization: `await new Promise(r => setTimeout(r, 500))`

---

## Checklist

When adding a new tool, tick each item:

- [ ] Schema file created and added to `native-tools/index.ts`
- [ ] Tool name added to `toolNames` in `packages/types/src/tool.ts`
- [ ] Tool added to a group or `ALWAYS_AVAILABLE_TOOLS` in `src/shared/tools.ts`
- [ ] Display name added to `TOOL_DISPLAY_NAMES`
- [ ] Handler class created in `src/core/tools/`
- [ ] `handlePartial()` emits partial `task.ask("tool", ..., partial=true)`
- [ ] `execute()` calls `askApproval("tool", completeMessage)` to finalize ChatRow (if UI needed)
- [ ] Import + `case` added in `presentAssistantMessage.ts`
- [ ] `toolDescription()` case added in `presentAssistantMessage.ts`
- [ ] `NativeToolArgs` entry added in `src/shared/tools.ts`
- [ ] Parser cases added in **both** `createPartialToolUse()` and `parseToolCall()` in `NativeToolCallParser.ts`
- [ ] `ClineSayTool.tool` union extended (if UI needed)
- [ ] `ChatRow` switch case added (if UI needed)
- [ ] Auto-approval guard added in `src/core/auto-approval/index.ts` (if always-approved)
- [ ] i18n strings added to `webview-ui/src/i18n/locales/en/chat.json` (if UI needed)
- [ ] Version bumped in `src/package.json`

---

## Build & Test

```bash
# Bump version in src/package.json (patch for backward-compatible changes)
# Then build:
./deploy.sh dev build Roo-Code

# Install in code-server:
./deploy.sh dev install-extensions
```
