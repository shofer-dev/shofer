import {
	type ShoferAsk,
	type ShoferSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	type ToolGroup,
	isAutoApprovableAsk,
} from "@shofer/types"

import { ShoferAskResponse } from "../../shared/WebviewMessage"

import { isWriteToolAction, isReadOnlyToolAction, getToolGroupForSayTool } from "./tools"
import { getMcpToolGroup } from "./mcp"
import { getCommandDecision } from "./commands"
import { webviewLog } from "../../utils/logging/subsystems"

// We have auto-approval actions for different categories.
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowBrowser"
	| "alwaysAllowMcp"
	| "alwaysAllowUncategorized"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"

// Some of these actions have additional settings associated with them.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "followupAutoApproveTimeoutMs" // For `alwaysAllowFollowupQuestions`.
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"

// Maps a resolved MCP tool group to the per-group auto-approval toggle that must
// ALSO be enabled — on top of the master `alwaysAllowMcp` gate — before a tool
// in that group is auto-approved. This mirrors the per-group gating applied to
// native tools (the `ask === "tool"` path) so that, e.g., browser tools served
// over MCP honor `alwaysAllowBrowser` instead of being approved by
// `alwaysAllowMcp` alone. Groups absent from this map (e.g. the generic "mcp"
// protocol group) are gated by `alwaysAllowMcp` by itself.
const MCP_GROUP_APPROVAL_GATE: Partial<Record<ToolGroup, AutoApprovalState>> = {
	read: "alwaysAllowReadOnly",
	write: "alwaysAllowWrite",
	execute: "alwaysAllowExecute",
	browser: "alwaysAllowBrowser",
	mode: "alwaysAllowModeSwitch",
	subtasks: "alwaysAllowSubtasks",
	questions: "alwaysAllowFollowupQuestions",
	uncategorized: "alwaysAllowUncategorized",
}

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	| { decision: "deny" }
	| { decision: "ask" }
	| {
			decision: "timeout"
			timeout: number
			fn: () => { askResponse: ShoferAskResponse; text?: string; images?: string[] }
	  }

