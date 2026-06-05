/**
 * Shared event-driven task-wait helper.
 *
 * Extracted from {@link WaitForTaskTool} so the workflow executor
 * ({@link WorkflowTask}) and the LLM-facing tool share one
 * implementation — one coordination primitive, two callers.
 *
 * Design: see todos/workflow_rework.md Work Item 3.
 */

import type { TaskHandle } from "@shofer/types"

import type { ShoferProvider } from "../webview/ShoferProvider"
import { workflowLog } from "../../utils/logging/subsystems"

export interface EventWaitOptions {
	/** Map of taskId → TaskHandle, mutated in-place as events arrive. */
	handles: Map<string, TaskHandle>
	/** Returns true when the wait condition is satisfied. */
	conditionMet: () => boolean
	/** Maximum milliseconds to wait before giving up. */
	timeoutMs: number
	/**
	 * Optional callback fired when a child routes a question to the parent
	 * (managedTask:needs-parent-input). If provided and returns true, the
	 * condition is rechecked immediately — the caller usually relays the
	 * question to the user, delivers the answer, then resolves.
	 */
	onNeedsParentInput?: (taskId: string) => Promise<boolean>
	/** AbortSignal from the caller's task for cooperative cancellation. */
	abortSignal?: AbortSignal
}

/**
 * Event-driven wait: listens on {@link TaskManager} events for
 * `managedTask:completed`, `managedTask:error`, and
 * `managedTask:needs-parent-input`, resolving when `conditionMet()`
 * returns true or `timeoutMs` elapses.
 *
 * The provided {@link EventWaitOptions.handles} map is mutated in-place
 * — callers read the settled statuses from it after this resolves.
 */
export async function waitForTasksEventDriven(provider: ShoferProvider, options: EventWaitOptions): Promise<void> {
	const { handles, conditionMet, timeoutMs, onNeedsParentInput, abortSignal } = options

	if (conditionMet()) return

	const taskManager = provider.taskManager

	await new Promise<void>((resolve) => {
		let settled = false

		const cleanup = () => {
			if (settled) return
			settled = true
			taskManager.off("managedTask:completed", onComplete)
			taskManager.off("managedTask:error", onError)
			taskManager.off("managedTask:needs-parent-input", onNeedsInput)
			clearTimeout(timeoutTimer)
			if (abortHandler && abortSignal) {
				abortSignal.removeEventListener("abort", abortHandler)
			}
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
			checkAndMaybeResolve()
		}

		const onNeedsInput = (childId: string) => {
			const handle = handles.get(childId)
			if (!handle) return
			if (onNeedsParentInput) {
				// Let the caller handle the relay (WI4). If the callback
				// returns true, the question was answered and the handle
				// has been updated — recheck the condition.
				void onNeedsParentInput(childId).then((resolved) => {
					if (resolved) {
						handle.status = "waiting_for_parent"
						checkAndMaybeResolve()
					}
				})
			} else {
				handle.status = "waiting_for_parent"
				checkAndMaybeResolve()
			}
		}

		// AbortSignal handler for cooperative cancellation (Stop button).
		let abortHandler: (() => void) | undefined
		if (abortSignal) {
			if (abortSignal.aborted) {
				resolve()
				return
			}
			abortHandler = () => {
				cleanup()
				resolve()
			}
			abortSignal.addEventListener("abort", abortHandler, { once: true })
		}

		const timeoutTimer = setTimeout(() => {
			cleanup()
			resolve()
		}, timeoutMs)

		taskManager.on("managedTask:completed", onComplete)
		taskManager.on("managedTask:error", onError)
		taskManager.on("managedTask:needs-parent-input", onNeedsInput)
	})
}
