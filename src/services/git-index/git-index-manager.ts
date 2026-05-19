import * as vscode from "vscode"
import { execFile } from "child_process"
import { promisify } from "util"

import type { ContextProxy } from "../../core/config/ContextProxy"
import type { CodebaseIndexConfig } from "@shofer/types"
import type { GitSearchResult } from "./interfaces/git"
import type { IndexingState } from "../code-index/interfaces/manager"
import type { IEmbedder } from "../code-index/interfaces/embedder"

import { CodeIndexConfigManager } from "../code-index/config-manager"
import { CodeIndexServiceFactory } from "../code-index/service-factory"
import { QdrantVectorStore } from "../code-index/vector-store/qdrant-client"

import { GitCacheManager } from "./git-cache-manager"
import { GitHistoryStateManager } from "./git-state-manager"
import { GitHistoryOrchestrator } from "./git-history-orchestrator"
import { GitSearchService } from "./git-search-service"

import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName } from "@shofer/types"

const execFileAsync = promisify(execFile)

/**
 * Collection name prefix for git index collections.
 * Distinct from "ws-" (code index) to keep collections separate.
 */
const GIT_COLLECTION_PREFIX = "git-"

/**
 * Default configuration values for git search (read at search time, not indexing).
 * Indexing defaults live in GitHistoryOrchestrator.
 */
const DEFAULT_GIT_SEARCH_MIN_SCORE = 0.4
const DEFAULT_GIT_SEARCH_MAX_RESULTS = 20

/**
 * Per-workspace singleton manager for git commit history indexing and search.
 *
 * Architecture:
 * ```
 * GitIndexManager (singleton per workspace)
 *  ├── CodeIndexConfigManager     — REUSED: same embedder/Qdrant settings
 *  ├── GitHistoryStateManager     — progress events (Standby|Indexing|Indexed|Error|Stopping)
 *  ├── GitCacheManager            — SHA-256 per-commit content hash cache (globalStorage)
 *  ├── CodeIndexServiceFactory    — REUSED: creates IEmbedder + QdrantVectorStore (dedicated collection)
 *  ├── GitHistoryOrchestrator     — drives indexing (extract → embed → upsert)
 *  │    ├── GitLogExtractor       — runs `git log --format=...` for structured output
 *  │    └── GitWatcher            — polls for new commits (stub in Phase 1)
 *  └── GitSearchService           — embeds query → cosine search against git Qdrant collection
 * ```
 */
export class GitIndexManager {
	// --- Singleton Implementation ---
	private static instances = new Map<string, GitIndexManager>()

	/** Context proxy for reading persisted config (globalState). */
	private _contextProxy?: ContextProxy

	/**
	 * Get or create the GitIndexManager singleton for a workspace.
	 *
	 * @param context - VS Code extension context
	 * @param workspacePath - Path to the workspace root
	 * @returns GitIndexManager instance for the workspace, or undefined if no workspace
	 */
	public static getInstance(context: vscode.ExtensionContext, workspacePath?: string): GitIndexManager | undefined {
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

		if (!GitIndexManager.instances.has(workspacePath)) {
			const folderUri =
				folder?.uri ??
				({
					fsPath: workspacePath,
					scheme: "file",
					authority: "",
					path: workspacePath,
					toString: () => `file://${workspacePath}`,
				} as unknown as vscode.Uri)
			GitIndexManager.instances.set(workspacePath, new GitIndexManager(workspacePath, folderUri, context))
		}
		return GitIndexManager.instances.get(workspacePath)!
	}

	public static getAllInstances(): GitIndexManager[] {
		return Array.from(GitIndexManager.instances.values())
	}

	public static disposeAll(): void {
		for (const instance of GitIndexManager.instances.values()) {
			instance.dispose()
		}
		GitIndexManager.instances.clear()
	}

	// --- Instance Members ---

	public readonly workspacePath: string
	private readonly _folderUri: vscode.Uri
	private readonly context: vscode.ExtensionContext

	private _configManager: CodeIndexConfigManager | undefined
	private readonly _stateManager: GitHistoryStateManager
	private _serviceFactory: CodeIndexServiceFactory | undefined
	private _embedder: IEmbedder | undefined
	private _vectorStore: QdrantVectorStore | undefined
	private _searchService: GitSearchService | undefined
	private _cacheManager: GitCacheManager | undefined
	private _orchestrator: GitHistoryOrchestrator | undefined

	private _isInitialized = false
	private _isGitRepo: boolean | undefined

