import type { HistoryItem, ShoferMessage, TokenUsage } from "@shofer/types"

/**
 * Lifecycle state of a remote-owned task, as observed from the controller side.
 * A shadow never "runs" locally — it only reflects the `Message`/lifecycle event
 * stream the owning node emits over the pool feed.
 */
export type RemoteTaskStatus = "created" | "running" | "completed" | "aborted" | "error"

/**
 * A lightweight, controller-side buffer for a task that RUNS on a remote node
 * (Shofer Nodes L2). It is deliberately **not** a `taskManager`-managed {@link
 * import("../task/Task.js")} — it holds no agent, no tools, no file-diff
 * machinery. It exists only to reconstruct the reduced-but-real conversation the
 * webview renders from the remote's high-fidelity `Message` stream, plus a
 * synthetic `currentTaskItem`-shaped summary so the TaskHeader has something to
 * show.
 *
 * The registry owns one shadow per remote task (`Map<taskId, RemoteTaskShadow>`),
 * feeds it demuxed pool events, and — when the shadow is the focused task —
 * mirrors its deltas to the webview exactly like a local Task does.
 */
export class RemoteTaskShadow {
	readonly taskId: string
	readonly executorId: string
	/** Human-friendly node label (for the synthetic summary / notices). */
	readonly nodeLabel: string
	readonly createdAt = Date.now()
	/** The originating prompt, when known (remote lifecycle events don't carry it). */
	readonly prompt: string

	status: RemoteTaskStatus = "created"
	/** Last error type/message, when `status === "error"`. */
	error?: string
	/** The reduced-but-real conversation, driven by the remote `Message` stream. */
	messages: ShoferMessage[] = []
	/**
	 * Latest authoritative token usage from the remote's `TaskTokenUsageUpdated`
	 * feed. Surfaced in the synthetic header summary so the controller's token
	 * meter / cost display reflect the remote task (full-fidelity rendering, L2).
	 */
	tokenUsage?: TokenUsage
	constructor(opts: { taskId: string; executorId: string; nodeLabel: string; prompt?: string }) {
		this.taskId = opts.taskId
		this.executorId = opts.executorId
		this.nodeLabel = opts.nodeLabel
		this.prompt = opts.prompt ?? ""
	}

	/**
	 * Apply a `Message` delta from the remote feed.
	 * - `created` → append (dedupe by `ts`; a redelivered create updates in place).
	 * - `updated` → in-place update by `ts` (append if we never saw the create).
	 *
	 * A non-auto-approved `ask` is buffered like any other message: the webview
	 * renders the normal approve/deny affordance and the answer round-trips to the
	 * executor via the reverse ask channel (NodeRegistry.respondToAsk).
	 */
	applyMessageDelta(action: "created" | "updated", message: ShoferMessage): void {
		const idx = this.messages.findIndex((m) => m.ts === message.ts)
		if (idx === -1) this.messages.push(message)
		else this.messages[idx] = message

		if (this.status === "created") this.status = "running"
	}

	markStarted(): void {
		if (this.status === "created") this.status = "running"
	}

	markCompleted(): void {
		this.status = "completed"
	}

	markAborted(): void {
		this.status = "aborted"
	}

	markError(errorType?: string): void {
		this.status = "error"
		this.error = errorType
	}

	/** Record the latest token usage from the remote's `TaskTokenUsageUpdated` feed. */
	setTokenUsage(usage: TokenUsage): void {
		this.tokenUsage = usage
	}

	/**
	 * Drop the buffered conversation (Shofer Nodes L3 rebuild). When the executor
	 * rewinds its task it reinitializes and re-emits the
	 * post-rewind `Message` stream; clearing here lets those deltas repopulate the
	 * shadow so its conversation matches the executor, with no stale tail.
	 */
	clearMessages(): void {
		this.messages = []
		this.status = "running"
	}

	/** First non-empty user/prompt text, for the header summary. */
	private summaryText(): string {
		if (this.prompt) return this.prompt
		const firstText = this.messages.find((m) => m.text && m.text.trim().length > 0)?.text
		return firstText ?? "(remote task)"
	}

	/**
	 * A synthetic {@link HistoryItem}-shaped summary for `currentTaskItem`. Token
	 * counts and cost mirror the remote's authoritative usage (shared-fs L2: the
	 * remote task renders at full fidelity, so its token meter / cost surface just
	 * like a local task's). Zeroed until the first `TaskTokenUsageUpdated` arrives.
	 */
	toTaskItem(): HistoryItem {
		const usage = this.tokenUsage
		return {
			id: this.taskId,
			number: 0,
			ts: this.createdAt,
			task: this.summaryText(),
			tokensIn: usage?.totalTokensIn ?? 0,
			tokensOut: usage?.totalTokensOut ?? 0,
			cacheReads: usage?.totalCacheReads,
			cacheWrites: usage?.totalCacheWrites,
			totalCost: usage?.totalCost ?? 0,
		}
	}
}
