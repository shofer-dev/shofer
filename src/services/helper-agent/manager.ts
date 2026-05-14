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
	type HelperAgentConversationData,
	type HelperAgentCostTracking,
	type QuestionResult,
	DEFAULT_MAX_CONTEXT_TOKENS,
	DEFAULT_CONTEXT_FILL_THRESHOLD,
	DEFAULT_MAX_RESPONSE_TOKENS,
	QUESTION_TIMEOUT_MS,
	HELPER_AGENT_SYSTEM_PROMPT,
	CONVERSATION_STORE_VERSION,
} from "@shofer/types"

/**
 * HelperAgentManager — singleton per workspace.
 *
 * Manages the lifecycle of a persistent, long-context LLM companion that
 * accumulates codebase knowledge over time. The agent runs on a cheap model
 * with a large context window, surviving task termination and VSCode restarts.
 *
 * Follows the same singleton-per-workspace pattern as CodeIndexManager.
 */
export class HelperAgentManager {
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
				const workspaceFolders = vscode.workspace.workspaceFolders
				if (!workspaceFolders || workspaceFolders.length === 0) {
					return undefined
				}
				folder = workspaceFolders[0]
			}
			workspacePath = folder.uri.fsPath
		}

		if (!HelperAgentManager.instances.has(workspacePath)) {
			const folderUri =
				folder?.uri ??
				({
					fsPath: workspacePath,
					scheme: "file",
					authority: "",
					path: workspacePath,
					toString: () => `file://${workspacePath}`,
				} as unknown as vscode.Uri)
			HelperAgentManager.instances.set(workspacePath, new HelperAgentManager(workspacePath, folderUri, context))
		}
		return HelperAgentManager.instances.get(workspacePath)!
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
	private readonly _folderUri: vscode.Uri
	private readonly context: vscode.ExtensionContext

	private _state: HelperAgentState = "Standby"
	private _stateMessage: string = ""
	private _config: HelperAgentConfig | null = null
	private _messages: AgentMessage[] = []
	private _fileContexts: FileContextEntry[] = []
	private _costTracking: HelperAgentCostTracking = {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalTokensTruncated: 0,
		estimatedCostUSD: 0,
		lastUpdated: Date.now(),
	}

	// Event emitters for UI updates
	private _stateChangeEmitter = new vscode.EventEmitter<HelperAgentState>()
	public readonly onStateChange = this._stateChangeEmitter.event

	private _conversationUpdateEmitter = new vscode.EventEmitter<void>()
	public readonly onConversationUpdate = this._conversationUpdateEmitter.event

	// Flag to prevent race conditions during error recovery
	private _isRecoveringFromError = false

	private constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.workspacePath = workspacePath
		this._folderUri = folderUri
		this.context = context
	}

	// ─── Public API ──────────────────────────────────────────────────────

	/** Current state of the agent. */
	public get state(): HelperAgentState {
		return this._state
	}

	/** Current state message for UI display. */
	public get stateMessage(): string {
		return this._stateMessage
	}

	/** Whether the feature is enabled and configured. */
	public get isFeatureEnabled(): boolean {
		return this._config?.enabled ?? false
	}

	/** Whether the feature has valid API configuration. */
	public get isFeatureConfigured(): boolean {
		if (!this._config) return false
		return !!(this._config.apiKey && this._config.modelId)
	}

	/** Whether the agent is available to answer questions (Ready or Busy state). */
	public get isHelperAgentAvailable(): boolean {
		return this._state === "Ready" || this._state === "Busy"
	}

	/** Number of messages in the conversation. */
	public get conversationTurnCount(): number {
		return this._messages.length
	}

	/** Current files in context. */
	public get contextFiles(): string[] {
		return this._fileContexts.map((f) => f.filePath)
	}

	/** Current token estimate for the context window. */
	public get estimatedTokenCount(): number {
		let count = 0
		for (const msg of this._messages) {
			count += Math.ceil(msg.content.length / 4) // rough estimate: 4 chars per token
		}
		for (const fc of this._fileContexts) {
			count += fc.tokenEstimate
		}
		return count
	}

	/** Max context tokens from config or default. */
	public get maxContextTokens(): number {
		return this._config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
	}

	/** Fill threshold from config or default. */
	public get contextFillThreshold(): number {
		return this._config?.contextFillThreshold ?? DEFAULT_CONTEXT_FILL_THRESHOLD
	}

	/** Whether the context is nearly full (above fill threshold). */
	public get isContextNearlyFull(): boolean {
		return this.estimatedTokenCount > this.maxContextTokens * this.contextFillThreshold
	}

	/** Current context usage snapshot. */
	public getContextUsage() {
		const currentTokens = this.estimatedTokenCount
		const maxTokens = this.maxContextTokens
		return {
			currentTokens,
			maxTokens,
			fillFraction: maxTokens > 0 ? currentTokens / maxTokens : 0,
			isNearlyFull: this.isContextNearlyFull,
		}
	}

	/** Current cost tracking snapshot (for UI display). */
	public getCostSnapshot() {
		return {
			sessionInputTokens: this._costTracking.totalInputTokens,
			sessionOutputTokens: this._costTracking.totalOutputTokens,
			sessionEstimatedCostUSD: this._costTracking.estimatedCostUSD,
		}
	}

	/** Get all messages (for chat view). */
	public getMessages(): ReadonlyArray<AgentMessage> {
		return this._messages
	}

	// ─── Initialization ──────────────────────────────────────────────────

	/**
	 * Initializes the manager with configuration and restores persisted state.
	 * Must be called before using askQuestion().
	 */
	public async initialize(): Promise<{ requiresRestart: boolean }> {
		try {
			this._setState("Initializing", "Loading configuration...")

			// 1. Load configuration from VS Code settings and secrets
			const config = this._loadConfiguration()
			if (!config) {
				this._setState("Standby", "Helper agent is not configured")
				return { requiresRestart: false }
			}
			this._config = config

			// 2. Resolve API key from SecretStorage
			config.apiKey = await this._resolveApiKey()

			// 3. Check if enabled
			if (!config.enabled) {
				this._setState("Standby", "Helper agent is disabled")
				return { requiresRestart: false }
			}

			// 4. Restore persisted conversation
			await this._loadConversation()

			// 5. Validate API configuration
			if (!config.apiKey || !config.modelId) {
				this._setState("Error", "API key or model ID not configured")
				return { requiresRestart: false }
			}

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

	/**
	 * Ask a question to the helper agent. Returns the agent's answer.
	 * This is a synchronous (blocking) call — the caller waits for the answer.
	 *
	 * @param question - The question text
	 * @param contextFiles - Optional file paths to load into context
	 * @param timeoutMs - Optional timeout in milliseconds (default: 5 min)
	 */
	public async askQuestion(
		question: string,
		contextFiles?: string[],
		timeoutMs: number = QUESTION_TIMEOUT_MS,
	): Promise<QuestionResult> {
		if (!this._config) {
			throw new Error("Helper agent is not initialized. Call initialize() first.")
		}

		if (!this.isHelperAgentAvailable) {
			throw new Error(`Helper agent is not available (state: ${this._state})`)
		}

		const startTime = Date.now()

		try {
			this._setState("Busy", "Processing question...")

			// Load context files if provided
			if (contextFiles && contextFiles.length > 0) {
				for (const filePath of contextFiles) {
					await this._loadFileIntoContext(filePath)
				}
			}

			// Build messages array for the LLM call
			const messages = this._buildMessages(question)

			// Call the LLM
			const result = await this._callLLM(messages, timeoutMs)

			// Save the Q&A to conversation history
			const userMsg: AgentMessage = {
				id: randomUUID(),
				role: "user",
				content: question,
				timestamp: Date.now(),
				metadata: {
					fileReferences: contextFiles,
				},
			}
			const assistantMsg: AgentMessage = {
				id: randomUUID(),
				role: "assistant",
				content: result.answer,
				timestamp: Date.now(),
			}

			this._messages.push(userMsg, assistantMsg)
			await this._saveConversation()
			this._conversationUpdateEmitter.fire()

			const contextUsage = this.getContextUsage()
			const durationMs = Date.now() - startTime

			this._setState("Ready", "Agent is ready")

			return {
				answer: result.answer,
				tokensUsed: result.tokensUsed,
				contextUsage,
				costSnapshot: this.getCostSnapshot(),
				contextFiles: this.contextFiles,
				durationMs,
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this._setState("Error", message)
			TelemetryService.instance.captureEvent(TelemetryEventName.HELPER_AGENT_ERROR, {
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
				location: "askQuestion",
			})
			throw error
		}
	}

	// ─── Context Management ──────────────────────────────────────────────

	/**
	 * Clears the conversation context, resetting to just the system prompt.
	 * Cost tracking is preserved.
	 */
	public async clearContext(): Promise<void> {
		this._messages = []
		this._fileContexts = []
		await this._saveConversation()
		this._conversationUpdateEmitter.fire()

		if (this._state === "Error") {
			this._setState("Standby", "Context cleared. Agent needs re-initialization.")
		} else {
			this._setState("Ready", "Context cleared. Agent is ready.")
		}
	}

	// ─── Error Recovery ──────────────────────────────────────────────────

	/**
	 * Recovers from error state by resetting internal state.
	 * Forces a clean re-initialization on next operation.
	 */
	public async recoverFromError(): Promise<void> {
		if (this._isRecoveringFromError) {
			return
		}

		this._isRecoveringFromError = true
		try {
			// Preserve conversation and cost tracking; just reset state
			this._config = null
			this._setState("Standby", "Recovered from error")
		} finally {
			this._isRecoveringFromError = false
		}
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────

	/**
	 * Cleans up the manager instance.
	 */
	public dispose(): void {
		this._stateChangeEmitter.dispose()
		this._conversationUpdateEmitter.dispose()
	}

	// ─── Persistence Helpers ─────────────────────────────────────────────

	/** Path to the conversation store JSON file in globalStorage. */
	private _conversationStorePath(): string {
		const workspaceHash = createHash("sha256").update(this.workspacePath).digest("hex").substring(0, 16)
		return path.join(this.context.globalStorageUri.fsPath, `shofer-helper-agent-${workspaceHash}.json`)
	}

	private async _loadConversation(): Promise<void> {
		try {
			const filePath = this._conversationStorePath()
			const data = await fs.readFile(filePath, "utf-8")
			const parsed: HelperAgentConversationData = JSON.parse(data)

			if (parsed.version !== CONVERSATION_STORE_VERSION) {
				console.warn(`[HelperAgent] Unknown conversation store version: ${parsed.version}`)
				return
			}

			this._messages = parsed.messages ?? []
			this._fileContexts = parsed.fileContexts ?? []
			this._costTracking = parsed.costTracking ?? {
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalTokensTruncated: 0,
				estimatedCostUSD: 0,
				lastUpdated: Date.now(),
			}

			// Verify file contexts — re-read files and check hashes
			const validContexts: FileContextEntry[] = []
			for (const fc of this._fileContexts) {
				try {
					const fullPath = path.resolve(this.workspacePath, fc.filePath)
					const content = await fs.readFile(fullPath, "utf-8")
					const currentHash = createHash("sha256").update(content).digest("hex")
					if (currentHash === fc.contentHash) {
						validContexts.push(fc)
					}
					// Hash mismatch → silently evict
				} catch {
					// File deleted or unreadable → silently evict
				}
			}
			this._fileContexts = validContexts
		} catch (error) {
			// File doesn't exist yet (first launch) — start fresh
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error("[HelperAgent] Error loading conversation:", error)
			}
		}
	}

	private async _saveConversation(): Promise<void> {
		try {
			const filePath = this._conversationStorePath()
			const dir = path.dirname(filePath)
			await fs.mkdir(dir, { recursive: true })

			const data: HelperAgentConversationData = {
				version: CONVERSATION_STORE_VERSION as 1,
				workspacePath: this.workspacePath,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				messages: this._messages,
				fileContexts: this._fileContexts,
				costTracking: this._costTracking,
			}

			await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf-8")
		} catch (error) {
			console.error("[HelperAgent] Error saving conversation:", error)
		}
	}

	// ─── Configuration ───────────────────────────────────────────────────

	/**
	 * Loads helper agent configuration from VS Code settings and SecretStorage.
	 * Uses vscode.workspace.getConfiguration("shofer") for settings and
	 * context.secrets.get() for API keys.
	 */
	private _loadConfiguration(): HelperAgentConfig | null {
		const config = vscode.workspace.getConfiguration("shofer")

		const enabled = config.get<boolean>("helperAgentEnabled", true)
		const provider = config.get<string>("helperAgentProvider", "openai") as HelperAgentConfig["provider"]
		const modelId = config.get<string>("helperAgentModelId", "")
		const baseUrl = config.get<string>("helperAgentBaseUrl") ?? undefined
		const maxContextTokens = config.get<number>("helperAgentMaxContextTokens", DEFAULT_MAX_CONTEXT_TOKENS)
		const contextFillThreshold = config.get<number>(
			"helperAgentContextFillThreshold",
			DEFAULT_CONTEXT_FILL_THRESHOLD,
		)

		// API key is read from SecretStorage. We resolve it in _resolveApiKey()
		// during initialize(), which is async.
		return {
			enabled,
			provider,
			modelId,
			apiKey: "", // Will be resolved in _resolveApiKey
			baseUrl,
			maxContextTokens,
			contextFillThreshold,
		}
	}

	/**
	 * Resolves the API key from VS Code SecretStorage for the configured provider.
	 */
	private async _resolveApiKey(): Promise<string> {
		if (!this._config) return ""

		const secretKey = this._getSecretKeyForProvider(this._config.provider)
		try {
			return (await this.context.secrets.get(secretKey)) ?? ""
		} catch {
			return ""
		}
	}

	private _getSecretKeyForProvider(provider: HelperAgentConfig["provider"]): string {
		switch (provider) {
			case "openai":
				return "helperAgentOpenAiKey"
			case "gemini":
				return "helperAgentGeminiKey"
			case "openai-compatible":
				return "helperAgentOpenAiCompatibleKey"
			case "anthropic":
				return "helperAgentAnthropicKey"
			case "ollama":
				return "helperAgentOllamaKey"
			case "openrouter":
				return "helperAgentOpenRouterKey"
			default:
				return "helperAgentOpenAiKey"
		}
	}

	// ─── LLM Calling ─────────────────────────────────────────────────────

	private _buildMessages(question: string): Array<{ role: string; content: string }> {
		const messages: Array<{ role: string; content: string }> = []

		// System prompt with directory tree placeholder (empty for Phase 1)
		const systemPrompt = HELPER_AGENT_SYSTEM_PROMPT.replace(
			"{directoryTree}",
			"[Workspace structure will be populated in a future phase]",
		)
		messages.push({ role: "system", content: systemPrompt })

		// File contexts as system messages
		for (const fc of this._fileContexts) {
			messages.push({
				role: "system",
				content: `[File context: ${fc.filePath}]\n(Content hash: ${fc.contentHash}, tokens: ~${fc.tokenEstimate})`,
			})
		}

		// Conversation history
		for (const msg of this._messages) {
			messages.push({ role: msg.role, content: msg.content })
		}

		// Current question
		messages.push({ role: "user", content: question })

		return messages
	}

	private async _callLLM(
		messages: Array<{ role: string; content: string }>,
		timeoutMs: number,
	): Promise<{ answer: string; tokensUsed: { prompt: number; completion: number; total: number } }> {
		if (!this._config) {
			throw new Error("Helper agent config not loaded")
		}

		const { provider, modelId, apiKey, baseUrl } = this._config

		// Determine the API endpoint based on provider
		let endpoint: string
		let headers: Record<string, string>
		let body: Record<string, unknown>

		switch (provider) {
			case "openai":
				endpoint = baseUrl
					? `${baseUrl.replace(/\/$/, "")}/chat/completions`
					: "https://api.openai.com/v1/chat/completions"
				headers = {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				}
				break
			case "gemini":
				endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`
				headers = { "Content-Type": "application/json" }
				break
			case "openai-compatible":
			case "openrouter":
				endpoint = baseUrl
					? `${baseUrl.replace(/\/$/, "")}/chat/completions`
					: provider === "openrouter"
						? "https://openrouter.ai/api/v1/chat/completions"
						: "http://localhost:11434/v1/chat/completions"
				headers = {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				}
				if (provider === "openrouter") {
					;(headers as Record<string, string>)["HTTP-Referer"] = "https://github.com/shofer-ai/shofer"
				}
				break
			case "ollama":
				endpoint = baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/chat` : "http://localhost:11434/api/chat"
				headers = { "Content-Type": "application/json" }
				break
			default:
				throw new Error(`Unsupported provider: ${provider}`)
		}

		// Build the request body
		if (provider === "gemini") {
			const contents = messages
				.filter((m) => m.role !== "system")
				.map((m) => ({
					role: m.role === "assistant" ? "model" : "user",
					parts: [{ text: m.content }],
				}))
			const systemMsg = messages.find((m) => m.role === "system")
			body = {
				contents,
				systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
				generationConfig: {
					maxOutputTokens: DEFAULT_MAX_RESPONSE_TOKENS,
				},
			}
		} else if (provider === "ollama") {
			body = {
				model: modelId,
				messages,
				stream: false,
				options: {
					num_predict: DEFAULT_MAX_RESPONSE_TOKENS,
				},
			}
		} else {
			body = {
				model: modelId,
				messages,
				max_tokens: DEFAULT_MAX_RESPONSE_TOKENS,
			}
		}

		// Make the API call
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			})

			if (!response.ok) {
				const errorText = await response.text().catch(() => "Unknown error")
				throw new Error(`LLM API error (${response.status}): ${errorText}`)
			}

			const data = (await response.json()) as any

			// Parse the response based on provider
			let answer: string
			let promptTokens = 0
			let completionTokens = 0

			if (provider === "gemini") {
				answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
				promptTokens = data.usageMetadata?.promptTokenCount ?? 0
				completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0
			} else if (provider === "ollama") {
				answer = data.message?.content ?? ""
				promptTokens = data.prompt_eval_count ?? 0
				completionTokens = data.eval_count ?? 0
			} else {
				answer = data.choices?.[0]?.message?.content ?? ""
				promptTokens = data.usage?.prompt_tokens ?? 0
				completionTokens = data.usage?.completion_tokens ?? 0
			}

			// Update cost tracking
			const totalTokens = promptTokens + completionTokens
			this._costTracking.totalInputTokens += promptTokens
			this._costTracking.totalOutputTokens += completionTokens
			this._costTracking.estimatedCostUSD += this._estimateCost(promptTokens, completionTokens)
			this._costTracking.lastUpdated = Date.now()

			return {
				answer,
				tokensUsed: {
					prompt: promptTokens,
					completion: completionTokens,
					total: totalTokens,
				},
			}
		} finally {
			clearTimeout(timeoutId)
		}
	}

	// ─── File Context ────────────────────────────────────────────────────

	private async _loadFileIntoContext(filePath: string): Promise<void> {
		try {
			const fullPath = path.resolve(this.workspacePath, filePath)
			const content = await fs.readFile(fullPath, "utf-8")
			const contentHash = createHash("sha256").update(content).digest("hex")

			// Check if already in context with same hash
			const existing = this._fileContexts.find((fc) => fc.filePath === filePath)
			if (existing) {
				existing.contentHash = contentHash
				existing.lastReferencedAt = Date.now()
				existing.tokenEstimate = Math.ceil(content.length / 4)
				return
			}

			const entry: FileContextEntry = {
				filePath,
				contentHash,
				tokenEstimate: Math.ceil(content.length / 4),
				loadedAt: Date.now(),
				lastReferencedAt: Date.now(),
			}

			this._fileContexts.push(entry)

			// Check context size and truncate if needed
			this._enforceContextLimit()
		} catch (error) {
			// File can't be read — silently skip
			console.warn(`[HelperAgent] Could not load file into context: ${filePath}`, error)
		}
	}

	private _enforceContextLimit(): void {
		const maxTokens = this._config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS

		while (this.estimatedTokenCount > maxTokens) {
			// Evict least-recently-referenced file contexts first
			if (this._fileContexts.length > 0) {
				this._fileContexts.sort((a, b) => a.lastReferencedAt - b.lastReferencedAt)
				const evicted = this._fileContexts.shift()!
				this._costTracking.totalTokensTruncated += evicted.tokenEstimate
				continue
			}

			// Then truncate oldest conversation turns
			if (this._messages.length > 2) {
				this._messages.shift()
				this._messages.shift() // remove a user+assistant pair
				this._costTracking.totalTokensTruncated += 100 // rough estimate
				continue
			}

			// Can't truncate further
			break
		}
	}

	// ─── Cost Estimation ─────────────────────────────────────────────────

	/**
	 * Rough cost estimate based on provider pricing.
	 * Uses approximate per-token rates. For precise costs, integrate with
	 * a pricing table in a future phase.
	 */
	private _estimateCost(promptTokens: number, completionTokens: number): number {
		// Rough estimates per 1M tokens:
		// - Input: $0.15 (Gemini Flash), $2.50 (GPT-4o-mini), $0.25 (Claude Haiku)
		// - Output: $0.60 (Gemini Flash), $10.00 (GPT-4o-mini), $1.25 (Claude Haiku)
		// Using conservative averages for now
		const inputRatePerM = 0.5 // $0.50 per 1M input tokens (average)
		const outputRatePerM = 2.0 // $2.00 per 1M output tokens (average)

		return (promptTokens / 1_000_000) * inputRatePerM + (completionTokens / 1_000_000) * outputRatePerM
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
