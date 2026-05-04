# Adding New Tools to RooCode

## Three Kinds of Tools

RooCode supports three tool integration patterns. Choose the one that fits your use case:

| Kind                 | Where the tool lives                | How RooCode discovers it             | See doc                                                          |
| -------------------- | ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| **Native tool**      | Inside RooCode (TypeScript handler) | Compiled into the extension          | This document                                                    |
| **External LM tool** | Separate VS Code extension          | `vscode.lm.tools` + extension config | [`tool-categories.md`](tool-categories.md) § "External LM Tools" |
| **MCP tool**         | External MCP server                 | MCP protocol                         | [`tool-categories.md`](tool-categories.md) § "MCP Tools"         |

---

## Native Tool Checklist (11 steps)

| #   | Location                                               | Always required?         |
| --- | ------------------------------------------------------ | ------------------------ |
| 1   | Tool Schema (`src/core/prompts/tools/native-tools/`)   | ✅                       |
| 2   | `toolNames` array (`packages/types/src/tool.ts`)       | ✅                       |
| 3   | `TOOL_GROUPS` (`packages/types/src/tool.ts`)           | ✅                       |
| 4   | Tool Handler — `BaseTool` subclass (`src/core/tools/`) | ✅                       |
| 5   | Message Router (`presentAssistantMessage.ts`)          | ✅                       |
| 6   | `NativeToolArgs` type (`src/shared/tools.ts`)          | ✅                       |
| 7   | `NativeToolCallParser` — 2 switch cases                | ✅                       |
| 8   | `ClineSayTool` type (`vscode-extension-host.ts`)       | If tool shows UI         |
| 9   | `ChatRow` webview rendering                            | If tool shows UI         |
| 10  | Auto-approval registration                             | If tool is auto-approved |
| 11  | i18n strings (`chat.json`)                             | If tool shows UI         |

---

## Step 1: Tool Schema

Create a schema file in `src/core/prompts/tools/native-tools/`:

```typescript
import type OpenAI from "openai"

const myTool: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "my_tool",
		description: "Description shown to LLM",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				param1: { type: "string", description: "..." },
				param2: { type: "number", description: "..." },
			},
			required: ["param1"],
			additionalProperties: false,
		},
	},
}
export default myTool
```

Add to `native-tools/index.ts`:

```typescript
import myTool from "./my_tool"
return [, /* ...existing... */ myTool]
```

## Step 2: ToolName

Add to the `toolNames` array in [`packages/types/src/tool.ts`](../packages/types/src/tool.ts):

```typescript
export const toolNames = [
	// ...
	"my_tool",
] as const
```

## Step 3: Assign to a ToolGroup

Add the tool to one of the 9 groups in `TOOL_GROUPS` ([`packages/types/src/tool.ts`](../packages/types/src/tool.ts)). See [`tool-categories.md`](tool-categories.md) for the full category reference.

```typescript
export const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
    read:        { tools: ["read_file", ..., "my_tool"] },  // if read-only
    write:       { tools: ["apply_diff", ..., "my_tool"] },  // if content-mutating
    execute:     { tools: ["execute_command", ..., "my_tool"] }, // if runs commands
    browser:     { tools: [] },
    mcp:         { tools: ["use_mcp_tool", "access_mcp_resource"] },
    mode:        { tools: ["switch_mode", "new_task"] },
    subtasks:    { tools: ["check_task_status", "wait_for_task", "list_background_tasks"] },
    questions:   { tools: ["ask_followup_question"] },
    uncategorized: { tools: [] },
}
```

If the tool should bypass mode filtering entirely, add it to `ALWAYS_AVAILABLE_TOOLS` instead. Also add a display name in `TOOL_DISPLAY_NAMES`.

> **This group assignment** is the **single source of truth** — it drives mode filtering, auto-approval classification, and the tools UI. See [`auto_approval.md`](auto_approval.md) for how the group maps to the auto-approval toggle (e.g., a tool in the `write` group is controlled by the "Write" toggle).

## Step 4: Tool Handler

Create a handler class in `src/core/tools/` extending `BaseTool<TName>`:

```typescript
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
			if (!param1) {
				task.consecutiveMistakeCount++
				task.recordToolError("my_tool")
				pushToolResult(await task.sayAndCreateMissingParamError("my_tool", "param1"))
				return
			}
			task.consecutiveMistakeCount = 0

			const completeMessage = JSON.stringify({
				tool: "myTool",
				path: getReadablePath(task.cwd, param1),
				content: `Doing something with ${param1}`,
			} satisfies ClineSayTool)

			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) return

			pushToolResult(`Success: did something with ${param1}`)
		} catch (error) {
			await handleError("doing my tool action", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"my_tool">): Promise<void> {
		const param1: string | undefined = block.params.param1
		if (!this.hasPathStabilized(param1)) return
		const partialMessage = JSON.stringify({ tool: "myTool", content: "" })
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const myTool = new MyTool()
```

