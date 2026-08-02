import type { HistoryItem, ShoferMessage, TaskSnapshot, TaskState, TokenUsage } from "@shofer/types"

/**
 * The controller-side buffer for a task that RUNS somewhere else.
 *
 * It is not a {@link import("@shofer/core").Task}: it holds no agent, no tools, no
 * diff machinery, and it never advances a loop. It exists only to reconstruct the
 * conversation the chat view renders — backfilled once from the owning host's task
 * snapshot, then kept current by that task's event stream — plus a synthetic
 * `HistoryItem`-shaped summary so the task header has something to show.
 *
 * One instance lives for as long as a view is attached. Detaching drops it; a
 * re-attach backfills a fresh one, so there is no stale buffer to reconcile and no
 * persistent connection to a host nobody is watching.
 */
export class AttachedTask {
	/** The task's id ON THE OWNING HOST — the id every ShoferApi call addresses. */
	readonly taskId: string
	/** Base URL of the owning host's ShoferApi (`http://host:port`). */
	readonly address: string
	/** When this attachment was opened, used as the header timestamp fallback. */
	readonly attachedAt = Date.now()

	/** The task's title on the owning host (its first prompt), when it reported one. */
	private summary = ""
	/** Creation timestamp reported by the owning host, when it knows one. */
	private createdAt?: number
	/** Lifecycle + rating as last reported (snapshot, then lifecycle events). */
	private state: TaskState = { lifecycle: "running" }
	/** The reduced-but-real conversation the chat view renders. */
	private buffer: ShoferMessage[] = []
	/** Authoritative counters from the owning host, so the token meter is real. */
	private usage?: TokenUsage

	constructor(opts: { taskId: string; address: string }) {
		this.taskId = opts.taskId
		this.address = opts.address
	}

	/** The buffered conversation (the array the webview state carries). */
	get messages(): ShoferMessage[] {
		return this.buffer
	}

	/** The task's lifecycle as last reported by the owning host. */
	get lifecycle(): TaskState["lifecycle"] {
		return this.state.lifecycle
	}

	/**
	 * Adopt a freshly fetched snapshot as the whole truth: transcript, lifecycle,
	 * counters and title. Replacing (rather than merging) is the point — a re-attach
	 * must render what the host has NOW, with no tail left over from before.
	 */
	applySnapshot(snapshot: TaskSnapshot): void {
		this.buffer = [...snapshot.messages]
		this.summary = snapshot.summary ?? this.summary
		this.createdAt = snapshot.createdAt ?? this.createdAt
		if (snapshot.state) this.state = snapshot.state
		if (snapshot.tokenUsage) this.usage = snapshot.tokenUsage
	}

	/**
	 * Apply one `Message` delta from the task's event stream.
	 *
	 * Upsert by `ts`, which is a message's identity on the owning host: a `created`
	 * we already hold (because the snapshot raced the stream, or the host redelivered
	 * it) updates in place instead of duplicating, and an `updated` for a message we
	 * never saw the creation of is appended rather than dropped.
	 *
	 * An outstanding, non-auto-approved `ask` is buffered like any other message, so
	 * the chat view renders the normal approve/deny affordance; the answer travels
	 * back over `respondToAsk`.
	 */
	applyMessageDelta(message: ShoferMessage): void {
		const idx = this.buffer.findIndex((m) => m.ts === message.ts)
		if (idx === -1) this.buffer.push(message)
		else this.buffer[idx] = message
		if (this.state.lifecycle !== "running") this.state = { lifecycle: "running" }
	}

	/** Record the latest authoritative token usage from the owning host. */
	setTokenUsage(usage: TokenUsage): void {
		this.usage = usage
	}

	/** Record a lifecycle transition observed on the task's event stream. */
	setState(state: TaskState): void {
		this.state = state
	}

	/**
	 * A synthetic {@link HistoryItem} for `currentTaskItem` — what the task header
	 * renders. Counters mirror the owning host's authoritative usage, and are zero
	 * until it reports any; nothing here is estimated locally.
	 */
	toTaskItem(): HistoryItem {
		return {
			id: this.taskId,
			number: 0,
			ts: this.createdAt ?? this.attachedAt,
			task: this.summaryText(),
			tokensIn: this.usage?.totalTokensIn ?? 0,
			tokensOut: this.usage?.totalTokensOut ?? 0,
			cacheReads: this.usage?.totalCacheReads,
			cacheWrites: this.usage?.totalCacheWrites,
			totalCost: this.usage?.totalCost ?? 0,
			taskState: this.state,
		}
	}

	/** The header text: the host's title, else the first non-empty message text. */
	private summaryText(): string {
		if (this.summary) return this.summary
		return this.buffer.find((m) => m.text && m.text.trim().length > 0)?.text ?? this.taskId
	}
}
