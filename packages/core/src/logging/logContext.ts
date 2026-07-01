/**
 * @fileoverview Async-local task attribution for the logging transport.
 *
 * Log entries carry only a subsystem `ctx` (e.g. `[Task]`, `[API]`) — they do
 * not know which *task instance* produced them. To power the per-task /
 * per-workflow "Logs" tab we need to attribute every line emitted during a
 * task's execution to that task's id, including lines from deep utility code
 * (API providers, MCP, git) that have no task reference.
 *
 * An {@link AsyncLocalStorage} solves this without touching the 100+ call
 * sites: each Task/WorkflowTask wraps its run loop in
 * {@link runWithLogTaskContext}, and the transport reads the ambient store on
 * every `write()` (see `CompactTransport.write`). The store propagates across
 * `await`, promise chains, and timers scheduled within the loop, so all
 * synchronous *and* asynchronous work spawned by the loop is attributed to the
 * owning task. A nested task (e.g. a workflow's child agent) establishes its
 * own context, overriding the parent's for its subtree — so child logs are
 * attributed to the child, not the whole tree.
 */

import { AsyncLocalStorage } from "node:async_hooks"

/** The task identity stamped onto every log line emitted within the context. */
export interface LogTaskContext {
	/** The owning task / workflow instance id. */
	taskId: string
	/** The root task id of the tree this task belongs to (for future grouping). */
	rootTaskId?: string
}

const storage = new AsyncLocalStorage<LogTaskContext>()

/**
 * Run `fn` with the given task context installed as the ambient log context.
 * Every log line emitted (synchronously or via awaited/scheduled async work)
 * inside `fn` is attributed to `ctx.taskId`.
 */
export function runWithLogTaskContext<T>(ctx: LogTaskContext, fn: () => T): T {
	return storage.run(ctx, fn)
}

/** Return the current ambient log task context, or `undefined` outside any task. */
export function getLogTaskContext(): LogTaskContext | undefined {
	return storage.getStore()
}
