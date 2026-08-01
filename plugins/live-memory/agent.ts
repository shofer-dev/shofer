/**
 * LiveMemoryAgent — the plugin-native orchestrator (Stage C). It is the
 * plugin-side analogue of the built-in `LiveMemoryManager` (`packages/core/src/
 * services/live-memory/manager.ts`), reimplemented on ONLY the Stage-A/B plugin
 * modules — {@link ContextWindow}, {@link QuestionQueue}, {@link MemoryLlmClient}
 * ({@link MemoryLlmClient.chatWithTools}), {@link LiveMemoryToolExecutor}, and
 * {@link estimateUsdCost} (via the llm client) — with no reach into `@shofer/core`.
 *
 * It faithfully ports the manager's:
 *   - **state machine** (Standby / Initializing / Ready / Busy / Error),
 *   - the **≤25-iteration agent loop** ({@link MAX_AGENT_ITERATIONS}) that drives
 *     `chatWithTools`, dispatches every returned tool call through the tool executor,
 *     feeds the tool results back into the {@link ContextWindow}, and loops until the
 *     model answers with no further tool calls or the iteration cap is hit,
 *   - **request serialization** via {@link QuestionQueue} (single in-flight + a
 *     per-entry timeout covering queue-wait AND processing),
 *   - **cost accumulation** (prompt/completion tokens + USD, folded across iterations),
 *   - the **recentlyModifiedFiles** KV-cache-preserving hint (settable from observed edits),
 *   - **soft limits** (softTimeoutSec / softResultLength embedded in the question turn),
 *   - **clearContext**, and
 *   - the streaming/state callbacks the Stage-E chat panel consumes.
 *
 * Deliberate manager parity with plugin-shaped seams: the built-in resolves config
 * from `ContextProxy`; the plugin has no such config, so the agent starts Ready after
 * a lightweight {@link initialize} (the LLM handler is built lazily inside the loop,
 * exactly like the built-in). The directory tree + the accumulated observation-log
 * context are injected as strings (the plugin builds them from `ctx.host.fs` /
 * `MemoryStore`), keeping this class host-agnostic and unit-testable.
 */

