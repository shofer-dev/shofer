import { PLUGIN_LOCAL_REQUEST_PREFIX } from "@shofer/types"

/**
 * Where a plugin UI request must be answered.
 *
 * A plugin-owned feature keeps its per-task state on the host that RUNS the task, so
 * a request about that state has to reach that host — which, for a focused remote
 * shadow, is an executor rather than this process. Two things override that:
 *
 *  - a `local:` method is for something only this host can do (open an editor, show a
 *    viewer); routing it to a headless executor would silently do nothing;
 *  - a **mutating** request while a local task is running is refused outright, because
 *    the executor and this host share the workspace and both would be writing it.
 *
 * Split out of `ShoferProvider` so these rules — the ones that are easy to get subtly
 * wrong and hard to reproduce — are unit-testable without a webview.
 */
export type PluginRequestTarget = { target: "local" } | { target: "shadow"; taskId: string } | { blocked: string }

export interface PluginRequestRoutingInput {
	/** The plugin-defined method being called. */
	method: string
	/** Whether the request changes state rather than reading it. */
	mutates?: boolean
	/** The focused remote shadow task, when one is focused. */
	shadowTaskId?: string
	/** Whether any local task is currently running in this workspace. */
	hasActiveLocalTask: boolean
	/** Message used when a mutating request is refused (host-localized). */
	blockedMessage: string
}

export function resolvePluginRequestTarget(input: PluginRequestRoutingInput): PluginRequestTarget {
	if (input.method.startsWith(PLUGIN_LOCAL_REQUEST_PREFIX)) {
		return { target: "local" }
	}
	if (!input.shadowTaskId) {
		return { target: "local" }
	}
	if (input.mutates && input.hasActiveLocalTask) {
		return { blocked: input.blockedMessage }
	}
	return { target: "shadow", taskId: input.shadowTaskId }
}
