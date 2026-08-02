import { ShoferEventName, type AskResponse, type ExtensionMessage, type ServerEvent } from "@shofer/types"
import type { ShoferMessage, TaskSnapshot, TokenUsage } from "@shofer/types"
import { ShoferHttpClient } from "@shofer/core"
import { t } from "@shofer/core"

import { AttachedTask } from "./AttachedTask"

/**
 * Attach a view to a task running on another host — the one generic remote-agent
 * capability core keeps.
 *
 * Given `(address, taskId, token)` it does three things and nothing else:
 * **backfill** the task's snapshot, **subscribe** that task's event stream, and
 * **render** the result into the chat view of the attaching view, with asks,
 * follow-up messages and cancel travelling back over the same ShoferApi. Detaching
 * closes the connection; the task is unaffected, and a re-attach starts from a fresh
 * snapshot.
 *
 * Deliberately NOT a fleet layer: it holds no registry of hosts, no pool, no
 * connection kept alive for a host nobody is watching, and it never decides where a
 * task should run. A dispatcher (a plugin) decides that and hands the reference here.
 *
 * **Per-view focus.** Attachments are keyed by view, so the sidebar and an editor tab
 * can watch different remote tasks at once — and either can watch a remote task while
 * the other runs a local one.
 */

/** Where a remote task lives and what it takes to talk to it. */
export interface AttachTarget {
	/** Base URL of the owning host's ShoferApi, e.g. `http://worker-3:30099`. */
	address: string
	/** The task's id on that host. */
	taskId: string
	/**
	 * The host's bearer token. Taken per invocation and held only for the life of
	 * the attachment — it is machine trust for another host, and persisting it here
	 * would make this host a store of other hosts' credentials.
	 */
	token?: string
}

/**
 * The subset of the ShoferApi client an attachment drives. Structural, so
 * {@link ShoferHttpClient} satisfies it and a test can supply a fake without a
 * server.
 */
export interface AttachClient {
	getTaskSnapshot(taskId: string): Promise<TaskSnapshot | undefined>
	subscribeTask(taskId: string, listener: (event: ServerEvent) => void): () => void
	sendMessage(taskId: string, message: string): Promise<void>
	cancelTask(taskId: string): Promise<void>
	respondToAsk(taskId: string, response: AskResponse): Promise<void>
}

/**
 * What an attachment needs from the view it renders into. Structural so the manager
 * does not import `ShoferProvider` (which imports it back).
 */
export interface AttachViewHost {
	postMessageToWebview(message: ExtensionMessage): Promise<void> | void
	postInitState(): Promise<void>
}

interface Attachment {
	task: AttachedTask
	client: AttachClient
	unsubscribe: () => void
}

export class TaskAttachmentManager {
	private static instance: TaskAttachmentManager | undefined

	/** One attachment per view — this is what makes the focus per-view. */
	private readonly attachments = new Map<AttachViewHost, Attachment>()

	constructor(private readonly createClient: (target: AttachTarget) => AttachClient = defaultClientFactory) {}

	/** The process-wide manager (views come and go; the map outlives them). */
	static getInstance(): TaskAttachmentManager {
		if (!TaskAttachmentManager.instance) TaskAttachmentManager.instance = new TaskAttachmentManager()
		return TaskAttachmentManager.instance
	}

	/** The remote task this view is currently rendering, if any. */
	get(view: AttachViewHost): AttachedTask | undefined {
		return this.attachments.get(view)?.task
	}

	/** Whether this view is attached to that specific remote task. */
	isAttachedTo(view: AttachViewHost, taskId: string | undefined): boolean {
		if (!taskId) return false
		return this.attachments.get(view)?.task.taskId === taskId
	}

