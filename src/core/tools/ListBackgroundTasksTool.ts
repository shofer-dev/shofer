import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"

type ListBackgroundTasksParams = {
	scope?: "children" | "peers" | null
}

export class ListBackgroundTasksTool extends BaseTool<"list_background_tasks"> {
	readonly name = "list_background_tasks" as const

	async execute(params: ListBackgroundTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const scope = params.scope ?? "children"
		const { askApproval, pushToolResult } = callbacks

		let tasks: Array<{ task_id: string; title: string | undefined; status: string; created_at?: number }>

		if (scope === "peers") {
			// Enumerate all tasks sharing the caller's rootTaskId.
			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult("Provider reference lost")
				return
			}
			const allManaged = provider.taskManager.getManagedTasks()
			tasks = []
			for (const managed of allManaged) {
				const peerId = managed.id
				if (peerId === task.taskId) continue
				// Resolve rootTaskId: live instance first, then persisted history
				// so resumable-but-unloaded peers are included.
				const liveTask = provider.taskManager.getManagedTaskInstance(peerId)
				let peerRootTaskId = liveTask?.rootTaskId
				if (!peerRootTaskId) {
					try {
						const { historyItem } = await provider.getTaskWithId(peerId)
						peerRootTaskId = historyItem.rootTaskId
					} catch {
						// Not resumable — skip.
						continue
					}
				}
				if (task.rootTaskId && peerRootTaskId !== task.rootTaskId) continue
				// Respect opt-in scope restriction.
				if (task.knownPeers && !task.knownPeers.has(peerId)) continue
				tasks.push({
					task_id: peerId,
					title: managed.name ?? peerId,
					status: managed.state?.lifecycle ?? "idle",
					created_at: managed.createdAt,
				})
			}

			// Telemetry: peer discovery.
			try {
				const { TelemetryService } = await import("@shofer/telemetry")
				TelemetryService.instance.capturePeerDiscovery(task.taskId)
			} catch {
				// non-fatal
			}
		} else {
			// Default: children scope (existing behavior).
			tasks = Array.from(task.backgroundChildren.values()).map((h) => ({
				task_id: h.taskId,
				title: getManagedTaskTitle(task, h.taskId),
				status: h.status,
				created_at: h.createdAt,
			}))
		}

		// Finalize the streaming partial "tool" ask with the task snapshot so the
		// ChatRow can render a list of background children. Auto-approval marks
		// this tool as always-approved, so askApproval returns immediately.
		const completeMessage = JSON.stringify({
			tool: "listBackgroundTasks",
			scope,
			tasks,
		})
		const didApprove = await askApproval("tool", completeMessage)
		if (!didApprove) {
			return
		}

		pushToolResult(JSON.stringify({ tasks }, null, 2))
	}

	override async handlePartial(task: Task, block: ToolUse<"list_background_tasks">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "listBackgroundTasks",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const listBackgroundTasksTool = new ListBackgroundTasksTool()
