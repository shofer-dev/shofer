import type { McpExecutionStatus, McpToolCallResponse } from "@shofer/types"

import type { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { t } from "../../../i18n"
import { toolNamesMatch } from "../../../utils/mcp-name"
import { outputError } from "../../../utils/outputChannelLogger"

/**
 * Result of MCP tool existence validation.
 */
export interface McpToolValidationResult {
	isValid: boolean
	resolvedToolName?: string
	availableTools?: string[]
}

/**
 * Shared helper — validates that an MCP server and tool exist, the server has
 * available tools, and the tool is not disabled. Used by both the synchronous
 * `use_mcp_tool` path and the async `call_mcp_tool_async` path.
 *
 * Mutates `task` state on validation failure (increments mistake counters,
 * pushes error messages).
 */
export async function validateMcpToolExists(
	task: Task,
	serverName: string,
	toolName: string,
	pushToolResult: (content: string) => void,
): Promise<McpToolValidationResult> {
	try {
		const provider = task.providerRef.deref()
		const mcpHub = provider?.getMcpHub()

		if (!mcpHub) {
			return { isValid: true }
		}

		const servers = mcpHub.getAllServers()
		const server = servers.find((s) => s.name === serverName)

		if (!server) {
			const availableServersArray = servers.map((s) => s.name)
			const availableServers =
				availableServersArray.length > 0 ? availableServersArray.join(", ") : "No servers available"

			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			await task.say("error", t("mcp:errors.serverNotFound", { serverName, availableServers }))
			task.didToolFailInCurrentTurn = true

			pushToolResult(formatResponse.unknownMcpServerError(serverName, availableServersArray))
			return { isValid: false, availableTools: [] }
		}

		if (!server.tools || server.tools.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			await task.say(
				"error",
				t("mcp:errors.toolNotFound", {
					toolName,
					serverName,
					availableTools: "No tools available",
				}),
			)
			task.didToolFailInCurrentTurn = true

			pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, []))
			return { isValid: false, availableTools: [] }
		}

		const tool = server.tools.find((t) => toolNamesMatch(t.name, toolName))

		if (!tool) {
			const availableToolNames = server.tools.map((t) => t.name)

			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			await task.say(
				"error",
				t("mcp:errors.toolNotFound", {
					toolName,
					serverName,
					availableTools: availableToolNames.join(", "),
				}),
			)
			task.didToolFailInCurrentTurn = true

			pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, availableToolNames))
			return { isValid: false, availableTools: availableToolNames }
		}

		if (tool.enabledForPrompt === false) {
			const enabledTools = server.tools.filter((t) => t.enabledForPrompt !== false)
			const enabledToolNames = enabledTools.map((t) => t.name)

			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			await task.say(
				"error",
				t("mcp:errors.toolDisabled", {
					toolName,
					serverName,
					availableTools:
						enabledToolNames.length > 0 ? enabledToolNames.join(", ") : "No enabled tools available",
				}),
			)
			task.didToolFailInCurrentTurn = true

			pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, enabledToolNames))
			return { isValid: false, availableTools: enabledToolNames }
		}

		return { isValid: true, availableTools: server.tools.map((t) => t.name), resolvedToolName: tool.name }
	} catch (error) {
		outputError("Error validating MCP tool existence:", error)
		return { isValid: true }
	}
}

/**
 * Shared helper — shapes raw MCP tool response content into displayable
 * text and image data URLs. Used by both synchronous and async paths.
 */
export function processMcpToolContent(toolResult: any): { text: string; images: string[] } {
	if (!toolResult?.content || toolResult.content.length === 0) {
		return { text: "", images: [] }
	}

	const images: string[] = []

	const textContent = toolResult.content
		.map((item: any) => {
			if (item.type === "text") {
				return item.text
			}
			if (item.type === "resource") {
				const { blob: _, ...rest } = item.resource
				return JSON.stringify(rest, null, 2)
			}
			if (item.type === "image") {
				if (item.mimeType && item.data) {
					if (item.data.startsWith("data:")) {
						images.push(item.data)
					} else {
						images.push(`data:${item.mimeType};base64,${item.data}`)
					}
				}
				return ""
			}
			return ""
		})
		.filter(Boolean)
		.join("\n\n")

	return { text: textContent, images }
}

/**
 * Shared helper — runs an MCP tool call through the hub, streaming execution
 * status to the webview. Returns the raw tool response for the caller to shape
 * via {@link processMcpToolContent}.
 *
 * The `signal` parameter is optional; when provided it supports cooperative
 * cancellation (passed through to `McpHub.callTool`).
 */
export async function runMcpToolCall(
	task: Task,
	opts: {
		serverName: string
		toolName: string
		args?: Record<string, unknown>
		executionId: string
		signal?: AbortSignal
	},
): Promise<McpToolCallResponse | undefined> {
	const { serverName, toolName, args, executionId, signal } = opts

	await task.say("mcp_server_request_started")

	// Send started status
	await sendExecutionStatus(task, {
		executionId,
		status: "started",
		serverName,
		toolName,
	})

	// Pass task.taskId as conversationId so mcp-server can track the conversation
	const toolResult = await task.providerRef
		.deref()
		?.getMcpHub()
		?.callTool(serverName, toolName, args, undefined, task.taskId, signal ?? task.abortSignal)

	let toolResultPretty = "(No response)"
	let images: string[] = []

	if (toolResult) {
		const { text: outputText, images: extractedImages } = processMcpToolContent(toolResult)
		images = extractedImages

		if (outputText || images.length > 0) {
			await sendExecutionStatus(task, {
				executionId,
				status: "output",
				response: outputText || (images.length > 0 ? `[${images.length} image(s)]` : ""),
			})

			toolResultPretty =
				(toolResult.isError ? "Error:\n" : "") +
				(outputText || (images.length > 0 ? `[${images.length} image(s) received]` : ""))
		}

		await sendExecutionStatus(task, {
			executionId,
			status: toolResult.isError ? "error" : "completed",
			response: toolResultPretty,
			error: toolResult.isError ? "Error executing MCP tool" : undefined,
		})
	} else {
		await sendExecutionStatus(task, {
			executionId,
			status: "error",
			error: "No response from MCP server",
		})
	}

	await task.say("mcp_server_response", toolResultPretty, images)

	return toolResult
}

/**
 * Posts an MCP execution status update to the webview.
 */
async function sendExecutionStatus(task: Task, status: McpExecutionStatus): Promise<void> {
	const clineProvider = task.providerRef.deref()
	clineProvider?.postMessageToWebview({
		type: "mcpExecutionStatus",
		text: JSON.stringify(status),
	})
}
