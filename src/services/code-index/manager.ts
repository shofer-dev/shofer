import * as vscode from "vscode"
import { ContextProxy } from "../../core/config/ContextProxy"
import { VectorStoreSearchResult } from "./interfaces"
import { IndexingState } from "./interfaces/manager"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager } from "./state-manager"
import { CodeIndexServiceFactory } from "./service-factory"
import { CodeIndexSearchService } from "./search-service"
import { CodeIndexOrchestrator } from "./orchestrator"
import { CacheManager } from "./cache-manager"
import { ShoferIgnoreController } from "../../core/ignore/ShoferIgnoreController"
import { GitIgnoreFilter, IIgnoreFilter } from "./shared/git-ignore-filter"
import fs from "fs/promises"
import ignore from "ignore"
import path from "path"
import { t } from "../../i18n"
import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName } from "@shofer/types"
import { codeIndexLog } from "../../utils/logging/subsystems"
import { updateCodeIndexMetrics, incCodeIndexError } from "../../metrics/registry"

export class CodeIndexManager {
	// --- Singleton Implementation ---
	private static instances = new Map<string, CodeIndexManager>() // Map workspace path to instance

	// Specialized class instances
	private _configManager: CodeIndexConfigManager | undefined
	private readonly _stateManager: CodeIndexStateManager
	private _serviceFactory: CodeIndexServiceFactory | undefined
	private _orchestrator: CodeIndexOrchestrator | undefined
	private _searchService: CodeIndexSearchService | undefined
	private _cacheManager: CacheManager | undefined
	private _shoferIgnoreController: ShoferIgnoreController | undefined
	private _gitIgnoreFilter: GitIgnoreFilter | undefined
	private _gitIgnoreWatcher: vscode.FileSystemWatcher | undefined
	private _gitIgnoreRefreshTimer: NodeJS.Timeout | undefined

	// Flag to prevent race conditions during error recovery
	private _isRecoveringFromError = false

	public static getInstance(context: vscode.ExtensionContext, workspacePath?: string): CodeIndexManager | undefined {
		// Resolve the workspace folder to get both fsPath and the real URI
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

		if (!CodeIndexManager.instances.has(workspacePath)) {
			// folder may be undefined when workspacePath was provided but doesn't match
			// any workspace folder (e.g. cwd passed from a tool). Fall back to file:// URI.
			const folderUri =
				folder?.uri ??
				({
					fsPath: workspacePath,
					scheme: "file",
					authority: "",
					path: workspacePath,
					toString: () => `file://${workspacePath}`,
				} as unknown as vscode.Uri)
			CodeIndexManager.instances.set(workspacePath, new CodeIndexManager(workspacePath, folderUri, context))
		}
		return CodeIndexManager.instances.get(workspacePath)!
	}

	public static getAllInstances(): CodeIndexManager[] {
		return Array.from(CodeIndexManager.instances.values())
	}

	public static disposeAll(): void {
		for (const instance of CodeIndexManager.instances.values()) {
			instance.dispose()
		}
		CodeIndexManager.instances.clear()
	}

	private readonly workspacePath: string
	private readonly _folderUri: vscode.Uri
	private readonly context: vscode.ExtensionContext

	// Private constructor for singleton pattern
	private constructor(workspacePath: string, folderUri: vscode.Uri, context: vscode.ExtensionContext) {
		this.workspacePath = workspacePath
		this._folderUri = folderUri
		this.context = context
		this._stateManager = new CodeIndexStateManager()
	}

	// --- Public API ---

	/**
	 * Returns the workspaceState key for per-folder indexing enablement,
	 * keyed by the real workspace folder URI so local/remote schemes cannot collide.
	 */
	private _workspaceEnabledKey(): string {
		return "codeIndexWorkspaceEnabled:" + this._folderUri.toString(true)
	}

	public get isWorkspaceEnabled(): boolean {
		const explicit = this.context.workspaceState.get<boolean | undefined>(this._workspaceEnabledKey(), undefined)
		if (explicit !== undefined) return explicit
		return this.autoEnableDefault
	}

