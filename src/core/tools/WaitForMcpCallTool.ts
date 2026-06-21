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

			// The user pressing Stop aborts task.abortSignal. Race it alongside the
			// settle/timeout promises so the wait unwinds immediately on cancel
			// instead of lingering until the timeout (the loop checks task.abort
			// after this returns).
			// abortSignal is optional in non-provider/test contexts.
			let onAbort: (() => void) | undefined
			const abortPromise = new Promise<"aborted">((resolve) => {
				if (task.abortSignal?.aborted) {
					resolve("aborted")
					return
				}
				onAbort = () => resolve("aborted")
				task.abortSignal?.addEventListener("abort", onAbort, { once: true })
			})

			// Mark the task as `waiting` for the duration of the blocking await so
			// the Task Selector / TaskHeader surface "this agent is blocked on an
			// external event, not actively working". Mirrors WaitForTaskTool. The
			// state is restored in the finally so an exception in the wait path
			// does not strand the task in `waiting` forever. The taskManager
			// reference is optional — in unit tests / non-provider contexts
			// (e.g. CLI) the state transition is skipped.
			const taskManager = task.providerRef.deref()?.taskManager
			taskManager?.setState(task.taskId, { lifecycle: "waiting" })

			try {
				if (waitStrategy === "any") {
					await Promise.race([Promise.race(settlePromises), timeoutPromise, abortPromise])
				} else {
					await Promise.race([Promise.all(settlePromises), timeoutPromise, abortPromise])
				}
			} finally {
				if (timer) clearTimeout(timer)
				if (onAbort) task.abortSignal?.removeEventListener("abort", onAbort)
				// Only restore "running" if the task is still alive. A user Stop
				// aborts the task; resurrecting it to "running" here would make a
				// cancelled task reappear as active.
				if (!task.abort && !task.abandoned) {
					taskManager?.setState(task.taskId, { lifecycle: "running" })
				}
			}

			// If the wait ended because the task was aborted, stop here — the task
			// is being torn down; don't build or emit results on a dead task.
			if (task.abort || task.abandoned) {
				return
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
					const shaped = processMcpToolContent(r.result, task.getMcpMaxResponseBytes?.())
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
