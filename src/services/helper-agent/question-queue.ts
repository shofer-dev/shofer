/**
 * QuestionQueue — bounded FIFO queue for Helper Agent questions.
 *
 * Serializes question processing so that only one LLM call is in flight at
 * a time. Each entry has its own timeout that covers BOTH queue wait time
 * AND LLM processing time, matching the user-facing SLA.
 *
 * Cancellation:
 *  - Per-entry: the entry's timeout fires → remove from queue OR abort the
 *    active LLM call if processing has already started.
 *  - Bulk: cancelAll() rejects every pending entry and aborts the active
 *    LLM call.
 *
 * The queue is processor-agnostic: the consumer registers a `processor`
 * callback that is invoked for each entry; the callback receives the
 * AbortSignal so it can wire it through to its underlying LLM client.
 */

import {
	MAX_QUESTION_QUEUE_SIZE,
	QUESTION_TIMEOUT_MS,
	type QuestionResult,
} from "@shofer/types"

/** Function the queue calls to actually process a question. */
export type QuestionProcessor = (
	question: string,
	contextFiles: string[] | undefined,
	signal: AbortSignal,
) => Promise<QuestionResult>

interface QueueEntry {
	question: string
	contextFiles?: string[]
	timeoutMs: number
	startTime: number
	resolve: (result: QuestionResult) => void
	reject: (error: Error) => void
}

export class QuestionQueue {
	private readonly _entries: QueueEntry[] = []
	private readonly _maxSize: number
	private _activeAbortController: AbortController | null = null
	private _processor: QuestionProcessor | null = null
	private _isProcessing = false

	constructor(maxSize: number = MAX_QUESTION_QUEUE_SIZE) {
		this._maxSize = maxSize
	}

	/** Register the function used to actually process a question. */
	public setProcessor(processor: QuestionProcessor): void {
		this._processor = processor
	}

	public get pendingCount(): number {
		return this._entries.length
	}

	public get isProcessing(): boolean {
		return this._isProcessing
	}

	/**
	 * Enqueue a question. Returns a promise that resolves with the
	 * question result, rejects with a timeout error, or rejects with an
	 * error from the processor.
	 */
	public enqueue(
		question: string,
		contextFiles?: string[],
		timeoutMs: number = QUESTION_TIMEOUT_MS,
	): Promise<QuestionResult> {
		if (this._entries.length >= this._maxSize) {
			return Promise.reject(
				new Error(`Helper agent question queue is full (max ${this._maxSize}). Try again later.`),
			)
		}

		return new Promise<QuestionResult>((resolve, reject) => {
			const startTime = Date.now()

			const timeoutId = setTimeout(() => {
				const idx = this._entries.findIndex((e) => e.resolve === wrappedResolve)
				if (idx !== -1) {
					this._entries.splice(idx, 1)
					reject(new Error(`Helper agent question timed out after ${timeoutMs}ms (in queue)`))
					return
				}
				// Already in flight — abort the active LLM call.
				this._activeAbortController?.abort()
			}, timeoutMs)

			const wrappedResolve = (result: QuestionResult) => {
				clearTimeout(timeoutId)
				resolve(result)
			}
			const wrappedReject = (error: Error) => {
				clearTimeout(timeoutId)
				reject(error)
			}

			this._entries.push({
				question,
				contextFiles,
				timeoutMs,
				startTime,
				resolve: wrappedResolve,
				reject: wrappedReject,
			})

			void this._drain()
		})
	}

	/** Cancel every pending entry and abort the active LLM call. */
	public cancelAll(): void {
		this._activeAbortController?.abort()
		this._activeAbortController = null

		const pending = this._entries.splice(0)
		for (const entry of pending) {
			entry.reject(new Error("Helper agent questions cancelled"))
		}
	}

	/**
	 * Drain the queue one entry at a time. Re-entrant safe: a second call
	 * while processing is a no-op.
	 */
	private async _drain(): Promise<void> {
		if (this._isProcessing) return
		const processor = this._processor
		if (!processor) return

		while (this._entries.length > 0) {
			const entry = this._entries.shift()!

			if (Date.now() - entry.startTime > entry.timeoutMs) {
				entry.reject(new Error(`Helper agent question timed out (queue wait for ${entry.timeoutMs}ms)`))
				continue
			}

			this._isProcessing = true
			this._activeAbortController = new AbortController()
			try {
				const result = await processor(entry.question, entry.contextFiles, this._activeAbortController.signal)
				entry.resolve(result)
			} catch (error) {
				entry.reject(error instanceof Error ? error : new Error(String(error)))
			} finally {
				this._activeAbortController = null
				this._isProcessing = false
			}
		}
	}
}