### partial vs. complete UI messages

`handlePartial()` emits streaming `task.ask("tool", ..., partial=true)` — updates the ChatRow in real time.
`execute()` must call `askApproval("tool", completeMessage)` to finalise the ChatRow entry.

## Step 5: Message Router

In [`presentAssistantMessage.ts`](../src/core/assistant-message/presentAssistantMessage.ts):

**5a.** Import the tool:

```typescript
import { myTool } from "../tools/MyTool"
```

**5b.** Add a case before `default:`:

```typescript
case "my_tool":
    await checkpointSaveAndMark(cline)  // if file-modifying
    await myTool.handle(cline, block as ToolUse<"my_tool">, {
        askApproval, handleError, pushToolResult,
    })
    break
```

**5c.** Add `toolDescription()` case:

```typescript
case "my_tool":
    return `[${block.name} for '${block.params.param1}']`
```

## Step 6: NativeToolArgs

In [`src/shared/tools.ts`](../src/shared/tools.ts):

```typescript
export type NativeToolArgs = {
	// ...
	my_tool: { param1: string; param2?: number }
}
```

## Step 7: NativeToolCallParser

In [`NativeToolCallParser.ts`](../src/core/assistant-message/NativeToolCallParser.ts), add cases in **both** `createPartialToolUse()` and `parseToolCall()`. Both switch statements must stay in sync. Helper methods: `this.coerceOptionalNumber()`, `this.coerceOptionalBoolean()`.

## Step 8–9: ClineSayTool + ChatRow

**If the tool renders a ChatRow entry**, add the camelCase name to `ClineSayTool.tool` union in [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts) and add a `case` in [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx).

## Step 10: Auto-Approval

For the ToolGroup-driven auto-approval system (see [`auto_approval.md`](auto_approval.md)):

- **If the tool belongs to an existing group** (`read`, `write`, `execute`, `browser`, `mcp`, `mode`, `subtasks`, `questions`): no code changes needed — it inherits the group's toggle automatically.
- **If the tool should be unconditionally auto-approved**: add it to the appropriate list in `src/core/auto-approval/index.ts`.
- **If the tool needs a new auto-approval toggle**: add the toggle following the pattern in [`auto_approval.md`](auto_approval.md).

The `alwaysAllow*` toggles in Settings → Auto-Approve map directly to ToolGroups:
`read`→Read, `write`→Write, `execute`→Execute, `browser`→Browser, `mcp`→MCP, `mode`→Mode, `subtasks`→Subtasks, `questions`→Question, `uncategorized`→Uncategorized.

## Step 11: i18n

Add label strings to [`webview-ui/src/i18n/locales/en/chat.json`](../webview-ui/src/i18n/locales/en/chat.json) if the tool shows UI.

---

## External LM Tool Checklist

For tools registered by a separate VS Code extension:

| #   | Location                                            | Description                                                                  |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Extension's `package.json`                          | Add `toolGroups` config mapping each tool name → ToolGroup                   |
| 2   | [`build-tools.ts`](../src/core/task/build-tools.ts) | Add config namespace to `configNamespaces` in `resolveExternalLmToolGroup()` |
| 3   | [`tool.ts`](../packages/types/src/tool.ts)          | Ensure the ToolGroup exists in the enum                                      |

See [`tool-categories.md`](tool-categories.md) § "External LM Tools" for the full reference and examples.

---

## Mode Filtering

Tools are filtered per-mode via [`filter-tools-for-mode.ts`](../src/core/prompts/tools/filter-tools-for-mode.ts). The mode's `groups` array determines which ToolGroup categories are available. `ALWAYS_AVAILABLE_TOOLS` bypass mode filtering entirely. See [`tool_access.md`](tool_access.md) for the complete decision rule.

---

## Build & Test

```bash
./deploy.sh dev build Roo-Code
./deploy.sh dev install-extensions
```

---

## Related Documentation

| Document                                   | Covers                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`tool-categories.md`](tool-categories.md) | The 9 ToolGroup categories, where each tool gets its group, mode filtering, backward compat |
| [`auto_approval.md`](auto_approval.md)     | Decision flow, toggles, unconditionally-approved tools, cost/request limits                 |
| [`tool_access.md`](tool_access.md)         | `groups`, `tools_allowed`, `tools_denied` field reference and decision rules                |
| [`native_tools.md`](native_tools.md)       | Complete reference of all native tools, their groups, params, and mode availability         |
