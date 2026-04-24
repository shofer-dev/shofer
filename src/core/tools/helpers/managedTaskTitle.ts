/**
 * Shared helper for resolving the human-readable title of a managed background task
 * from the parent Task's TaskManager.
 *
 * Background tools (`check_task_status`, `wait_for_task`, `list_background_tasks`)
 * all need to surface the child task's display name to the UI. This module
 * centralizes both the deref-chain (`providerRef → taskManager → managedTask`)
 * and the "missing name" policy: we always return `undefined` when no name is
 * available and let the UI decide how to fall back (typically to the task id),
 * so the wire format unambiguously distinguishes "real title" from "id echo".
 */

import type { Task } from "../../task/Task"

/**
 * Returns the managed task's `name` if available, otherwise `undefined`.
 *
 * Returns `undefined` when:
 *   - the provider WeakRef has been collected,
 *   - the TaskManager has no entry for `taskId`, or
 *   - the managed task exists but has no `name` set.
 *
 * Callers MUST NOT substitute the task id here — the UI layer handles fallback.
 */
export function getManagedTaskTitle(task: Task, taskId: string): string | undefined {
	return task.providerRef.deref()?.taskManager.getManagedTask(taskId)?.name
}