	// Private constructor for singleton pattern
	private constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.workspacePath = workspacePath
		this._folderUri = folderUri
		this.context = context
		this._stateManager = new GitHistoryStateManager()
	}

	// --- Public API ---

	/** Event emitted when indexing progress updates. */
	public get onProgressUpdate() {
		return this._stateManager.onProgressUpdate
	}

	/** Current state of the git history indexing process. */
	public get state(): IndexingState {
		if (!this.isFeatureEnabled) {
			return "Standby"
		}
		return this._stateManager.state
	}

	/** Whether git indexing is enabled in settings. */
	public get isFeatureEnabled(): boolean {
		return this._configManager?.isFeatureEnabled ?? false
	}

	/** Whether the embedder and Qdrant are configured. */
	public get isFeatureConfigured(): boolean {
		return this._configManager?.isFeatureConfigured ?? false
	}
	/** Whether the manager has been initialized successfully. */
	public get isInitialized(): boolean {
		return this._isInitialized
	}

	/**
	 * Initializes the manager with configuration and dependent services.
	 * Must be called before using any other methods.
	 *
	 * @param contextProxy - Context proxy for config/secret access
	 */
	public async initialize(contextProxy: ContextProxy): Promise<void> {
		if (this._isInitialized) return

		this._contextProxy = contextProxy

		// 1. ConfigManager Initialization and Configuration Loading
		if (!this._configManager) {
			this._configManager = new CodeIndexConfigManager(contextProxy)
		}
		await this._configManager.loadConfiguration()

		// 2. Check if feature is enabled
		if (!this.isFeatureEnabled) {
			this._stateManager.setSystemState("Standby", "Git indexing is disabled in settings.")
			return
		}

		// 3. Check if feature is configured
		if (!this.isFeatureConfigured) {
			this._stateManager.setSystemState(
				"Standby",
				"Git indexing is not configured (Missing API Key or Qdrant URL).",
			)
			return
		}

		// 4. Verify this is a git repository
		this._isGitRepo = await this._checkIsGitRepo()
		if (!this._isGitRepo) {
			this._stateManager.setSystemState("Standby", "Not a git repository.")
			return
		}

		// 5. CacheManager Initialization
		if (!this._cacheManager) {
			this._cacheManager = new GitCacheManager(this.context, this.workspacePath)
			await this._cacheManager.initialize()
			this._wireCacheDiagnostics()
		}

		// 6. Create services (embedder, vector store, search service, orchestrator)
		await this._recreateServices()

		this._isInitialized = true

		// 7. Auto-start indexing — mirrors CodeIndexManager.initialize() so that
		// the git index begins building on extension activation (and on any
		// later transition into enabled+configured+git-repo) without requiring
		// an explicit user click. Fire-and-forget: startIndexing kicks off a
		// long-running background pipeline and reports progress via events.
		void this.startIndexing().catch(() => {
			// State + telemetry already captured inside startIndexing()
		})
	}

	/**
	 * Starts the git history indexing process.
	 *
	 * Delegates to GitHistoryOrchestrator which drives the pipeline:
	 * extract → filter → batch embed → upsert.
	 */
	public async startIndexing(): Promise<void> {
		if (!this._isGitRepo) {
			this._stateManager.setSystemState("Standby", "Not a git repository.")
			return
		}

		if (!this._orchestrator) {
			this._stateManager.setSystemState("Error", "Services not created. Call initialize() first.")
			return
		}

		const gitMaxHistoryDays = this._readGitConfig("codebaseIndexGitMaxHistoryDays", 365)
		const gitMaxCommits = this._readGitConfig("codebaseIndexGitMaxCommits", 10000)
		const gitBranch = this._readGitConfig("codebaseIndexGitBranch", "master")

		try {
			await this._orchestrator.startIndexing(gitMaxHistoryDays, gitMaxCommits, gitBranch)
		} catch (error) {
			// State is already set by the orchestrator; re-log for extension.ts visibility.
			const message = error instanceof Error ? error.message : String(error)
			try {
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: message,
					stack: error instanceof Error ? error.stack : undefined,
					location: "GitIndexManager.startIndexing",
				})
			} catch {
				// Telemetry may not be initialized yet.
			}
			throw error
		}
	}

	/**
	 * Stops any in-progress indexing operation and the git watcher.
	 */
	public stopIndexing(): void {
		this._orchestrator?.stopIndexing()
	}

	/**
	 * Stops only the git watcher.
	 */
	public stopWatcher(): void {
		this._orchestrator?.stopWatcher()
	}

	/**
	 * Clears the git index data from Qdrant.
	 */
	public async clearIndexData(): Promise<void> {
		if (this._vectorStore) {
			await this._vectorStore.deleteCollection()
		}
		this._stateManager.setSystemState("Standby", "Git index cleared.")
	}

	/**
	 * Searches the git commit history index for relevant entries.
	 *
	 * @param query - Natural language search query
	 * @param maxResults - Optional override for the result cap. When omitted,
	 *   falls back to the user-configurable `codebaseIndexGitSearchMaxResults`
	 *   setting (or DEFAULT_GIT_SEARCH_MAX_RESULTS).
	 * @returns Array of search results sorted by descending score
	 */
	public async searchIndex(query: string, maxResults?: number): Promise<GitSearchResult[]> {
		if (!this._searchService) {
			throw new Error("Git search service is not available. Call initialize() first.")
		}

		if (!this.isFeatureEnabled) {
			throw new Error("Git indexing is disabled in the settings.")
		}

		if (!this.isFeatureConfigured) {
			throw new Error("Git indexing is not configured (Missing API Key or Qdrant URL).")
		}

		const minScore = this._readGitConfig("codebaseIndexGitSearchMinScore", DEFAULT_GIT_SEARCH_MIN_SCORE)
		// Tool-supplied `maxResults` always wins over the setting-derived default —
		// the tool layer is responsible for clamping to its public ceiling before
		// calling in here, so we trust the value as-is.
		const effectiveMax =
			maxResults !== undefined
				? maxResults
				: this._readGitConfig("codebaseIndexGitSearchMaxResults", DEFAULT_GIT_SEARCH_MAX_RESULTS)

		return this._searchService.search(query, minScore, effectiveMax)
	}

	/**
	 * Gets the current status of the git indexing system.
	 */
	public getCurrentStatus() {
		return this._stateManager.getCurrentStatus()
	}

	/**
	 * Reacts to a change in persisted git-index settings (e.g. the user
	 * toggling `codebaseIndexGitEnabled` in the popover).
	 *
	 * Mirrors {@link CodeIndexManager.handleSettingsChange}: re-loads the
	 * config, then drives the state machine into one of four buckets:
	 *  - feature disabled        → stop indexing, go Standby
	 *  - first-time enable       → initialize() (which itself auto-starts)
	 *  - config change requiring restart on an already-initialized manager
	 *                            → recreate services and restart indexing
	 *  - no-op change            → leave the running indexer alone
	 *
	 * Called from the webview-message handler when the user flips the git
	 * enable toggle so indexing starts/stops immediately without an extra
	 * explicit Start button.
	 */
	public async handleSettingsChange(contextProxy: ContextProxy): Promise<void> {
		this._contextProxy = contextProxy

		// First-time enable: defer to initialize() which sets up services AND
		// kicks off indexing in one shot.
		if (!this._isInitialized) {
			await this.initialize(contextProxy)
			return
		}

		if (!this._configManager) {
			this._configManager = new CodeIndexConfigManager(contextProxy)
		}
		const { requiresRestart } = await this._configManager.loadConfiguration()

		// Feature turned off — stop the orchestrator and reset state.
		if (!this.isFeatureEnabled) {
			this.stopIndexing()
			this._stateManager.setSystemState("Standby", "Git indexing is disabled in settings.")
			return
		}

		if (!this.isFeatureConfigured) {
			this.stopIndexing()
			this._stateManager.setSystemState(
				"Standby",
				"Git indexing is not configured (Missing API Key or Qdrant URL).",
			)
			return
		}

		if (requiresRestart) {
			try {
				if (!this._cacheManager) {
					this._cacheManager = new GitCacheManager(this.context, this.workspacePath)
					await this._cacheManager.initialize()
					this._wireCacheDiagnostics()
				}
				await this._recreateServices()
				void this.startIndexing().catch(() => {
					// State + telemetry already captured inside startIndexing()
				})
			} catch (error) {
				try {
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						location: "GitIndexManager.handleSettingsChange",
					})
				} catch {
					// Telemetry may not be initialized yet.
				}
				throw error
			}
		}
	}

	/**
	 * Disposes all resources held by this manager.
	 */
	public dispose(): void {
		this._orchestrator?.stopIndexing()
		this._cacheManager?.dispose()
		this._stateManager.dispose()
		GitIndexManager.instances.delete(this.workspacePath)
	}

	// --- Private Helpers ---

	/**
	 * Wires the GitCacheManager's onCacheUpdated event to refresh the
	 * cumulative commit-count diagnostic and (lazily, throttled by HEAD
	 * change detection) the short HEAD-SHA diagnostic surfaced in the
	 * popover.
	 */
	private _wireCacheDiagnostics(): void {
		if (!this._cacheManager) return
		const cache = this._cacheManager
		// Seed immediately so the cumulative count is visible on (re)load
		// even before any new commit is indexed in this session.
		this._stateManager.setIndexedCommitCount(cache.getCommitCount())
		void this._refreshHeadSha()
		cache.onCacheUpdated(() => {
			this._stateManager.setIndexedCommitCount(cache.getCommitCount())
			void this._refreshHeadSha()
		})
	}

	/**
	 * Reads the short (7-char) HEAD SHA via `git rev-parse` and forwards
	 * it to the state manager. Best-effort: errors are swallowed because
	 * a missing/transient git state should never break indexing.
	 */
	private async _refreshHeadSha(): Promise<void> {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--short=7", "HEAD"], {
				cwd: this.workspacePath,
			})
			const hash = stdout.trim()
			if (hash) {
				this._stateManager.setLatestCommitHash(hash)
			}
		} catch {
			// Non-fatal: leave latestCommitHash as-is.
		}
	}

	/**
	 * Recreates all dependent services (embedder, vector store, search service, orchestrator).
	 *
	 * Pattern mirrors CodeIndexManager._recreateServices().
	 */
	private async _recreateServices(): Promise<void> {
		const configManager = this._configManager!

		// Create the embedder via CodeIndexServiceFactory.
		// The CacheManager parameter is only used for scanner/watcher creation (not embedder),
		// so we pass a lightweight placeholder.
		const { CacheManager } = await import("../code-index/cache-manager")
		const placeholderCache = new CacheManager(this.context, this.workspacePath)
		this._serviceFactory = new CodeIndexServiceFactory(configManager, this.workspacePath, placeholderCache)

		const embedder = this._serviceFactory.createEmbedder()

		// Validate the embedder
		const validation = await this._serviceFactory.validateEmbedder(embedder)
		if (!validation.valid) {
			throw new Error(`Embedder validation failed: ${validation.error}`)
		}

		// Compute vector size using the same logic as CodeIndexServiceFactory.createVectorStore()
		const config = configManager.getConfig()
		const { getDefaultModelId, getModelDimension } = await import("../../shared/embeddingModels")
		const provider = config.embedderProvider
		const modelId = config.modelId ?? getDefaultModelId(provider)
		let vectorSize: number | undefined = getModelDimension(provider, modelId)
		if (!vectorSize && config.modelDimension && (config.modelDimension as number) > 0) {
			vectorSize = config.modelDimension as number
		}
		if (!vectorSize || vectorSize <= 0) {
			throw new Error(
				`Could not determine vector dimension for git index. Provider: ${provider}, Model: ${modelId}`,
			)
		}

		if (!config.qdrantUrl) {
			throw new Error("Qdrant URL is not configured.")
		}

		// Create a git-specific Qdrant vector store (git- prefix instead of ws-).
		// We MUST pass a git-specific payload schema; the default code-index
		// schema would (a) restrict `with_payload.include` to filePath/codeChunk/…
		// (stripping every commit field on the way back from Qdrant) and
		// (b) reject the resulting empty payload in `isPayloadValid`, leaving the
		// search service with zero results despite a fully populated collection.
		const vectorStore = new QdrantVectorStore(
			this.workspacePath,
			config.qdrantUrl,
			vectorSize,
			config.qdrantApiKey,
			GIT_COLLECTION_PREFIX,
			{
				required: ["commit_hash", "subject"],
				include: ["commit_hash", "short_hash", "author", "author_date", "subject", "body"],
			},
		)

		this._embedder = embedder
		this._vectorStore = vectorStore

		// Create GitHistoryOrchestrator (pass poll interval from settings)
		const pollIntervalMinutes = this._readGitConfig("codebaseIndexGitPollIntervalMinutes", 5)
		const pollIntervalMs = pollIntervalMinutes * 60 * 1000

		this._orchestrator = new GitHistoryOrchestrator(
			this.workspacePath,
			this._stateManager,
			this._cacheManager!,
			embedder,
			vectorStore,
			pollIntervalMs,
		)

		// Create GitSearchService
		this._searchService = new GitSearchService(embedder, vectorStore)
	}

	/**
	 * Check whether the workspace directory is inside a git repository.
	 */
	private async _checkIsGitRepo(): Promise<boolean> {
		try {
			await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd: this.workspacePath,
			})
			return true
		} catch {
			return false
		}
	}

	/**
	 * Read a git-specific config value from VS Code settings, with a default.
	 */
	private _readGitConfig<T>(key: keyof CodebaseIndexConfig, defaultValue: T): T {
		const cfg = this._contextProxy?.getGlobalState("codebaseIndexConfig")
		const value = cfg?.[key] as T | undefined
		return value !== undefined ? value : defaultValue
	}
}
