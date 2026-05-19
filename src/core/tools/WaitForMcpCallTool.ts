import { TelemetryService } from "@shofer/telemetry"

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

			// Per-call settle records. We track `settled` so the outer timeout can
			// emit a structured `status:"timeout"` entry for each handle that did
			// not finish in time, instead of collapsing the whole call into one
			// generic error.
			type SettleRecord = {
				callId: string
				serverName: string
				toolName: string
				result?: any
				error?: string
				status: "completed" | "error" | "timeout"
				settled: boolean
			}

			const records: SettleRecord[] = handles.map((h) => ({
				callId: h.callId,
				serverName: h.serverName,
				toolName: h.toolName,
				status: "completed",
				settled: false,
			}))

			const settlePromises = handles.map((h, i) =>
				h.promise
					.then((result) => {
						records[i].result = result
						records[i].status = "completed"
						records[i].settled = true
					})
					.catch((err) => {
						records[i].error = err instanceof Error ? err.message : String(err)
						records[i].status = "error"
						records[i].settled = true
					}),
			)

			let timer: NodeJS.Timeout | undefined
			const timeoutPromise = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs)
			})

			try {
				if (waitStrategy === "any") {
					await Promise.race([Promise.race(settlePromises), timeoutPromise])
				} else {
					await Promise.race([Promise.all(settlePromises), timeoutPromise])
				}
			} finally {
				if (timer) clearTimeout(timer)
			}

			// Mark any still-unsettled handles as timed out for the response. We
			// intentionally do NOT mutate the underlying Task.mcpAsyncCalls handle
			// — the call may still complete later and be retrievable via
			// check_mcp_call_status.
			const timeoutSec = params.timeout ?? 120
			for (const r of records) {
				if (!r.settled) {
					r.status = "timeout"
					r.error = `Did not complete within ${timeoutSec}s`
					TelemetryService.instance.captureMcpAsyncCallTimedOut(task.taskId, {
						callId: r.callId,
						serverName: r.serverName,
						toolName: r.toolName,
						timeoutSec,
					})
				}
			}

			// Delete-on-read: settled handles have been observed exactly once via this
			// wait and returned to the agent; release them from the per-task map.
			// Unsettled (timed-out) handles stay in the map so a subsequent
			// check_mcp_call_status / wait_for_mcp_call can still observe them.
			for (const r of records) {
				if (r.settled) {
					task.mcpAsyncCalls.delete(r.callId)
				}
			}

			// Shape results
			const output = records.map((r) => {
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
