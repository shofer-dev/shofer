import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { processMcpToolContent } from "./mcp/use-mcp-shared"

interface WaitForMcpCallParams {
	call_ids: string[]
	wait?: "all" | "any"
	timeout?: number
}

export class WaitForMcpCallTool extends BaseTool<"wait_for_mcp_call"> {
	readonly name = "wait_for_mcp_call" as const

	async execute(params: WaitForMcpCallParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks

		try {
			if (!params.call_ids || params.call_ids.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("wait_for_mcp_call")
				pushToolResult(await task.sayAndCreateMissingParamError("wait_for_mcp_call", "call_ids"))
				return
			}

			const waitStrategy: "all" | "any" = params.wait ?? "all"
			const timeoutMs = (params.timeout ?? 120) * 1000

			// Collect handles
			const handles = params.call_ids.map((id) => task.mcpAsyncCalls.get(id)).filter(Boolean) as NonNullable<
				ReturnType<typeof task.mcpAsyncCalls.get>
			>[]

			if (handles.length === 0) {
				pushToolResult(
					formatResponse.toolResult(
						JSON.stringify({
							error: "None of the provided call_ids correspond to known async MCP calls",
							call_ids: params.call_ids,
						}),
					),
				)
				return
			}

			// Build a promise that resolves based on the wait strategy
			const promises = handles.map((h) =>
				h.promise
					.then((result) => ({
						callId: h.callId,
						serverName: h.serverName,
						toolName: h.toolName,
						result,
						status: "completed" as const,
					}))
					.catch((err) => ({
						callId: h.callId,
						serverName: h.serverName,
						toolName: h.toolName,
						error: err instanceof Error ? err.message : String(err),
						status: "error" as const,
					})),
			)

			let resolvedResults: Array<{
				callId: string
				serverName: string
				toolName: string
				result?: any
				error?: string
				status: "completed" | "error"
			}>

			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Timed out after ${params.timeout ?? 120}s`)), timeoutMs),
			)

			if (waitStrategy === "any") {
				const result = await Promise.race([Promise.race(promises), timeoutPromise])
				resolvedResults = [result]
			} else {
				resolvedResults = await Promise.race([Promise.all(promises), timeoutPromise])
			}

			// Shape results
			const output = resolvedResults.map((r) => {
				let resultText = ""
				let images: string[] = []

				if (r.result) {
					const shaped = processMcpToolContent(r.result)
					resultText =
						(r.result.isError ? "Error:\n" : "") +
						(shaped.text || (shaped.images.length > 0 ? `[${shaped.images.length} image(s) received]` : ""))
					images = shaped.images
				}

				return {
					call_id: r.callId,
					server_name: r.serverName,
					tool_name: r.toolName,
					status: r.status,
					result: resultText,
					error: r.error,
					images: images.length > 0 ? images : undefined,
				}
			})

			const allImages = output.flatMap((o) => o.images ?? [])

			pushToolResult(formatResponse.toolResult(JSON.stringify(output, null, 2), allImages))
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err)
			pushToolResult(
				formatResponse.toolResult(
					JSON.stringify({
						error,
						call_ids: params.call_ids,
					}),
				),
			)
		}
	}
}

export const waitForMcpCallTool = new WaitForMcpCallTool()
