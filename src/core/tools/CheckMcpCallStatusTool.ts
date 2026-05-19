import type { ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { processMcpToolContent } from "./mcp/use-mcp-shared"

interface CheckMcpCallStatusParams {
	call_id: string
}

export class CheckMcpCallStatusTool extends BaseTool<"check_mcp_call_status"> {
	readonly name = "check_mcp_call_status" as const

	async execute(params: CheckMcpCallStatusParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks

		try {
			if (!params.call_id) {
				task.consecutiveMistakeCount++
				task.recordToolError("check_mcp_call_status")
				pushToolResult(await task.sayAndCreateMissingParamError("check_mcp_call_status", "call_id"))
				return
			}

			const handle = task.mcpAsyncCalls.get(params.call_id)

			if (!handle) {
				pushToolResult(
					formatResponse.toolResult(
						JSON.stringify({
							call_id: params.call_id,
							status: "not_found",
							error: `No async MCP call found with id: ${params.call_id}`,
						}),
					),
				)
				return
			}

			const { callId, serverName, toolName, status, result, error } = handle

			if (status === "running") {
				pushToolResult(
					formatResponse.toolResult(
						JSON.stringify({ call_id: callId, server_name: serverName, tool_name: toolName, status }),
					),
				)
				return
			}

			if (status === "completed" && result) {
				const shaped = processMcpToolContent(result)
				const resultText =
					(result.isError ? "Error:\n" : "") +
					(shaped.text || (shaped.images.length > 0 ? `[${shaped.images.length} image(s) received]` : ""))
				pushToolResult(
					formatResponse.toolResult(
						JSON.stringify({
							call_id: callId,
							server_name: serverName,
							tool_name: toolName,
							status,
							result: resultText,
							images: shaped.images.length > 0 ? shaped.images : undefined,
						}),
						shaped.images,
					),
				)
				// Delete-on-read: settled handle has been observed exactly once and
				// returned to the agent; release it from the per-task map to bound memory.
				task.mcpAsyncCalls.delete(callId)
				return
			}

			if (status === "error") {
				pushToolResult(
					formatResponse.toolResult(
						JSON.stringify({
							call_id: callId,
							server_name: serverName,
							tool_name: toolName,
							status,
							error,
						}),
					),
				)
				task.mcpAsyncCalls.delete(callId)
				return
			}

			if (status === "cancelled") {
				pushToolResult(
					formatResponse.toolResult(
						JSON.stringify({
							call_id: callId,
							server_name: serverName,
							tool_name: toolName,
							status,
						}),
					),
				)
				task.mcpAsyncCalls.delete(callId)
				return
			}

			pushToolResult(
				formatResponse.toolResult(
					JSON.stringify({ call_id: callId, server_name: serverName, tool_name: toolName, status }),
				),
			)
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err)
			pushToolResult(formatResponse.toolError(error))
		}
	}
}

export const checkMcpCallStatusTool = new CheckMcpCallStatusTool()
