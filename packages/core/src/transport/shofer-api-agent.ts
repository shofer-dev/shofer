import { type ShoferAPI, ShoferEventName } from "@shofer/types"

import type {
	AgentApi,
	AskResponse,
	CreateTaskInput,
	OutstandingAsk,
	ServerEvent,
	ShoferMessage,
	TaskSnapshot,
} from "@shofer/types"

/** Construction options for {@link ShoferApiAgent}. */
export interface ShoferApiAgentOptions {
	/**
	 * Whether to honor the per-task `apiConfiguration` a controller ships with
	 * {@link AgentApi.createTask}. `true` on a `shofer serve` node started WITHOUT
	 * explicit CLI provider/model/api-key/base-url overrides, so the front-end's
	 * API Configuration drives each task (and can differ per task). `false` when
	 * the node has a manual CLI override — the node's own config always wins and
	 * the incoming config is ignored. Defaults to `false` (the in-process/local
	 * adapter, which never receives a remote config anyway).
	 */
	allowClientConfig?: boolean
}

/**
 * Live {@link AgentApi} backed by the in-process {@link ShoferAPI} (§11).
 *
 * This is the adapter that connects the HTTP/SSE transport to the real agent: the
 * HTTP server (`createHttpServer`) becomes drivable by instantiating it with
 * `new ShoferApiAgent(api)`. The remaining wiring is an entrypoint that calls
 * `server.listen(...)` (a `shofer serve` command / extension command); running it
 * fully headless is gated on §9.
 *
 * `ShoferAPI` is itself an `AgentApi` now, so this class carries only what the
 * interface cannot: the `allowClientConfig` gate on a client-supplied per-task
 * provider config, and rehydrating an addressed task before delivering to it.
 * Everything else delegates straight through.
 */

/** Agent events a transport forwards to its subscribers. */
export const FORWARDED_EVENTS = [
	ShoferEventName.TaskCreated,
	ShoferEventName.TaskStarted,
	ShoferEventName.TaskCompleted,
	ShoferEventName.TaskAborted,
	ShoferEventName.TaskError,
	ShoferEventName.Message,
	ShoferEventName.TaskModeSwitched,
	ShoferEventName.TaskTitleChanged,
	// Full-fidelity remote rendering: a client's token/context meter needs
	// authoritative token usage from the executor.
	ShoferEventName.TaskTokenUsageUpdated,
] as const

/**
 * The ask a task is blocked on, or `undefined` when it is not blocked.
 *
 * The rule is the transcript's own: a task is waiting on an ask exactly when the LAST
 * message is a complete (`partial !== true`) ask that was neither auto-approved nor
 * already answered. Anything after it — a tool result, the next assistant turn — means
 * the ask was resolved and the loop moved on. This is the same shape the chat view
 * uses to decide whether to show approve/deny, which is what keeps an attached view's
 * affordances identical to the owning host's.
 */
export function findOutstandingAsk(messages: ShoferMessage[]): OutstandingAsk | undefined {
	const last = messages[messages.length - 1]
	if (!last || last.type !== "ask" || !last.ask) return undefined
	if (last.partial === true || last.autoApproved === true || last.isAnswered === true) return undefined
	return { ask: last.ask, askId: last.askId, text: last.text, ts: last.ts }
}

export class ShoferApiAgent implements AgentApi {
	constructor(
		private readonly api: ShoferAPI,
		private readonly options: ShoferApiAgentOptions = {},
	) {}

	async createTask(input: CreateTaskInput): Promise<{ taskId: string }> {
		// Apply the client's per-task API Configuration only when this host has no
		// local CLI override (`allowClientConfig`). `mode` is applied regardless of
		// that gate: it selects behaviour, not credentials.
		const apiConfiguration = this.options.allowClientConfig ? input.apiConfiguration : undefined
		return this.api.createTask({ ...input, apiConfiguration })
	}

	async sendMessage(taskId: string, message: string, images?: string[]): Promise<void> {
		// Ensure the addressed task has a live instance (rehydrates from the task
		// store after a host restart; no-op when it is already live), then deliver.
		await this.api.resumeTask(taskId).catch(() => {})
		await this.api.sendMessage(taskId, message, images)
	}

	cancelTask(taskId: string): Promise<void> {
		return this.api.cancelTask(taskId)
	}

	respondToAsk(taskId: string, response: AskResponse): Promise<void> {
		return this.api.respondToAsk(taskId, response)
	}

	getTaskSnapshot(taskId: string): Promise<TaskSnapshot | undefined> {
		return this.api.getTaskSnapshot(taskId)
	}

	pluginRequest(taskId: string, plugin: string, method: string, params?: unknown): Promise<unknown> {
		return this.api.pluginRequest(taskId, plugin, method, params)
	}

	subscribe(listener: (event: ServerEvent) => void): () => void {
		return this.api.subscribe(listener)
	}
}
