import { pluginRegistry } from "@shofer/core"
import { taskPlacementAnswerSchema, type DispatchedTaskRef, type TaskPlacementQuestion } from "@shofer/types"

import type { ShoferProvider } from "./ShoferProvider"

/**
 * WHERE a task about to be created should run — the sibling of
 * [`resolveTaskCwd`](./resolveTaskCwd.ts), one level up.
 *
 * `resolveTaskCwd` asks which directory; this asks which MACHINE, and it asks it the
 * only way core is willing to: by broadcasting the question and letting a plugin
 * claim the task. Core knows nothing about queues, schedulers or workers — a plugin
 * that dispatches work answers with the reference of the task it created elsewhere,
 * and the host then attaches to it instead of starting one locally.
 *
 * Three outcomes, and the middle one is why this is not a boolean:
 *
 * - **Nobody claims it** (`undefined`) — the overwhelmingly common case. The caller
 *   runs the existing in-process path, unchanged. A Shofer with no plugins installed
 *   never leaves the process, and a task that ends up executing here should not pay
 *   for a round-trip to find that out.
 * - **A plugin claims it** — it already created the task somewhere; the answer names
 *   it (`taskId`, and where to reach it). The host does NOT create a local task.
 * - **A plugin recognised the question and FAILED** — `{ error }`, which becomes a
 *   thrown error and aborts task creation. A throw from `handleRequest` means "not my
 *   question" (that is how `requestAll` reads it), so a dispatcher that meant to fail
 *   must say so in its answer; silently falling back to running the task locally
 *   would send work to a machine the user did not choose, which is exactly what the
 *   seam exists to prevent.
 *
 * The first well-formed answer wins, like `resolve-task-cwd`. Two dispatchers fighting
 * over one task is a configuration mistake, not a case to arbitrate here.
 */
export async function resolveTaskPlacement(
	provider: ShoferProvider,
	question: TaskPlacementQuestion,
): Promise<DispatchedTaskRef | undefined> {
	const answers = await pluginRegistry.requestAll("resolve-task-placement", question, {
		cwd: question.cwd ?? provider.cwd,
		workspacePath: provider.cwd,
	})

	for (const answer of answers) {
		const parsed = taskPlacementAnswerSchema.safeParse(answer)
		if (!parsed.success) continue
		if ("error" in parsed.data) throw new Error(parsed.data.error)
		return parsed.data.dispatched
	}
	return undefined
}

/**
 * Take a claimed task's reference and make it observable: attach this view to it when
 * the dispatcher said where it landed.
 *
 * A dispatcher that cannot (yet) name an address has still dispatched the task — the
 * work is running, it is simply not watchable from here — so that case is recorded
 * and reported as `false` rather than treated as a failure.
 *
 * @returns whether the view is now attached to the dispatched task.
 */
export async function adoptDispatchedTask(provider: ShoferProvider, dispatched: DispatchedTaskRef): Promise<boolean> {
	if (!dispatched.address) {
		provider.log(`[placement] task ${dispatched.taskId} dispatched without an address — not attaching`)
		return false
	}

	const { TaskAttachmentManager } = await import("../attach/TaskAttachmentManager")
	await TaskAttachmentManager.getInstance().attach(provider, {
		address: dispatched.address,
		taskId: dispatched.taskId,
		token: dispatched.token,
	})
	provider.log(`[placement] attached to dispatched task ${dispatched.taskId} on ${dispatched.address}`)
	return true
}
