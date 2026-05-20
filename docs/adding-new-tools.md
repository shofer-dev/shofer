# Adding New Tools to Shofer.

## Three Kinds of Tools

Shofer supports three tool integration patterns. Choose the one that fits your use case:

| Kind                 | Where the tool lives               | How Shofer discovers it              | See doc                                                          |
| -------------------- | ---------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| **Native tool**      | Inside Shofer (TypeScript handler) | Compiled into the extension          | This document                                                    |
| **External LM tool** | Separate VS Code extension         | `shofer.privateToolProviders` config | [`tool-categories.md`](tool-categories.md) § "External LM Tools" |
| **MCP tool**         | External MCP server                | MCP protocol                         | [`tool-categories.md`](tool-categories.md) § "MCP Tools"         |

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
| 8   | `ShoferSayTool` type (`vscode-extension-host.ts`)      | If tool shows UI         |
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
    mcp:         { tools: ["use_mcp_tool", "access_mcp_resource",
                          "call_mcp_tool_async", "check_mcp_call_status", "wait_for_mcp_call"] },
    mode:        { tools: ["switch_mode"] },
    subtasks:    { tools: ["new_task", "check_task_status", "wait_for_task",
                          "list_background_tasks", "cancel_tasks", "answer_subtask_question"] },
    questions:   { tools: ["ask_followup_question"] },
    uncategorized: { tools: [] },
}
```

If the tool should bypass mode filtering entirely, add it to `ALWAYS_AVAILABLE_TOOLS` instead. Also add a display name in `TOOL_DISPLAY_NAMES`.

> **TOOL_GROUPS drives mode filtering and the tools UI** — but it is _not_ the single source of truth for auto-approval. The `read`, `write`, `execute`, `browser`, and `questions` groups _are_ group-driven (via `getToolGroupForSayTool` in [`src/core/auto-approval/tools.ts`](../src/core/auto-approval/tools.ts)), so adding a tool there is enough. The `subtasks`, `mode`, and `mcp` groups use **separate hardcoded camelCase allowlists** inside `checkAutoApproval()` in [`src/core/auto-approval/index.ts`](../src/core/auto-approval/index.ts) — a new tool in any of those three groups MUST also be added to the relevant list there, or it will fall through to the default "ask" branch and prompt the user even when the matching `alwaysAllow*` toggle is on. See Step 10 below.

## Step 4: Tool Handler

Create a handler class in `src/core/tools/` extending `BaseTool<TName>`:

```typescript
import { type ShoferSayTool } from "@shofer/types"
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
			} satisfies ShoferSayTool)

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
    await checkpointSaveAndMark(shofer)  // if file-modifying
    await myTool.handle(shofer, block as ToolUse<"my_tool">, {
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

## Step 8–9: ShoferSayTool + ChatRow

**If the tool renders a ChatRow entry**, add the camelCase name to `ShoferSayTool.tool` union in [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts) and add a `case` in [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx).

## Step 10: Auto-Approval

Auto-approval decisions happen in `checkAutoApproval()` in [`src/core/auto-approval/index.ts`](../src/core/auto-approval/index.ts), dispatched on the `ask` kind that the tool posts:

| Ask kind           | Used by                                                      | How the tool is matched                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"tool"`           | Most native tools (handler calls `askApproval("tool", …)`)   | `JSON.parse(text).tool` (camelCase, e.g. `"newTask"`) is matched against per-group branches. For `read`/`write`/`browser` the branch resolves the group via `getToolGroupForSayTool` ([`tools.ts`](../src/core/auto-approval/tools.ts)) — **purely group-driven**. For `subtasks`/`mode`/MCP-status tools the branch uses a **hardcoded camelCase allowlist** that must be edited directly. |
| `"command"`        | `execute_command`                                            | Gated by `alwaysAllowExecute` + the allow/deny command lists.                                                                                                                                                                                                                                                                                                                               |
| `"use_mcp_server"` | `use_mcp_tool`, `access_mcp_resource`, `call_mcp_tool_async` | `JSON.parse(text).type` must be `"use_mcp_tool"` or `"access_mcp_resource"`; gated by `alwaysAllowMcp` (plus `alwaysAllowUncategorized` for tools not in a configured MCP server group).                                                                                                                                                                                                    |
| `"followup"`       | `ask_followup_question`                                      | Gated by `alwaysAllowFollowupQuestions` + `followupAutoApproveTimeoutMs`.                                                                                                                                                                                                                                                                                                                   |

**Decision matrix for a new tool:**

- **`read` / `write` / `execute` / `browser` group, `ask:"tool"`** — no auto-approval code changes needed beyond Step 3. Make sure the camelCase → snake_case entry exists in `SAY_TOOL_TO_NATIVE_NAME` in [`tools.ts`](../src/core/auto-approval/tools.ts) so `getToolGroupForSayTool` can resolve the group.
- **`subtasks` group, `ask:"tool"`** — add the camelCase name to the `["newTask", "finishTask", "cancelTasks", "answerSubtaskQuestion"]` allowlist (gated by `alwaysAllowSubtasks`) **or** to the unconditional `["waitForTask", "checkTaskStatus", "listBackgroundTasks"]` list if it is a purely informational query that mutates nothing.
- **`mode` group, `ask:"tool"`** — add to the `switchMode` branch gated by `alwaysAllowModeSwitch`.
- **MCP status/management tool with `ask:"tool"`** — add to the unconditional `["checkMcpCallStatus", "waitForMcpCall"]` list if purely informational.
- **MCP invocation with `ask:"use_mcp_server"`** — the payload's `type` field MUST be `"use_mcp_tool"` or `"access_mcp_resource"`; any other value falls through to the default `ask` branch and the `alwaysAllowMcp` toggle will not apply. Pattern for async invocations: post `type: "use_mcp_tool"` plus an `async: true` flag (see [`CallMcpToolAsyncTool.ts`](../src/core/tools/CallMcpToolAsyncTool.ts)).
- **Unconditionally auto-approved (no toggle)** — add the camelCase name to the appropriate "approve" list near the top of the `ask === "tool"` branch (e.g. alongside `updateTodoList`, `skills`, `fetchWebPage`, …).
- **New toggle needed** — add a new `alwaysAllow*` setting following the pattern in [`auto_approval.md`](auto_approval.md), then add a new branch in `checkAutoApproval`.

The `alwaysAllow*` toggles in Settings → Auto-Approve map by intent (not 1:1 to TOOL_GROUPS):
`read`→Read, `write`→Write, `execute`→Execute, `browser`→Browser, `mcp`→MCP (gates both the `use_mcp_server` ask path and any MCP `ask:"tool"` calls), `subtasks`→Subtasks (covers `new_task` / `attempt_completion` / `cancel_tasks` / `answer_subtask_question`), `modeSwitch`→Mode, `followupQuestions`→Question, `uncategorized`→Uncategorized.

## Step 11: i18n

Add label strings to [`webview-ui/src/i18n/locales/en/chat.json`](../webview-ui/src/i18n/locales/en/chat.json) if the tool shows UI.

---

## External LM Tool Checklist

For tools registered by a separate VS Code extension:

| #   | Location                                            | Description                                                                                                                                  |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Extension's `package.json`                          | Add `toolGroups` config mapping each tool name → ToolGroup                                                                                   |
| 2   | [`build-tools.ts`](../src/core/task/build-tools.ts) | Tool group resolved automatically by `resolvePrivateToolGroup()` via `shofer.privateToolProviders` + `shofer.<providerId>.toolGroups` config |
| 3   | [`tool.ts`](../packages/types/src/tool.ts)          | Ensure the ToolGroup exists in the enum                                                                                                      |

See [`tool-categories.md`](tool-categories.md) § "External LM Tools" for the full reference and examples.

---

## Mode Filtering

Tools are filtered per-mode via [`filter-tools-for-mode.ts`](../src/core/prompts/tools/filter-tools-for-mode.ts). The mode's `groups` array determines which ToolGroup categories are available. `ALWAYS_AVAILABLE_TOOLS` bypass mode filtering entirely. See [`tool_access.md`](tool_access.md) for the complete decision rule.

---

## Build & Test

```bash
./deploy.sh dev build shofer
./deploy.sh dev install-extensions
```

---

## Gaps & Areas for Improvement

This section tracks known gaps, undocumented steps, and design warts in the native tool implementation workflow. These are not bugs in this doc — they are places where the codebase plumbing is more complex than the checklist captures, or where a missing step will silently break tool integration.

### Checklist gaps (items not in the 11-step list but needed in practice)

- **`TOOL_DISPLAY_NAMES`** (in [`tool.ts`](../packages/types/src/tool.ts)): Mentioned in a sentence under Step 3 but not listed as its own checklist row. Every tool needs a human-readable display name here — it drives the tools-UI panel and auto-approval setting labels. Without it the tool is unnamed in the SettingsView.

- **`SAY_TOOL_TO_NATIVE_NAME`** (in [`tools.ts`](../src/core/auto-approval/tools.ts)): The camelCase → snake_case mapping used by `getToolGroupForSayTool()`. A tool in the `read` / `write` / `execute` / `browser` group that uses `ask:"tool"` MUST have an entry here. Step 10 mentions this in prose but it's easy to miss. Without it, auto-approval falls through to `"ask"` even with the toggle on.

- **`toolParamNames`** (in [`src/shared/tools.ts`](../src/shared/tools.ts)): If a tool introduces a new parameter name not already in the `toolParamNames` const array, it must be added there. This array drives the `ToolParamName` type used in `ToolUse.params` — a missing entry means the streaming infrastructure cannot type the parameter and the partial-json parser may drop it.

### Tool group pitfalls

- **`write` group `customTools`**: The `write` group has two arrays — `tools` (always available when write is allowed) and `customTools` (opt-in only, gated behind `experiments.customTools`). Adding a write-mutating tool to `customTools` instead of `tools` means it won't appear unless the user has custom tools enabled. The doc shows merging both arrays in the example but doesn't explain the distinction.

- **9 groups only**: There are exactly 9 tool groups. Adding a 10th requires changes to `toolGroups` const, `TOOL_GROUPS`, `toolGroupsSchema`, the `<Mode × Allowed Groups>` matrix in `tool-categories.md`, and the auto-approval switch in `index.ts`. The doc has no warning about this.

### Auto-approval fragmentation

The auto-approval system requires 4 separate code locations for full integration of a tool that uses `ask:"tool"` and belongs to `subtasks`, `mode`, or `mcp`:

1. [`checkAutoApproval()`](../src/core/auto-approval/index.ts) — the hardcoded per-group camelCase allowlists
2. [`SAY_TOOL_TO_NATIVE_NAME`](../src/core/auto-approval/tools.ts) — the camelCase → snake_case mapping
3. [`TOOL_GROUPS`](../packages/types/src/tool.ts) — the snake_case → group mapping
4. Handler code — constructing the `ShoferSayTool.tool` camelCase string

For `read` / `write` / `execute` / `browser` groups the chain is symbolic (group-driven), but for `subtasks` / `mode` / `mcp` it is hardcoded. A developer adding a new subtask-group tool must remember to edit BOTH the `TOOL_GROUPS` entry AND the hardcoded allowlist in `checkAutoApproval()`. Missing the allowlist edit silently breaks auto-approval.

### Handler example omissions

The Step 4 handler example is intentionally minimal, but real tool implementations also need:

- **File Change Tracking**: Tools that mutate workspace files must call `task.fileContextTracker.captureOriginal(relPath, content)` before mutation and `task.fileContextTracker.trackFileContext(relPath, "shofer_edited")` after. Without these, the file won't appear in the FileChangesPanel. See [`file-change-tracking.md`](file-change-tracking.md).

- **`checkpointSaveAndMark`**: File-mutating tools get a `checkpointSaveAndMark(shofer)` call in the `presentAssistantMessage.ts` switch before the tool's `.handle()` is invoked (see Step 5b). The handler itself does not call checkpoint — the router does.

- **`resetPartialState()`**: Tools that override `handlePartial()` must call `this.resetPartialState()` at the end of `execute()` on both success and error paths. Skipping this causes the next invocation to short-circuit on a stale stabilized path.

---

## Related Documentation

| Document                                   | Covers                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`tool-categories.md`](tool-categories.md) | The 9 ToolGroup categories, where each tool gets its group, mode filtering, backward compat |
| [`auto_approval.md`](auto_approval.md)     | Decision flow, toggles, unconditionally-approved tools, cost/request limits                 |
| [`tool_access.md`](tool_access.md)         | `groups`, `tools_allowed`, `tools_denied` field reference and decision rules                |
| [`native_tools.md`](native_tools.md)       | Complete reference of all native tools, their groups, params, and mode availability         |
