import { TaskStatus } from "@shofer/types"
import type { BackgroundTaskStatus, TaskHandle } from "@shofer/types"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { MAX_SUBTASK_RESULT_LENGTH } from "./NewTaskTool"

const DEFAULT_TIMEOUT_SECONDS = 120

interface WaitForTaskParams {
	task_ids: string[]
	wait?: "all" | "any" | null
	timeout?: number | null
}

/** Map a live TaskStatus to BackgroundTaskStatus. */
function mapTaskStatus(taskStatus: TaskStatus): BackgroundTaskStatus {
	switch (taskStatus) {
		case TaskStatus.Interactive:
		case TaskStatus.Resumable:
		case TaskStatus.Idle:
			return "waiting"
		case TaskStatus.Running:
			return "running"
		case TaskStatus.None:
		default:
			return "error"
	}
}

export class WaitForTaskTool extends BaseTool<"wait_for_task"> {
	readonly name = "wait_for_task" as const

	async execute(params: WaitForTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { task_ids, wait = "all", timeout = DEFAULT_TIMEOUT_SECONDS } = params
		const { askApproval, pushToolResult } = callbacks

		const effectiveWait = wait ?? "all"
		const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_SECONDS

		// Validate all task IDs exist in this task's background children.
		const handles = new Map<string, TaskHandle>()
		const missing: string[] = []
		for (const id of task_ids) {
			const handle = task.backgroundChildren.get(id)
			if (!handle) {
				missing.push(id)
			} else {
				handles.set(id, handle)
			}
		}
		if (missing.length > 0) {
			pushToolResult(formatResponse.toolError(`Tasks not found in background children: ${missing.join(", ")}`))
			return
		}

		// Finalize the streaming partial "tool" ask so the ChatRow shows a complete
		// entry. Auto-approval marks this tool as always-approved (see
		// src/core/auto-approval/index.ts), so this does not block on user input.
		// Per the shared title-fallback policy, we emit `undefined` for unknown
		// titles and let the UI fall back to the task id.
		const task_titles = task_ids.map((id) => getManagedTaskTitle(task, id))
		const completeMessage = JSON.stringify({
			tool: "waitForTask",
			task_ids,
			task_titles,
			wait: effectiveWait,
			timeout: effectiveTimeout,
		})
		const didApprove = await askApproval("tool", completeMessage)
		if (!didApprove) {
			return
		}

		const provider = task.providerRef.deref()
		if (!provider) {
			pushToolResult(formatResponse.toolError("Provider reference lost"))
			return
		}

		const readPersistedStatus = async (taskId: string): Promise<"completed" | "pending"> => {
			try {
				const { historyItem } = await provider.getTaskWithId(taskId)
				return historyItem.taskState?.lifecycle === "completed" ? "completed" : "pending"
			} catch (_) {
				// No persisted history yet — treat as pending.
				return "pending"
			}
		}

		const isTerminal = (id: string) => {
			const h = handles.get(id)!
			return h.status === "completed" || h.status === "error" || h.status === "cancelled"
		}

		// A child blocked on a question to the parent is *not* terminal, but
		// it is a wake-up condition: the parent's wait_for_task must return
		// so the LLM can decide whether to answer (via answer_subtask_question)
		// or cancel (via cancel_tasks). Both wait modes treat it as
		// "the wait condition is satisfied for this child".
		const needsParentInput = (id: string) => handles.get(id)!.status === "waiting_for_parent"

		// Phase 1: resolve any non-terminal handles from persisted state first,
		// so tasks that already finished (but whose event we missed) are caught early.
		for (const [id, handle] of handles) {
			if (!isTerminal(id)) {
				const persisted = await readPersistedStatus(id)
				if (persisted === "completed") {
					handle.status = "completed"
				}
			}
		}

		// Condition predicates for the two wait modes.
		// A child that has routed a question to the parent counts as "done
		// for the purposes of waiting" — the parent must come back and act.
		const allSatisfied = () => [...handles.keys()].every((id) => isTerminal(id) || needsParentInput(id))
		const anySatisfied = () =>
			[...handles.values()].some((h) => h.status === "completed" || h.status === "waiting_for_parent")
		const conditionMet = () => (effectiveWait === "all" ? allSatisfied() : anySatisfied())

		if (!conditionMet()) {
			// Event-driven wait — no polling; resolves on the first relevant event.
			await new Promise<void>((resolve) => {
				let settled = false

				const cleanup = () => {
					if (settled) return
					settled = true
					provider.taskManager.off("managedTask:completed", onComplete)
					provider.taskManager.off("managedTask:error", onError)
					provider.taskManager.off("managedTask:needs-parent-input", onNeedsParentInput)
					clearTimeout(timer)
				}

				const checkAndMaybeResolve = () => {
					if (conditionMet()) {
						cleanup()
						resolve()
					}
				}

				const onComplete = (completedId: string) => {
					const handle = handles.get(completedId)
					if (!handle) return
					handle.status = "completed"
					checkAndMaybeResolve()
				}

				const onError = (erroredId: string) => {
					const handle = handles.get(erroredId)
					if (!handle) return
					handle.status = "error"
					// For "all" mode an error is still a terminal state — recheck.
					checkAndMaybeResolve()
				}

				const onNeedsParentInput = (childId: string) => {
					const handle = handles.get(childId)
					if (!handle) return
					handle.status = "waiting_for_parent"
					checkAndMaybeResolve()
				}

				const timer = setTimeout(async () => {
					// Timeout: re-check authoritative sources before giving up to close
					// the race window between our initial check and the timer firing.
					for (const [id, handle] of handles) {
						if (!isTerminal(id)) {
							const persisted = await readPersistedStatus(id)
							if (persisted === "completed") {
								handle.status = "completed"
							} else {
								const liveInstance = provider.taskManager.getManagedTaskInstance(id)
								handle.status = liveInstance ? mapTaskStatus(liveInstance.taskStatus) : "error"
							}
						}
					}
					cleanup()
					resolve()
				}, effectiveTimeout * 1000)

				provider.taskManager.on("managedTask:completed", onComplete)
				provider.taskManager.on("managedTask:error", onError)
				provider.taskManager.on("managedTask:needs-parent-input", onNeedsParentInput)
			})
		}

		// Build results — for each task, fetch the last completion/error message
		// or surface the pending parent question.
		const resultLines: string[] = []
		const completedIds: string[] = []
		const needsAnswerIds: string[] = []

		for (const [id, handle] of handles) {
			let result: string | undefined
			let errorText: string | undefined
			let pendingQuestionText: string | undefined

			if (handle.status === "completed" || handle.status === "error" || handle.status === "cancelled") {
				const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
				const messages = await readTaskMessages({ taskId: id, globalStoragePath })
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
			} else if (handle.status === "waiting_for_parent") {
				const liveInstance = provider.taskManager.getManagedTaskInstance(id)
				const pq = liveInstance?.getPendingParentQuestion()
				if (pq) {
					const suggestionList =
						pq.suggestions.length > 0 ? pq.suggestions.map((s) => `"${s.answer}"`).join(", ") : "none"
					pendingQuestionText = `Pending parent question: "${pq.question}"\nSuggestions: ${suggestionList}\nAnswer via answer_subtask_question(task_id="${id}", answer=...) or cancel via cancel_tasks.`
				}
				needsAnswerIds.push(id)
			}

			if (handle.status === "completed") {
				completedIds.push(id)
			}

			const timedOut = handle.status === "running" || handle.status === "waiting"
			resultLines.push(
				`Task: ${id}\nStatus: ${handle.status}` +
					(timedOut ? `\nTimed out after ${effectiveTimeout}s` : "") +
					(result ? `\nResult: ${result.slice(0, MAX_SUBTASK_RESULT_LENGTH)}` : "") +
					(errorText ? `\nError: ${errorText.slice(0, MAX_SUBTASK_RESULT_LENGTH)}` : "") +
					(pendingQuestionText ? `\n${pendingQuestionText}` : ""),
			)
		}

		const timedOut = [...handles.values()].some((h) => h.status === "running" || h.status === "waiting")
		const summary =
			`Completed: [${completedIds.join(", ")}]\n` +
			(needsAnswerIds.length > 0 ? `Awaiting parent answer: [${needsAnswerIds.join(", ")}]\n` : "") +
			(timedOut ? `Timed out (${effectiveTimeout}s limit reached)\n` : "") +
			`\n` +
			resultLines.join("\n\n")

		pushToolResult(summary)
	}

	override async handlePartial(task: Task, block: ToolUse<"wait_for_task">): Promise<void> {
		const rawIds = block.params.task_ids
		// `task_ids` streams as a JSON array fragment; show whatever is available.
		const ids: string[] = Array.isArray(rawIds) ? rawIds : []
		const partialMessage = JSON.stringify({
			tool: "waitForTask",
			task_ids: ids,
			wait: block.params.wait ?? "all",
			timeout: block.params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const waitForTaskTool = new WaitForTaskTool()
