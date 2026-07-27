import { pluginRegistry } from "@shofer/core"

import type { ShoferProvider } from "./ShoferProvider"

/**
 * Where a task about to be created should run.
 *
 * Core knows that a task has a working directory; it does not know that git worktrees
 * exist, or that a user might want each task in its own checkout. So it asks: every
 * plugin is offered the `"resolve-task-cwd"` question and the first concrete answer
 * wins. Nobody answering means the task runs in the workspace, which is what happened
 * before any of this existed.
 *
 * **Errors propagate.** `requestAll` treats a throw as "no answer", which is right for a
 * plugin that does not recognise the question — but wrong for one that recognised it and
 * failed: silently falling back to the workspace would run the agent on the user's
 * current branch, the exact outcome a per-task worktree exists to prevent. So a plugin
 * that means to fail says so in its answer, and this turns that into a thrown error the
 * caller reports instead of starting the task.
 */
export async function resolveTaskCwd(provider: ShoferProvider): Promise<string | undefined> {
	const answers = await pluginRegistry.requestAll("resolve-task-cwd", undefined, {
		cwd: provider.cwd,
		workspacePath: provider.cwd,
	})

	for (const answer of answers) {
		const placement = answer as { cwd?: unknown; error?: unknown } | undefined
		if (typeof placement?.error === "string") throw new Error(placement.error)
		if (typeof placement?.cwd === "string" && placement.cwd.length > 0) return placement.cwd
	}
	return undefined
}
