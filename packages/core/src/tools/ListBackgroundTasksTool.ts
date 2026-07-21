import { BaseTool, ToolCallbacks } from "./BaseTool.js"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle.js"
import { Task } from "../task/Task.js"
import { type ToolUse } from "@shofer/types"
import type { TaskLifecycle } from "@shofer/types"

type ListBackgroundTasksParams = {
	scope?: "children" | "peers" | null
}

interface TaskEntry {
	task_id: string
	title: string
	status: TaskLifecycle
	created_at?: number
}

/** Resolve the best-known lifecycle by preferring the live ManagedTask state. */
function resolveLifecycle(taskId: string, task: Task, persistedLifecycle: TaskLifecycle): TaskLifecycle {
	const provider = task.providerRef.deref()
	if (!provider) return persistedLifecycle

	const managed = provider.taskManager.getManagedTask(taskId)
	if (managed?.state?.lifecycle) return managed.state.lifecycle

	return persistedLifecycle
}

export class ListBackgroundTasksTool extends BaseTool<"list_background_tasks"> {
	readonly name = "list_background_tasks" as const

	async execute(params: ListBackgroundTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const scope = params.scope ?? "children"
		const { askApproval, pushToolResult } = callbacks

		const provider = task.providerRef.deref()
		if (!provider) {
			pushToolResult("Provider reference lost")
			return
		}

		let tasks: TaskEntry[]

		if (scope === "peers") {
			// ───── Peers scope: merge ManagedTasks + TaskHistoryStore ─────
			// ManagedTasks covers live + terminal tasks still in the in-memory
			// registry.  TaskHistoryStore covers EVERY task ever persisted,
			// including stopped/cancelled tasks removed from ManagedTasks.
			//
			// A "peer" is a task that shares the caller's root task tree. The
			// candidate MUST carry a `rootTaskId` equal to the caller's
			// `effectiveRootId`. Tasks without a `rootTaskId` (other root /
			// top-level tasks from unrelated sessions) are NOT peers and must be
			// excluded — otherwise a root caller sees every persisted task in the
			// store as a "peer". This strict equality check replaces the previous
			// truthy-short-circuit (`managed.rootTaskId && …`) which let
			// rootless tasks slip through.
			//
			// The `knownPeers` gate is applied ONLY to non-root callers
			// (`task.rootTaskId` truthy): a non-root task may only message its
			// explicitly granted peers. A root caller has no `rootTaskId` and no
			// meaningful peer grant set, so it discovers ALL descendants in its
			// tree (every task whose `rootTaskId === root.taskId`).
			const seen = new Set<string>()
			tasks = []

			const effectiveRootId = task.rootTaskId ?? task.taskId

			// 1. ManagedTasks (in-memory, authoritative for lifecycle)
			for (const managed of provider.taskManager.getManagedTasks()) {
				if (managed.id === task.taskId) continue
				if (managed.rootTaskId !== effectiveRootId) continue
				if (task.rootTaskId && (!task.knownPeers || !task.knownPeers.has(managed.id))) continue

				seen.add(managed.id)
				tasks.push({
					task_id: managed.id,
					title: managed.name ?? managed.id,
					status: resolveLifecycle(managed.id, task, managed.state?.lifecycle ?? "idle"),
					created_at: managed.createdAt,
				})
			}

			// 2. TaskHistoryStore (persisted, catches tasks removed from ManagedTasks)
			const allHistory = provider.taskHistoryStore.getAll()
			for (const item of allHistory) {
				if (item.id === task.taskId) continue
				if (seen.has(item.id)) continue
				if (item.rootTaskId !== effectiveRootId) continue
				if (task.rootTaskId && (!task.knownPeers || !task.knownPeers.has(item.id))) continue

				seen.add(item.id)
				const lifecycle = resolveLifecycle(item.id, task, item.taskState?.lifecycle ?? "idle")
				tasks.push({
					task_id: item.id,
					title: item.name ?? item.task ?? "",
					status: lifecycle,
					created_at: item.createdAt ?? item.ts,
				})
			}

			// Telemetry: peer discovery.
			try {
				const { TelemetryService } = await import("@shofer/telemetry")
				TelemetryService.instance.capturePeerDiscovery(task.taskId)
			} catch {
				// non-fatal
			}

			// Sort by created_at descending (newest first)
			tasks.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
		} else {
			// ───── Children scope: TaskHandle + TaskHistoryStore ─────
			const seen = new Set<string>()
			tasks = []

			// 1. Live background children (TaskHandle — runtime)
			for (const [childId, handle] of task.backgroundChildren) {
				seen.add(childId)
				tasks.push({
					task_id: childId,
					title: getManagedTaskTitle(task, childId) ?? childId,
					status: (handle.status as TaskLifecycle) ?? "idle",
					created_at: handle.createdAt,
				})
			}

			// 2. Persisted children not in the live map.
			// Includes BOTH background and synchronous (foreground) children:
			// a synchronous child is never added to `backgroundChildren` (only
			// `childTaskId` is set), so without this fallback it would be
			// invisible to `list_background_tasks` even though it is a direct
			// child of this task. Matching on `parentTaskId` is the authoritative
			// parent-child relationship; the previous `isBackground` gate
			// excluded synchronous children entirely.
			const allHistory = provider.taskHistoryStore.getAll()
			for (const item of allHistory) {
				if (seen.has(item.id)) continue
				if (item.parentTaskId !== task.taskId) continue

				seen.add(item.id)
				const lifecycle = resolveLifecycle(item.id, task, item.taskState?.lifecycle ?? "idle")
				tasks.push({
					task_id: item.id,
					title: item.name ?? item.task ?? "",
					status: lifecycle,
					created_at: item.createdAt ?? item.ts,
				})
			}

			// Sort by created_at ascending (oldest first) to match existing behavior
			tasks.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
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