import { randomUUID, createHash } from "node:crypto"
import { readFile as nodeReadFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"

import { EMBEDDED_WORKTREES_DIR } from "@shofer/types"

import {
	DEFAULT_MAX_CONTEXT_TOKENS,
	DEFAULT_CONTEXT_FILL_THRESHOLD,
	LIVE_MEMORY_SYSTEM_PROMPT,
	QUESTION_TIMEOUT_MS,
	DEFAULT_LIVE_MEMORY_SOFT_TIMEOUT_SEC,
	DEFAULT_LIVE_MEMORY_SOFT_RESULT_LENGTH,
	type AgentMessage,
	type AgentMessagePart,
	type FileContextEntry,
	type PreloadedDoc,
	type QuestionResult,
	type LiveMemoryCostTracking,
} from "./types.js"

import { ContextWindow, estimateTokens, type ContextUsage } from "./context-window.js"
import { QuestionQueue, type QuestionSoftLimits } from "./question-queue.js"
import {
	MemoryLlmClient,
	type ConversationMessage,
	type ConversationContentBlock,
	type ToolDefinition,
} from "./memory-llm.js"
import { LiveMemoryToolExecutor, LIVE_MEMORY_PLUGIN_READ_TOOLS } from "./tool-executor.js"
import type { ConversationSnapshot } from "./memory-store.js"

/**
 * Workspace-relative prefixes whose edits never become a "recently modified" hint:
 * Shofer's own config directory, and the embedded worktrees (a task's own checkout,
 * not a change to the workspace the memory describes).
 */
const IGNORED_MODIFICATION_PREFIXES = [".shofer/", `${EMBEDDED_WORKTREES_DIR}/`]

/** Lifecycle states, mirroring the built-in `LiveMemoryState` (minus `Stopping`, unused here). */
export type LiveMemoryAgentState = "Standby" | "Initializing" | "Ready" | "Busy" | "Error"

/** Fired on every state transition (Stage-E UI). */
export interface AgentStateEvent {
	state: LiveMemoryAgentState
	message: string
}
export type AgentStateCallback = (event: AgentStateEvent) => void

/** Fired whenever the in-flight conversation mutates (streaming text / tool calls). */
export type AgentConversationCallback = (messages: ReadonlyArray<AgentMessage>) => void

/** Options for a single question (mirrors `LiveMemoryManager.askQuestion`). */
export interface AgentAskOptions {
	/** HARD timeout (ms) covering queue-wait + processing. Defaults to {@link QUESTION_TIMEOUT_MS}. */
	timeoutMs?: number
	/** Soft (advisory) wall-time recommendation, embedded in the prompt. */
	softTimeoutSec?: number
	/** Soft (advisory) answer-length recommendation, embedded in the prompt. */
	softResultLength?: number
}

/** Construction dependencies — supplied by `main.ts` from a `PluginContext`. */
export interface LiveMemoryAgentOptions {
	/** LLM adapter over `ctx.ai.buildHandler` (Stage A). */
	llm: MemoryLlmClient
	/** Read-only tool dispatcher over the plugin host surface (Stage B). */
	executor: LiveMemoryToolExecutor
	/** Absolute workspace root (for resolving contextFiles). */
	workspacePath: string
	/** Tool catalog offered to the model. Defaults to {@link buildPluginToolCatalog}. */
	tools?: ToolDefinition[]
	/** Context-window budget. Defaults to {@link DEFAULT_MAX_CONTEXT_TOKENS}. */
	maxContextTokens?: number
	/** Fill fraction at which the window is "nearly full". Defaults to {@link DEFAULT_CONTEXT_FILL_THRESHOLD}. */
	contextFillThreshold?: number
	/** Stable workspace-structure string folded into the system prompt. */
	directoryTree?: string
	/** Rebuild the directory tree (invoked by {@link clearContext}). */
	rebuildDirectoryTree?: () => string | Promise<string>
	/**
	 * Accumulated-memory context (observation/Q&A log) folded into the system prompt.
	 * Consulted only when the volatile block is (re)FROZEN — not per question: in-place
	 * mutation of the prompt would truncate the provider's KV cache at the first changed
	 * byte. Changes after the freeze arrive via {@link memoryDeltaProvider} instead.
	 */
	memoryContextProvider?: () => string | Promise<string>
	/**
	 * Renders the observations recorded AFTER the given timestamp — the delta appended
	 * to the history as a memory-update message while the frozen prefix stays
	 * byte-identical (cache-preserving). Empty string ⇒ nothing new.
	 */
	memoryDeltaProvider?: (sinceAt: number) => string | Promise<string>
	/**
	 * Documents preloaded VERBATIM into the system prompt from the `preloadGlobs`
	 * config. Fixed prompt overhead outside the evictable window; re-read via
	 * {@link LiveMemoryAgentOptions.reloadPreloadedDocs} on the reset command.
	 */
	preloadedDocs?: PreloadedDoc[]
	/** Re-read the preload globs fresh from disk (invoked by {@link resetContext}). */
	reloadPreloadedDocs?: () => Promise<PreloadedDoc[]>
	/** Read a workspace file's UTF-8 content for contextFiles loading. Defaults to node fs. */
	readFile?: (absolutePath: string) => Promise<string>
	/** Persist the conversation snapshot after each answered question. */
	persist?: (snapshot: ConversationSnapshot) => void | Promise<void>
	onStateChange?: AgentStateCallback
	onConversationUpdate?: AgentConversationCallback
}

/** Hard cap on agent-loop iterations per question (tool round-trips) — matches the built-in. */
export const MAX_AGENT_ITERATIONS = 25

function emptyCostTracking(): LiveMemoryCostTracking {
	return {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalTokensTruncated: 0,
		estimatedCostUSD: 0,
		lastUpdated: Date.now(),
	}
}

export class LiveMemoryAgent {
	private _state: LiveMemoryAgentState = "Standby"
	private _stateMessage = "Live Memory has not been initialized"

	private readonly _llm: MemoryLlmClient
	private readonly _executor: LiveMemoryToolExecutor
	private readonly _workspacePath: string
	private readonly _tools: ToolDefinition[]
	private readonly _window: ContextWindow
	private readonly _queue: QuestionQueue
	private readonly _readFile: (absolutePath: string) => Promise<string>
	private readonly _rebuildDirectoryTree?: () => string | Promise<string>
	private readonly _memoryContextProvider?: () => string | Promise<string>
	private readonly _memoryDeltaProvider?: (sinceAt: number) => string | Promise<string>
	private readonly _reloadPreloadedDocs?: () => Promise<PreloadedDoc[]>
	private readonly _persist?: (snapshot: ConversationSnapshot) => void | Promise<void>
	private readonly _onStateChange?: AgentStateCallback
	private readonly _onConversationUpdate?: AgentConversationCallback

	private _directoryTreeString: string
	private _recentlyModifiedFiles = new Set<string>()
	private _costTracking: LiveMemoryCostTracking = emptyCostTracking()
	private _preloadedDocs: PreloadedDoc[]
	/**
	 * The FROZEN volatile system block (accumulated memory + preloaded docs +
	 * file-context manifest + folded system markers). Rendered once and re-sent
	 * byte-identical every question so the provider's prefix cache keeps matching;
	 * changes since the freeze are APPENDED to the history as memory-update delta
	 * messages instead of mutating this block. `null` ⇒ re-freeze on next use.
	 */
	private _frozenVolatile: string | null = null
	/** Watermark: observations at/before this are represented in the frozen block. */
	private _freezeAt = 0
	/** Wall time of the last REAL question (keep-warm idle gate). */
	private _lastQueryAt = 0

	constructor(opts: LiveMemoryAgentOptions) {
		this._llm = opts.llm
		this._executor = opts.executor
		this._workspacePath = opts.workspacePath
		this._tools = opts.tools ?? buildPluginToolCatalog()
		this._readFile = opts.readFile ?? ((p) => nodeReadFile(p, "utf-8"))
		this._rebuildDirectoryTree = opts.rebuildDirectoryTree
		this._memoryContextProvider = opts.memoryContextProvider
		this._memoryDeltaProvider = opts.memoryDeltaProvider
		this._preloadedDocs = opts.preloadedDocs ?? []
		this._reloadPreloadedDocs = opts.reloadPreloadedDocs
		this._persist = opts.persist
		this._onStateChange = opts.onStateChange
		this._onConversationUpdate = opts.onConversationUpdate
		this._directoryTreeString = opts.directoryTree ?? "[No workspace structure available]"

		this._window = new ContextWindow({
			maxContextTokens: opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
			contextFillThreshold: opts.contextFillThreshold ?? DEFAULT_CONTEXT_FILL_THRESHOLD,
		})
		this._queue = new QuestionQueue()
		this._queue.setProcessor((q, files, signal, softLimits) => this._processQuestion(q, files, signal, softLimits))
	}

	// ─── Public API ────────────────────────────────────────────────────────

	get state(): LiveMemoryAgentState {
		return this._state
	}

	get stateMessage(): string {
		return this._stateMessage
	}

	get isLiveMemoryAvailable(): boolean {
		return this._state === "Ready" || this._state === "Busy"
	}

	get conversationTurnCount(): number {
		return this._window.messages.length
	}

	get contextFiles(): string[] {
		return this._window.fileContextPaths
	}

	get estimatedTokenCount(): number {
		return this._window.estimatedTokenCount
	}

	get maxContextTokens(): number {
		return this._window.maxContextTokens
	}

	get contextFillThreshold(): number {
		return this._window.contextFillThreshold
	}

	get isContextNearlyFull(): boolean {
		return this._window.isNearlyFull
	}

	get pendingQuestionCount(): number {
		return this._queue.pendingCount
	}

	getContextUsage(): ContextUsage {
		return this._window.getUsage()
	}

	getCostSnapshot() {
		return {
			sessionInputTokens: this._costTracking.totalInputTokens,
			sessionOutputTokens: this._costTracking.totalOutputTokens,
			sessionEstimatedCostUSD: this._costTracking.estimatedCostUSD,
		}
	}

	getMessages(): ReadonlyArray<AgentMessage> {
		return this._window.messages
	}

	/** Best-effort model label (`id`) for the system-prompt section — undefined on the denying stub. */
	async getModelLabel(): Promise<string | undefined> {
		const info = await this._llm.getModelInfo()
		return info?.id
	}

	/**
	 * Lightweight initialization. The plugin carries no async provider config (the LLM
	 * handler is built lazily inside the loop), so this simply promotes the agent to
	 * Ready. Restores a persisted conversation snapshot when provided.
	 */
	initialize(restore?: ConversationSnapshot): void {
		this._setState("Initializing", "Loading Live Memory...")
		if (restore) this.restore(restore)
		this._setState("Ready", "Agent is ready")
	}

	/** Restore a persisted conversation window + cost ledger. */
	restore(snapshot: ConversationSnapshot): void {
		this._window.restore(snapshot.messages, snapshot.fileContexts)
		this._costTracking = snapshot.costTracking ?? emptyCostTracking()
		this._frozenVolatile = null // re-freeze from the restored state on first use
	}

	get preloadedDocCount(): number {
		return this._preloadedDocs.length
	}

	get preloadedTokenEstimate(): number {
		return this._preloadedDocs.reduce((sum, d) => sum + d.tokenEstimate, 0)
	}

	get lastQueryAt(): number {
		return this._lastQueryAt
	}

	/**
	 * Notify the agent that a file was modified by a task tool. The path is accumulated
	 * and surfaced as a hint on the next question (no eviction → preserves the provider's
	 * KV cache). Mirrors `LiveMemoryManager.notifyFileModified`.
	 *
	 * Edits inside an embedded worktree are dropped: the memory describes the workspace,
	 * and a per-task worktree's churn is not a change to it until the branch merges back.
	 * The legacy `.shofer/worktrees/` location is covered by the `.shofer/` prefix, which
	 * is filtered anyway.
	 */
	notifyFileModified(filePath: string): void {
		if (!filePath) return
		if (IGNORED_MODIFICATION_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return
		this._recentlyModifiedFiles.add(filePath)
	}

	cancelAllQuestions(): void {
		this._queue.cancelAll()
		if (this._state === "Busy") this._setState("Ready", "Agent is ready")
	}

	/** Reset the context window + rebuild the directory tree (mirrors the built-in). */
	async clearContext(): Promise<void> {
		this._window.clear()
		this._frozenVolatile = null
		if (this._rebuildDirectoryTree) {
			try {
				this._directoryTreeString = await this._rebuildDirectoryTree()
			} catch {
				this._directoryTreeString = "[Workspace directory tree unavailable]"
			}
		}
		await this._doPersist()
		this._fireConversationUpdate()
		this._setState("Ready", "Context cleared. Agent is ready.")
	}

	/**
	 * Start this workspace's memory over (the `reset` command): drop the history
	 * trail like {@link clearContext} AND re-read the configured preload globs fresh
	 * from disk, so the verbatim reference docs come back current.
	 */
	async resetContext(): Promise<void> {
		if (this._reloadPreloadedDocs) {
			try {
				this._preloadedDocs = await this._reloadPreloadedDocs()
			} catch {
				// Keep the docs from the last successful load — a transient read failure
				// must not silently degrade the memory to no reference material.
			}
		}
		await this.clearContext()
		this._setState("Ready", "Memory reset — preloaded docs re-read. Agent is ready.")
	}

	/**
	 * Invalidate the frozen volatile block so the next question re-renders it (used
	 * by the compactor after it rewrote the running summary — the prompt changes
	 * there anyway, so the one-time cache re-write is amortized).
	 */
	invalidateFrozenPrefix(): void {
		this._frozenVolatile = null
	}

	/**
	 * KV/prompt-cache keep-warm heartbeat: re-send the SAME prompt prefix a real
	 * question would use, with a minimal trailing turn, refreshing the provider
	 * cache's TTL. No-ops unless idle-and-warm-worthy: Ready state, nothing queued,
	 * a non-empty window, and a real question asked within the last
	 * {@link KEEP_WARM_MAX_IDLE_MS} (checked by the caller, which owns the config).
	 */
	async keepWarmPing(): Promise<void> {
		if (this._state !== "Ready" || this._queue.pendingCount > 0) return
		if (this._window.messages.length === 0 && this._preloadedDocs.length === 0) return
		const systemPrompt = await this._prepareSystemPrompt()
		const conversation = this._buildBaseConversation(
			"(keep-warm ping — reply with a single token and nothing else)",
		)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), 60_000)
		try {
			await this._llm.chatWithTools({
				systemPrompt,
				messages: conversation,
				tools: this._tools,
				signal: controller.signal,
			})
		} finally {
			clearTimeout(timer)
		}
	}

	/**
	 * Enqueue a question. Resolves with the {@link QuestionResult}, rejects on
	 * timeout/error. Mirrors `LiveMemoryManager.askQuestion`.
	 */
	async askQuestion(question: string, contextFiles?: string[], opts: AgentAskOptions = {}): Promise<QuestionResult> {
		if (!this.isLiveMemoryAvailable) {
			throw new Error(`Live Memory is not available (state: ${this._state})`)
		}
		const { timeoutMs = QUESTION_TIMEOUT_MS, softTimeoutSec, softResultLength } = opts
		return this._queue.enqueue(question, contextFiles, timeoutMs, { softTimeoutSec, softResultLength })
	}

	// ─── Queue processor — one question end-to-end ───────────────────────────

	private async _processQuestion(
		question: string,
		contextFiles: string[] | undefined,
		signal: AbortSignal,
		softLimits: QuestionSoftLimits = {},
	): Promise<QuestionResult> {
		const startTime = Date.now()
		this._lastQueryAt = startTime // keep-warm idle gate: a real question ran
		this._setState("Busy", "Processing question...")
		try {
			const recentlyModified = this._drainRecentlyModifiedFiles()

			const newContextPaths: string[] = []
			if (contextFiles && contextFiles.length > 0) {
				const before = new Set(this._window.fileContextPaths)
				for (const filePath of contextFiles) {
					await this._loadFileIntoContext(filePath)
					if (!before.has(filePath)) newContextPaths.push(filePath)
				}
			}

			// KV-cache-preserving system prompt: stable prefix + the FROZEN volatile block
			// (accumulated memory + preloaded docs + manifest). Changes since the freeze are
			// appended to the history as delta messages by _prepareSystemPrompt; per-question
			// volatile hints ride the trailing question turn.
			const systemPrompt = await this._prepareSystemPrompt()
			const questionHints = this._buildQuestionHints(recentlyModified, softLimits, newContextPaths)
			let baseConversation = this._buildBaseConversation(question, questionHints)
			const tools = this._tools
			const executor = this._executor

			const conversation: ConversationMessage[] = [...baseConversation]
			let baseLength = baseConversation.length

			// Persisted user + assistant messages built up front so the chat panel can
			// stream the turn live; `assistantMsg.parts` is mutated in place.
			const userMsg: AgentMessage = {
				id: randomUUID(),
				role: "user",
				content: question,
				timestamp: Date.now(),
				parts: [{ kind: "text", text: question }],
				metadata: { fileReferences: contextFiles },
			}
			const assistantMsg: AgentMessage = {
				id: randomUUID(),
				role: "assistant",
				content: "",
				timestamp: Date.now(),
				parts: [],
			}
			this._window.appendMessage(userMsg)
			this._window.appendMessage(assistantMsg)
			this._fireConversationUpdate()

			const parts = assistantMsg.parts as AgentMessagePart[]
			const appendStreamingText = (kind: "text" | "reasoning", delta: string): void => {
				if (!delta) return
				const last = parts[parts.length - 1]
				if (last && last.kind === kind) {
					last.text += delta
				} else {
					parts.push({ kind, text: delta })
				}
				this._fireConversationUpdate()
			}

			let totalPrompt = 0
			let totalCompletion = 0
			let totalCost = 0
			let finalAnswer = ""
			let iterations = 0

			for (;;) {
				if (signal.aborted) {
					const err = new Error("Live Memory agent aborted")
					err.name = "AbortError"
					throw err
				}
				if (iterations >= MAX_AGENT_ITERATIONS) {
					finalAnswer =
						finalAnswer ||
						`I was unable to finish this question within ${MAX_AGENT_ITERATIONS} tool iterations. Please narrow the scope or try again.`
					break
				}
				iterations += 1

				const result = await this._llm.chatWithTools({
					systemPrompt,
					messages: conversation,
					tools,
					signal,
					onStream: (event) => {
						switch (event.kind) {
							case "text":
								appendStreamingText("text", event.delta)
								break
							case "reasoning":
								appendStreamingText("reasoning", event.delta)
								break
							case "tool_call":
								parts.push({
									kind: "tool_call",
									toolCallId: event.toolCall.id,
									name: event.toolCall.name,
									args: event.toolCall.arguments,
									inProgress: true,
								})
								this._fireConversationUpdate()
								break
						}
					},
				})
				totalPrompt += result.tokensUsed.prompt
				totalCompletion += result.tokensUsed.completion
				totalCost += result.estimatedCostUSD

				if (result.toolCalls.length === 0) {
					finalAnswer = result.answer
					break
				}

				// Append the assistant turn carrying any text + tool_use blocks.
				const assistantBlocks: ConversationContentBlock[] = []
				if (result.answer) assistantBlocks.push({ type: "text", text: result.answer })
				for (const tc of result.toolCalls) {
					let parsedInput: Record<string, unknown> = {}
					try {
						parsedInput = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
					} catch {
						parsedInput = { _raw: tc.arguments }
					}
					assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: parsedInput })
				}
				conversation.push({ role: "assistant", content: assistantBlocks })

				// Execute every tool call and bundle results into one user turn.
				const toolResultBlocks: ConversationContentBlock[] = []
				for (const tc of result.toolCalls) {
					const exec = await executor.execute(tc.name, tc.arguments, signal)
					toolResultBlocks.push({
						type: "tool_result",
						tool_use_id: tc.id,
						content: exec.content,
						is_error: exec.isError ?? false,
					})

					const part = parts.find((p) => p.kind === "tool_call" && p.toolCallId === tc.id) as
						| Extract<AgentMessagePart, { kind: "tool_call" }>
						| undefined
					if (part) {
						part.result = exec.content
						part.isError = exec.isError ?? false
						part.inProgress = false
						this._fireConversationUpdate()
					}
				}
				conversation.push({ role: "user", content: toolResultBlocks })

				// Enforce the context budget, accumulate evicted tokens, then refresh the
				// base portion so the next iteration benefits from the eviction.
				this._window.enforceLimit()
				this._costTracking.totalTokensTruncated += this._window.consumeEvictedTokens()

				const freshBase = this._buildBaseConversation(question, questionHints)
				conversation.splice(0, baseLength, ...freshBase)
				baseLength = freshBase.length
			}

			// Finalize the assistant message (append the closing answer if streaming didn't).
			assistantMsg.content = finalAnswer
			if (finalAnswer) {
				const last = parts[parts.length - 1]
				if (!(last && last.kind === "text" && last.text === finalAnswer)) {
					const hasText = parts.some((p) => p.kind === "text" && p.text.includes(finalAnswer))
					if (!hasText) parts.push({ kind: "text", text: finalAnswer })
				}
			} else {
				// An EMPTY answer must not be persisted: some providers reject a history
				// containing an empty assistant message on every subsequent request, so one
				// failed/empty answer would poison the whole workspace until a clear.
				this._window.removeMessagesById([userMsg.id, assistantMsg.id])
			}

			this._window.enforceLimit()
			this._costTracking.totalTokensTruncated += this._window.consumeEvictedTokens()
			this._accumulateCost(totalPrompt, totalCompletion, totalCost)

			await this._doPersist()
			this._fireConversationUpdate()
			this._setState("Ready", "Agent is ready")

			return {
				answer: finalAnswer,
				tokensUsed: { prompt: totalPrompt, completion: totalCompletion, total: totalPrompt + totalCompletion },
				contextUsage: this._window.getUsage(),
				costSnapshot: this.getCostSnapshot(),
				contextFiles: this._window.fileContextPaths,
				durationMs: Date.now() - startTime,
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const isAbort =
				error instanceof Error &&
				(error.name === "AbortError" || error.name === "TimeoutError" || message.includes("aborted"))
			// On abort/timeout return to Ready; on a real error surface it.
			this._setState(isAbort ? "Ready" : "Error", isAbort ? "Agent is ready" : message)
			throw error instanceof Error ? error : new Error(message)
		}
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _drainRecentlyModifiedFiles(): string[] {
		if (this._recentlyModifiedFiles.size === 0) return []
		const files = Array.from(this._recentlyModifiedFiles)
		this._recentlyModifiedFiles.clear()
		return files
	}

	/** The cross-question-stable prefix: instructions + directory tree. */
	private _buildStablePrompt(): string {
		const treeContent = this._directoryTreeString
			? `[Workspace structure:\n${this._directoryTreeString}\n\nshoferignore and .gitignore patterns are respected.]`
			: "[No workspace structure available]"
		return LIVE_MEMORY_SYSTEM_PROMPT.replace("{directoryTree}", treeContent)
	}

	/**
	 * Render the volatile block from the CURRENT state: accumulated memory,
	 * preloaded reference docs (verbatim), the file-context manifest, and folded
	 * system markers. Only called when (re)freezing — between freezes the block is
	 * re-sent byte-identical and changes ride as appended delta messages.
	 */
	private async _renderVolatileBlock(): Promise<string> {
		const parts: string[] = []

		if (this._memoryContextProvider) {
			const memory = await this._memoryContextProvider()
			if (memory && memory.trim()) {
				parts.push(`==== ACCUMULATED MEMORY ====\n${memory}`)
			}
		}

		if (this._preloadedDocs.length > 0) {
			const docs = this._preloadedDocs.map((d) => `#### ${d.filePath}\n${d.content}`).join("\n\n")
			parts.push(
				`==== PRE-LOADED REFERENCE DOCUMENTS (configured for this workspace) ====\n` +
					`These files were loaded verbatim from disk when your memory started — treat them as ` +
					`current, authoritative reference material and answer from them without re-reading.\n\n${docs}`,
			)
		}

		for (const fc of this._window.fileContexts) {
			parts.push(
				`[File context: ${fc.filePath}]\n(Content hash: ${fc.contentHash}, tokens: ~${fc.tokenEstimate})`,
			)
		}

		for (const msg of this._window.messages) {
			if (msg.role === "system") parts.push(msg.content)
		}

		return parts.join("\n\n")
	}

	/**
	 * The full system prompt for a request, KV-cache-preserving: stable prefix +
	 * the FROZEN volatile block. On first use (or after an invalidation) the block
	 * is rendered and frozen with a watermark; afterwards, observations recorded
	 * since the watermark are APPENDED to the history as a memory-update delta
	 * message ({@link AgentMessage.metadata.observation}) — the model learns of the
	 * change while the prefix stays byte-identical, so the provider's cache extends
	 * instead of truncating at the first mutated byte.
	 */
	private async _prepareSystemPrompt(): Promise<string> {
		if (this._frozenVolatile === null) {
			const freezeAt = Date.now()
			this._frozenVolatile = await this._renderVolatileBlock()
			this._freezeAt = freezeAt
		} else if (this._memoryDeltaProvider) {
			const sinceAt = this._freezeAt
			this._freezeAt = Date.now()
			try {
				const delta = await this._memoryDeltaProvider(sinceAt)
				if (delta && delta.trim()) {
					this._window.appendMessage({
						id: randomUUID(),
						role: "user",
						content: `[Memory update — activity observed since your context was last rendered]\n${delta}`,
						timestamp: Date.now(),
						metadata: { observation: true },
					})
					this._fireConversationUpdate()
				}
			} catch {
				// Best-effort delta; a failed render loses awareness, never the question.
			}
		}
		const stable = this._buildStablePrompt()
		return this._frozenVolatile ? `${stable}\n\n${this._frozenVolatile}` : stable
	}

	private _buildQuestionHints(
		recentlyModifiedFiles: string[],
		softLimits: QuestionSoftLimits = {},
		newContextPaths: string[] = [],
	): string {
		const parts: string[] = []

		if (recentlyModifiedFiles.length > 0) {
			parts.push(
				`[Note: the following files have been modified since you last read them: ${recentlyModifiedFiles.join(", ")}. Consider re-reading them if relevant to this question.]`,
			)
		}

		if (newContextPaths.length > 0) {
			// Newly-loaded context files land in the frozen manifest only at the next
			// re-freeze (mutating it now would truncate the provider's prefix cache), so
			// tell the model about them on the volatile question turn instead.
			parts.push(
				`[Note: the caller loaded these files into your context for this question: ${newContextPaths.join(", ")}. Read them with read_file if their contents matter here.]`,
			)
		}

		const softTimeoutSec = softLimits.softTimeoutSec ?? DEFAULT_LIVE_MEMORY_SOFT_TIMEOUT_SEC
		const softResultLength = softLimits.softResultLength ?? DEFAULT_LIVE_MEMORY_SOFT_RESULT_LENGTH
		parts.push(
			`[Soft constraints for this question — recommendations, not hard limits, and not enforced by the runtime: aim to complete within ~${softTimeoutSec}s of wall time (use fewer tool round-trips when possible) and keep your final answer under ~${softResultLength} characters. If the question genuinely requires more, exceed the limits rather than giving an incorrect or misleading answer.]`,
		)

		return parts.join("\n\n")
	}

	private _buildBaseConversation(question: string, questionHints = ""): ConversationMessage[] {
		const conv: ConversationMessage[] = []
		for (const msg of this._window.messages) {
			if (msg.role === "system") continue
			// Skip empty turns: the in-flight assistant placeholder (filled at finalize),
			// and any empty assistant message a legacy snapshot may carry — providers can
			// reject a conversation containing an empty assistant message outright.
			if (!msg.content.trim()) continue
			conv.push({ role: msg.role as "user" | "assistant", content: msg.content })
		}
		const questionContent = questionHints ? `${question}\n\n${questionHints}` : question
		conv.push({ role: "user", content: questionContent })
		return conv
	}

	private async _loadFileIntoContext(filePath: string): Promise<void> {
		try {
			const fullPath = resolvePath(this._workspacePath, filePath)
			const content = await this._readFile(fullPath)
			const contentHash = createHash("sha256").update(content).digest("hex")
			const entry: FileContextEntry = {
				filePath,
				contentHash,
				tokenEstimate: estimateTokens(content),
				loadedAt: Date.now(),
				lastReferencedAt: Date.now(),
			}
			this._window.upsertFileContext(entry)
			this._window.enforceLimit()
			this._costTracking.totalTokensTruncated += this._window.consumeEvictedTokens()
		} catch {
			// Missing/unreadable file — skip (best-effort, matches the built-in's warn+continue).
		}
	}

	private _accumulateCost(promptTokens: number, completionTokens: number, costUSD: number): void {
		this._costTracking.totalInputTokens += promptTokens
		this._costTracking.totalOutputTokens += completionTokens
		this._costTracking.estimatedCostUSD += costUSD
		this._costTracking.lastUpdated = Date.now()
	}

	private _snapshot(): ConversationSnapshot {
		return {
			messages: [...this._window.messages],
			fileContexts: [...this._window.fileContexts],
			costTracking: this._costTracking,
		}
	}

	private async _doPersist(): Promise<void> {
		if (!this._persist) return
		try {
			await this._persist(this._snapshot())
		} catch {
			// Best-effort persistence; never surface to the caller.
		}
	}

	private _fireConversationUpdate(): void {
		this._onConversationUpdate?.(this._window.messages)
	}

	private _setState(newState: LiveMemoryAgentState, message: string): void {
		if (newState !== this._state || message !== this._stateMessage) {
			this._state = newState
			this._stateMessage = message
			this._onStateChange?.({ state: newState, message })
		}
	}
}

