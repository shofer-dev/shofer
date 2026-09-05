import { type ShoferExtensionApi, ShoferEventName, pickClientTunableSettings } from "@shofer/types"

import type {
	ShoferApi,
	AskResponse,
	CreateTaskInput,
	Envelope,
	OutstandingAsk,
	ServerEvent,
	ShoferMessage,
	TaskSnapshot,
	TraceContext,
} from "@shofer/types"

/** Construction options for {@link ShoferApiAgent}. */
export interface ShoferApiAgentOptions {
	/**
	 * Whether to honor the per-task `apiConfiguration` a controller ships with
	 * {@link ShoferApi.createTask}. `true` on a `shofer serve` node started WITHOUT
	 * explicit CLI provider/model/api-key/base-url overrides, so the front-end's
	 * API Configuration drives each task (and can differ per task). `false` when
	 * the node has a manual CLI override — the node's own config always wins and
	 * the incoming config is ignored. Defaults to `false` (the in-process/local
	 * adapter, which never receives a remote config anyway).
	 */
	allowClientConfig?: boolean
}

/**
 * Live {@link ShoferApi} backed by the in-process {@link ShoferExtensionApi} (§11).
 *
 * This is the adapter that connects the HTTP/SSE transport to the real agent: the
 * HTTP server (`createHttpServer`) becomes drivable by instantiating it with
 * `new ShoferApiAgent(api)`. The remaining wiring is an entrypoint that calls
 * `server.listen(...)` (a `shofer serve` command / extension command); running it
 * fully headless is gated on §9.
 *
 * `ShoferExtensionApi` is itself a `ShoferApi` now, so this class carries only what the
 * interface cannot: the `allowClientConfig` gate on a client-supplied per-task
 * provider config, and rehydrating an addressed task before delivering to it.
 * Everything else delegates straight through.
 */

/**
 * Agent events a transport forwards to its subscribers.
 *
 * The set is the task's LIFECYCLE, not the host's internals: everything here is
 * a fact about a task the controller drives, and every one of them is already
 * re-emitted host-wide with the task id as its first argument (which is what the
 * per-task stream filter reads). Deliberately absent: `taskFocused` /
 * `taskUnfocused` (which window a human is looking at — the host's own UI
 * state), `queuedMessagesUpdated` (an echo of what the controller itself sent),
 * and the configuration/query-response events, which describe the host rather
 * than any task.
 *
 * The rule to apply when adding one: a controller with no view onto this host
 * must be able to act on it, and it must carry its task id.
 */
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

	// Blocking states. A controller that cannot see these cannot tell a task
	// waiting on a human from one that is thinking, which is the difference
	// between "show the approval" and "show a spinner" — and, on a headless
	// controller, between escalating an ask and letting it sit forever.
	ShoferEventName.TaskActive,
	ShoferEventName.TaskInteractive,
	ShoferEventName.TaskResumable,
	ShoferEventName.TaskIdle,
	// The other half of that pair: an ask stopped being outstanding. Without it a
	// controller only learns an approval was resolved by re-reading the transcript.
	ShoferEventName.TaskAskResponded,

	// Delegation. A task that spawns children is a tree, and the edges are only
	// ever announced here — a controller watching the parent otherwise sees a
	// silent gap where the child's whole run happened.
	ShoferEventName.TaskPaused,
	ShoferEventName.TaskUnpaused,
	ShoferEventName.TaskSpawned,
	ShoferEventName.TaskDelegated,
	ShoferEventName.TaskDelegationResumed,

	// A tool failed, named. The transcript carries the failure text; this carries
	// which tool, which is what an observer aggregates on.
	ShoferEventName.TaskToolFailed,
] as const

/**
 * The ask a task is blocked on, or `undefined` when it is not blocked.
 *
 * The rule is the transcript's own: a task is waiting on an ask exactly when the LAST
 * message is a complete (`partial !== true`) ask that was neither auto-approved, nor
 * already answered, nor withdrawn. Anything after it — a tool result, the next assistant turn — means
 * the ask was resolved and the loop moved on. This is the same shape the chat view
 * uses to decide whether to show approve/deny, which is what keeps an attached view's
 * affordances identical to the owning host's.
 */
export function findOutstandingAsk(messages: ShoferMessage[]): OutstandingAsk | undefined {
	const last = messages[messages.length - 1]
	if (!last || last.type !== "ask" || !last.ask) return undefined
	if (last.partial === true || last.autoApproved === true || last.isAnswered === true) return undefined
	// A withdrawn ask is finalized but was never a decision: the tool call it
	// previewed was abandoned before it executed, so there is nothing to approve.
	if (last.abandoned === true) return undefined
	return { ask: last.ask, askId: last.askId, text: last.text, ts: last.ts }
}

export class ShoferApiAgent implements ShoferApi {
	constructor(
		private readonly api: ShoferExtensionApi,
		private readonly options: ShoferApiAgentOptions = {},
	) {}

	async createTask(input: CreateTaskInput): Promise<{ taskId: string }> {
		// Apply the client's per-task API Configuration only when this host has no
		// local CLI override (`allowClientConfig`). `mode` is applied regardless of
		// that gate: it selects behaviour, not credentials.
		//
		// A pinned host is not fully deaf, though. The pin protects credentials and
		// model identity; it was never meant to freeze how the pinned model
		// BEHAVES, and an all-or-nothing gate made the whole `apiConfiguration`
		// parameter dead on every deployed worker (they all pass `--provider`), so
		// a controller could not turn reasoning off for a latency-sensitive turn.
		// `CLIENT_TUNABLE_PROVIDER_SETTINGS` is the behaviour-only subset that
		// survives the pin — the same distinction `mode` already relies on.
		const apiConfiguration = this.options.allowClientConfig
			? input.apiConfiguration
			: pickClientTunableSettings(input.apiConfiguration)
		return this.api.createTask({ ...input, apiConfiguration })
	}

	sendMessage(taskId: string, message: string, images?: string[], trace?: TraceContext): Promise<void> {
		// Straight through. This used to `resumeTask` first, to give the addressed
		// task a live instance before delivering — but rehydration RAISES a resume
		// ask, and resuming with nothing queued to answer it hands that ask to
		// whoever watches asks (on a headless node, the CLI ask dispatcher, which
		// spends the `--retry` budget and then declines). Delivery owns the
		// rehydration now, and does it queue-first so the message itself answers
		// the resume ask. Sequencing them here could only re-open that race.
		return this.api.sendMessage(taskId, message, images, trace)
	}

	cancelTask(taskId: string): Promise<void> {
		return this.api.cancelTask(taskId)
	}

	respondToAsk(taskId: string, response: AskResponse): Promise<void> {
		return this.api.respondToAsk(taskId, response)
	}

	deliverToMailbox(taskId: string, envelope: Envelope): Promise<void> {
		// Straight through, and deliberately NOT preceded by a resume: delivery
		// owns rehydration (queue-first, so the wake turn answers the resume ask
		// itself), exactly as `sendMessage` does.
		return this.api.deliverToMailbox(taskId, envelope)
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
