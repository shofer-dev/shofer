/**
 * plugin-agent — the proactive **agent-steering** capability handed to a plugin via
 * `ctx.agent` (design §6.11 G8; Phase 7, P7).
 *
 * A plugin granted `permissions.agent` gets a live {@link PluginAgent} that can put a
 * message in front of a task — from a background service ({@link
 * PluginContext.registerService}), a file watcher ({@link PluginHost.watch}), or a
 * lifecycle hook — e.g. "the deploy just failed, here's the log." This is powerful (a
 * plugin steering the agent has billed/behavioral impact), so it is gated on a dedicated
 * grant.
 *
 * There is exactly **one delivery door**, `deliver`, and it takes an envelope
 * (`task_messaging.md`): whatever plane a message arrived on, it lands in the target
 * task's mailbox, and the envelope's own `wake`/`deadline`/`kind` carry what a delivery
 * MODE used to. A plugin also registers a **mailbox transport** here, which is the
 * reverse direction: how an envelope addressed to a task this node does not hold leaves
 * the node.
 *
 * The delivery itself is host-side (it needs the provider's task manager and task
 * persistence), so `@shofer/core` stays host-agnostic by consuming a
 * {@link PluginAgentProvider} seam the extension/CLI supplies — mirroring
 * {@link PluginAiProvider}. Two states:
 * - `permissions.agent` granted ⇒ {@link createPluginAgent}: delegates to the host seam.
 * - `permissions.agent` ungranted (but the host wired the seam) ⇒ {@link
 *   createDeniedPluginAgent}: every call throws + warns (a plugin can never silently
 *   steer the agent without the grant).
 *
 * When the host wires **no** agent seam (headless/pure-core), the manager omits `ctx.agent`
 * entirely — there is nothing to steer.
 */

import type {
	Envelope,
	PluginAgent,
	PluginAgentSpawnOptions,
	PluginDeliverInput,
	PluginMailboxTransport,
	PluginTaskHandle,
} from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Host seam backing `ctx.agent` (P7). Supplied by the extension/CLI where the task
 * manager and task persistence live, so core never imports the provider.
 *
 * `deliver` resolves the target task (an explicit `input.taskId`, else the active one),
 * completes the envelope and hands it to that task's mailbox — rehydrating a dormant task
 * when the envelope asks to wake it. It REFUSES when there is no target rather than
 * starting a task: a delivery must never become a billed spawn nobody asked for.
 */
export interface PluginAgentProvider {
	/** Deliver an envelope into a task's mailbox; resolves once the box persisted it. */
	deliver(input: PluginDeliverInput): Promise<Envelope>
	/** Register a route for envelopes this node cannot address locally; returns an unregister fn. */
	registerMailboxTransport(transport: PluginMailboxTransport): () => void
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
		async deliver(envelope: PluginDeliverInput): Promise<Envelope> {
			try {
				return await provider.deliver(envelope)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.agent.deliver failed: ${String(error)}`)
				throw error
			}
		},
		// Synchronous by contract: registration is bookkeeping, and a plugin registering
		// its transport during `start` must be able to do it without an await point that
		// could interleave with the first delivery.
		registerMailboxTransport(transport: PluginMailboxTransport): () => void {
			try {
				return provider.registerMailboxTransport(transport)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.agent.registerMailboxTransport failed: ${String(error)}`)
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
		async deliver(): Promise<never> {
			return deny("deliver")
		},
		// Synchronous, matching the granted surface: a caller that stored the returned
		// unregister function would otherwise get `undefined` instead of an error.
		registerMailboxTransport(): () => void {
			return deny("registerMailboxTransport")
		},
		async spawn(): Promise<never> {
			return deny("spawn")
		},
		async cancel(): Promise<void> {
			deny("cancel")
		},
	}
}