	public async setWorkspaceEnabled(enabled: boolean): Promise<void> {
		await this.context.workspaceState.update(this._workspaceEnabledKey(), enabled)
	}

	public get autoEnableDefault(): boolean {
		return this.context.globalState.get("codeIndexAutoEnableDefault", true)
	}

	public async setAutoEnableDefault(enabled: boolean): Promise<void> {
		await this.context.globalState.update("codeIndexAutoEnableDefault", enabled)
	}

	public get onProgressUpdate() {
		return this._stateManager.onProgressUpdate
	}

	private assertInitialized() {
		if (!this._configManager || !this._orchestrator || !this._searchService || !this._cacheManager) {
			throw new Error("CodeIndexManager not initialized. Call initialize() first.")
		}
	}

	public get state(): IndexingState {
		if (!this.isFeatureEnabled) {
			return "Standby"
		}
		this.assertInitialized()
		return this._orchestrator!.state
	}

	public get isFeatureEnabled(): boolean {
		return this._configManager?.isFeatureEnabled ?? false
	}

	public get isFeatureConfigured(): boolean {
		return this._configManager?.isFeatureConfigured ?? false
	}

	public get isInitialized(): boolean {
		try {
			this.assertInitialized()
			return true
		} catch (error) {
			return false
		}
	}

	/**
	 * Initializes the manager with configuration and dependent services.
	 * Must be called before using any other methods.
	 * @returns Object indicating if a restart is needed
	 */
	public async initialize(contextProxy: ContextProxy): Promise<{ requiresRestart: boolean }> {
		// 1. ConfigManager Initialization and Configuration Loading
		if (!this._configManager) {
			this._configManager = new CodeIndexConfigManager(contextProxy)
		}
		// Load configuration once to get current state and restart requirements
		const { requiresRestart } = await this._configManager.loadConfiguration()

		// 2. Check if feature is enabled
		if (!this.isFeatureEnabled) {
			if (this._orchestrator) {
				this._orchestrator.stopWatcher()
			}
			return { requiresRestart }
		}

		// 3. Check if workspace is available
		const workspacePath = this.workspacePath
		if (!workspacePath) {
			this._stateManager.setSystemState("Standby", "No workspace folder open")
			return { requiresRestart }
		}

		// 4. Check workspace-level enablement (before creating expensive services)
		if (!this.isWorkspaceEnabled) {
			this._stateManager.setSystemState("Standby", "Indexing not enabled for this workspace")
			return { requiresRestart }
		}

		// 5. CacheManager Initialization
		if (!this._cacheManager) {
			const indexKeyPath = await this._resolveIndexKeyPath()
			this._cacheManager = new CacheManager(this.context, this.workspacePath, indexKeyPath)
			await this._cacheManager.initialize()
			// Surface diagnostics in the popover: every time the cache is
			// touched, refresh the cumulative file-count and the most-recent
			// file path. This is the data path that lets users verify the
			// Phase 1/2 fast-path didn't silently drop files.
			this._cacheManager.onEntryUpdated((relPath) => {
				this._stateManager.recordFileIndexed(relPath)
				const count = this._cacheManager!.getEntryCount()
				this._stateManager.setIndexedFileCount(count)
				this._emitCodeIndexMetrics(count)
			})
			// Seed the cumulative count immediately on (re)load so the popover
			// shows the persisted total even before any new file change fires.
			const initialCount = this._cacheManager.getEntryCount()
			this._stateManager.setIndexedFileCount(initialCount)
			this._emitCodeIndexMetrics(initialCount)
		}

		// 6. Determine if Core Services Need Recreation
		const needsServiceRecreation = !this._serviceFactory || requiresRestart

		if (needsServiceRecreation) {
			await this._recreateServices()
		}

		// 7. Handle Indexing Start/Restart
		const shouldStartOrRestartIndexing =
			requiresRestart ||
			(needsServiceRecreation && (!this._orchestrator || this._orchestrator.state !== "Indexing"))

		if (shouldStartOrRestartIndexing) {
			this._orchestrator?.startIndexing()
		}

		return { requiresRestart }
	}

