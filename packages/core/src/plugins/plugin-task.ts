/**
 * plugin-task — the **chat-timeline control** capability handed to a plugin via
 * `ctx.task` (design §6.11 G9).
 *
 * Where {@link import("./plugin-agent.js").PluginAgentProvider} steers what the agent
 * *does*, this governs the task's visible **timeline**: appending the plugin's own
 * marker rows to it, reading them back, and rewinding it. It is what lets a plugin own
 * a feature whose UX belongs inline in the conversation (a workspace-snapshot marker
 * with restore/diff actions, an external-job status row) instead of being confined to a
 * side panel — without core growing any knowledge of that feature.
 *
 * The mutation is host-side (it needs the task stack, the message manager, and message
 * persistence), so `@shofer/core` stays host-agnostic by consuming a
 * {@link PluginTaskProvider} seam the extension/CLI supplies — the same recipe as
 * `plugin-agent.ts` / `plugin-ai.ts`. Two states:
 * - `permissions.task` granted ⇒ {@link createPluginTaskControl}: delegates to the seam.
 * - ungranted (seam wired) ⇒ {@link createDeniedPluginTaskControl}: every call throws + warns.
 *
 * When the host wires **no** task seam (pure-core embedding), the manager omits
 * `ctx.task` entirely — there is no timeline to control.
 */

import type { PluginMarker, PluginMarkerInput, PluginRewindOptions, PluginTaskControl } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Host seam backing {@link PluginTaskControl}. Supplied where the task stack lives, so
 * core never imports the provider. Every method is plugin-scoped by the caller passing
 * `pluginName`: a plugin can only read back and act on **its own** markers, so one
 * plugin can neither observe nor rewind another's anchors.
 */
export interface PluginTaskProvider {
	/** Append a marker row to the target task's timeline (persisted). */
	marker(pluginName: string, input: PluginMarkerInput): Promise<void>
	/** That plugin's markers on `taskId` (default: the current task), oldest first. */
	listMarkers(pluginName: string, taskId?: string): Promise<PluginMarker[]>
	/** Rewind the current task's chat timeline to `ts` and restart it. */
	rewind(pluginName: string, ts: number, opts?: PluginRewindOptions): Promise<void>
}

/**
 * The live {@link PluginTaskControl} for a granted plugin: delegates to the host
 * {@link PluginTaskProvider}, tagging every call with the plugin's name so the host can
 * scope markers to their owner. Provider errors are re-thrown to the plugin (it awaits
 * them) and additionally warned, so a misconfigured host shows up in the log.
 */
export function createPluginTaskControl(pluginName: string, provider: PluginTaskProvider): PluginTaskControl {
	return {
		async marker(input: PluginMarkerInput): Promise<void> {
			try {
				await provider.marker(pluginName, input)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.task.marker failed: ${String(error)}`)
				throw error
			}
		},
		async listMarkers(taskId?: string): Promise<PluginMarker[]> {
			try {
				return await provider.listMarkers(pluginName, taskId)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.task.listMarkers failed: ${String(error)}`)
				throw error
			}
		},
		async rewind(ts: number, opts?: PluginRewindOptions): Promise<void> {
			try {
				await provider.rewind(pluginName, ts, opts)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.task.rewind failed: ${String(error)}`)
				throw error
			}
		},
	}
}

/**
 * The **denying** {@link PluginTaskControl} for a plugin that did not request
 * `permissions.task` (design §8). Every call throws a descriptive error and warns —
 * distinct from an *absent* `ctx.task` (no host seam), so the author gets "not granted"
 * rather than a missing API.
 */
export function createDeniedPluginTaskControl(
	pluginName: string,
	warn: (message: string) => void = warnPlugin,
): PluginTaskControl {
	const deny = (method: string): never => {
		const message =
			`[plugin:${pluginName}] ctx.task.${method} denied — the plugin declares no permissions.task grant. ` +
			`Writing to and rewinding a task's timeline is destructive; add "task": true to the manifest permissions.`
		warn(message)
		throw new Error(message)
	}
	return {
		// `async` so the throw surfaces as a rejected promise, matching the contract.
		async marker(): Promise<void> {
			deny("marker")
		},
		async listMarkers(): Promise<PluginMarker[]> {
			return deny("listMarkers")
		},
		async rewind(): Promise<void> {
			deny("rewind")
		},
	}
}
