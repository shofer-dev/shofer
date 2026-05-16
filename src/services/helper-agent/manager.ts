/**
 * HelperAgentManager — singleton-per-workspace orchestrator for the
 * Helper Agent (a persistent, read-only codebase Q&A companion).
 *
 * Responsibilities (delegated to focused collaborators):
 *   - persistence            → ConversationStore
 *   - request serialization  → QuestionQueue
 *   - context budget         → ContextWindow
 *   - LLM dispatch           → HelperAgentLlmClient (wraps shared ApiHandler)
 *   - workspace scan         → HelperAgentDirectoryTree
 *   - external file changes  → HelperAgentFileWatcher
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
	type HelperAgentState,
	type HelperAgentConfig,
	type AgentMessage,
	type FileContextEntry,
	type QuestionResult,
	DEFAULT_MAX_CONTEXT_TOKENS,
	DEFAULT_CONTEXT_FILL_THRESHOLD,
	HELPER_AGENT_SYSTEM_PROMPT,
	QUESTION_TIMEOUT_MS,
	DEFAULT_HELPER_SOFT_TIMEOUT_SEC,
	DEFAULT_HELPER_SOFT_RESULT_LENGTH,
} from "@shofer/types"

import { ContextProxy } from "../../core/config/ContextProxy"
import { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { buildApiHandler } from "../../api"
import { logger } from "../../utils/logging"

import { HelperAgentDirectoryTree } from "./directory-tree"
import { HelperAgentFileWatcher } from "./file-watcher"
import { ConversationStore, type ConversationSnapshot } from "./conversation-store"
import { QuestionQueue } from "./question-queue"
import { ContextWindow, estimateTokens } from "./context-window"
import { HelperAgentLlmClient } from "./llm-client"
import { HelperAgentToolExecutor, HELPER_AGENT_READ_TOOLS } from "./tool-executor"
import { getNativeTools } from "../../core/prompts/tools/native-tools"
import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"

export class HelperAgentManager implements vscode.Disposable {
	// ─── Singleton Implementation ────────────────────────────────────────

	private static instances = new Map<string, HelperAgentManager>()

	public static getInstance(
		context: vscode.ExtensionContext,
		workspacePath?: string,
	): HelperAgentManager | undefined {
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

		let instance = HelperAgentManager.instances.get(workspacePath)
		if (!instance) {
			instance = new HelperAgentManager(workspacePath, context)
			HelperAgentManager.instances.set(workspacePath, instance)
		}
		return instance
	}

	public static getAllInstances(): HelperAgentManager[] {
		return Array.from(HelperAgentManager.instances.values())
	}

	public static disposeAll(): void {
		for (const instance of HelperAgentManager.instances.values()) {
			instance.dispose()
		}
		HelperAgentManager.instances.clear()
	}

	// ─── Instance Fields ─────────────────────────────────────────────────

	private readonly workspacePath: string
	private readonly context: vscode.ExtensionContext

	private _state: HelperAgentState = "Standby"
	private _stateMessage: string = ""
	private _config: HelperAgentConfig | null = null

	private readonly _store: ConversationStore
	private readonly _queue: QuestionQueue
	private readonly _window: ContextWindow
	private _llm: HelperAgentLlmClient | null = null

	/** Workspace structure scanner — feeds the system prompt. */
	private _directoryTree: HelperAgentDirectoryTree | null = null
	private _directoryTreeString: string = "[No workspace structure available]"

	/** External-edit detector — invalidates file context on writes. */
	private _fileWatcher: HelperAgentFileWatcher | null = null

	/** Read-only tool dispatcher used inside the agent loop. */
	private _toolExecutor: HelperAgentToolExecutor | null = null

	/** Cached tool catalog — the Read group minus `ask_helper_agent`. */
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

	private _stateChangeEmitter = new vscode.EventEmitter<HelperAgentState>()
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

	public get state(): HelperAgentState {
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

	public get isHelperAgentAvailable(): boolean {
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
	 * Notify the helper agent that a file was modified by a task tool.
	 * The path is accumulated and surfaced as a hint on the next question
	 * (no eviction → preserves the LLM provider's KV cache).
	 */
	public notifyFileModified(filePath: string): void {
		if (!filePath) return
		if (filePath.startsWith(".shofer/")) return
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
				this._setState("Standby", "Helper agent is not configured")
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
				this._setState("Standby", "Helper agent is disabled")
				return { requiresRestart: false }
			}

			const snapshot = await this._store.load()
			this._restoreSnapshot(snapshot)

			if (!config.apiConfigId) {
				this._setState("Error", "No API Configuration selected")
				return { requiresRestart: false }
			}

			this._llm = new HelperAgentLlmClient(config)

			this._setState("Ready", "Agent is ready")
			return { requiresRestart: false }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this._setState("Error", message)
			TelemetryService.instance.captureEvent(TelemetryEventName.HELPER_AGENT_ERROR, {
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
			throw new Error("Helper agent is not initialized. Call initialize() first.")
		}
		if (!this.isHelperAgentAvailable && this._state !== "Busy") {
			throw new Error(`Helper agent is not available (state: ${this._state})`)
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
		if (!llm) throw new Error("Helper agent LLM client is not initialized")

		logger.info(
			`[HelperAgent.Manager] _processQuestion start questionLen=${question.length} contextFiles=${(contextFiles ?? []).length}`,
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
			const { systemPrompt, baseConversation } = this._buildAgentPrompt(question, recentlyModified, softLimits)
			const tools = this._getToolCatalog()
			const executor = this._getToolExecutor()

			// In-flight conversation grows across iterations with assistant
			// (text + tool_use blocks) and user (tool_result blocks) turns.
			// Only the original question + final assistant text are persisted.
			const conversation: Anthropic.Messages.MessageParam[] = [...baseConversation]

			let totalPrompt = 0
			let totalCompletion = 0
			let totalCost = 0
			let finalAnswer = ""
			let iterations = 0

			for (;;) {
				if (signal.aborted) {
					const err = new Error("Helper agent aborted")
					err.name = "AbortError"
					throw err
				}
				if (iterations >= HelperAgentManager.MAX_AGENT_ITERATIONS) {
					finalAnswer =
						finalAnswer ||
						`I was unable to finish this question within ${HelperAgentManager.MAX_AGENT_ITERATIONS} tool iterations. Please narrow the scope or try again.`
					break
				}
				iterations += 1
				logger.info(
					`[HelperAgent.Manager] agent-loop iter=${iterations} convLen=${conversation.length} tools=${tools.length}`,
				)
				const result = await llm.chatWithTools({ systemPrompt, messages: conversation, tools, signal })
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
				}
				conversation.push({ role: "user", content: toolResultBlocks })
			}

			logger.info(
				`[HelperAgent.Manager] agent-loop done iters=${iterations} answerLen=${finalAnswer.length} prompt=${totalPrompt} completion=${totalCompletion}`,
			)

			const userMsg: AgentMessage = {
				id: randomUUID(),
				role: "user",
				content: question,
				timestamp: Date.now(),
				metadata: { fileReferences: contextFiles },
			}
			const assistantMsg: AgentMessage = {
				id: randomUUID(),
				role: "assistant",
				content: finalAnswer,
				timestamp: Date.now(),
			}

			this._window.appendMessage(userMsg)
			this._window.appendMessage(assistantMsg)

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
				`[HelperAgent.Manager] _processQuestion FAILED isAbort=${isAbort} error=${message}\n${error instanceof Error ? (error.stack ?? "") : ""}`,
			)

			if (!isAbort) {
				this._setState("Error", message)
			} else {
				// On abort/timeout, return to Ready so future questions can proceed.
				this._setState("Ready", "Agent is ready")
			}

			TelemetryService.instance.captureEvent(TelemetryEventName.HELPER_AGENT_ERROR, {
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
				`[HelperAgent] Failed to persist conversation: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	// ─── Configuration (via ContextProxy) ────────────────────────────────

	/**
	 * Read helper-agent configuration from ContextProxy + ProviderSettingsManager.
	 *
	 * The helper agent does not own provider/model/credentials — those come
	 * from an API Configuration profile (managed under Settings → Providers,
	 * persisted via ProviderSettingsManager). The Settings → Helper Agent tab
	 * only stores: enabled flag, apiConfigId link, optional context-window
	 * override, and the context-fill threshold.
	 */
	private async _loadConfiguration(): Promise<HelperAgentConfig | null> {
		const proxy = await ContextProxy.getInstance(this.context)

		const enabled = proxy.getValue("helperAgentEnabled") ?? true
		const apiConfigId = proxy.getValue("helperAgentApiConfigId") ?? ""
		const overrideMaxContextTokens = proxy.getValue("helperAgentMaxContextTokens")
		const contextFillThreshold = proxy.getValue("helperAgentContextFillThreshold") ?? DEFAULT_CONTEXT_FILL_THRESHOLD

		// No profile linked → return a partial config; initialize() turns this
		// into an Error state with a "No API Configuration selected" message.
		if (!apiConfigId) {
			return {
				enabled,
				apiConfigId: "",
				apiConfigName: "",
				providerSettings: {},
				maxContextTokens: overrideMaxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
				contextFillThreshold,
			}
		}

		const psm = new ProviderSettingsManager(this.context)
		try {
			const profile = await psm.getProfile({ id: apiConfigId })
			// Resolve max context tokens: explicit override wins; otherwise
			// query the model info reported by the resolved handler.
			let resolvedMaxContextTokens = overrideMaxContextTokens
			if (resolvedMaxContextTokens === undefined) {
				try {
					const handler = buildApiHandler(profile, { taskId: "shofer-helper-agent" })
					const info = handler.getModel().info
					resolvedMaxContextTokens = info?.contextWindow ?? DEFAULT_MAX_CONTEXT_TOKENS
				} catch (error) {
					logger.warn(
						`[HelperAgent] Failed to inspect model info for context window: ${error instanceof Error ? error.message : String(error)}`,
					)
					resolvedMaxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS
				}
			}
			return {
				enabled,
				apiConfigId,
				apiConfigName: profile.name,
				providerSettings: profile,
				maxContextTokens: resolvedMaxContextTokens,
				contextFillThreshold,
			}
		} catch (error) {
			logger.warn(
				`[HelperAgent] API Configuration '${apiConfigId}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
			)
			return {
				enabled,
				apiConfigId: "",
				apiConfigName: "",
				providerSettings: {},
				maxContextTokens: overrideMaxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
				contextFillThreshold,
			}
		}
	}

	// ─── Directory Tree + File Watcher ───────────────────────────────────

	private async _initDirectoryTree(): Promise<void> {
		try {
			this._directoryTree = new HelperAgentDirectoryTree(this.workspacePath, this._window.maxContextTokens)
			this._directoryTreeString = await this._directoryTree.generate()
		} catch (error) {
			logger.warn(
				`[HelperAgent] Failed to generate directory tree: ${error instanceof Error ? error.message : String(error)}`,
			)
			this._directoryTreeString = "[Workspace directory tree unavailable]"
		}
	}

	private _startFileWatcher(): void {
		if (this._fileWatcher) return

		this._fileWatcher = new HelperAgentFileWatcher(this.workspacePath, (filePath, event) => {
			if (event === "deleted") {
				this._window.removeFileContext(filePath)
			} else {
				this._window.invalidateFileContext(filePath)
			}
		})

		this._fileWatcher.start()
	}

	// ─── Message Construction ────────────────────────────────────────────

	/**
	 * Build the system prompt + base conversation array for an agent-loop
	 * iteration. The system prompt is held stable across iterations; the
	 * conversation grows with tool_use / tool_result blocks. File-context
	 * markers and the prior persisted Q&A history are embedded as plain
	 * user/assistant text turns.
	 */
	private _buildAgentPrompt(
		question: string,
		recentlyModifiedFiles: string[],
		softLimits: { softTimeoutSec?: number; softResultLength?: number } = {},
	): { systemPrompt: string; baseConversation: Anthropic.Messages.MessageParam[] } {
		const treeContent = this._directoryTreeString
			? `[Workspace structure:\n${this._directoryTreeString}\n\n.shoferignore and .gitignore patterns are respected.]`
			: "[No workspace structure available]"

		const systemPromptParts = [HELPER_AGENT_SYSTEM_PROMPT.replace("{directoryTree}", treeContent)]

		for (const fc of this._window.fileContexts) {
			systemPromptParts.push(
				`[File context: ${fc.filePath}]\n(Content hash: ${fc.contentHash}, tokens: ~${fc.tokenEstimate})`,
			)
		}

		if (recentlyModifiedFiles.length > 0) {
			systemPromptParts.push(
				`[Note: the following files have been modified since you last read them: ${recentlyModifiedFiles.join(", ")}. Consider re-reading them if relevant to this question.]`,
			)
		}

		const softTimeoutSec = softLimits.softTimeoutSec ?? DEFAULT_HELPER_SOFT_TIMEOUT_SEC
		const softResultLength = softLimits.softResultLength ?? DEFAULT_HELPER_SOFT_RESULT_LENGTH
		systemPromptParts.push(
			`[Soft constraints for this question — recommendations, not hard limits, and not enforced by the runtime: aim to complete within ~${softTimeoutSec}s of wall time (use fewer tool round-trips when possible) and keep your final answer under ~${softResultLength} characters. If the question genuinely requires more, exceed the limits rather than giving an incorrect or misleading answer.]`,
		)

		const baseConversation: Anthropic.Messages.MessageParam[] = []
		for (const msg of this._window.messages) {
			if (msg.role === "system") {
				systemPromptParts.push(msg.content)
				continue
			}
			baseConversation.push({ role: msg.role as "user" | "assistant", content: msg.content })
		}

		baseConversation.push({ role: "user", content: question })
		return { systemPrompt: systemPromptParts.join("\n\n"), baseConversation }
	}

	/** Lazily construct the Read-category tool catalog (minus ask_helper_agent). */
	private _getToolCatalog(): OpenAI.Chat.ChatCompletionTool[] {
		if (!this._toolCatalog) {
			const allowed = new Set<string>(HELPER_AGENT_READ_TOOLS)
			this._toolCatalog = getNativeTools().filter((t) => t.type === "function" && allowed.has(t.function.name))
			logger.info(
				`[HelperAgent.Manager] tool catalog built: ${this._toolCatalog.length} tools — ${this._toolCatalog
					.map((t) => (t as any).function.name)
					.join(", ")}`,
			)
		}
		return this._toolCatalog
	}

	/** Lazily construct the workspace-scoped tool executor. */
	private _getToolExecutor(): HelperAgentToolExecutor {
		if (!this._toolExecutor) {
			this._toolExecutor = new HelperAgentToolExecutor(this.workspacePath, this.context)
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
				`[HelperAgent] Could not load file into context: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
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

	private _setState(newState: HelperAgentState, message: string): void {
		const stateChanged = newState !== this._state || message !== this._stateMessage
		if (stateChanged) {
			this._state = newState
			this._stateMessage = message
			this._stateChangeEmitter.fire(newState)
		}
	}
}

// ─── Provider → Secret Key Mapping ─────────────────────────────────────
// (removed) The helper agent now consumes credentials from an API
// Configuration profile via ProviderSettingsManager — no per-provider
// helper-agent secrets exist in storage.
