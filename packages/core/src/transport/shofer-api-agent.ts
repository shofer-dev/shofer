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
 * Note: `ShoferAPI` is current-task-centric (`sendMessage`/`cancelCurrentTask`
 * have no task id), so `sendMessage(taskId, …)` resumes that task first. A future
 * multi-session API would let the transport address tasks directly.
 */
const FORWARDED_EVENTS = [
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
function findOutstandingAsk(messages: ShoferMessage[]): OutstandingAsk | undefined {
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
		// Apply the controller's per-task API Configuration only when this node has
		// no local CLI override (`allowClientConfig`). `configuration` is a partial
		// ShoferSettings; ProviderSettings is a subset of it, so it seeds the task's
		// provider/model/base-url/key for this task.
		const configuration =
			this.options.allowClientConfig && input.apiConfiguration ? input.apiConfiguration : undefined
		// `mode` is required and always applied per-task (independent of the config
		// gate above): it selects behaviour, not credentials. Passed as `initialMode`
		// so concurrent tasks can run different modes without a global mode switch.
		const taskId = await this.api.startNewTask({
			text: input.prompt,
			taskId: input.taskId,
			initialMode: input.mode,
			configuration,
		})
		return { taskId }
	}

	async sendMessage(taskId: string, message: string): Promise<void> {
		// Ensure the addressed task has a live instance (rehydrates from the task
		// store after an executor restart; no-op when it is already live), then
		// deliver task-addressed — never current-task-centric, which both raced
		// concurrent tasks and, in headless hosts, routed into a webview invoke
		// that nothing consumes.
		await this.api.resumeTask(taskId).catch(() => {})
		await this.api.sendMessage(message, undefined, taskId)
	}

	async cancelTask(taskId: string): Promise<void> {
		void taskId // ShoferAPI is current-task-centric; the id is implied.
		await this.api.cancelCurrentTask()
	}

	async respondToAsk(taskId: string, response: AskResponse): Promise<void> {
		await this.api.respondToAsk(taskId, response)
	}

	/**
	 * Assemble the task's snapshot from this host's own records: the conversation and
	 * live counters from {@link ShoferAPI.getTaskConversation}, the lifecycle and title
	 * from the task-history entry, and the outstanding ask derived from the transcript
	 * tail (see {@link findOutstandingAsk}).
	 *
	 * Deriving the ask here rather than reading it off a task instance is deliberate:
	 * the same rule then applies to a live task and to one rehydrated from disk, and
	 * the controller does not need a second wire method to learn it is blocked.
	 */
	async getTaskSnapshot(taskId: string): Promise<TaskSnapshot | undefined> {
		const conversation = await this.api.getTaskConversation(taskId)
		if (!conversation) return undefined

		const item = this.api.getTaskHistoryItems().find((entry) => entry.id === taskId)
		const messages = conversation.messages
		return {
			taskId,
			summary: item?.task,
			createdAt: item?.ts,
			state: item?.taskState,
			messages,
			outstandingAsk: findOutstandingAsk(messages),
			tokenUsage: conversation.tokenUsage,
		}
	}

	// ── Reverse data channel — delegate to the in-process API ─────────────────────

	pluginRequest(taskId: string, plugin: string, method: string, params?: unknown): Promise<unknown> {
		return this.api.pluginRequest(taskId, plugin, method, params)
	}

	subscribe(listener: (event: ServerEvent) => void): () => void {
		const handlers = FORWARDED_EVENTS.map((name) => {
			const handler = (...args: unknown[]) => listener({ type: name, args })
			this.api.on(name as never, handler as never)
			return { name, handler }
		})
		return () => {
			for (const { name, handler } of handlers) {
				this.api.off(name as never, handler as never)
			}
		}
	}
}