// ─── Tool catalog ──────────────────────────────────────────────────────────

/**
 * Build the OpenAI-style tool catalog the memory agent offers the model — the plugin
 * analogue of the built-in's `getNativeTools().filter(LIVE_MEMORY_READ_TOOLS)`. The
 * plugin cannot reach core's native-tool registry, so the read tools'
 * ({@link LIVE_MEMORY_PLUGIN_READ_TOOLS}) schemas are declared here; the names + argument
 * shapes match what {@link LiveMemoryToolExecutor} dispatches.
 */
export function buildPluginToolCatalog(): ToolDefinition[] {
	const s = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
		type: "object",
		properties: props,
		required,
		additionalProperties: false,
	})
	const str = (description: string) => ({ type: "string", description })
	const num = (description: string) => ({ type: "number", description })
	const bool = (description: string) => ({ type: "boolean", description })

	const defs: Record<LiveMemoryPluginReadToolName, { description: string; parameters: Record<string, unknown> }> = {
		read_file: {
			description: "Read a file's contents (optionally a line range).",
			parameters: s(
				{
					path: str("Workspace-relative path of the file to read."),
					offset: num("1-based line to start at (default 1)."),
					limit: num("Maximum number of lines to read (default 2000)."),
				},
				["path"],
			),
		},
		grep_search: {
			description: "Regex-search file contents under a directory. Returns file:line matches.",
			parameters: s(
				{
					regex: str("Regular expression to match against each line."),
					path: str("Directory to search under (default: workspace root)."),
					file_pattern: str("Glob restricting which files are scanned (default **/*)."),
				},
				["regex"],
			),
		},
		list_files: {
			description: "List files under a directory (optionally recursive).",
			parameters: s({
				path: str("Directory to list (default: workspace root)."),
				recursive: bool("List recursively when true."),
				limit: num("Maximum entries to return."),
			}),
		},
		find_files: {
			description: "Find files matching a glob pattern across the workspace.",
			parameters: s({
				pattern: str("Glob pattern to match (default **/*)."),
				limit: num("Maximum entries to return."),
			}),
		},
		get_changed_files: {
			description: "List files changed in the working tree (git status --porcelain).",
			parameters: s({}),
		},
		get_project_setup_info: {
			description: "Report the workspace root and which build/dependency manifests are present.",
			parameters: s({}),
		},
		fetch_web_page: {
			description: "Fetch one or more web pages and return their text content.",
			parameters: s(
				{
					urls: { type: "array", items: { type: "string" }, description: "URLs to fetch." },
				},
				["urls"],
			),
		},
		rag_search: {
			description: "Semantic code-index search over the workspace.",
			parameters: s(
				{
					query: str("Natural-language or code query."),
					directory_prefix: str("Restrict results to files under this workspace-relative prefix."),
				},
				["query"],
			),
		},
		git_search: {
			description: "Semantic search over the git commit history.",
			parameters: s({ query: str("Natural-language query over commit messages/diffs.") }, ["query"]),
		},
		list_code_usages: {
			description: "Find workspace symbols (definitions/usages) matching a name.",
			parameters: s(
				{
					symbol: str("Symbol name to look up."),
					file_path: str("Restrict to a single file (workspace-relative or absolute)."),
				},
				["symbol"],
			),
		},
		get_errors: {
			description: "List current diagnostics (errors/warnings), optionally filtered by path.",
			parameters: s({ path: str("Restrict diagnostics to files under this prefix.") }),
		},
	}

	return LIVE_MEMORY_PLUGIN_READ_TOOLS.map((name) => ({
		type: "function" as const,
		function: { name, description: defs[name].description, parameters: defs[name].parameters },
	}))
}

/** Names of the read tools the plugin agent offers (kept in sync with the executor). */
type LiveMemoryPluginReadToolName = (typeof LIVE_MEMORY_PLUGIN_READ_TOOLS)[number]
