import type { McpExecutionStatus, McpToolCallResponse, ShoferAskUseMcpServer, ToolName } from "@shofer/types"

import type { Task } from "../../task/Task.js"
import { type TaskProviderLike } from "../../task-provider/index.js"
import { formatResponse } from "../../prompts/responses.js"
import { t } from "../../i18n/index.js"
import { toolNamesMatch } from "../../utils/mcp-name.js"
import { mcpLog } from "../../logging/subsystems.js"

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
 * pushes error messages). The `callingToolName` parameter is the native tool
 * whose execution triggered this validation; it is forwarded to
 * `task.recordToolError` so per-tool error accounting stays accurate.
 */
export async function validateMcpToolExists(
	task: Task,
	serverName: string,
	toolName: string,
	pushToolResult: (content: string) => void,
	callingToolName: ToolName = "use_mcp_tool",
): Promise<McpToolValidationResult> {
	try {
		const provider = task.providerRef.deref() as TaskProviderLike | undefined
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
			task.recordToolError(callingToolName)
			await task.say("error", t("mcp:errors.serverNotFound", { serverName, availableServers }))
			task.didToolFailInCurrentTurn = true

			pushToolResult(formatResponse.unknownMcpServerError(serverName, availableServersArray))
			return { isValid: false, availableTools: [] }
		}

		if (!server.tools || server.tools.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError(callingToolName)
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
			task.recordToolError(callingToolName)
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
			task.recordToolError(callingToolName)
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
		mcpLog.error("Error validating MCP tool existence:", error)
		return { isValid: true }
	}
}

/**
 * Builds the `use_mcp_server` approval envelope for an MCP tool call.
 *
 * The single point at which a call's arguments are serialized for approval, and
 * deliberately so: the approval path resolves a verb-multiplexing tool's group
 * from the `operation` inside this string (`getMcpToolGroup`), so the string has
 * to be a serialization of the SAME object the call executes with. Both call
 * sites — `use_mcp_tool` and `call_mcp_tool_async` — pass one variable to this
 * helper and to `runMcpToolCall`, which is what makes "the verb that is gated is
 * the verb that runs" a property of the code rather than a convention.
 *
 * `arguments` is omitted (not empty-stringed) when the call carries none, so a
 * reader can tell "no arguments" from "lost".
 */
export function mcpApprovalEnvelope({
	serverName,
	toolName,
	args,
	async: isAsync,
}: {
	serverName: string
	toolName: string
	args?: Record<string, unknown>
	async?: boolean
}): string {
	return JSON.stringify({
		type: "use_mcp_tool",
		serverName,
		toolName,
		arguments: args ? JSON.stringify(args) : undefined,
		...(isAsync ? { async: true } : {}),
	} satisfies ShoferAskUseMcpServer)
}

/**
 * Default cap on the byte size of an MCP tool response text returned to
 * the LLM. Override per-task via the `shoferMcpMaxResponseBytes` setting
 * surfaced by `Task.getMcpMaxResponseBytes()`. See §4.7 of
 * `docs/mem-utilization-profiling.md`.
 */
export const DEFAULT_MCP_MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * Shared helper — shapes raw MCP tool response content into displayable
 * text and image data URLs. Used by both synchronous and async paths.
 *
 * When `maxBytes > 0` and the joined text exceeds the cap, the text is
 * truncated to roughly that many bytes (counted as UTF-8) and a
 * `[shofer: MCP response truncated …]` banner is appended so the agent
 * sees that the cut-off happened. A `maxBytes` of `0` disables truncation.
 */
export function processMcpToolContent(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	toolResult: any,
	maxBytes: number = DEFAULT_MCP_MAX_RESPONSE_BYTES,
): { text: string; images: string[] } {
	if (!toolResult?.content || toolResult.content.length === 0) {
		return { text: "", images: [] }
	}

	const images: string[] = []

	const textContent = toolResult.content
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

	if (maxBytes > 0) {
		const originalBytes = Buffer.byteLength(textContent, "utf8")
		if (originalBytes > maxBytes) {
			// Trim along UTF-8 boundaries: take the first `maxBytes` bytes,
			// re-decode, and strip any trailing U+FFFD replacement chars that
			// Node inserts when the byte window splits a multi-byte codepoint.
			// This avoids emitting broken sequences the LLM has to parse.
			const buf = Buffer.from(textContent, "utf8")
			const truncated = buf
				.subarray(0, maxBytes)
				.toString("utf8")
				.replace(/\uFFFD+$/, "")
			const banner = `\n\n[shofer: MCP response truncated from ${originalBytes} bytes to ${Buffer.byteLength(truncated, "utf8")} bytes — increase \`shoferMcpMaxResponseBytes\` to see more]`
			return { text: truncated + banner, images }
		}
	}

	return { text: textContent, images }
}

/**
 * Shared helper — runs an MCP tool call through the hub, streaming execution
 * status to the webview. Returns the raw tool response for the caller to shape
 * via {@link processMcpToolContent}.
 *
 * The `signal` parameter is optional; when provided it supports cooperative
 * cancellation (passed through to `McpHub.callTool`).
 *
 * `toolCallId` is the provider's own id for the tool call being executed, taken
 * from the native tool-call block and passed through UNMODIFIED — see
 * `McpHub.callTool`. It is absent for any invocation that did not come from a
 * provider tool call.
 */
export async function runMcpToolCall(
	task: Task,
	opts: {
		serverName: string
		toolName: string
		args?: Record<string, unknown>
		source?: "global" | "project"
		executionId: string
		toolCallId?: string
		signal?: AbortSignal
	},
): Promise<McpToolCallResponse | undefined> {
	const { serverName, toolName, args, source, executionId, toolCallId, signal } = opts

	await task.say("mcp_server_request_started")

	// Send started status
	await sendExecutionStatus(task, {
		executionId,
		status: "started",
		serverName,
		toolName,
	})

	// Pass task.taskId as taskId so mcp-server can track the conversation, and
	// the provider's tool-call id so it can identify the individual call.
	const toolResult = await (task.providerRef.deref() as TaskProviderLike | undefined)
		?.getMcpHub()
		?.callTool(serverName, toolName, args, source, task.taskId, toolCallId, signal ?? task.abortSignal)

	let toolResultPretty = "(No response)"
	let images: string[] = []

	if (toolResult) {
		const { text: outputText, images: extractedImages } = processMcpToolContent(
			toolResult,
			task.getMcpMaxResponseBytes?.(),
		)
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
	const clineProvider = task.providerRef.deref() as TaskProviderLike | undefined
	clineProvider?.postMessageToWebview({
		type: "mcpExecutionStatus",
		text: JSON.stringify(status),
	})
}
