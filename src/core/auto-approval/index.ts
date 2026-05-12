import {
	type ShoferAsk,
	type ShoferSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isNonBlockingAsk,
} from "@shofer/types"

import { ShoferAskResponse } from "../../shared/WebviewMessage"

import { isWriteToolAction, isReadOnlyToolAction, getToolGroupForSayTool } from "./tools"
import { isMcpToolUncategorized } from "./mcp"
import { getCommandDecision } from "./commands"

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
	if (isNonBlockingAsk(ask)) {
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
				// calls. Per-tool granularity is controlled by tool groups (see
				// `filterMcpToolsForMode`); tools without a group default to
				// "uncategorized" and require an additional opt-in via
				// `alwaysAllowUncategorized` (which is only meaningful when
				// `alwaysAllowMcp` is also true).
				if (state.alwaysAllowMcp !== true) {
					return { decision: "ask" }
				}

				if (isMcpToolUncategorized(mcpServerUse, state.mcpServers) && state.alwaysAllowUncategorized !== true) {
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
			console.error("Failed to parse tool:", error)
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
		if (tool.tool === "loadSkill") {
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

		if (["newTask", "finishTask"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		// Background-task status tools are purely informational queries against in-memory
		// state owned by the parent task. They mutate nothing, so they are always auto-approved
		// — matching the UX of `updateTodoList` / `skill`.
		if (["waitForTask", "checkTaskStatus", "listBackgroundTasks"].includes(tool?.tool)) {
			return { decision: "approve" }
		}

		// Harmless informational / lightweight read-only tools are unconditionally auto-approved
		// (independent of `alwaysAllowReadOnly`). These tools either query in-memory editor/LSP
		// state, fetch a public URL, or list workspace metadata — they cannot mutate user state
		// and gating them behind an approval prompt offers no security benefit while creating
		// the appearance of a "silent hang" when the corresponding chat-row renderer is missing.
		if (
			[
				"fetchWebPage",
				"findFiles",
				"viewImage",
				"getErrors",
				"getChangedFiles",
				"getProjectSetupInfo",
				"getSearchResults",
				"readProjectStructure",
				"listCodeUsages",
				"codebaseSearchWithLsp",
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