	/**
	 * Initiates the indexing process (initial scan and starts watcher).
	 * Automatically recovers from error state if needed before starting.
	 *
	 * @important This method should NEVER be awaited as it starts a long-running background process.
	 * The indexing will continue asynchronously and progress will be reported through events.
	 */
	public async startIndexing(): Promise<void> {
		if (!this.isFeatureEnabled || !this.isWorkspaceEnabled) {
			return
		}

		// Check if we're in error state and recover if needed
		const currentStatus = this.getCurrentStatus()
		if (currentStatus.systemStatus === "Error") {
			await this.recoverFromError()

			// After recovery, we need to reinitialize since recoverFromError clears all services
			// This will be handled by the caller (webviewMessageHandler) checking isInitialized
			return
		}

		this.assertInitialized()
		await this._orchestrator!.startIndexing()
	}

	/**
	 * Stops any in-progress indexing operation and the file watcher.
	 */
	public stopIndexing(): void {
		if (this._orchestrator) {
			this._orchestrator.stopIndexing()
		}
	}

	/**
	 * Stops the file watcher and potentially cleans up resources.
	 */
	public stopWatcher(): void {
		if (!this.isFeatureEnabled) {
			return
		}
		if (this._orchestrator) {
			this._orchestrator.stopWatcher()
		}
	}

	/**
	 * Recovers from error state by clearing the error and resetting internal state.
	 * This allows the manager to be re-initialized after a recoverable error.
	 *
	 * This method clears all service instances (configManager, serviceFactory, orchestrator, searchService)
	 * to force a complete re-initialization on the next operation. This ensures a clean slate
	 * after recovering from errors such as network failures or configuration issues.
	 *
	 * @remarks
	 * - Safe to call even when not in error state (idempotent)
	 * - Does not restart indexing automatically - call initialize() after recovery
	 * - Service instances will be recreated on next initialize() call
	 * - Prevents race conditions from multiple concurrent recovery attempts
	 */
	public async recoverFromError(): Promise<void> {
		// Prevent race conditions from multiple rapid recovery attempts
		if (this._isRecoveringFromError) {
			return
		}

		this._isRecoveringFromError = true
		try {
			// Clear error state
			this._stateManager.setSystemState("Standby", "")
		} catch (error) {
			// Log error but continue with recovery - clearing service instances is more important
			codeIndexLog.error("Failed to clear error state during recovery:", error)
		} finally {
			// Force re-initialization by clearing service instances
			// This ensures a clean slate even if state update failed
			this._configManager = undefined
			this._serviceFactory = undefined
			this._orchestrator = undefined
			this._searchService = undefined

			// Reset the flag after recovery is complete
			this._isRecoveringFromError = false
		}
	}

	/**
	 * Cleans up the manager instance and removes it from the singleton map.
	 */
	public dispose(): void {
		this.stopIndexing()
		// Optional dispose: tolerate cacheManager mocks (and the small
		// initialization window before _wireCacheDiagnostics has assigned a
		// real CacheManager) that don't implement dispose().
		this._cacheManager?.dispose?.()
		this._stateManager.dispose()
		this._disposeGitIgnoreWatcher()
		CodeIndexManager.instances.delete(this.workspacePath)
	}

	/**
	 * Lazily install (once per workspace) a watcher over every `.gitignore` in
	 * the tree. On any change/create/delete we re-run `git ls-files` to refresh
	 * the included-paths set used by {@link GitIgnoreFilter}. Refreshes are
	 * debounced because batch operations (branch switches, merges, mass deletes)
	 * fire many events back-to-back.
	 */
	private _ensureGitIgnoreWatcher(workspacePath: string): void {
		if (this._gitIgnoreWatcher) return
		const pattern = new vscode.RelativePattern(workspacePath, "**/.gitignore")
		const watcher = vscode.workspace.createFileSystemWatcher(pattern)
		const schedule = () => {
			if (this._gitIgnoreRefreshTimer) clearTimeout(this._gitIgnoreRefreshTimer)
			this._gitIgnoreRefreshTimer = setTimeout(() => {
				void this._gitIgnoreFilter?.refresh()
			}, 500)
		}
		watcher.onDidCreate(schedule)
		watcher.onDidChange(schedule)
		watcher.onDidDelete(schedule)
		this._gitIgnoreWatcher = watcher
	}