export async function checkAutoApproval({
	state,
	ask,
	text,
	isProtected,
}: {
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	ask: ShoferAsk
	text?: string
	isProtected?: boolean
}): Promise<CheckAutoApprovalResult> {
	if (isAutoApprovableAsk(ask)) {
		return { decision: "approve" }
	}

	if (!state || !state.autoApprovalEnabled) {
		return { decision: "ask" }
	}

	if (ask === "followup") {
		if (state.alwaysAllowFollowupQuestions === true) {
			try {
				const suggestion = (JSON.parse(text || "{}") as FollowUpData).suggest?.[0]

				if (
					suggestion &&
					typeof state.followupAutoApproveTimeoutMs === "number" &&
					state.followupAutoApproveTimeoutMs > 0
				) {
					return {
						decision: "timeout",
						timeout: state.followupAutoApproveTimeoutMs,
						fn: () => ({ askResponse: "messageResponse", text: suggestion.answer }),
					}
				} else {
					return { decision: "ask" }
				}
			} catch (error) {
				return { decision: "ask" }
			}
		} else {
			return { decision: "ask" }
		}
	}

	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}

		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse

			// Private provider tools (from extensions like vscode-tools or
			// browser-tools) are surfaced through the same `use_mcp_server` ask
			// purely for UI consistency. The user already opted in by
			// installing the providing extension, so we bypass MCP gating.
			if (mcpServerUse.external_lm_tool === true) {
				return { decision: "approve" }
			}

			if (mcpServerUse.type === "use_mcp_tool") {
				// `alwaysAllowMcp` is the master gate for auto-approving MCP tool
				// calls.
				if (state.alwaysAllowMcp !== true) {
					return { decision: "ask" }
				}

				// Per-group gating: beyond the master gate, a tool is only
				// auto-approved if its group's dedicated toggle is also enabled
				// (e.g. "browser" → `alwaysAllowBrowser`, "uncategorized" →
				// `alwaysAllowUncategorized`). This keeps MCP-served tools aligned
				// with the same per-group control that mode filtering and native
				// tools already respect. Groups without a dedicated toggle are
				// approved by `alwaysAllowMcp` alone.
				const group = getMcpToolGroup(mcpServerUse, state.mcpServers)
				const groupGate = MCP_GROUP_APPROVAL_GATE[group]

				if (groupGate && state[groupGate] !== true) {
					return { decision: "ask" }
				}

				return { decision: "approve" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		} catch (error) {
			return { decision: "ask" }
		}

		return { decision: "ask" }
	}

	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}

		if (state.alwaysAllowExecute === true) {
			const decision = getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || [])

			if (decision === "auto_approve") {
				return { decision: "approve" }
			} else if (decision === "auto_deny") {
				return { decision: "deny" }
			} else {
				return { decision: "ask" }
			}
		}
	}

	if (ask === "tool") {
		let tool: ShoferSayTool | undefined

		try {
			tool = JSON.parse(text || "{}")
		} catch (error) {
			webviewLog.error("Failed to parse tool:", error)
		}

		if (!tool) {
			return { decision: "ask" }
		}

		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		// The skill tool only loads pre-defined instructions from global or project skills.
		// It does not read arbitrary files - skills must be explicitly installed/defined by the user.
		// Auto-approval is intentional to provide a seamless experience when loading task instructions.
		if (tool.tool === "skills") {
			return { decision: "approve" }
		}

		// Non-destructive meta-operation: only renames the task in UI and history.
		if (tool.tool === "setTaskTitle") {
			return { decision: "approve" }
		}

		// Harmless meta-operation: appends a feedback line to the extension output channel.
		if (tool.tool === "giveFeedback") {
			return { decision: "approve" }
		}

		if (tool?.tool === "switchMode") {
			return state.alwaysAllowModeSwitch === true ? { decision: "approve" } : { decision: "ask" }
		}

		// Subtasks-group tools that the parent task uses to control its background children.
		// All gated by the single `alwaysAllowSubtasks` toggle:
		//   - newTask / finishTask: spawn / complete a subtask
		//   - cancelTasks:          stop one or more background children (destructive — in-flight work is lost)
		//   - answerSubtaskQuestion: reply to a question a background child routed up to the parent
		// (waitForTask / checkTaskStatus / listBackgroundTasks are purely informational and
		// unconditionally approved further down — same UX as updateTodoList / skills.)
		if (["newTask", "finishTask", "cancelTasks", "answerSubtaskQuestion"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		// askFollowupQuestion routed to another task is unconditionally approved.
		// A question only reaches the `ask === "tool"` path here when a background
		// child routes it UP to its parent (see AskFollowupQuestionTool: the
		// `task.parentTaskId && task.isBackgroundTask` branch uses
		// askApproval("tool", {tool: "askFollowupQuestion", ...})). No human is
		// interrupted — the parent answers via `answer_subtask_question` — so
		// gating it behind a user prompt is meaningless and would silently hang
		// the child. A question directed at the USER instead goes through the
		// `ask === "followup"` path above, which remains gated by
		// `alwaysAllowFollowupQuestions`.
		if ((tool?.tool as string) === "askFollowupQuestion") {
			return { decision: "approve" }
		}

		// sendMessageToTask: async is always approved (fire-and-forget); sync is gated.
		if ((tool?.tool as string) === "sendMessageToTask") {
			const isSync = (tool as any).wait === true
			if (!isSync) {
				return { decision: "approve" }
			}
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		// Background-task status tools are purely informational queries against in-memory
		// state owned by the parent task. They mutate nothing, so they are always auto-approved
		// — matching the UX of `updateTodoList` / `skill`.
		if (["waitForTask", "checkTaskStatus", "listBackgroundTasks"].includes(tool?.tool)) {
			return { decision: "approve" }
		}

		// Async MCP call management tools are purely informational queries against
		// in-memory state owned by the calling task. They mutate nothing and are
		// unconditionally auto-approved — same UX as the background-task tools above.
		// `callMcpToolAsync` is intentionally NOT in this list; it goes through the
		// `use_mcp_server` ask gate (alwaysAllowMcp + per-tool).
		if (["checkMcpCallStatus", "waitForMcpCall"].includes(tool?.tool)) {
			return { decision: "approve" }
		}

		// Harmless informational / lightweight read-only tools are unconditionally auto-approved
		// (independent of `alwaysAllowReadOnly`). These tools query in-memory editor/LSP state
		// or list workspace metadata — they cannot mutate user state and gating them behind an
		// approval prompt offers no security benefit while creating the appearance of a
		// "silent hang" when the corresponding chat-row renderer is missing.
		if (
			[
				"findFiles",
				"viewImage",
				"getErrors",
				"getChangedFiles",
				"getProjectSetupInfo",
				// getSearchResults removed — merged into grep_search
				"readProjectStructure",
				"listCodeUsages",
				"lspSearch",
				// sleep is harmless — it just pauses execution. Without auto-approval it
				// would prompt the user on every pause, and without a chat row it would
				// appear as a silent hang.
				"sleep",
			].includes(tool?.tool)
		) {
			return { decision: "approve" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		const toolGroup = getToolGroupForSayTool(tool)

		// Browser tools — controlled by the alwaysAllowBrowser toggle.
		// Automatically available for any tool whose group resolves to "browser"
		// (browser-tools extension tools, browser_* prefixed tools).
		if (toolGroup === "browser") {
			return state.alwaysAllowBrowser === true ? { decision: "approve" } : { decision: "ask" }
		}

		if (isReadOnlyToolAction(tool)) {
			return state.alwaysAllowReadOnly === true &&
				(!isOutsideWorkspace || state.alwaysAllowReadOnlyOutsideWorkspace === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (isWriteToolAction(tool)) {
			return state.alwaysAllowWrite === true &&
				(!isOutsideWorkspace || state.alwaysAllowWriteOutsideWorkspace === true) &&
				(!isProtected || state.alwaysAllowWriteProtected === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}
	}

	return { decision: "ask" }
}

export { AutoApprovalHandler } from "./AutoApprovalHandler"
