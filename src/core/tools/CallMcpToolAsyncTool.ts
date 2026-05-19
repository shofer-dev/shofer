import type { ShoferAskUseMcpServer } from "@shofer/types"

import { Task, type McpAsyncCallHandle } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { validateMcpToolExists, runMcpToolCall } from "./mcp/use-mcp-shared"

interface CallMcpToolAsyncParams {
	server_name: string
	tool_name: string
	arguments?: Record<string, unknown>
	source?: "global" | "project"
}

export class CallMcpToolAsyncTool extends BaseTool<"call_mcp_tool_async"> {
	readonly name = "call_mcp_tool_async" as const

	async execute(params: CallMcpToolAsyncParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!params.server_name) {
				task.consecutiveMistakeCount++
				task.recordToolError("call_mcp_tool_async")
				pushToolResult(await task.sayAndCreateMissingParamError("call_mcp_tool_async", "server_name"))
				return
			}
			if (!params.tool_name) {
				task.consecutiveMistakeCount++
				task.recordToolError("call_mcp_tool_async")
				pushToolResult(await task.sayAndCreateMissingParamError("call_mcp_tool_async", "tool_name"))
				return
			}

			const serverName = params.server_name
			const toolName = params.tool_name

			// Validate that the tool exists on the server (delegates to shared helper)
			const toolValidation = await validateMcpToolExists(
				task,
				serverName,
				toolName,
				pushToolResult,
				"call_mcp_tool_async",
			)
			if (!toolValidation.isValid) {
				return
			}

			const resolvedToolName = toolValidation.resolvedToolName ?? toolName
			task.consecutiveMistakeCount = 0

			// Approval: same gate as use_mcp_tool (gated by alwaysAllowMcp + per-tool approval).
			// The `async: true` flag lets the chat UI distinguish fire-and-forget invocations.
			const completeMessage = JSON.stringify({
				type: "use_mcp_tool",
				serverName,
				toolName: resolvedToolName,
				arguments: params.arguments ? JSON.stringify(params.arguments) : undefined,
				async: true,
			} satisfies ShoferAskUseMcpServer)

			const didApprove = await askApproval("use_mcp_server", completeMessage)
			if (!didApprove) {
				return
			}

			// Generate call ID
			const callId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
			const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()

			// Create AbortController
			const abortController = new AbortController()

			// Fire the MCP tool call WITHOUT awaiting
			const mcpPromise = runMcpToolCall(task, {
				serverName,
				toolName: resolvedToolName,
				args: params.arguments,
				source: params.source,
				executionId,
				signal: abortController.signal,
			})

			// Create handle and store on Task
			const handle: McpAsyncCallHandle = {
				callId,
				serverName,
				toolName: resolvedToolName,
				status: "running",
				promise: mcpPromise,
				abortController,
				createdAt: Date.now(),
			}

			task.mcpAsyncCalls.set(callId, handle)

			// Attach finalizer: update status when the promise settles.
			// The handle is canonical state; ignore late settles after an external
			// abort flipped status to "cancelled" (see Task.abortTask).
			mcpPromise
				.then((result) => {
					if (handle.status !== "running") return
					if (result) {
						handle.status = "completed"
						handle.result = result
					} else {
						handle.status = "error"
						handle.error = "MCP server returned no response"
					}
				})
				.catch((err) => {
					if (handle.status !== "running") return
					handle.status = "error"
					handle.error = err instanceof Error ? err.message : String(err)
				})

			pushToolResult(
				formatResponse.toolResult(
					JSON.stringify({
						call_id: callId,
						server_name: serverName,
						tool_name: resolvedToolName,
						status: "running",
					}),
				),
			)
		} catch (error) {
			await handleError("executing async MCP tool", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"call_mcp_tool_async">): Promise<void> {
		const params = block.params
		const partialMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: params.server_name ?? "",
			toolName: params.tool_name ?? "",
			arguments: params.arguments,
			async: true,
		} satisfies ShoferAskUseMcpServer)

		await task.ask("use_mcp_server", partialMessage, true).catch(() => {})
	}
}

export const callMcpToolAsyncTool = new CallMcpToolAsyncTool()
