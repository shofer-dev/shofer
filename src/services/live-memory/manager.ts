/**
 * LiveMemoryManager — singleton-per-workspace orchestrator for the
 * Live Memory (a persistent, read-only codebase Q&A companion).
 *
 * Responsibilities (delegated to focused collaborators):
 *   - persistence            → ConversationStore
 *   - request serialization  → QuestionQueue
 *   - context budget         → ContextWindow
 *   - LLM dispatch           → LiveMemoryLlmClient (wraps shared ApiHandler)
 *   - workspace scan         → LiveMemoryDirectoryTree
 *   - external file changes  → LiveMemoryFileWatcher
 *
 * The Manager itself is a thin state machine: it owns the lifecycle, the
 * configuration, and the event emitters consumed by the webview. All
 * heavy lifting lives in the modules above.
 *
 * Configuration & secrets are read from `ContextProxy` so the helper
 * agent participates in the extension's typed settings/migration plumbing
 * (no direct vscode.workspace.getConfiguration / context.secrets).
 */

import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { createHash, randomUUID } from "crypto"

import { TelemetryService } from "@shofer/telemetry"
import {
	TelemetryEventName,
	type LiveMemoryState,
	type LiveMemoryConfig,
	type AgentMessage,
	type AgentMessagePart,
	type FileContextEntry,
	type QuestionResult,
	DEFAULT_MAX_CONTEXT_TOKENS,
	DEFAULT_CONTEXT_FILL_THRESHOLD,
	LIVE_MEMORY_SYSTEM_PROMPT,
	QUESTION_TIMEOUT_MS,
	DEFAULT_LIVE_MEMORY_SOFT_TIMEOUT_SEC,
	DEFAULT_LIVE_MEMORY_SOFT_RESULT_LENGTH,
} from "@shofer/types"

