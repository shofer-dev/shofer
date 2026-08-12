import { ShoferEventName, type CompletionRating } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { taskLog } from "../logging/subsystems.js"
import type { Task } from "./Task.js"

/**
 * Emit the task's terminal `TaskCompleted` event.
 *
 * Shared by the two paths that can declare a task complete without asking
 * anyone: the `attempt_completion` tool (the agent says it is done) and the
 * conversational turn in `Task.recursivelyMakeShoferRequests` (a task with
 * `toolCallingEnabled === false` has no `attempt_completion` to call, so a
 * complete text-only reply IS the turn). Both are Self-Declared Terminal State
 * — no `task.ask(...)`, no user approval — so the token-usage flush, the
 * telemetry capture and the event payload must stay identical between them.
 *
 * Callers set `task.abort = true` after this returns, and MUST drain
 * `task.messageQueueService` first (Terminal-State Queue-Drain Rule).
 */
export function emitTaskCompleted(task: Task, rating: CompletionRating): void {
	taskLog.info(`[emitTaskCompleted] Emitting TaskCompleted event, taskId=${task.taskId}`)
	// Force a final token usage update before emitting TaskCompleted so the
	// latest stats are captured regardless of the throttle timer.
	task.emitFinalTokenUsageUpdate()

	TelemetryService.instance.captureTaskCompleted(task.taskId)
	task.emit(ShoferEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage, {
		rating,
		isSubtask: !!task.parentTaskId,
	})
	taskLog.info(`[emitTaskCompleted] TaskCompleted event emitted, taskId=${task.taskId}`)
}
