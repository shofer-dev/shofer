import {
	type ShoferAsk,
	type ShoferSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isAutoApprovableAsk,
} from "@shofer/types"

import { ShoferAskResponse } from "@shofer/types"

import { getToolGroupForSayTool } from "./tools.js"
import { getMcpToolGroup } from "./mcp.js"
import { getCommandDecision } from "./commands.js"
import { type AutoApprovalState, type AutoApprovalStateOptions, isGroupAutoApproved } from "./group-gates.js"
import { isPathAutoApproved } from "./paths.js"
import { webviewLog } from "../logging/subsystems.js"

// Per-group gating is centralized in ./group-gates (the §4 single source of
// truth, used by both the MCP and native-tool paths below).
export type { AutoApprovalState, AutoApprovalStateOptions } from "./group-gates.js"

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
			} catch {
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
				// with the same per-group control that native tools respect, via the
				// shared GROUP_GATE table. The MCP path does not apply the
				// outside-workspace / protected-file modifiers (applyModifiers:false).
				const group = getMcpToolGroup(mcpServerUse, state.mcpServers)

				if (!isGroupAutoApproved(group, state, {}, { applyModifiers: false })) {
					return { decision: "ask" }
				}

				return { decision: "approve" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		} catch {
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
		//   - cancelTasks:          stop one or more concurrent children (destructive — in-flight work is lost)
		// (checkTaskStatus / listBackgroundTasks are purely informational and
		// unconditionally approved further down — same UX as updateTodoList / skills.)
		if (["newTask", "finishTask", "cancelTasks"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		// askFollowupQuestion routed to another task is unconditionally approved.
		// A question only reaches the `ask === "tool"` path here when a background
		// child routes it UP to its parent (see AskFollowupQuestionTool: the
		// `task.parentTaskId && task.isBackgroundTask` branch uses
		// askApproval("tool", {tool: "askFollowupQuestion", ...})). No human is
		// interrupted — the parent answers the request in its mailbox with `reply` — so
		// gating it behind a user prompt is meaningless and would silently hang
		// the child. A question directed at the USER instead goes through the
		// `ask === "followup"` path above, which remains gated by
		// `alwaysAllowFollowupQuestions`.
		if ((tool?.tool as string) === "askFollowupQuestion") {
			return { decision: "approve" }
		}

		// The mailbox tools are unconditionally auto-approved (docs/task_messaging.md
		// § "Auto-approval"). None of them can block anything but the caller's own
		// loop and none is terminal: `sendMessage` has no side effect on the sender
		// and the recipient decides whether to answer, `reply` answers a request the
		// task already holds, and `wait` parks the caller under a mandatory timeout.
		// The `alwaysAllowSubtasks` gate that used to guard a SYNC send is gone with
		// the blocking send it existed for.
		if (["sendMessage", "reply", "wait"].includes(tool?.tool as string)) {
			return { decision: "approve" }
		}

		// Background-task status tools are purely informational queries against in-memory
		// state owned by the parent task. They mutate nothing, so they are always auto-approved
		// — matching the UX of `updateTodoList` / `skill`.
		if (["checkTaskStatus", "listBackgroundTasks"].includes(tool?.tool)) {
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
				"getProjectSetupInfo",
				// getSearchResults removed — merged into grep_search
				"readProjectStructure",
				"listCodeUsages",
				"lspSearch",
				// describeTools reads back the schemas of tools the model was shown as
				// stubs, out of the definitions this very request was built from. It
				// touches nothing and reveals nothing the tool list does not already
				// carry, so gating it would only stall the call that discovery exists
				// to unblock.
				"describeTools",
			].includes(tool?.tool)
		) {
			return { decision: "approve" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		const toolGroup = getToolGroupForSayTool(tool)

		// Native-tool group gating via the shared GROUP_GATE table (§4). Only the
		// browser / read / write groups are auto-approvable on this path — the
		// other groups are either handled by the tool-specific branches above
		// (mode → switchMode, subtasks → newTask/…) or intentionally fall through
		// to a user prompt. The native path applies the outside-workspace /
		// protected-file modifiers (applyModifiers:true).
		if (toolGroup === "browser" || toolGroup === "read" || toolGroup === "write") {
			const approved = isGroupAutoApproved(
				toolGroup,
				state,
				{ isOutsideWorkspace, isProtected, absolutePath: tool.absolutePath },
				{ applyModifiers: true },
			)

			if (!approved) {
				return { decision: "ask" }
			}

			// Batch reads (design §6): a `read_file` may bundle several files, each with its
			// own `isOutsideWorkspace`/`absolutePath`. The base check above only covered the
			// top-level tool path. When the blanket read-outside toggle is OFF, EVERY
			// outside-workspace batch entry must itself be path-approved; any unmatched entry
			// falls the whole tool back to a prompt. (When the blanket toggle is ON the group
			// check already approved every outside entry — no per-entry check needed.)
			if (toolGroup === "read" && tool.batchFiles?.length && state.alwaysAllowReadOnlyOutsideWorkspace !== true) {
				const everyOutsideEntryTrusted = tool.batchFiles.every(
					(entry) =>
						entry.isOutsideWorkspace !== true ||
						isPathAutoApproved(
							entry.absolutePath ?? "",
							"read",
							state.allowedReadPaths ?? [],
							state.allowedWritePaths ?? [],
						),
				)

				if (!everyOutsideEntryTrusted) {
					return { decision: "ask" }
				}
			}

			return { decision: "approve" }
		}
	}

	return { decision: "ask" }
}

export { AutoApprovalHandler } from "./AutoApprovalHandler.js"
