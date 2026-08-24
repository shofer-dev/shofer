/**
 * The transport-agnostic agent surface (v3 architecture §11).
 *
 * `ShoferApi` is the minimal control plane a front-end/transport drives: create a
 * task, send follow-up messages, cancel, and subscribe to the event stream. Every
 * transport (HTTP/SSE, ACP over stdio, the controller↔executor session protocol)
 * is implemented over this one interface, and the live in-process implementation
 * (`ShoferApiAgent`) backs it with the extension's `ShoferExtensionApi`.
 *
 * Lives in `@shofer/types` (vscode-free) so both the core-side implementations and
 * the wire-protocol modules can share it.
 */

import { z } from "zod"

import { taskStateSchema } from "./history.js"
import { shoferAskSchema, shoferMessageSchema, tokenUsageSchema } from "./message.js"
import type { ProviderSettings } from "./provider-settings.js"
import type { TraceContext } from "./trace-context.js"

/** A streamed agent event. `type` is the event name; other fields are event-specific. */
export interface ServerEvent {
	type: string
	[key: string]: unknown
}

/**
 * The `ask` a task is currently blocked on, carried in a {@link TaskSnapshot}.
 *
 * A task that raised an ask BEFORE a controller attached is still blocked on it —
 * nothing on the executor resolves an interactive ask locally — so the snapshot has
 * to name it explicitly rather than leaving the controller to re-derive it from the
 * transcript. The fields are exactly what {@link ShoferApi.respondToAsk} needs to
 * answer it (`askId` routes the answer to the outstanding ask).
 */
export const outstandingAskSchema = z.object({
	/** The ask kind (`tool`, `command`, `followup`, …). */
	ask: shoferAskSchema,
	/** Stable id of the outstanding ask; echoed back in {@link AskResponse.askId}. */
	askId: z.string().optional(),
	/** The ask's payload text (tool JSON, the question, …), as rendered. */
	text: z.string().optional(),
	/** Timestamp of the ask message, which is also its identity in `messages`. */
	ts: z.number(),
})

export type OutstandingAsk = z.infer<typeof outstandingAskSchema>

/**
 * A task's state so far, as read from the host that owns it — the backfill half of
 * attaching to a running task (the live half is the task-scoped event stream).
 *
 * It is deliberately the WHOLE conversation rather than a tail: a controller that
 * attaches mid-task renders the same transcript the owning host shows, including an
 * ask raised before it attached. Tasks persist their messages, so this is readable
 * for a task that is running, idle, or long finished.
 */
export const taskSnapshotSchema = z.object({
	taskId: z.string(),
	/** The task's first prompt (its title in history) — the synthetic header's text. */
	summary: z.string().optional(),
	/** Creation timestamp (ms since epoch), when the host knows it. */
	createdAt: z.number().optional(),
	/** Lifecycle + completion rating, as the owning host currently records them. */
	state: taskStateSchema.optional(),
	/** The reduced-but-real conversation: every `ShoferMessage` the task has emitted. */
	messages: z.array(shoferMessageSchema),
	/** The ask the task is blocked on, when it is blocked on one. */
	outstandingAsk: outstandingAskSchema.optional(),
	/** Authoritative token/cost counters, so an attached view's meter is real. */
	tokenUsage: tokenUsageSchema.optional(),
})

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>

/**
 * A reference to a task that has ALREADY been created somewhere else — the answer a
 * plugin gives when it claims a task at the placement seam.
 *
 * `address` is the base URL of the owning host's ShoferApi (e.g.
 * `http://worker-3:30099`); with it the controller attaches and renders the task
 * like a local one. Without it the dispatch is recorded but not observable — a
 * dispatcher that cannot (yet) say where the task landed.
 */
export const dispatchedTaskRefSchema = z.object({
	taskId: z.string().min(1),
	address: z.string().min(1).optional(),
	token: z.string().min(1).optional(),
})

export type DispatchedTaskRef = z.infer<typeof dispatchedTaskRefSchema>

/**
 * A plugin's answer to the `"resolve-task-placement"` broadcast: either a claim
 * (the task was dispatched — here is its reference) or a failure. A plugin that
 * does not recognise the question throws, which `requestAll` reads as "no answer".
 */
export const taskPlacementAnswerSchema = z.union([
	z.object({ error: z.string().min(1) }),
	z.object({ dispatched: dispatchedTaskRefSchema }),
])

export type TaskPlacementAnswer = z.infer<typeof taskPlacementAnswerSchema>

/** Parameters of the `"resolve-task-placement"` broadcast — what the task would be. */
export interface TaskPlacementQuestion {
	/** The initial prompt the task would run with. */
	prompt: string
	/** The mode slug the front-end selected, when it did. */
	mode?: string
	/** The API-configuration profile name the front-end selected, when it did. */
	apiConfigName?: string
	/** The directory placement already resolved (`resolve-task-cwd`), when any. */
	cwd?: string
}