	private _disposeGitIgnoreWatcher(): void {
		if (this._gitIgnoreRefreshTimer) {
			clearTimeout(this._gitIgnoreRefreshTimer)
			this._gitIgnoreRefreshTimer = undefined
		}
		this._gitIgnoreWatcher?.dispose()
		this._gitIgnoreWatcher = undefined
		this._gitIgnoreFilter = undefined
	}

	/**
	 * Clears all index data by stopping the watcher, clearing the Qdrant collection,
	 * and deleting the cache file.
	 */
	public async clearIndexData(): Promise<void> {
		if (!this.isFeatureEnabled) {
			return
		}
		this.assertInitialized()
		await this._orchestrator!.clearIndexData()
		await this._cacheManager!.clearCacheFile()
	}

	// --- Private Helpers ---

	public getCurrentStatus() {
		const status = this._stateManager.getCurrentStatus()
		return {
			...status,
			// Surface the feature-toggle as a first-class status so the UI can
			// render "disabled" without a separate config lookup. The underlying
			// state-machine value is preserved when enabled.
			systemStatus: this.isFeatureEnabled ? status.systemStatus : ("Disabled" as const),
			workspacePath: this.workspacePath,
			workspaceEnabled: this.isWorkspaceEnabled,
			autoEnableDefault: this.autoEnableDefault,
		}
	}

	public async searchIndex(
		query: string,
		directoryPrefix?: string,
		maxResults?: number,
	): Promise<VectorStoreSearchResult[]> {
		if (!this.isFeatureEnabled) {
			return []
		}
		this.assertInitialized()
		return this._searchService!.searchIndex(query, directoryPrefix, maxResults)
	}

