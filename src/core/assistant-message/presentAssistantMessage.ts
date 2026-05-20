import * as vscode from "vscode"
import { serializeError } from "serialize-error"
import { Anthropic } from "@anthropic-ai/sdk"

import type { ToolName, ShoferAsk, ToolProgressStatus } from "@shofer/types"
import { ConsecutiveMistakeError, TelemetryEventName } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"
import { customToolRegistry } from "@shofer/core"

import { t } from "../../i18n"

import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import type { ToolParamName, ToolResponse, ToolUse, McpToolUse } from "../../shared/tools"

import { AskIgnoredError } from "../task/AskIgnoredError"
import { Task } from "../task/Task"

import { listFilesTool } from "../tools/ListFilesTool"
import { readFileTool } from "../tools/ReadFileTool"
import { readCommandOutputTool } from "../tools/ReadCommandOutputTool"
import { writeToFileTool } from "../tools/WriteToFileTool"
import { editTool } from "../tools/EditTool"
import { searchReplaceTool } from "../tools/SearchReplaceTool"
import { editFileTool } from "../tools/EditFileTool"
import { applyPatchTool } from "../tools/ApplyPatchTool"
import { grepSearchTool } from "../tools/GrepSearchTool"
import { executeCommandTool } from "../tools/ExecuteCommandTool"
import { useMcpToolTool } from "../tools/UseMcpToolTool"
import { accessMcpResourceTool } from "../tools/accessMcpResourceTool"
import { askFollowupQuestionTool } from "../tools/AskFollowupQuestionTool"
import { switchModeTool } from "../tools/SwitchModeTool"
import { setTaskTitleTool } from "../tools/SetTaskTitleTool"
import { giveFeedbackTool } from "../tools/GiveFeedbackTool"
import { attemptCompletionTool, AttemptCompletionCallbacks } from "../tools/AttemptCompletionTool"
import { newTaskTool } from "../tools/NewTaskTool"
import { updateTodoListTool } from "../tools/UpdateTodoListTool"
import { runSlashCommandTool } from "../tools/RunSlashCommandTool"
import { skillsTool } from "../tools/SkillsTool"
import { generateImageTool } from "../tools/GenerateImageTool"
import { applyDiffTool as applyDiffToolClass } from "../tools/ApplyDiffTool"
import { isValidToolName, validateToolUse } from "../tools/validateToolUse"
import { ragSearchTool } from "../tools/RagSearchTool"
import { gitSearchTool } from "../tools/GitSearchTool"
import { lspSearchTool } from "../tools/LspSearchTool"
import { askAssistantAgentTool } from "../tools/AskAssistantAgentTool"
import { createDirectoryTool } from "../tools/CreateDirectoryTool"
import { createNewWorkspaceTool } from "../tools/CreateNewWorkspaceTool"
import { fetchWebPageTool } from "../tools/FetchWebPageTool"
import { fileTool } from "../tools/FileTool"
import { findFilesTool } from "../tools/FindFilesTool"
import { getChangedFilesTool } from "../tools/GetChangedFilesTool"
import { getErrorsTool } from "../tools/GetErrorsTool"
import { getProjectSetupInfoTool } from "../tools/GetProjectSetupInfoTool"
import { insertEditTool } from "../tools/InsertEditTool"
import { sedTool } from "../tools/SedTool"
import { listCodeUsagesTool } from "../tools/ListCodeUsagesTool"
import { readProjectStructureTool } from "../tools/ReadProjectStructureTool"
import { renameSymbolTool } from "../tools/RenameSymbolTool"
import { viewImageTool } from "../tools/ViewImageTool"
import { checkTaskStatusTool } from "../tools/CheckTaskStatusTool"
import { waitForTaskTool } from "../tools/WaitForTaskTool"
import { listBackgroundTasksTool } from "../tools/ListBackgroundTasksTool"
import { cancelTasksTool } from "../tools/CancelTasksTool"
import { answerSubtaskQuestionTool } from "../tools/AnswerSubtaskQuestionTool"
import { callMcpToolAsyncTool } from "../tools/CallMcpToolAsyncTool"
import { checkMcpCallStatusTool } from "../tools/CheckMcpCallStatusTool"
import { waitForMcpCallTool } from "../tools/WaitForMcpCallTool"
import { sleepTool } from "../tools/SleepTool"
import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { isPrivateLmTool, getPrivateToolInvokeCommand } from "../task/build-tools"
import { outputError, outputLog, outputWarn } from "../../utils/outputChannelLogger"

/**
 * Processes and presents assistant message content to the user interface.
 *
 * This function is the core message handling system that:
 * - Sequentially processes content blocks from the assistant's response.
 * - Displays text content to the user.
 * - Executes tool use requests with appropriate user approval.
 * - Manages the flow of conversation by determining when to proceed to the next content block.
 * - Coordinates file system checkpointing for modified files.
 * - Controls the conversation state to determine when to continue to the next request.
 *
 * The function uses a locking mechanism to prevent concurrent execution and handles
 * partial content blocks during streaming. It's designed to work with the streaming
 * API response pattern, where content arrives incrementally and needs to be processed
 * as it becomes available.
 */