	/**
	 * Attach `view` to a remote task: subscribe first, then backfill, then render.
	 *
	 * The order matters. Subscribing before the snapshot means an event fired while
	 * the snapshot is in flight is buffered rather than lost; the buffered deltas are
	 * then replayed onto the snapshot, and because deltas upsert by `ts` the overlap
	 * between "already in the snapshot" and "arrived during the fetch" resolves
	 * itself. Fetching first and subscribing after would leave a hole exactly where
	 * a busy task is most likely to speak.
	 *
	 * Throws when the host has no such task (or is unreachable) — the caller reports
	 * it; a half-attached view showing an empty conversation would be worse.
	 */
	async attach(view: AttachViewHost, target: AttachTarget): Promise<AttachedTask> {
		this.detach(view, { silent: true })

		const client = this.createClient(target)
		const task = new AttachedTask({ taskId: target.taskId, address: target.address })

		let backfilled = false
		const pending: ShoferMessage[] = []
		const unsubscribe = client.subscribeTask(target.taskId, (event) => {
			if (!backfilled) {
				const message = messageFromEvent(event)
				if (message) pending.push(message)
				return
			}
			void this.onEvent(view, event)
		})

		let snapshot: TaskSnapshot | undefined
		try {
			snapshot = await client.getTaskSnapshot(target.taskId)
		} catch (error) {
			unsubscribe()
			throw new Error(
				t("common:attach.errors.unreachable", {
					address: target.address,
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		}
		if (!snapshot) {
			unsubscribe()
			throw new Error(t("common:attach.errors.no_such_task", { taskId: target.taskId, address: target.address }))
		}

		task.applySnapshot(snapshot)
		for (const message of pending) task.applyMessageDelta(message)
		backfilled = true

		this.attachments.set(view, { task, client, unsubscribe })
		await view.postInitState()
		return task
	}

	/**
	 * Detach this view. The connection is torn down; the remote task keeps running,
	 * keeps buffering nothing here, and can be attached to again at any time.
	 */
	detach(view: AttachViewHost, opts: { silent?: boolean } = {}): AttachedTask | undefined {
		const attachment = this.attachments.get(view)
		if (!attachment) return undefined
		attachment.unsubscribe()
		this.attachments.delete(view)
		if (!opts.silent) void view.postInitState()
		return attachment.task
	}

	/** Answer the attached task's outstanding ask on its owning host. */
	async respondToAsk(view: AttachViewHost, response: AskResponse): Promise<void> {
		const attachment = this.require(view)
		await attachment.client.respondToAsk(attachment.task.taskId, response)
	}

	/** Send a follow-up message to the attached task. */
	async sendMessage(view: AttachViewHost, message: string): Promise<void> {
		const attachment = this.require(view)
		await attachment.client.sendMessage(attachment.task.taskId, message)
	}

	/** Cancel the attached task on its owning host (the view stays attached). */
	async cancelTask(view: AttachViewHost): Promise<void> {
		const attachment = this.require(view)
		await attachment.client.cancelTask(attachment.task.taskId)
	}

	private require(view: AttachViewHost): Attachment {
		const attachment = this.attachments.get(view)
		if (!attachment) throw new Error(t("common:attach.errors.not_attached"))
		return attachment
	}

	/**
	 * Fold one event off the task's stream into the buffer and mirror it to the
	 * webview — the same two posts a local task makes, so an attached conversation
	 * streams exactly like an in-process one.
	 */
	private async onEvent(view: AttachViewHost, event: ServerEvent): Promise<void> {
		const attachment = this.attachments.get(view)
		if (!attachment) return
		const { task } = attachment
		const args = (event.args as unknown[] | undefined) ?? []

		switch (event.type) {
			case ShoferEventName.Message: {
				const payload = args[0] as
					| { taskId?: string; action?: "created" | "updated"; message?: ShoferMessage }
					| undefined
				if (!payload?.message || payload.taskId !== task.taskId) return
				task.applyMessageDelta(payload.message)
				await view.postMessageToWebview(
					payload.action === "created"
						? { type: "shoferMessageAppended", shoferMessage: payload.message }
						: { type: "messageUpdated", shoferMessage: payload.message },
				)
				return
			}
			case ShoferEventName.TaskTokenUsageUpdated: {
				const usage = args[1] as TokenUsage | undefined
				if (!usage) return
				task.setTokenUsage(usage)
				await view.postInitState()
				return
			}
			case ShoferEventName.TaskStarted: {
				task.setState({ lifecycle: "running" })
				await view.postInitState()
				return
			}
			case ShoferEventName.TaskCompleted: {
				const info = args[3] as { rating?: "poor" | "well" | "excellent" } | undefined
				task.setState({ lifecycle: "completed", rating: info?.rating })
				await view.postInitState()
				return
			}
			case ShoferEventName.TaskAborted: {
				// `TaskAborted` is self-contained: its reason says whether the task
				// stopped because it broke or because someone stopped it.
				const reason = (args[1] as { reason?: string } | undefined)?.reason
				task.setState({ lifecycle: reason === "error" ? "error" : "paused" })
				await view.postInitState()
				return
			}
			case ShoferEventName.TaskError: {
				task.setState({ lifecycle: "error" })
				await view.postInitState()
				return
			}
			default:
				// The stream is an open-ended superset; an event this render path has
				// no use for is simply not rendered.
				return
		}
	}
}

/** The `Message` payload of a forwarded event, when it is one. */
function messageFromEvent(event: ServerEvent): ShoferMessage | undefined {
	if (event.type !== ShoferEventName.Message) return undefined
	const payload = (event.args as unknown[] | undefined)?.[0] as { message?: ShoferMessage } | undefined
	return payload?.message
}

/** Real transport: the HTTP/SSE client, scoped to one attachment. */
function defaultClientFactory(target: AttachTarget): AttachClient {
	return new ShoferHttpClient({ baseUrl: target.address, token: target.token })
}