/**
 * Parameters for {@link ShoferApi.createTask}.
 *
 * `mode` is **required**: every task runs in a specific mode (its slug, e.g.
 * `"code"`), so the controller must always state which one. It is applied
 * per-task (via `CreateTaskOptions.initialMode`), so concurrent tasks on the same
 * executor can run in different modes without a global mode switch. Unlike
 * `apiConfiguration`, `mode` is honoured even when the node has local CLI
 * overrides — it selects behaviour, not provider credentials.
 *
 * `apiConfiguration` carries the controller's per-task API Configuration (the
 * resolved {@link ProviderSettings}: provider, model, base URL, key, …) to the
 * executor. A remote node applies it so the task runs on the SAME provider the
 * VS Code front-end picked (and it can differ per task) — UNLESS the node was
 * launched with explicit CLI overrides (`--provider`/`--model`/`--api-key`/
 * `--base-url`), in which case the node's own config wins and this is ignored.
 * Omitted for local/in-process tasks (they read the provider's live config).
 */
export interface CreateTaskInput {
	prompt: string
	mode: string
	taskId?: string
	apiConfiguration?: ProviderSettings
	/** Image data URIs to seed the task with, same shape as {@link AskResponse.images}. */
	images?: string[]
	/**
	 * The task's title, set by the controller that created it.
	 *
	 * Supplying it LOCKS the title the same way `new_task`'s `title` does: the
	 * agent's `set_task_title` tool is omitted from the tool list entirely, so
	 * it cannot rename a task whose name its controller owns. A controller that
	 * displays tasks under its own labels (a phone call, a pipeline stage) wants
	 * this — both to keep the label stable and to keep one always-available tool
	 * out of a latency-sensitive turn.
	 *
	 * Omit it and the task names itself, exactly as before.
	 */
	title?: string
	/**
	 * W3C trace context of the request creating this task, so the run the
	 * controller asked for continues the controller's trace instead of starting
	 * an unrelated one.
	 *
	 * Transport-agnostic on purpose — it rides the body, so it survives a
	 * transport with no headers. Over HTTP the standard `traceparent`/`tracestate`
	 * headers are honoured too (that is what a generic instrumented client
	 * sends), with this field winning when both are present.
	 */
	trace?: TraceContext
}

/** A reply to an outstanding `ask` (interactive tool approval / follow-up). */
export interface AskResponse {
	/** The ask-response verb (e.g. `yesButtonClicked`, `noButtonClicked`, `messageResponse`). */
	askResponse: string
	/** Optional free-text the user typed alongside the response. */
	text?: string
	/** Optional image data URIs attached to the response. */
	images?: string[]
	/** The id of the ask being answered (routes to the correct outstanding ask). */
	askId?: string
	/**
	 * Optional mode slug to switch the task to as part of this answer. Mirrors the
	 * webview picking an `ask_followup_question` suggestion that carries a `mode`:
	 * the mode switch is applied to this task before the answer is resolved. Ignored
	 * when absent.
	 */
	mode?: string
}

/** The agent control plane a transport drives. */
export interface ShoferApi {
	createTask(input: CreateTaskInput): Promise<{ taskId: string }>
	/**
	 * Send a follow-up message to a running task. `images` are data URIs, the same
	 * shape {@link AskResponse.images} carries, so a client can attach them to a
	 * follow-up exactly as it can to an approval.
	 */
	sendMessage(taskId: string, message: string, images?: string[]): Promise<void>
	cancelTask(taskId: string): Promise<void>
	/**
	 * Answer a task's outstanding `ask` (interactive tool approval / follow-up).
	 * This is the reverse of the `ask` events streamed via {@link subscribe}: the
	 * front-end drives an approval back to the owning executor, so a remote task's
	 * approvals round-trip exactly like a local task's.
	 */
	respondToAsk(taskId: string, response: AskResponse): Promise<void>

	/**
	 * The task's state so far — messages, the ask it is blocked on, lifecycle and
	 * token usage. `undefined` when the host knows no such task.
	 *
	 * The backfill half of attaching to a task that is ALREADY running: a controller
	 * reads the transcript up to now, then subscribes the task's event stream for
	 * what comes next. Without it an attaching view would start mid-conversation and
	 * would never learn about an ask raised before it arrived — which, because a
	 * served host never resolves interactive asks locally, is exactly the state a
	 * task is most likely to be found in.
	 */
	getTaskSnapshot(taskId: string): Promise<TaskSnapshot | undefined>

	// ── Reverse data channel ──────────────────────────────────────────────────────
	// A plugin-owned per-task feature for a REMOTE (shadow) task: the controller reads
	// and mutates it on the owning executor over the control plane, exactly like a local
	// task drives its own in-process plugin. One generic method carries all of them —
	// the file-changes panel, checkpoints, anything a plugin ships — so adding a feature
	// never means adding a wire method.

	/**
	 * Call a plugin running on the task's host and return its result — the generic
	 * request/response channel for a FEATURE that lives in a plugin (`ShoferPlugin.handleRequest`).
	 *
	 * Per-task plugin state (a workspace snapshot, an external job) lives wherever the
	 * task runs, so a controller rendering a REMOTE task cannot reach it in-process. This
	 * routes the call to the owning host, keeping the transport generic: a new
	 * plugin-owned feature needs no new wire method.
	 *
	 * `params`/result are plugin-defined JSON. Errors propagate to the caller — a
	 * request has someone waiting on the answer.
	 */
	pluginRequest(taskId: string, plugin: string, method: string, params?: unknown): Promise<unknown>

	/** Subscribe to the agent event stream; returns an unsubscribe fn. */
	subscribe(listener: (event: ServerEvent) => void): () => void
}
