import { TaskStatus } from "@shofer/types"
import type { BackgroundTaskStatus } from "@shofer/types"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getModeBySlug } from "../../shared/modes"
import type { ToolUse } from "../../shared/tools"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { MAX_SUBTASK_RESULT_LENGTH } from "./NewTaskTool"

interface CheckTaskStatusParams {
	task_id: string
	include_activity?: boolean | null
}

/** Map a Task's runtime TaskStatus to our BackgroundTaskStatus representation. */
function mapTaskStatusToBackground(taskStatus: TaskStatus): BackgroundTaskStatus {
	switch (taskStatus) {
		case TaskStatus.Interactive:
		case TaskStatus.Resumable:
			return "waiting"
		case TaskStatus.Idle:
			return "waiting"
		case TaskStatus.Running:
			return "running"
		case TaskStatus.None:
		default:
			return "error"
	}
}

export class CheckTaskStatusTool extends BaseTool<"check_task_status"> {
	readonly name = "check_task_status" as const

	async execute(params: CheckTaskStatusParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { task_id } = params
		const { askApproval, pushToolResult } = callbacks

		// Gate: accept direct children (fast path) OR same-root peers.
		const handle = task.backgroundChildren.get(task_id)
		const isDirectChild = !!handle
		let isPeer = false

		if (!isDirectChild) {
			// Check if the task_id shares the caller's rootTaskId.
			if (task.rootTaskId) {
				const provider = task.providerRef.deref()
				if (provider) {
					try {
						const { historyItem } = await provider.getTaskWithId(task_id)
						if (historyItem.rootTaskId === task.rootTaskId) {
							isPeer = true
						}
					} catch {
						// Check live instance.
						const live = provider.taskManager.getManagedTaskInstance(task_id)
						if (live && live.rootTaskId === task.rootTaskId) {
							isPeer = true
						}
					}
				}
			}

			// Respect opt-in scope restriction.
			if (isPeer && task.knownPeers && !task.knownPeers.has(task_id)) {
				isPeer = false
			}
		}

		if (!isDirectChild && !isPeer) {
			pushToolResult(formatResponse.toolError(`Task ${task_id} not found in background children or peers.`))
			return
		}

		const provider = task.providerRef.deref()
		if (!provider) {
			pushToolResult(formatResponse.toolError("Provider reference lost"))
			return
		}

		// Resolve the child's mode for inclusion in the response.
		// Consult the live instance first (most current), falling back to
		// persisted HistoryItem.mode, then the handle's initial mode.
		let childMode: string | undefined
		const customModes = (await provider.getState())?.customModes
		const liveChild = provider.taskManager.getManagedTaskInstance(task_id)
		if (liveChild) {
			childMode = await liveChild.getTaskMode()
		}

		if (!childMode) {
			try {
				const { historyItem } = await provider.getTaskWithId(task_id)
				childMode = historyItem.mode
			} catch {
				// No persisted history — leave mode undefined.
			}
		}

		const modeDisplayName = childMode ? (getModeBySlug(childMode, customModes)?.name ?? childMode) : "unknown"

		// Finalize the streaming partial "tool" ask so the ChatRow shows a complete
		// entry. Auto-approval marks this tool as always-approved, so askApproval
		// returns immediately without blocking on user input.
		const completeMessage = JSON.stringify({
			tool: "checkTaskStatus",
			task_id,
			task_title: getManagedTaskTitle(task, task_id),
		})
		const didApprove = await askApproval("tool", completeMessage)
		if (!didApprove) {
			return
		}

		// For direct children, resolve status from the handle.
		// For peers, resolve from the live / persisted state directly.
		let effectiveStatus: BackgroundTaskStatus = "running"

		if (isDirectChild && handle) {
			// Authoritative-status resolution order (see WaitForTaskTool for rationale):
			if (
				handle.status !== "completed" &&
				handle.status !== "error" &&
				handle.status !== "cancelled" &&
				handle.status !== "waiting_for_parent"
			) {
				let resolvedFromLive = false
				const liveState = provider.taskManager.getTaskState(task_id)
				if (liveState?.lifecycle === "completed") {
					handle.status = "completed"
					resolvedFromLive = true
				}

				if (!resolvedFromLive) {
					try {
						const { historyItem } = await provider.getTaskWithId(task_id)
						if (historyItem.taskState?.lifecycle === "completed") {
							handle.status = "completed"
							resolvedFromLive = true
						}
					} catch (_) {
						// No persisted history yet — fall through to live check.
					}
				}

				if (!resolvedFromLive) {
					const liveTask = provider.taskManager.getManagedTaskInstance(task_id)
					if (liveTask) {
						handle.status = mapTaskStatusToBackground(liveTask.taskStatus)
					} else {
						handle.status = "error"
					}
				}
			}
			effectiveStatus = handle.status
		} else {
			// Peer path: resolve status from live/persisted state.
			let resolved = false
			const liveState = provider.taskManager.getTaskState(task_id)
			if (liveState) {
				effectiveStatus = liveState.lifecycle === "completed" ? "completed" : "running"
				resolved = true
			}
			if (!resolved) {
				try {
					const { historyItem } = await provider.getTaskWithId(task_id)
					const lc = historyItem.taskState?.lifecycle
					effectiveStatus = lc === "completed" ? "completed" : lc === "error" ? "error" : "running"
				} catch {
					effectiveStatus = "error"
				}
			}
		}

		let result: string | undefined
		let errorText: string | undefined
		let recentActivity: string | undefined

		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath

		if (effectiveStatus === "completed" || effectiveStatus === "error" || effectiveStatus === "cancelled") {
			const messages = await readTaskMessages({ taskId: task_id, globalStoragePath })
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i]
				if (msg.type === "say" && msg.say === "completion_result") {
					result = msg.text
					break
				}
				if (msg.type === "say" && msg.say === "error") {
					errorText = msg.text
					break
				}
			}
		}

		// When include_activity is true, surface the child's most recent tool
		// calls or messages so the parent can see what the child is currently
		// doing (useful for deciding whether to wait or cancel).
		if (params.include_activity) {
			try {
				const messages = await readTaskMessages({ taskId: task_id, globalStoragePath })
				// Collect the last 3 tool-use or say messages for context.
				const activityLines: string[] = []
				let collected = 0
				for (let i = messages.length - 1; i >= 0 && collected < 3; i--) {
					const msg = messages[i]
					if (
						msg.type === "say" &&
						(msg.say === "text" || msg.say === "completion_result" || msg.say === "error")
					) {
						const snippet = (msg.text ?? "").replace(/\n/g, " ").slice(0, 120)
						activityLines.unshift(`[say:${msg.say}] ${snippet}`)
						collected++
					} else if (msg.type === "say" && msg.say === "tool") {
						// The "tool" message is a JSON blob; try to extract tool name + args summary.
						try {
							const parsed = JSON.parse(msg.text ?? "{}")
							activityLines.unshift(`[tool] ${parsed.tool ?? "unknown"}`)
						} catch {
							activityLines.unshift("[tool] (parsing failed)")
						}
						collected++
					}
				}
				if (activityLines.length > 0) {
					recentActivity = "Recent activity:\n" + activityLines.map((l) => `  ${l}`).join("\n")
				}
			} catch {
				// Non-fatal: activity feed is best-effort.
			}
		}

		// Surface a pending parent question if the child is waiting for input
		// from the parent (ask_followup_question routed to parent).
		let pendingQuestionText: string | undefined
		try {
			const liveInstance = provider.taskManager.getManagedTaskInstance(task_id)
			const pq = liveInstance?.getPendingParentQuestion()
			if (pq) {
				const suggestionList =
					pq.suggestions.length > 0 ? pq.suggestions.map((s) => `"${s.answer}"`).join(", ") : "none"
				pendingQuestionText = `\nPending parent question: "${pq.question}"\nSuggestions: ${suggestionList}\nAnswer via answer_subtask_question(task_id="${task_id}", answer=...).`
			}
		} catch {
			// Non-fatal.
		}

		pushToolResult(
			`Task: ${task_id}\nMode: ${modeDisplayName}\nStatus: ${effectiveStatus}\n` +
				(result ? `Result: ${result.slice(0, MAX_SUBTASK_RESULT_LENGTH)}\n` : "") +
				(errorText ? `Error: ${errorText.slice(0, MAX_SUBTASK_RESULT_LENGTH)}\n` : "") +
				(recentActivity ? `\n${recentActivity}` : "") +
				(pendingQuestionText ?? ""),
		)
	}

	override async handlePartial(task: Task, block: ToolUse<"check_task_status">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "checkTaskStatus",
			task_id: block.params.task_id ?? "",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const checkTaskStatusTool = new CheckTaskStatusTool()