export async function presentAssistantMessage(shofer: Task) {
	if (shofer.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${shofer.taskId}.${shofer.instanceId} aborted`)
	}

	if (shofer.presentAssistantMessageLocked) {
		shofer.presentAssistantMessageHasPendingUpdates = true
		return
	}

	shofer.presentAssistantMessageLocked = true
	shofer.presentAssistantMessageHasPendingUpdates = false

	if (shofer.currentStreamingContentIndex >= shofer.assistantMessageContent.length) {
		// This may happen if the last content block was completed before
		// streaming could finish. If streaming is finished, and we're out of
		// bounds then this means we already  presented/executed the last
		// content block and are ready to continue to next request.
		if (shofer.didCompleteReadingStream) {
			shofer.userMessageContentReady = true
		}

		shofer.presentAssistantMessageLocked = false
		return
	}

	let block: any
	try {
		// Performance optimization: Use shallow copy instead of deep clone.
		// The block is used read-only throughout this function - we never mutate its properties.
		// We only need to protect against the reference changing during streaming, not nested mutations.
		// This provides 80-90% reduction in cloning overhead (5-100ms saved per block).
		block = { ...shofer.assistantMessageContent[shofer.currentStreamingContentIndex] }
	} catch (error) {
		outputError(`ERROR cloning block:`, error)
		outputError(
			`Block content:`,
			JSON.stringify(shofer.assistantMessageContent[shofer.currentStreamingContentIndex], null, 2),
		)
		shofer.presentAssistantMessageLocked = false
		return
	}

	switch (block.type) {
		case "mcp_tool_use": {
			// Handle native MCP tool calls (from mcp_serverName_toolName dynamic tools)
			// These are converted to the same execution path as use_mcp_tool but preserve
			// their original name in API history
			const mcpBlock = block as McpToolUse

			if (shofer.didRejectTool) {
				// For native protocol, we must send a tool_result for every tool_use to avoid API errors
				const toolCallId = mcpBlock.id
				const errorMessage = !mcpBlock.partial
					? `Skipping MCP tool ${mcpBlock.name} due to user rejecting a previous tool.`
					: `MCP tool ${mcpBlock.name} was interrupted and not executed due to user rejecting a previous tool.`

				if (toolCallId) {
					shofer.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: errorMessage,
						is_error: true,
					})
				}
				break
			}

			// Track if we've already pushed a tool result
			let hasToolResult = false
			const toolCallId = mcpBlock.id

			// Store approval feedback to merge into tool result (GitHub #10465)
			let approvalFeedback: { text: string; images?: string[] } | undefined

			const pushToolResult = (content: ToolResponse, feedbackImages?: string[]) => {
				if (hasToolResult) {
					outputWarn(
						`[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: ${toolCallId}`,
					)
					return
				}

				let resultContent: string
				let imageBlocks: Anthropic.ImageBlockParam[] = []

				if (typeof content === "string") {
					resultContent = content || "(tool did not return anything)"
				} else {
					const textBlocks = content.filter((item) => item.type === "text")
					imageBlocks = content.filter((item) => item.type === "image") as Anthropic.ImageBlockParam[]
					resultContent =
						textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
						"(tool did not return anything)"
				}

				// Merge approval feedback into tool result (GitHub #10465)
				if (approvalFeedback) {
					const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
					resultContent = `${feedbackText}\n\n${resultContent}`

					// Add feedback images to the image blocks
					if (approvalFeedback.images) {
						const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
						imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
					}
				}

				if (toolCallId) {
					shofer.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: resultContent,
					})

					if (imageBlocks.length > 0) {
						shofer.userMessageContent.push(...imageBlocks)
					}
				}

				// Emit tool result to the webview so ChatRow can show an expandable
				// output section beneath the MCP tool invocation block.
				// Skip when the tool produced no meaningful output.
				// Cap output at 2 KB to avoid bloating IPC messages.
				if (resultContent && resultContent !== "(tool did not return anything)") {
					const MAX_TOOL_RESULT = 2048
					const mcpTruncatedOutput =
						resultContent.length > MAX_TOOL_RESULT
							? resultContent.substring(0, MAX_TOOL_RESULT) +
								`\n\n[Output truncated: ${resultContent.length.toLocaleString()} chars total]`
							: resultContent

					shofer.say(
						"tool_result",
						JSON.stringify({
							tool: `mcp__${mcpBlock.serverName}__${mcpBlock.toolName}`,
							output: mcpTruncatedOutput,
						} satisfies import("@shofer/types").ShoferSayToolResult),
					)
				}

				hasToolResult = true
			}

			const toolDescription = () => `[mcp_tool: ${mcpBlock.serverName}/${mcpBlock.toolName}]`

			const askApproval = async (
				type: ShoferAsk,
				partialMessage?: string,
				progressStatus?: ToolProgressStatus,
				isProtected?: boolean,
			) => {
				const { response, text, images } = await shofer.ask(
					type,
					partialMessage,
					false,
					progressStatus,
					isProtected || false,
				)

				if (response !== "yesButtonClicked") {
					if (text) {
						await shofer.say("user_feedback", text, images)
						pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
					} else {
						pushToolResult(formatResponse.toolDenied())
					}
					shofer.didRejectTool = true
					return false
				}

				// Store approval feedback to be merged into tool result (GitHub #10465)
				// Don't push it as a separate tool_result here - that would create duplicates.
				// The tool will call pushToolResult, which will merge the feedback into the actual result.
				if (text) {
					await shofer.say("user_feedback", text, images)
					approvalFeedback = { text, images }
				}

				return true
			}

			const handleError = async (action: string, error: Error) => {
				// Silently ignore AskIgnoredError - this is an internal control flow
				// signal, not an actual error. It occurs when a newer ask supersedes an older one.
				if (error instanceof AskIgnoredError) {
					return
				}
				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
				await shofer.say(
					"error",
					`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
				)
				pushToolResult(formatResponse.toolError(errorString))
			}

			if (!mcpBlock.partial) {
				shofer.recordToolUsage("use_mcp_tool") // Record as use_mcp_tool for analytics
				TelemetryService.instance.captureToolUsage(shofer.taskId, "use_mcp_tool")
			}

			// Resolve sanitized server name back to original server name
			// The serverName from parsing is sanitized (e.g., "my_server" from "my server")
			// We need the original name to find the actual MCP connection
			const mcpHub = shofer.providerRef.deref()?.getMcpHub()
			let resolvedServerName = mcpBlock.serverName
			if (mcpHub) {
				const originalName = mcpHub.findServerNameBySanitizedName(mcpBlock.serverName)
				if (originalName) {
					resolvedServerName = originalName
				}
			}

			// Execute the MCP tool using the same handler as use_mcp_tool
			// Create a synthetic ToolUse block that the useMcpToolTool can handle
			const syntheticToolUse: ToolUse<"use_mcp_tool"> = {
				type: "tool_use",
				id: mcpBlock.id,
				name: "use_mcp_tool",
				params: {
					server_name: resolvedServerName,
					tool_name: mcpBlock.toolName,
					arguments: JSON.stringify(mcpBlock.arguments),
				},
				partial: mcpBlock.partial,
				nativeArgs: {
					server_name: resolvedServerName,
					tool_name: mcpBlock.toolName,
					arguments: mcpBlock.arguments,
				},
			}

			await useMcpToolTool.handle(shofer, syntheticToolUse, {
				askApproval,
				handleError,
				pushToolResult,
			})
			break
		}
		case "text": {
			if (shofer.didRejectTool || shofer.didAlreadyUseTool) {
				break
			}

			let content = block.content

			if (content) {
				// Have to do this for partial and complete since sending
				// content in thinking tags to markdown renderer will
				// automatically be removed.
				// Strip any streamed <thinking> tags from text output.
				content = content.replace(/<thinking>\s?/g, "")
				content = content.replace(/\s?<\/thinking>/g, "")
			}

			await shofer.say("text", content, undefined, block.partial)
			break
		}
		case "tool_use": {
			// Native tool calling is the only supported tool calling mechanism.
			// A tool_use block without an id is invalid and cannot be executed.
			const toolCallId = (block as any).id as string | undefined
			if (!toolCallId) {
				const errorMessage =
					"Invalid tool call: missing tool_use.id. XML tool calls are no longer supported. Remove any XML tool markup (e.g. <read_file>...</read_file>) and use native tool calling instead."
				// Record a tool error for visibility/telemetry. Use the reported tool name if present.
				try {
					if (
						typeof (shofer as any).recordToolError === "function" &&
						typeof (block as any).name === "string"
					) {
						;(shofer as any).recordToolError((block as any).name as ToolName, errorMessage)
					}
				} catch {
					// Best-effort only
				}
				shofer.consecutiveMistakeCount++
				await shofer.say("error", errorMessage)
				shofer.userMessageContent.push({ type: "text", text: errorMessage })
				shofer.didAlreadyUseTool = true
				break
			}

			// Fetch state early so it's available for toolDescription and validation
			const state = await shofer.providerRef.deref()?.getState()
			const { mode, customModes, experiments: stateExperiments, disabledTools } = state ?? {}

			const toolDescription = (): string => {
				switch (block.name) {
					case "execute_command":
						return `[${block.name} for '${block.params.command}']`
					case "read_file":
						// Prefer native typed args when available; fall back to legacy params
						// Check if nativeArgs exists (native protocol)
						if (block.nativeArgs) {
							return readFileTool.getReadFileToolDescription(block.name, block.nativeArgs)
						}
						return readFileTool.getReadFileToolDescription(block.name, block.params)
					case "write_to_file":
						return `[${block.name} for '${block.params.path}']`
					case "apply_diff":
						// Native-only: tool args are structured (no XML payloads).
						return block.params?.path ? `[${block.name} for '${block.params.path}']` : `[${block.name}]`
					case "grep_search":
						return `[${block.name} for '${block.params.query}'${
							block.params.fileTypes
								? ` in '${block.params.fileTypes}'`
								: block.params.file_pattern
									? ` in '${block.params.file_pattern}'`
									: ""
						}]`
					case "edit":
					case "search_and_replace":
						return `[${block.name} for '${block.params.file_path}']`
					case "search_replace":
						return `[${block.name} for '${block.params.file_path}']`
					case "edit_file":
						return `[${block.name} for '${block.params.file_path}']`
					case "apply_patch":
						return `[${block.name}]`
					case "list_files":
						return `[${block.name} for '${block.params.path}']`
					case "use_mcp_tool":
						return `[${block.name} for '${block.params.server_name}']`
					case "access_mcp_resource":
						return `[${block.name} for '${block.params.server_name}']`
					case "call_mcp_tool_async":
						return `[${block.name} for '${block.params.server_name}/${block.params.tool_name}']`
					case "check_mcp_call_status":
						return `[${block.name} for '${block.params.call_id}']`
					case "wait_for_mcp_call": {
						const ids = block.params.call_ids
						const idsStr = Array.isArray(ids) ? ids.join(", ") : ids
						return `[${block.name} for '${idsStr ?? ""}']`
					}
					case "ask_followup_question":
						return `[${block.name} for '${block.params.question}']`
					case "attempt_completion":
						return `[${block.name}]`
					case "switch_mode":
						return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
					case "set_task_title":
						return `[${block.name} to '${block.params.title}']`
					case "give_feedback":
						return `[${block.name}]`
					case "rag_search":
						return `[${block.name} for '${block.params.query}']`
					case "git_search":
						return `[${block.name} for '${block.params.query}']`
					case "ask_assistant_agent":
						return `[${block.name} for '${block.params.question}']`
					case "lsp_search":
						return `[${block.name} for '${block.params.query}']`
					case "read_command_output":
						return `[${block.name} for '${block.params.artifact_id}']`
					case "update_todo_list":
						return `[${block.name}]`
					case "new_task": {
						const mode = block.params.mode ?? defaultModeSlug
						const message = block.params.message ?? "(no message)"
						const modeName = getModeBySlug(mode, customModes)?.name ?? mode
						return `[${block.name} in ${modeName} mode: '${message}']`
					}
					case "run_slash_command":
						return `[${block.name} for '${block.params.command}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
					case "check_task_status":
						return `[${block.name} for '${block.params.task_id}']`
					case "wait_for_task": {
						const ids = block.params.task_ids
						const idsStr = Array.isArray(ids) ? ids.join(", ") : ids
						return `[${block.name} for '${idsStr ?? ""}']`
					}
					case "cancel_tasks": {
						const ids = block.params.task_ids
						const idsStr = Array.isArray(ids) ? ids.join(", ") : ids
						return `[${block.name} for '${idsStr ?? ""}']`
					}
					case "answer_subtask_question":
						return `[${block.name} for '${block.params.task_id}']`
					case "list_background_tasks":
						return `[${block.name}]`
					case "skills":
						return `[${block.name} for '${block.params.skill}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
					case "generate_image":
						return `[${block.name} for '${block.params.path}']`
					case "get_errors":
						return `[${block.name}]`
					case "get_changed_files":
						return `[${block.name}]`
					case "get_project_setup_info":
						return `[${block.name}]`
					case "read_project_structure":
						return `[${block.name}]`
					case "list_code_usages":
						return `[${block.name} for '${block.params.filePath}']`
					case "fetch_web_page":
						return `[${block.name} for '${block.params.urls}']`
					case "create_directory":
						return `[${block.name} for '${block.params.path}']`
					case "create_new_workspace":
						return `[${block.name} for '${block.params.path}']`
					case "file":
						return `[${block.name} ${block.params.subcommand ?? "?"} '${block.params.path}'${block.params.destination ? ` -> '${block.params.destination}'` : ""}]`
					case "find_files":
						return `[${block.name} for '${block.params.pattern}']`
					case "view_image":
						return `[${block.name} for '${block.params.filePath}']`
					case "insert_edit":
						return `[${block.name} for '${block.params.filePath}']`
					case "rename_symbol":
						return `[${block.name} for '${block.params.filePath}']`
					case "sleep":
						return `[Sleep for ${block.params.seconds || "?"}s]`
					default:
						return `[${block.name}]`
				}
			}

			if (shofer.didRejectTool) {
				// Ignore any tool content after user has rejected tool once.
				// For native tool calling, we must send a tool_result for every tool_use to avoid API errors
				const errorMessage = !block.partial
					? `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`
					: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`

				shofer.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: sanitizeToolUseId(toolCallId),
					content: errorMessage,
					is_error: true,
				})

				break
			}

			// Track if we've already pushed a tool result for this tool call (native tool calling only)
			let hasToolResult = false

			// If this is a native tool call but the parser couldn't construct nativeArgs
			// (e.g., malformed/unfinished JSON in a streaming tool call), we must NOT attempt to
			// execute the tool. Instead, emit exactly one structured tool_result so the provider
			// receives a matching tool_result for the tool_use_id.
			//
			// This avoids executing an invalid tool_use block and prevents duplicate/fragmented
			// error reporting.
			if (!block.partial) {
				const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined
				const isKnownTool = isValidToolName(String(block.name), stateExperiments)
				if (isKnownTool && !block.nativeArgs && !customTool) {
					const errorMessage =
						`Invalid tool call for '${block.name}': missing nativeArgs. ` +
						`This usually means the model streamed invalid or incomplete arguments and the call could not be finalized.`

					shofer.consecutiveMistakeCount++
					try {
						shofer.recordToolError(block.name as ToolName, errorMessage)
					} catch {
						// Best-effort only
					}

					// Push tool_result directly without setting didAlreadyUseTool so streaming can
					// continue gracefully.
					shofer.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: formatResponse.toolError(errorMessage),
						is_error: true,
					})

					break
				}
			}

			// Store approval feedback to merge into tool result (GitHub #10465)
			let approvalFeedback: { text: string; images?: string[] } | undefined

			const pushToolResult = (content: ToolResponse) => {
				// Native tool calling: only allow ONE tool_result per tool call
				if (hasToolResult) {
					outputWarn(
						`[presentAssistantMessage] Skipping duplicate tool_result for tool_use_id: ${toolCallId}`,
					)
					return
				}

				let resultContent: string
				let imageBlocks: Anthropic.ImageBlockParam[] = []

				if (typeof content === "string") {
					resultContent = content || "(tool did not return anything)"
				} else {
					const textBlocks = content.filter((item) => item.type === "text")
					imageBlocks = content.filter((item) => item.type === "image") as Anthropic.ImageBlockParam[]
					resultContent =
						textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
						"(tool did not return anything)"
				}

				// Merge approval feedback into tool result (GitHub #10465)
				if (approvalFeedback) {
					const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
					resultContent = `${feedbackText}\n\n${resultContent}`
					if (approvalFeedback.images) {
						const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
						imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
					}
				}

				shofer.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: sanitizeToolUseId(toolCallId),
					content: resultContent,
				})

				if (imageBlocks.length > 0) {
					shofer.userMessageContent.push(...imageBlocks)
				}

				// Emit tool result to the webview so ChatRow can show an expandable
				// output section beneath the tool invocation block.
				//
				// Suppress for tools whose results are already visible inline in the
				// chat UI (dedicated ChatRow renderers) — showing a redundant "Output"
				// section adds noise without value.
				const TOOLS_WITH_INLINE_RESULT = new Set([
					"attempt_completion",
					"update_todo_list",
					"set_task_title",
					"give_feedback",
					"switch_mode",
					"skills",
					"run_slash_command",
					"ask_assistant_agent",
					"new_task",
					"check_task_status",
					"wait_for_task",
					"list_background_tasks",
					"cancel_tasks",
					"answer_subtask_question",
					"generate_image",
				])

				// Cap output at 2 KB to avoid bloating IPC messages and persisted
				// ui_messages.json with multi-MB grep/file results.
				if (
					resultContent &&
					resultContent !== "(tool did not return anything)" &&
					!TOOLS_WITH_INLINE_RESULT.has(block.name)
				) {
					const MAX_TOOL_RESULT = 2048
					const truncatedOutput =
						resultContent.length > MAX_TOOL_RESULT
							? resultContent.substring(0, MAX_TOOL_RESULT) +
								`\n\n[Output truncated: ${resultContent.length.toLocaleString()} chars total]`
							: resultContent

					shofer.say(
						"tool_result",
						JSON.stringify({
							tool: block.name,
							output: truncatedOutput,
						} satisfies import("@shofer/types").ShoferSayToolResult),
					)
				}

				hasToolResult = true
			}

			const askApproval = async (
				type: ShoferAsk,
				partialMessage?: string,
				progressStatus?: ToolProgressStatus,
				isProtected?: boolean,
			) => {
				const { response, text, images } = await shofer.ask(
					type,
					partialMessage,
					false,
					progressStatus,
					isProtected || false,
				)

				if (response !== "yesButtonClicked") {
					// Handle both messageResponse and noButtonClicked with text.
					if (text) {
						await shofer.say("user_feedback", text, images)
						pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
					} else {
						pushToolResult(formatResponse.toolDenied())
					}
					shofer.didRejectTool = true
					return false
				}

				// Store approval feedback to be merged into tool result (GitHub #10465)
				// Don't push it as a separate tool_result here - that would create duplicates.
				// The tool will call pushToolResult, which will merge the feedback into the actual result.
				if (text) {
					await shofer.say("user_feedback", text, images)
					approvalFeedback = { text, images }
				}

				return true
			}

			const askFinishSubTaskApproval = async () => {
				// Ask the user to approve this task has completed, and he has
				// reviewed it, and we can declare task is finished and return
				// control to the parent task to continue running the rest of
				// the sub-tasks.
				const toolMessage = JSON.stringify({ tool: "finishTask" })
				return await askApproval("tool", toolMessage)
			}

			const handleError = async (action: string, error: Error) => {
				// Silently ignore AskIgnoredError - this is an internal control flow
				// signal, not an actual error. It occurs when a newer ask supersedes an older one.
				if (error instanceof AskIgnoredError) {
					return
				}
				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`

				await shofer.say(
					"error",
					`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
				)

				pushToolResult(formatResponse.toolError(errorString))
			}

			if (!block.partial) {
				// Check if this is a custom tool - if so, record as "custom_tool" (like MCP tools)
				const isCustomTool = stateExperiments?.customTools && customToolRegistry.has(block.name)
				const recordName = isCustomTool ? "custom_tool" : block.name
				shofer.recordToolUsage(recordName)
				TelemetryService.instance.captureToolUsage(shofer.taskId, recordName)

				// Track legacy format usage for read_file tool (for migration monitoring)
				if (block.name === "read_file" && block.usedLegacyFormat) {
					const modelInfo = shofer.api.getModel()
					TelemetryService.instance.captureEvent(TelemetryEventName.READ_FILE_LEGACY_FORMAT_USED, {
						taskId: shofer.taskId,
						model: modelInfo?.id,
					})
				}
			}

			// Validate tool use before execution - ONLY for complete (non-partial) blocks.
			// Validating partial blocks would cause validation errors to be thrown repeatedly
			// during streaming, pushing multiple tool_results for the same tool_use_id and
			// potentially causing the stream to appear frozen.
			if (!block.partial) {
				const modelInfo = shofer.api.getModel()
				// Resolve aliases in includedTools before validation
				// e.g., "edit_file" should resolve to "apply_diff"
				const rawIncludedTools = modelInfo?.info?.includedTools
				const { resolveToolAlias } = await import("../prompts/tools/filter-tools-for-mode")
				const includedTools = rawIncludedTools?.map((tool) => resolveToolAlias(tool))

				try {
					const toolRequirements =
						disabledTools?.reduce(
							(acc: Record<string, boolean>, tool: string) => {
								acc[tool] = false
								const resolvedToolName = resolveToolAlias(tool)
								acc[resolvedToolName] = false
								return acc
							},
							{} as Record<string, boolean>,
						) ?? {}

					validateToolUse(
						block.name as ToolName,
						mode ?? defaultModeSlug,
						customModes ?? [],
						toolRequirements,
						block.params,
						stateExperiments,
						includedTools,
					)
				} catch (error) {
					shofer.consecutiveMistakeCount++
					// For validation errors (unknown tool, tool not allowed for mode), we need to:
					// 1. Send a tool_result with the error (required for native tool calling)
					// 2. NOT set didAlreadyUseTool = true (the tool was never executed, just failed validation)
					// This prevents the stream from being interrupted with "Response interrupted by tool use result"
					// which would cause the extension to appear to hang
					const errMsg = error instanceof Error ? error.message : String(error)
					const errorContent = formatResponse.toolError(errMsg)
					// Push tool_result directly without setting didAlreadyUseTool
					shofer.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: typeof errorContent === "string" ? errorContent : "(validation error)",
						is_error: true,
					})

					break
				}
			}

			// Check for identical consecutive tool calls.
			// new_task is exempt: calling it multiple times in one turn is legitimate fan-out
			// parallelism (models like Claude 3.5+ emit several tool-use blocks simultaneously).
			if (!block.partial && block.name !== "new_task") {
				// Use the detector to check for repetition, passing the ToolUse
				// block directly.
				const repetitionCheck = shofer.toolRepetitionDetector.check(block)

				// If execution is not allowed, notify user and break.
				if (!repetitionCheck.allowExecution && repetitionCheck.askUser) {
					// Handle repetition similar to mistake_limit_reached pattern.
					const { response, text, images } = await shofer.ask(
						repetitionCheck.askUser.messageKey as ShoferAsk,
						repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
					)

					if (response === "messageResponse") {
						// Add user feedback to userContent.
						shofer.userMessageContent.push(
							{
								type: "text" as const,
								text: `Tool repetition limit reached. User feedback: ${text}`,
							},
							...formatResponse.imageBlocks(images),
						)

						// Add user feedback to chat.
						await shofer.say("user_feedback", text, images)
					}

					// Track tool repetition in telemetry via PostHog exception tracking and event.
					TelemetryService.instance.captureConsecutiveMistakeError(shofer.taskId)
					TelemetryService.instance.captureException(
						new ConsecutiveMistakeError(
							`Tool repetition limit reached for ${block.name}`,
							shofer.taskId,
							shofer.consecutiveMistakeCount,
							shofer.consecutiveMistakeLimit,
							"tool_repetition",
							shofer.apiConfiguration.apiProvider,
							shofer.api.getModel().id,
						),
					)

					// Return tool result message about the repetition
					pushToolResult(
						formatResponse.toolError(
							`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
						),
					)
					break
				}
			}

			switch (block.name) {
				case "write_to_file":
					await checkpointSaveAndMark(shofer)
					await writeToFileTool.handle(shofer, block as ToolUse<"write_to_file">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "update_todo_list":
					await updateTodoListTool.handle(shofer, block as ToolUse<"update_todo_list">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "apply_diff":
					await checkpointSaveAndMark(shofer)
					await applyDiffToolClass.handle(shofer, block as ToolUse<"apply_diff">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "edit":
				case "search_and_replace":
					await checkpointSaveAndMark(shofer)
					await editTool.handle(shofer, block as ToolUse<"edit">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "search_replace":
					await checkpointSaveAndMark(shofer)
					await searchReplaceTool.handle(shofer, block as ToolUse<"search_replace">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "edit_file":
					await checkpointSaveAndMark(shofer)
					await editFileTool.handle(shofer, block as ToolUse<"edit_file">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "apply_patch":
					await checkpointSaveAndMark(shofer)
					await applyPatchTool.handle(shofer, block as ToolUse<"apply_patch">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "read_file":
					// Type assertion is safe here because we're in the "read_file" case
					await readFileTool.handle(shofer, block as ToolUse<"read_file">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "list_files":
					await listFilesTool.handle(shofer, block as ToolUse<"list_files">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "rag_search":
					await ragSearchTool.handle(shofer, block as ToolUse<"rag_search">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "git_search":
					await gitSearchTool.handle(shofer, block as ToolUse<"git_search">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "ask_assistant_agent":
					await askAssistantAgentTool.handle(shofer, block as ToolUse<"ask_assistant_agent">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "lsp_search":
					await lspSearchTool.handle(shofer, block as ToolUse<"lsp_search">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "grep_search":
					await grepSearchTool.handle(shofer, block as ToolUse<"grep_search">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "execute_command":
					await executeCommandTool.handle(shofer, block as ToolUse<"execute_command">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "read_command_output":
					await readCommandOutputTool.handle(shofer, block as ToolUse<"read_command_output">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "use_mcp_tool":
					await useMcpToolTool.handle(shofer, block as ToolUse<"use_mcp_tool">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "access_mcp_resource":
					await accessMcpResourceTool.handle(shofer, block as ToolUse<"access_mcp_resource">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "ask_followup_question":
					await askFollowupQuestionTool.handle(shofer, block as ToolUse<"ask_followup_question">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "switch_mode":
					await switchModeTool.handle(shofer, block as ToolUse<"switch_mode">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "set_task_title":
					await setTaskTitleTool.handle(shofer, block as ToolUse<"set_task_title">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "give_feedback":
					await giveFeedbackTool.handle(shofer, block as ToolUse<"give_feedback">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "new_task":
					await checkpointSaveAndMark(shofer)
					await newTaskTool.handle(shofer, block as ToolUse<"new_task">, {
						askApproval,
						handleError,
						pushToolResult,
						toolCallId: block.id,
					})
					break
				case "attempt_completion": {
					// CRITICAL: Prevent duplicate attempt_completion execution when LLM generates
					// multiple attempt_completion calls in a single response (common after delegation).
					// Only execute the FIRST attempt_completion and skip subsequent ones.
					if (shofer.didExecuteAttemptCompletion) {
						outputLog(
							`[presentAssistantMessage] Skipping duplicate attempt_completion (tool_use_id: ${toolCallId})`,
						)
						pushToolResult(
							formatResponse.toolError(
								"Skipped duplicate attempt_completion. Only one attempt_completion is allowed per response.",
							),
						)
						break
					}

					// Mark that we're executing attempt_completion to prevent duplicates
					shofer.didExecuteAttemptCompletion = true

					const completionCallbacks: AttemptCompletionCallbacks = {
						askApproval,
						handleError,
						pushToolResult,
						askFinishSubTaskApproval,
						toolDescription,
					}
					await attemptCompletionTool.handle(
						shofer,
						block as ToolUse<"attempt_completion">,
						completionCallbacks,
					)
					break
				}
				case "run_slash_command":
					await runSlashCommandTool.handle(shofer, block as ToolUse<"run_slash_command">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "check_task_status":
					await checkTaskStatusTool.handle(shofer, block as ToolUse<"check_task_status">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "wait_for_task":
					await waitForTaskTool.handle(shofer, block as ToolUse<"wait_for_task">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "list_background_tasks":
					await listBackgroundTasksTool.handle(shofer, block as ToolUse<"list_background_tasks">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "cancel_tasks":
					await cancelTasksTool.handle(shofer, block as ToolUse<"cancel_tasks">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "answer_subtask_question":
					await answerSubtaskQuestionTool.handle(shofer, block as ToolUse<"answer_subtask_question">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "call_mcp_tool_async":
					await callMcpToolAsyncTool.handle(shofer, block as ToolUse<"call_mcp_tool_async">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "check_mcp_call_status":
					await checkMcpCallStatusTool.handle(shofer, block as ToolUse<"check_mcp_call_status">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "wait_for_mcp_call":
					await waitForMcpCallTool.handle(shofer, block as ToolUse<"wait_for_mcp_call">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "skills":
					await skillsTool.handle(shofer, block as ToolUse<"skills">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "generate_image":
					await checkpointSaveAndMark(shofer)
					await generateImageTool.handle(shofer, block as ToolUse<"generate_image">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "create_directory":
					await checkpointSaveAndMark(shofer)
					await createDirectoryTool.handle(shofer, block as ToolUse<"create_directory">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "create_new_workspace":
					await createNewWorkspaceTool.handle(shofer, block as ToolUse<"create_new_workspace">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "file":
					await checkpointSaveAndMark(shofer)
					await fileTool.handle(shofer, block as ToolUse<"file">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "fetch_web_page":
					await fetchWebPageTool.handle(shofer, block as ToolUse<"fetch_web_page">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "find_files":
					await findFilesTool.handle(shofer, block as ToolUse<"find_files">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "get_errors":
					await getErrorsTool.handle(shofer, block as ToolUse<"get_errors">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "get_changed_files":
					await getChangedFilesTool.handle(shofer, block as ToolUse<"get_changed_files">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "get_project_setup_info":
					await getProjectSetupInfoTool.handle(shofer, block as ToolUse<"get_project_setup_info">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "insert_edit":
					await checkpointSaveAndMark(shofer)
					await insertEditTool.handle(shofer, block as ToolUse<"insert_edit">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "sed":
					await checkpointSaveAndMark(shofer)
					await sedTool.handle(shofer, block as ToolUse<"sed">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "list_code_usages":
					await listCodeUsagesTool.handle(shofer, block as ToolUse<"list_code_usages">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "read_project_structure":
					await readProjectStructureTool.handle(shofer, block as ToolUse<"read_project_structure">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "rename_symbol":
					await checkpointSaveAndMark(shofer)
					await renameSymbolTool.handle(shofer, block as ToolUse<"rename_symbol">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "view_image":
					await viewImageTool.handle(shofer, block as ToolUse<"view_image">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				case "sleep":
					await sleepTool.handle(shofer, block as ToolUse<"sleep">, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				default: {
					// Handle unknown/invalid tool names OR custom tools
					// This is critical for native tool calling where every tool_use MUST have a tool_result

					// CRITICAL: Don't process partial blocks for unknown tools - just let them stream in.
					// If we try to show errors for partial blocks, we'd show the error on every streaming chunk,
					// creating a loop that appears to freeze the extension. Only handle complete blocks.
					if (block.partial) {
						break
					}

					const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined

					if (customTool) {
						try {
							let customToolArgs

							if (customTool.parameters) {
								try {
									customToolArgs = customTool.parameters.parse(block.nativeArgs || block.params || {})
								} catch (parseParamsError) {
									const errMsg =
										parseParamsError instanceof Error
											? parseParamsError.message
											: String(parseParamsError)
									const message = `Custom tool "${block.name}" argument validation failed: ${errMsg}`
									outputError(message)
									shofer.consecutiveMistakeCount++
									await shofer.say("error", message)
									pushToolResult(formatResponse.toolError(message))
									break
								}
							}

							const result = await customTool.execute(customToolArgs, {
								mode: mode ?? defaultModeSlug,
								task: shofer,
							})

							outputLog(
								`${customTool.name}.execute(): ${JSON.stringify(customToolArgs)} -> ${JSON.stringify(result)}`,
							)

							pushToolResult(result)
							shofer.consecutiveMistakeCount = 0
						} catch (executionError: any) {
							shofer.consecutiveMistakeCount++
							// Record custom tool error with static name
							shofer.recordToolError("custom_tool", executionError.message)
							await handleError(`executing custom tool "${block.name}"`, executionError)
						}

						break
					}

					// Check if this is a tool from a private provider
					// (registered via shofer.privateToolProviders config).
					if (isPrivateLmTool(block.name)) {
						const invokeCommand = getPrivateToolInvokeCommand(block.name)
						if (!invokeCommand) {
							// Provider lost between build and execution — fall through to unknown tool.
						} else {
							const toolInput = (block.nativeArgs || block.params || {}) as Record<string, unknown>
							const askPayload = JSON.stringify({
								type: "use_mcp_tool",
								serverName: "extension-tools",
								toolName: block.name,
								arguments: JSON.stringify(toolInput),
								external_lm_tool: true,
							})

							const didApprove = await askApproval("use_mcp_server", askPayload)
							if (!didApprove) {
								break
							}

							try {
								shofer.consecutiveMistakeCount = 0
								await shofer.say("mcp_server_request_started")

								const result = await vscode.commands.executeCommand<{
									content: string
									is_error?: boolean
								}>(invokeCommand, block.name, toolInput)

								const resultText = result?.content ?? "(tool returned empty result)"
								await shofer.say("mcp_server_response", resultText)
								pushToolResult(result.is_error ? formatResponse.toolError(resultText) : resultText)
							} catch (execError: any) {
								shofer.consecutiveMistakeCount++
								await handleError(
									`executing private tool "${block.name}"`,
									execError instanceof Error ? execError : new Error(String(execError)),
								)
							}
							break
						}
					}

					// Not a custom tool or private tool — handle as unknown tool error
					const errorMessage = `Unknown tool "${block.name}". This tool does not exist. Please use one of the available tools.`
					shofer.consecutiveMistakeCount++
					shofer.recordToolError(block.name as ToolName, errorMessage)
					await shofer.say("error", t("tools:unknownToolError", { toolName: block.name }))
					// Push tool_result directly WITHOUT setting didAlreadyUseTool
					// This prevents the stream from being interrupted with "Response interrupted by tool use result"
					shofer.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: formatResponse.toolError(errorMessage),
						is_error: true,
					})
					break
				}
			}

			break
		}
	}

	// Seeing out of bounds is fine, it means that the next too call is being
	// built up and ready to add to assistantMessageContent to present.
	// When you see the UI inactive during this, it means that a tool is
	// breaking without presenting any UI. For example the write_to_file tool
	// was breaking when relpath was undefined, and for invalid relpath it never
	// presented UI.
	// This needs to be placed here, if not then calling
	// shofer.presentAssistantMessage below would fail (sometimes) since it's
	// locked.
	shofer.presentAssistantMessageLocked = false

	// NOTE: When tool is rejected, iterator stream is interrupted and it waits
	// for `userMessageContentReady` to be true. Future calls to present will
	// skip execution since `didRejectTool` and iterate until `contentIndex` is
	// set to message length and it sets userMessageContentReady to true itself
	// (instead of preemptively doing it in iterator).
	if (!block.partial || shofer.didRejectTool || shofer.didAlreadyUseTool) {
		// Block is finished streaming and executing.
		if (shofer.currentStreamingContentIndex === shofer.assistantMessageContent.length - 1) {
			// It's okay that we increment if !didCompleteReadingStream, it'll
			// just return because out of bounds and as streaming continues it
			// will call `presentAssitantMessage` if a new block is ready. If
			// streaming is finished then we set `userMessageContentReady` to
			// true when out of bounds. This gracefully allows the stream to
			// continue on and all potential content blocks be presented.
			// Last block is complete and it is finished executing
			shofer.userMessageContentReady = true // Will allow `pWaitFor` to continue.
		}

		// Call next block if it exists (if not then read stream will call it
		// when it's ready).
		// Need to increment regardless, so when read stream calls this function
		// again it will be streaming the next block.
		shofer.currentStreamingContentIndex++

		if (shofer.currentStreamingContentIndex < shofer.assistantMessageContent.length) {
			// There are already more content blocks to stream, so we'll call
			// this function ourselves.
			presentAssistantMessage(shofer)
			return
		} else {
			// CRITICAL FIX: If we're out of bounds and the stream is complete, set userMessageContentReady
			// This handles the case where assistantMessageContent is empty or becomes empty after processing
			if (shofer.didCompleteReadingStream) {
				shofer.userMessageContentReady = true
			}
		}
	}

	// Block is partial, but the read stream may have finished.
	if (shofer.presentAssistantMessageHasPendingUpdates) {
		presentAssistantMessage(shofer)
	}
}

/**
 * save checkpoint and mark done in the current streaming task.
 * @param task The Task instance to checkpoint save and mark.
 * @returns
 */
async function checkpointSaveAndMark(task: Task) {
	if (task.currentStreamingDidCheckpoint) {
		return
	}
	try {
		await task.checkpointSave(true)
		task.currentStreamingDidCheckpoint = true
	} catch (error) {
		outputError(
			`[Task#presentAssistantMessage] Error saving checkpoint: ${error instanceof Error ? error.message : String(error)}`,
			error,
		)
	}
}