	/**
	 * Private helper method to recreate services with current configuration.
	 * Used by both initialize() and handleSettingsChange().
	 */
	private async _recreateServices(): Promise<void> {
		// Stop watcher if it exists
		if (this._orchestrator) {
			this.stopWatcher()
		}
		// Clear existing services to ensure clean state
		this._orchestrator = undefined
		this._searchService = undefined

		// (Re)Initialize service factory — pass a status-update callback so
		// validateEmbedder can surface Ollama/embedder retry progress to the UI.
		const indexKeyPath = await this._resolveIndexKeyPath()
		this._serviceFactory = new CodeIndexServiceFactory({
			configManager: this._configManager!,
			workspacePath: this.workspacePath,
			cacheManager: this._cacheManager!,
			notifyRetryStatus: (msg: string) => this._stateManager.setSystemState("Indexing", msg),
			indexKeyPath,
		})

		const workspacePath = this.workspacePath

		if (!workspacePath) {
			this._stateManager.setSystemState("Standby", "")
			return
		}

		// Prefer git itself as the .gitignore oracle: it honours nested .gitignore
		// files, .git/info/exclude, the global core.excludesfile, and negations —
		// all the things the flat `ignore` library does not. Fall back to a
		// root-only `.gitignore` parse when the workspace is not a git repo (or
		// the git binary is unavailable), so behaviour does not regress for
		// non-git users. See shared/git-ignore-filter.ts.
		let ignoreInstance: IIgnoreFilter
		const gitFilter = await GitIgnoreFilter.create(workspacePath)
		if (gitFilter) {
			ignoreInstance = gitFilter
			this._gitIgnoreFilter = gitFilter
			this._ensureGitIgnoreWatcher(workspacePath)
		} else {
			const flat = ignore()
			const ignorePath = path.join(workspacePath, ".gitignore")
			try {
				const content = await fs.readFile(ignorePath, "utf8")
				flat.add(content)
				flat.add(".gitignore")
			} catch (error) {
				// Workspace has no .gitignore at the root (or the read failed).
				// Non-fatal: indexing proceeds with no git-derived filtering, with
				// CODEBASE_INDEX_IGNORED_DIRS and .shoferignore still applied.
				incCodeIndexError("gitignore")
				codeIndexLog.error("Unexpected error loading .gitignore:", error)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "_recreateServices",
				})
			}
			ignoreInstance = {
				ignores: (p: string) => flat.ignores(p),
				refresh: () => Promise.resolve(), // flat ignore has no snapshot to rebuild
			}
		}

		// Create ShoferIgnoreController instance (cached — created only once per workspace)
		if (!this._shoferIgnoreController) {
			this._shoferIgnoreController = new ShoferIgnoreController(workspacePath)
			await this._shoferIgnoreController.initialize()
		}

		// (Re)Create shared service instances
		const { embedder, vectorStore, scanner, fileWatcher } = this._serviceFactory.createServices(
			this.context,
			this._cacheManager!,
			ignoreInstance,
			this._shoferIgnoreController,
		)

		// Validate embedder configuration before proceeding
		const validationResult = await this._serviceFactory.validateEmbedder(embedder)
		if (!validationResult.valid) {
			const errorMessage = validationResult.error || "Embedder configuration validation failed"
			this._stateManager.setSystemState("Error", errorMessage)
			throw new Error(errorMessage)
		}

		// (Re)Initialize orchestrator
		this._orchestrator = new CodeIndexOrchestrator(
			this._configManager!,
			this._stateManager,
			this.workspacePath,
			this._cacheManager!,
			vectorStore,
			scanner,
			fileWatcher,
		)

		// (Re)Initialize search service
		this._searchService = new CodeIndexSearchService(
			this._configManager!,
			this._stateManager,
			embedder,
			vectorStore,
		)

		// Clear any error state after successful recreation
		this._stateManager.setSystemState("Standby", "")
	}

	/**
	 * Handle code index settings changes.
	 * This method should be called when code index settings are updated
	 * to ensure the CodeIndexConfigManager picks up the new configuration.
	 * If the configuration changes require a restart, the service will be restarted.
	 */
	public async handleSettingsChange(): Promise<void> {
		if (this._configManager) {
			const { requiresRestart } = await this._configManager.loadConfiguration()

			const isFeatureEnabled = this.isFeatureEnabled
			const isFeatureConfigured = this.isFeatureConfigured

			// If feature is disabled, stop the service (including any active scan)
			if (!isFeatureEnabled) {
				this.stopIndexing()
				this._stateManager.setSystemState("Standby", "Code indexing is disabled")
				return
			}

			if (requiresRestart && isFeatureEnabled && isFeatureConfigured) {
				try {
					// Ensure cacheManager is initialized before recreating services
					const indexKeyPath = await this._resolveIndexKeyPath()
					if (!this._cacheManager) {
						this._cacheManager = new CacheManager(this.context, this.workspacePath, indexKeyPath)
						await this._cacheManager.initialize()
					}

					// Recreate services with new configuration
					await this._recreateServices()
				} catch (error) {
					// Error state already set in _recreateServices
					incCodeIndexError("service-recreate")
					codeIndexLog.error("Failed to recreate services:", error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						location: "handleSettingsChange",
					})
					// Re-throw the error so the caller knows validation failed
					throw error
				}
			}
		}
	}

	/**
	 * Resolve the stable index key path for this workspace. If the workspace
	 * is a git worktree, returns the main repo path so that linked worktrees
	 * share the same Qdrant collection and local cache file. Otherwise returns
	 * the workspace path unchanged.
	 */
	private async _resolveIndexKeyPath(): Promise<string> {
		// Lazy import to avoid a circular dependency at the module level.
		const { GitSource } = await import("./git/git-source")
		return GitSource.resolveWorktreeMainRepoPath(this.workspacePath)
	}

	/**
	 * Push gauge snapshots for the code-index dashboard row.
	 *
	 * embedderQueueDepth is set to 0 here — wiring the per-provider
	 * concurrency-lane depth requires deeper instrumentation in the embedder
	 * pipeline and is tracked as a future improvement.
	 */
	private _emitCodeIndexMetrics(fileCount: number): void {
		const provider = this._configManager?.currentEmbedderProvider ?? "unknown"
		updateCodeIndexMetrics(fileCount, 0, provider)
	}
}