import { ContextProxy } from "../../core/config/ContextProxy"
import { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { buildApiHandler } from "../../api"
import { liveMemoryLog as logger } from "../../utils/logging/subsystems"
import { ShoferIgnoreController } from "../../core/ignore/ShoferIgnoreController"

import { LiveMemoryDirectoryTree } from "./directory-tree"
import { LiveMemoryFileWatcher } from "./file-watcher"
import { ConversationStore, type ConversationSnapshot } from "./conversation-store"
import { QuestionQueue } from "./question-queue"
import { ContextWindow, estimateTokens } from "./context-window"
import { LiveMemoryLlmClient } from "./llm-client"
import { LiveMemoryToolExecutor, LIVE_MEMORY_READ_TOOLS } from "./tool-executor"
import { getNativeTools } from "../../core/prompts/tools/native-tools"
import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"

export class LiveMemoryManager implements vscode.Disposable {
	// ─── Singleton Implementation ────────────────────────────────────────

	private static instances = new Map<string, LiveMemoryManager>()

	public static getInstance(
		context: vscode.ExtensionContext,
		workspacePath?: string,
	): LiveMemoryManager | undefined {
		let folder: vscode.WorkspaceFolder | undefined

		if (workspacePath) {
			folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === workspacePath)
		} else {
			const activeEditor = vscode.window.activeTextEditor
			if (activeEditor) {
				folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
			}
			if (!folder) {
				const folders = vscode.workspace.workspaceFolders
				if (!folders || folders.length === 0) return undefined
				folder = folders[0]
			}
			workspacePath = folder.uri.fsPath
		}

		let instance = LiveMemoryManager.instances.get(workspacePath)
		if (!instance) {
			instance = new LiveMemoryManager(workspacePath, context)
			LiveMemoryManager.instances.set(workspacePath, instance)
		}
		return instance
	}

	public static getAllInstances(): LiveMemoryManager[] {
		return Array.from(LiveMemoryManager.instances.values())
	}

	public static disposeAll(): void {
		for (const instance of LiveMemoryManager.instances.values()) {
			instance.dispose()
		}
		LiveMemoryManager.instances.clear()
	}

	// ─── Instance Fields ─────────────────────────────────────────────────

	private readonly workspacePath: string
	private readonly context: vscode.ExtensionContext

	private _state: LiveMemoryState = "Standby"
	private _stateMessage: string = ""
	private _config: LiveMemoryConfig | null = null

	private readonly _store: ConversationStore
	private readonly _queue: QuestionQueue
	private readonly _window: ContextWindow
	private _llm: LiveMemoryLlmClient | null = null

	/** Workspace structure scanner — feeds the system prompt. */
	private _directoryTree: LiveMemoryDirectoryTree | null = null
	private _directoryTreeString: string = "[No workspace structure available]"

	/** External-edit detector — invalidates file context on writes. */
	private _fileWatcher: LiveMemoryFileWatcher | null = null

	/** .shoferignore controller — filters file watcher, directory tree, and notifications. */
	private _shoferIgnoreController?: ShoferIgnoreController

	/** Read-only tool dispatcher used inside the agent loop. */
	private _toolExecutor: LiveMemoryToolExecutor | null = null

	/** Cached tool catalog — the Read group minus `ask_live_memory`. */
	private _toolCatalog: OpenAI.Chat.ChatCompletionTool[] | null = null

	/** Hard cap on agent-loop iterations per question (tool round-trips). */
	private static readonly MAX_AGENT_ITERATIONS = 25

	/** Files modified by tasks since last question (KV-cache preserving hint). */
	private _recentlyModifiedFiles = new Set<string>()

	private _costTracking = {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalTokensTruncated: 0,
		estimatedCostUSD: 0,
		lastUpdated: Date.now(),
	}

	private _stateChangeEmitter = new vscode.EventEmitter<LiveMemoryState>()
	public readonly onStateChange = this._stateChangeEmitter.event

	private _conversationUpdateEmitter = new vscode.EventEmitter<void>()
	public readonly onConversationUpdate = this._conversationUpdateEmitter.event

	private _isRecoveringFromError = false

	private constructor(workspacePath: string, context: vscode.ExtensionContext) {
		this.workspacePath = workspacePath
		this.context = context
		this._store = new ConversationStore(workspacePath, context.globalStorageUri.fsPath)
		this._window = new ContextWindow()
		this._queue = new QuestionQueue()
		this._queue.setProcessor((q, files, signal, softLimits) => this._processQuestion(q, files, signal, softLimits))
	}

	// ─── Public API ──────────────────────────────────────────────────────

	public get state(): LiveMemoryState {
		return this._state
	}

	public get stateMessage(): string {
		return this._stateMessage
	}

	public get isFeatureEnabled(): boolean {
		return this._config?.enabled ?? false
	}

	public get isFeatureConfigured(): boolean {
		return !!this._config?.apiConfigId
	}

	public get isLiveMemoryAvailable(): boolean {
		return this._state === "Ready" || this._state === "Busy"
	}

	public get modelId(): string {
		return this._config?.providerSettings.apiModelId ?? this._config?.apiConfigName ?? "not configured"
	}

	public get provider(): string {
		return this._config?.providerSettings.apiProvider ?? "unknown"
	}

	public get conversationTurnCount(): number {
		return this._window.messages.length
	}

	public get contextFiles(): string[] {
		return this._window.fileContextPaths
	}

	public get estimatedTokenCount(): number {
		return this._window.estimatedTokenCount
	}

	public get maxContextTokens(): number {
		return this._window.maxContextTokens
	}

	/**
	 * How `maxContextTokens` was resolved for the active configuration.
	 * Surfaced in the popover so a user can tell whether the displayed value
	 * comes from the model's reported `info.contextWindow`, from an explicit
	 * override, or has not been resolved yet (agent is in Error/Standby).
	 */
	public get contextWindowSource(): "override" | "model-info" | "unresolved" {
		return this._config?.contextWindowSource ?? "unresolved"
	}

	public get contextFillThreshold(): number {
		return this._window.contextFillThreshold
	}

	public get isContextNearlyFull(): boolean {
		return this._window.isNearlyFull
	}

	public getContextUsage() {
		return this._window.getUsage()
	}

	public getCostSnapshot() {
		return {
			sessionInputTokens: this._costTracking.totalInputTokens,
			sessionOutputTokens: this._costTracking.totalOutputTokens,
			sessionEstimatedCostUSD: this._costTracking.estimatedCostUSD,
		}
	}

	public getMessages(): ReadonlyArray<AgentMessage> {
		return this._window.messages
	}

	public get pendingQuestionCount(): number {
		return this._queue.pendingCount
	}

	/**
	 * Notify the live memory agent that a file was modified by a task tool.
	 * The path is accumulated and surfaced as a hint on the next question
	 * (no eviction → preserves the LLM provider's KV cache).
	 *
	 * Files matching .shoferignore patterns are silently skipped.
	 */
	public notifyFileModified(filePath: string): void {
		if (!filePath) return
		if (filePath.startsWith(".shofer/")) return
		// Respect .shoferignore patterns
		if (this._shoferIgnoreController && !this._shoferIgnoreController.validateAccess(filePath)) return
		this._recentlyModifiedFiles.add(filePath)
	}

	public cancelAllQuestions(): void {
		this._queue.cancelAll()
		if (this._state === "Busy") {
			this._setState("Ready", "Agent is ready")
		}
	}

	// ─── Initialization ──────────────────────────────────────────────────

	public async initialize(): Promise<{ requiresRestart: boolean }> {
		try {
			this._setState("Initializing", "Loading configuration...")

			const config = await this._loadConfiguration()
			if (!config) {
				this._setState("Standby", "Live Memory is not configured")
				return { requiresRestart: false }
			}
			this._config = config

			this._window.configure({
				maxContextTokens: config.maxContextTokens,
				contextFillThreshold: config.contextFillThreshold,
			})

			await this._initDirectoryTree()
			this._startFileWatcher()

			if (!config.enabled) {
				this._setState("Standby", "Live Memory is disabled")
				return { requiresRestart: false }
			}

			const snapshot = await this._store.load()
			this._restoreSnapshot(snapshot)

			if (!config.apiConfigId) {
				this._setState("Error", "No API Configuration selected")
				return { requiresRestart: false }
			}

			this._llm = new LiveMemoryLlmClient(config)

			this._setState("Ready", "Agent is ready")
			return { requiresRestart: false }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this._setState("Error", message)
			TelemetryService.instance.captureEvent(TelemetryEventName.LIVE_MEMORY_ERROR, {
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
				location: "initialize",
			})
			return { requiresRestart: false }
		}
	}

	// ─── Question Processing ─────────────────────────────────────────────

	public async askQuestion(
		question: string,
		contextFiles?: string[],
		opts: {
			timeoutMs?: number
			softTimeoutSec?: number
			softResultLength?: number
		} = {},
	): Promise<QuestionResult> {
		if (!this._config || !this._llm) {
			throw new Error("Live Memory is not initialized. Call initialize() first.")
		}
		if (!this.isLiveMemoryAvailable && this._state !== "Busy") {
			throw new Error(`Live Memory is not available (state: ${this._state})`)
		}
		const { timeoutMs = QUESTION_TIMEOUT_MS, softTimeoutSec, softResultLength } = opts
		return this._queue.enqueue(question, contextFiles, timeoutMs, {
			softTimeoutSec,
			softResultLength,
		})
	}

	/** Queue processor — runs one question end-to-end. */
	private async _processQuestion(
		question: string,
		contextFiles: string[] | undefined,
		signal: AbortSignal,
		softLimits: { softTimeoutSec?: number; softResultLength?: number } = {},
	): Promise<QuestionResult> {
		const startTime = Date.now()
		const llm = this._llm
		if (!llm) throw new Error("Live Memory LLM client is not initialized")

		logger.info(
			`[LiveMemory.Manager] _processQuestion start questionLen=${question.length} contextFiles=${(contextFiles ?? []).length}`,
		)

		this._setState("Busy", "Processing question...")
		try {
			const recentlyModified = this._drainRecentlyModifiedFiles()

			if (contextFiles && contextFiles.length > 0) {
				for (const filePath of contextFiles) {
					await this._loadFileIntoContext(filePath)
				}
			}

			// ── Build the agent loop's prompt + initial conversation ───────
			// The system prompt holds ONLY content that is stable across
			// questions (directory tree, file-context manifest, folded system
			// markers) so the provider's KV/attention cache survives from one
			// question to the next. Per-question volatile hints (recently-
			// modified files, soft constraints) ride on the trailing question
			// turn instead — putting them in the system prefix would bust the
			// cache on every question, defeating the eviction-avoidance design.
			const systemPrompt = this._buildSystemPrompt()
			const questionHints = this._buildQuestionHints(recentlyModified, softLimits)
			let baseConversation = this._buildBaseConversation(question, questionHints)
			const tools = this._getToolCatalog()
			const executor = this._getToolExecutor()

			// In-flight conversation grows across iterations with assistant
			// (text + tool_use blocks) and user (tool_result blocks) turns.
			// Only the original question + final assistant text are persisted.
			const conversation: Anthropic.Messages.MessageParam[] = [...baseConversation]
			let baseLength = baseConversation.length

			// ── Construct the persisted user + assistant messages UP FRONT ─
			// so the chat panel can stream the turn live. We mutate
			// `assistantMsg.parts` in place as text / reasoning / tool calls
			// arrive, firing `_conversationUpdateEmitter` after each event.
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
			this._conversationUpdateEmitter.fire()

			// Helpers that mutate assistantMsg.parts in place and fan out to
			// the chat panel. `appendStreamingText` coalesces adjacent
			// deltas of the same kind into one part so the UI gets a single
			// growing block rather than one part per chunk.
			const parts = assistantMsg.parts as AgentMessagePart[]
			const appendStreamingText = (kind: "text" | "reasoning", delta: string): void => {
				if (!delta) return
				const last = parts[parts.length - 1]
				if (last && last.kind === kind) {
					last.text += delta
				} else {
					parts.push({ kind, text: delta })
				}
				this._conversationUpdateEmitter.fire()
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
				if (iterations >= LiveMemoryManager.MAX_AGENT_ITERATIONS) {
					finalAnswer =
						finalAnswer ||
						`I was unable to finish this question within ${LiveMemoryManager.MAX_AGENT_ITERATIONS} tool iterations. Please narrow the scope or try again.`
					break
				}
				iterations += 1
				logger.info(
					`[LiveMemory.Manager] agent-loop iter=${iterations} convLen=${conversation.length} tools=${tools.length}`,
				)
				const result = await llm.chatWithTools({
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
								// Push a placeholder part; result/isError get
								// filled in once the executor returns.
								parts.push({
									kind: "tool_call",
									toolCallId: event.toolCall.id,
									name: event.toolCall.name,
									args: event.toolCall.arguments,
									inProgress: true,
								})
								this._conversationUpdateEmitter.fire()
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

				// Append assistant turn carrying both any text and tool_use blocks.
				const assistantBlocks: Anthropic.Messages.ContentBlockParam[] = []
				if (result.answer) assistantBlocks.push({ type: "text", text: result.answer })
				for (const tc of result.toolCalls) {
					let parsedInput: unknown = {}
					try {
						parsedInput = tc.arguments ? JSON.parse(tc.arguments) : {}
					} catch {
						parsedInput = { _raw: tc.arguments }
					}
					assistantBlocks.push({
						type: "tool_use",
						id: tc.id,
						name: tc.name,
						input: parsedInput as Record<string, unknown>,
					})
				}
				conversation.push({ role: "assistant", content: assistantBlocks })

				// Execute every tool call sequentially and bundle the
				// results into a single user turn (Anthropic convention).
				const toolResultBlocks: Anthropic.Messages.ContentBlockParam[] = []
				for (const tc of result.toolCalls) {
					const exec = await executor.execute(tc.name, tc.arguments, signal)
					toolResultBlocks.push({
						type: "tool_result",
						tool_use_id: tc.id,
						content: exec.content,
						is_error: exec.isError ?? false,
					})

					// Patch the in-flight tool_call part with the result so
					// the chat panel can collapse the spinner and show the
					// outcome live.
					const part = parts.find((p) => p.kind === "tool_call" && p.toolCallId === tc.id) as
						| Extract<AgentMessagePart, { kind: "tool_call" }>
						| undefined
					if (part) {
						part.result = exec.content
						part.isError = exec.isError ?? false
						part.inProgress = false
						this._conversationUpdateEmitter.fire()
					}
				}
				conversation.push({ role: "user", content: toolResultBlocks })

				// Enforce the context budget after each iteration so the
				// persisted window stays trimmed. Then refresh the base
				// portion of the in-flight conversation so the next
				// iteration's LLM call benefits from the eviction.
				this._window.enforceLimit()
				this._costTracking.totalTokensTruncated += this._window.consumeEvictedTokens()

				const freshBase = this._buildBaseConversation(question, questionHints)
				conversation.splice(0, baseLength, ...freshBase)
				baseLength = freshBase.length
			}

			logger.info(
				`[LiveMemory.Manager] agent-loop done iters=${iterations} answerLen=${finalAnswer.length} prompt=${totalPrompt} completion=${totalCompletion}`,
			)

			// Finalize the in-flight assistant message. `finalAnswer` is the
			// text from the LAST iteration only (the model's closing answer
			// after all tool calls). If streaming already pushed it into
			// `parts`, we don't duplicate; otherwise append it now.
			assistantMsg.content = finalAnswer
			if (finalAnswer) {
				const last = parts[parts.length - 1]
				if (!(last && last.kind === "text" && last.text === finalAnswer)) {
					// The streaming callback should have already appended
					// this text. If it didn't (e.g. provider skipped text
					// chunks and only delivered tool_calls then a final
					// `answer` blob), add it now so the panel shows it.
					const hasText = parts.some((p) => p.kind === "text" && p.text.includes(finalAnswer))
					if (!hasText) parts.push({ kind: "text", text: finalAnswer })
				}
			}

			// Enforce limit after appending — prevents unbounded growth
			// between questions when no contextFiles are loaded.
			this._window.enforceLimit()
			this._costTracking.totalTokensTruncated += this._window.consumeEvictedTokens()

			this._accumulateCost(totalPrompt, totalCompletion, totalCost)

			await this._persist()
			this._conversationUpdateEmitter.fire()

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

			logger.error(
				`[LiveMemory.Manager] _processQuestion FAILED isAbort=${isAbort} error=${message}\n${error instanceof Error ? (error.stack ?? "") : ""}`,
			)

			if (!isAbort) {
				this._setState("Error", message)
			} else {
				// On abort/timeout, return to Ready so future questions can proceed.
				this._setState("Ready", "Agent is ready")
			}

			TelemetryService.instance.captureEvent(TelemetryEventName.LIVE_MEMORY_ERROR, {
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
				location: "askQuestion",
			})
			throw error instanceof Error ? error : new Error(message)
		}
	}

	private _drainRecentlyModifiedFiles(): string[] {
		if (this._recentlyModifiedFiles.size === 0) return []
		const files = Array.from(this._recentlyModifiedFiles)
		this._recentlyModifiedFiles.clear()
		return files
	}

	// ─── Context Management ──────────────────────────────────────────────

	public async clearContext(): Promise<void> {
		this._window.clear()
		await this._initDirectoryTree()
		await this._persist()
		this._conversationUpdateEmitter.fire()

		if (this._state === "Error") {
			this._setState("Standby", "Context cleared. Agent needs re-initialization.")
		} else {
			this._setState("Ready", "Context cleared. Agent is ready.")
		}
	}

	public async recoverFromError(): Promise<void> {
		if (this._isRecoveringFromError) return
		this._isRecoveringFromError = true
		try {
			this._config = null
			this._llm = null
			this._setState("Standby", "Recovered from error")
		} finally {
			this._isRecoveringFromError = false
		}
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────

	public dispose(): void {
		if (this._fileWatcher) {
			this._fileWatcher.dispose()
			this._fileWatcher = null
		}
		if (this._shoferIgnoreController) {
			this._shoferIgnoreController.dispose()
			this._shoferIgnoreController = undefined
		}
		this.cancelAllQuestions()
		this._stateChangeEmitter.dispose()
		this._conversationUpdateEmitter.dispose()
	}

	// ─── Persistence Glue ────────────────────────────────────────────────

	private _restoreSnapshot(snapshot: ConversationSnapshot): void {
		this._window.restore(snapshot.messages, snapshot.fileContexts)
		this._costTracking = snapshot.costTracking
	}

	private _snapshot(): ConversationSnapshot {
		return {
			messages: [...this._window.messages],
			fileContexts: [...this._window.fileContexts],
			costTracking: this._costTracking,
		}
	}

	private async _persist(): Promise<void> {
		try {
			await this._store.save(this._snapshot())
		} catch (error) {
			logger.error(
				`[LiveMemory] Failed to persist conversation: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	// ─── Configuration (via ContextProxy) ────────────────────────────────

	/**
	 * Read live-memory configuration from ContextProxy + ProviderSettingsManager.
	 *
	 * The live memory agent does not own provider/model/credentials — those come
	 * from an API Configuration profile (managed under Settings → Providers,
	 * persisted via ProviderSettingsManager). The Settings → Live Memory tab
	 * only stores: enabled flag, apiConfigId link, optional context-window
	 * override, and the context-fill threshold.
	 */
	private async _loadConfiguration(): Promise<LiveMemoryConfig | null> {
		const proxy = await ContextProxy.getInstance(this.context)

		const enabled = proxy.getValue("liveMemoryEnabled") ?? true
		const apiConfigId = proxy.getValue("liveMemoryApiConfigId") ?? ""
		const overrideMaxContextTokens = proxy.getValue("liveMemoryMaxContextTokens")
		const contextFillThreshold =
			proxy.getValue("liveMemoryContextFillThreshold") ?? DEFAULT_CONTEXT_FILL_THRESHOLD

		// No profile linked → return a partial config; initialize() turns this
		// into an Error state with a "No API Configuration selected" message.
		// `contextWindowSource: "unresolved"` flags the popover that the
		// displayed `maxContextTokens` is just a placeholder for the
		// (about-to-be-Error) ContextWindow init, not a real model value.
		if (!apiConfigId) {
			return {
				enabled,
				apiConfigId: "",
				apiConfigName: "",
				providerSettings: {},
				maxContextTokens: overrideMaxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
				contextWindowSource: overrideMaxContextTokens !== undefined ? "override" : "unresolved",
				contextFillThreshold,
			}
		}

		const psm = new ProviderSettingsManager(this.context)
		const profile = await psm.getProfile({ id: apiConfigId })

		// Resolve max context tokens: explicit override wins; otherwise
		// query the model info reported by the resolved handler. Any failure
		// here MUST throw so initialize() promotes the agent to Error state
		// — silently falling back to DEFAULT_MAX_CONTEXT_TOKENS hides real
		// configuration problems (e.g. the popover showing 128K when the
		// linked profile actually has a 1M window).
		let resolvedMaxContextTokens: number
		let contextWindowSource: "override" | "model-info"
		if (overrideMaxContextTokens !== undefined) {
			resolvedMaxContextTokens = overrideMaxContextTokens
			contextWindowSource = "override"
		} else {
			const handler = buildApiHandler(profile, { taskId: "shofer-live-memory" })
			const info = handler.getModel().info
			if (!info?.contextWindow || info.contextWindow <= 0) {
				throw new Error(
					`API Configuration '${profile.name}' did not report a context window. ` +
						`Set 'Max context tokens' under Settings → Live Memory to override.`,
				)
			}
			resolvedMaxContextTokens = info.contextWindow
			contextWindowSource = "model-info"
		}

		return {
			enabled,
			apiConfigId,
			apiConfigName: profile.name,
			providerSettings: profile,
			maxContextTokens: resolvedMaxContextTokens,
			contextWindowSource,
			contextFillThreshold,
		}
	}

	// ─── Directory Tree + File Watcher ───────────────────────────────────

	private async _initDirectoryTree(): Promise<void> {
		try {
			this._directoryTree = new LiveMemoryDirectoryTree(
				this.workspacePath,
				this._window.maxContextTokens,
				this._shoferIgnoreController,
			)
			this._directoryTreeString = await this._directoryTree.generate()
		} catch (error) {
			logger.warn(
				`[LiveMemory] Failed to generate directory tree: ${error instanceof Error ? error.message : String(error)}`,
			)
			this._directoryTreeString = "[Workspace directory tree unavailable]"
		}
	}

	private _startFileWatcher(): void {
		if (this._fileWatcher) return

		this._fileWatcher = new LiveMemoryFileWatcher(
			this.workspacePath,
			(filePath, event) => {
				if (event === "deleted") {
					this._window.removeFileContext(filePath)
				} else {
					this._window.invalidateFileContext(filePath)
				}
			},
			this._shoferIgnoreController,
		)

		this._fileWatcher.start()
	}

	// ─── Message Construction ────────────────────────────────────────────

	/**
	 * Build the system prompt for the live memory agent. This holds ONLY content
	 * that is stable from one question to the next — the directory tree, the
	 * file-context manifest, and folded-in system markers — so the provider's
	 * prompt/KV cache survives across questions. Per-question volatile hints
	 * (recently-modified files, soft constraints) deliberately live on the
	 * trailing question turn instead (see `_buildQuestionHints`); placing them
	 * in this prefix would invalidate the cache on every question and defeat
	 * the eviction-avoidance design. Stable within a single question's loop too.
	 *
	 * System-role messages from the persisted window are folded in so
	 * truncation markers and other system notes survive trimming.
	 */
	private _buildSystemPrompt(): string {
		const treeContent = this._directoryTreeString
			? `[Workspace structure:\n${this._directoryTreeString}\n\nshoferignore and .gitignore patterns are respected.]`
			: "[No workspace structure available]"

		const parts = [LIVE_MEMORY_SYSTEM_PROMPT.replace("{directoryTree}", treeContent)]

		for (const fc of this._window.fileContexts) {
			parts.push(
				`[File context: ${fc.filePath}]\n(Content hash: ${fc.contentHash}, tokens: ~${fc.tokenEstimate})`,
			)
		}

		// Fold in system-role messages from the persisted window (e.g.
		// truncation markers, file-context notes) so they survive trimming.
		for (const msg of this._window.messages) {
			if (msg.role === "system") {
				parts.push(msg.content)
			}
		}

		return parts.join("\n\n")
	}

	/**
	 * Build the per-question hint block (recently-modified files + soft
	 * constraints). Returns "" when there is nothing to add. This rides on the
	 * trailing question turn rather than the system prefix so it never busts
	 * the cross-question KV cache.
	 */
	private _buildQuestionHints(
		recentlyModifiedFiles: string[],
		softLimits: { softTimeoutSec?: number; softResultLength?: number } = {},
	): string {
		const parts: string[] = []

		if (recentlyModifiedFiles.length > 0) {
			parts.push(
				`[Note: the following files have been modified since you last read them: ${recentlyModifiedFiles.join(", ")}. Consider re-reading them if relevant to this question.]`,
			)
		}

		const softTimeoutSec = softLimits.softTimeoutSec ?? DEFAULT_LIVE_MEMORY_SOFT_TIMEOUT_SEC
		const softResultLength = softLimits.softResultLength ?? DEFAULT_LIVE_MEMORY_SOFT_RESULT_LENGTH
		parts.push(
			`[Soft constraints for this question — recommendations, not hard limits, and not enforced by the runtime: aim to complete within ~${softTimeoutSec}s of wall time (use fewer tool round-trips when possible) and keep your final answer under ~${softResultLength} characters. If the question genuinely requires more, exceed the limits rather than giving an incorrect or misleading answer.]`,
		)

		return parts.join("\n\n")
	}

	/**
	 * Build the base conversation array from the persisted window messages
	 * plus the current question. This is refreshable — after
	 * enforceLimit() trims the window, a fresh call produces a shorter
	 * base that leaves more room for in-flight tool results. The per-question
	 * hint block (if any) is appended to the trailing question turn so the
	 * stable system prefix stays cache-friendly.
	 */
	private _buildBaseConversation(question: string, questionHints = ""): Anthropic.Messages.MessageParam[] {
		const conv: Anthropic.Messages.MessageParam[] = []
		for (const msg of this._window.messages) {
			if (msg.role !== "system") {
				conv.push({ role: msg.role as "user" | "assistant", content: msg.content })
			}
		}
		const questionContent = questionHints ? `${question}\n\n${questionHints}` : question
		conv.push({ role: "user", content: questionContent })
		return conv
	}

	/** Lazily construct the Read-category tool catalog (minus ask_live_memory). */
	private _getToolCatalog(): OpenAI.Chat.ChatCompletionTool[] {
		if (!this._toolCatalog) {
			const allowed = new Set<string>(LIVE_MEMORY_READ_TOOLS)
			this._toolCatalog = getNativeTools().filter((t) => t.type === "function" && allowed.has(t.function.name))
			logger.info(
				`[LiveMemory.Manager] tool catalog built: ${this._toolCatalog.length} tools — ${this._toolCatalog
					.map((t) => (t as any).function.name)
					.join(", ")}`,
			)
		}
		return this._toolCatalog
	}

	/** Lazily construct the workspace-scoped tool executor. */
	private _getToolExecutor(): LiveMemoryToolExecutor {
		if (!this._toolExecutor) {
			this._toolExecutor = new LiveMemoryToolExecutor(this.workspacePath, this.context)
		}
		return this._toolExecutor
	}

	// ─── File Context ────────────────────────────────────────────────────

	private async _loadFileIntoContext(filePath: string): Promise<void> {
		try {
			const fullPath = path.resolve(this.workspacePath, filePath)
			const content = await fs.readFile(fullPath, "utf-8")
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
		} catch (error) {
			logger.warn(
				`[LiveMemory] Could not load file into context: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	// ─── Cost Accumulation ───────────────────────────────────────────────

	private _accumulateCost(promptTokens: number, completionTokens: number, costUSD: number): void {
		this._costTracking.totalInputTokens += promptTokens
		this._costTracking.totalOutputTokens += completionTokens
		this._costTracking.estimatedCostUSD += costUSD
		this._costTracking.lastUpdated = Date.now()
	}

	// ─── State Management ────────────────────────────────────────────────

	private _setState(newState: LiveMemoryState, message: string): void {
		const stateChanged = newState !== this._state || message !== this._stateMessage
		if (stateChanged) {
			this._state = newState
			this._stateMessage = message
			this._stateChangeEmitter.fire(newState)
		}
	}
}

// ─── Provider → Secret Key Mapping ─────────────────────────────────────
// (removed) The live memory agent now consumes credentials from an API
// Configuration profile via ProviderSettingsManager — no per-provider
// live-memory secrets exist in storage.
