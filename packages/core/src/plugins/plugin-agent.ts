/**
 * plugin-agent — the proactive **agent-steering** capability handed to a plugin via
 * `ctx.agent` (design §6.11 G8; Phase 7, P7).
 *
 * A plugin granted `permissions.agent` gets a live {@link PluginAgent} that can inject a
 * message into the running agent — from a background service ({@link
 * PluginContext.registerService}), a file watcher ({@link PluginHost.watch}), or a
 * lifecycle hook — e.g. "the deploy just failed, here's the log." This is powerful (a
 * plugin steering the agent has billed/behavioral impact), so it is gated on a dedicated
 * grant.
 *
 * The *injection* is host-side (it needs the provider's task manager / message queue), so
 * `@shofer/core` stays host-agnostic by consuming a {@link PluginAgentProvider} seam the
 * extension/CLI supplies — mirroring {@link PluginAiProvider}. Two states:
 * - `permissions.agent` granted ⇒ {@link createPluginAgent}: delegates to the host seam.
 * - `permissions.agent` ungranted (but the host wired the seam) ⇒ {@link
 *   createDeniedPluginAgent}: every call throws + warns (a plugin can never silently
 *   steer the agent without the grant).
 *
 * When the host wires **no** agent seam (headless/pure-core), the manager omits `ctx.agent`
 * entirely — there is nothing to steer.
 */

import type { PluginAgent, PluginAgentNotifyOptions, PluginAgentSpawnOptions, PluginTaskHandle } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Host seam that injects a plugin's `notify` message into the agent (P7). Supplied by the
 * extension/CLI where the task manager / message queue live, so core never imports the
 * provider. Resolves the target task (an explicit `opts.taskId`, else the active task),
 * enqueues the message (`mode: "queue"`/`"interrupt"`) or starts a new task
 * (`mode: "spawn"`).
 */
export interface PluginAgentProvider {
	/** Deliver `message` to the agent per `opts` (default `mode: "queue"`). */
	notify(message: string, opts?: PluginAgentNotifyOptions): Promise<void>
	/** Start a task and return an awaitable, cancellable handle (§14). */
	spawn(prompt: string, opts?: PluginAgentSpawnOptions): Promise<PluginTaskHandle>
	/** Cancel a task by id (§14). No-op if not found. */
	cancel(taskId: string): Promise<void>
}

/**
 * The live {@link PluginAgent} for a granted plugin: delegates to the host
 * {@link PluginAgentProvider}. Errors from the provider are surfaced to the plugin (it
 * awaits the promise) and additionally warned so a misconfigured host is visible in the log.
 */
export function createPluginAgent(pluginName: string, provider: PluginAgentProvider): PluginAgent {
	return {
		async notify(message: string, opts?: PluginAgentNotifyOptions): Promise<void> {
			try {
				await provider.notify(message, opts)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.agent.notify failed: ${String(error)}`)
				throw error
			}
		},
		async spawn(prompt: string, opts?: PluginAgentSpawnOptions): Promise<PluginTaskHandle> {
			try {
				return await provider.spawn(prompt, opts)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.agent.spawn failed: ${String(error)}`)
				throw error
			}
		},
		async cancel(taskId: string): Promise<void> {
			try {
				await provider.cancel(taskId)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.agent.cancel failed: ${String(error)}`)
				throw error
			}
		},
	}
}

/**
 * The **denying** {@link PluginAgent} for a plugin that did **not** request
 * `permissions.agent` (design §8). Every call throws a descriptive error and emits a
 * shown + logged warning — the plugin fails loudly rather than silently steering the agent.
 * Distinct from an *absent* `ctx.agent` (no host seam): here the field is present so a
 * plugin author gets a clear "not granted" error rather than a missing API.
 */
export function createDeniedPluginAgent(pluginName: string, warn: (message: string) => void = warnPlugin): PluginAgent {
	const deny = (method: string): never => {
		const message =
			`[plugin:${pluginName}] ctx.agent.${method} denied — the plugin declares no permissions.agent grant. ` +
			`Steering the agent is billed/behavioral; add "agent": true to the manifest permissions.`
		warn(message)
		throw new Error(message)
	}
	return {
		// `async` so the throw surfaces as a rejected promise (matching the
		// `Promise`-returning contract), not a synchronous throw at the call site.
		async notify(): Promise<void> {
			deny("notify")
		},
		async spawn(): Promise<never> {
			return deny("spawn")
		},
		async cancel(): Promise<void> {
			deny("cancel")
		},
	}
}
