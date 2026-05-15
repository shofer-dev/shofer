/**
 * ContextWindow — token accounting + LRU eviction for the Helper Agent.
 *
 * Owns the in-memory list of conversation messages and file context entries
 * and is the single source of truth for "how full is the window". Pure
 * domain logic: no I/O, no vscode imports.
 *
 * Token estimation uses the conventional 4-chars-per-token heuristic. This
 * is intentionally cheap and providers' authoritative usage numbers are
 * folded back via the cost ledger after each LLM call.
 *
 * Eviction policy when over the configured budget:
 *   1. Drop the least-recently-referenced file context entry first.
 *   2. If no file contexts remain, drop the oldest user+assistant pair.
 *   3. Stop once under budget OR when only the system pair remains.
 *
 * Truncated tokens are accumulated into the cost ledger so the UI can
 * surface "X tokens evicted this session".
 */

import {
	DEFAULT_MAX_CONTEXT_TOKENS,
	DEFAULT_CONTEXT_FILL_THRESHOLD,
	type AgentMessage,
	type FileContextEntry,
} from "@shofer/types"

/** Snapshot of the current context window utilisation. */
export interface ContextUsage {
	currentTokens: number
	maxTokens: number
	fillFraction: number
	isNearlyFull: boolean
}

export interface ContextWindowOptions {
	maxContextTokens?: number
	contextFillThreshold?: number
}

/** Average chars per token used by the cheap heuristic. */
const CHARS_PER_TOKEN = 4

/** Approximate token cost of a truncated message pair (used for accounting). */
const TRUNCATED_MESSAGE_PAIR_TOKEN_COST = 100

export class ContextWindow {
	private _messages: AgentMessage[] = []
	private _fileContexts: FileContextEntry[] = []
	private _maxContextTokens: number
	private _contextFillThreshold: number
	/** Tokens evicted by truncation, accumulated for the cost ledger. */
	private _evictedTokens = 0

	constructor(options: ContextWindowOptions = {}) {
		this._maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
		this._contextFillThreshold = options.contextFillThreshold ?? DEFAULT_CONTEXT_FILL_THRESHOLD
	}

	// ─── Settings ──────────────────────────────────────────────────────

	public configure(options: ContextWindowOptions): void {
		if (options.maxContextTokens !== undefined) this._maxContextTokens = options.maxContextTokens
		if (options.contextFillThreshold !== undefined) this._contextFillThreshold = options.contextFillThreshold
	}

	public get maxContextTokens(): number {
		return this._maxContextTokens
	}

	public get contextFillThreshold(): number {
		return this._contextFillThreshold
	}

	// ─── Snapshots & queries ───────────────────────────────────────────

	public get messages(): ReadonlyArray<AgentMessage> {
		return this._messages
	}

	public get fileContexts(): ReadonlyArray<FileContextEntry> {
		return this._fileContexts
	}

	public get fileContextPaths(): string[] {
		return this._fileContexts.map((f) => f.filePath)
	}

	public get estimatedTokenCount(): number {
		let count = 0
		for (const msg of this._messages) {
			count += Math.ceil(msg.content.length / CHARS_PER_TOKEN)
		}
		for (const fc of this._fileContexts) {
			count += fc.tokenEstimate
		}
		return count
	}

	public get isNearlyFull(): boolean {
		return this.estimatedTokenCount > this._maxContextTokens * this._contextFillThreshold
	}

	public getUsage(): ContextUsage {
		const currentTokens = this.estimatedTokenCount
		return {
			currentTokens,
			maxTokens: this._maxContextTokens,
			fillFraction: this._maxContextTokens > 0 ? currentTokens / this._maxContextTokens : 0,
			isNearlyFull: this.isNearlyFull,
		}
	}

	/** Tokens evicted since the last reset; consumed by the cost ledger. */
	public consumeEvictedTokens(): number {
		const value = this._evictedTokens
		this._evictedTokens = 0
		return value
	}

	// ─── Mutations ─────────────────────────────────────────────────────

	public restore(messages: AgentMessage[], fileContexts: FileContextEntry[]): void {
		this._messages = [...messages]
		this._fileContexts = [...fileContexts]
	}

	public clear(): void {
		this._messages = []
		this._fileContexts = []
	}

	public appendMessage(message: AgentMessage): void {
		this._messages.push(message)
	}

	/**
	 * Insert or refresh a file context entry. If a hash mismatch is
	 * detected for an existing entry, the entry's lastReferencedAt is
	 * bumped so it survives eviction longer.
	 */
	public upsertFileContext(entry: FileContextEntry): void {
		const existing = this._fileContexts.find((fc) => fc.filePath === entry.filePath)
		if (existing) {
			existing.contentHash = entry.contentHash
			existing.tokenEstimate = entry.tokenEstimate
			existing.lastReferencedAt = entry.lastReferencedAt
			return
		}
		this._fileContexts.push(entry)
	}

	public removeFileContext(filePath: string): void {
		const idx = this._fileContexts.findIndex((fc) => fc.filePath === filePath)
		if (idx !== -1) this._fileContexts.splice(idx, 1)
	}

	/**
	 * Mark a file context as stale so it will be reloaded on next reference.
	 * Implemented by clearing its content hash; the loader will see a
	 * mismatch and re-read the file.
	 */
	public invalidateFileContext(filePath: string): void {
		const fc = this._fileContexts.find((f) => f.filePath === filePath)
		if (fc) fc.contentHash = ""
	}

	/**
	 * Enforce the configured token budget by evicting LRU file contexts,
	 * then oldest message pairs, until under budget or unable to evict
	 * further.
	 */
	public enforceLimit(): void {
		while (this.estimatedTokenCount > this._maxContextTokens) {
			if (this._fileContexts.length > 0) {
				this._fileContexts.sort((a, b) => a.lastReferencedAt - b.lastReferencedAt)
				const evicted = this._fileContexts.shift()!
				this._evictedTokens += evicted.tokenEstimate
				continue
			}

			if (this._messages.length > 2) {
				this._messages.shift()
				this._messages.shift()
				this._evictedTokens += TRUNCATED_MESSAGE_PAIR_TOKEN_COST
				continue
			}

			break
		}
	}
}

/** Estimate token count for a string using the cheap heuristic. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}
