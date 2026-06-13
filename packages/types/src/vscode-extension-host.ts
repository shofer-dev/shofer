import { z } from "zod"

import type { CodebaseIndexConfig } from "./codebase-index.js"
import type { GlobalSettings, ShoferSettings } from "./global-settings.js"
import type { ProviderSettings, ProviderSettingsEntry } from "./provider-settings.js"
import type { HistoryItem, CostLimit, TaskState } from "./history.js"
import type { ModeConfig, PromptComponent } from "./mode.js"
import type { TelemetrySetting } from "./telemetry.js"
import type { Experiments } from "./experiment.js"
import type { ShoferMessage, QueuedMessage, TaskInteractionPayload } from "./message.js"
import {
	type MarketplaceItem,
	type MarketplaceInstalledMetadata,
	type InstallMarketplaceItemOptions,
	marketplaceItemSchema,
} from "./marketplace.js"
import type { TodoItem } from "./todo.js"
import type { OrganizationAllowList } from "./organization.js"
import type { SerializedCustomToolDefinition } from "./custom-tool.js"
import type { WebviewMetricsPush } from "./metrics.js"

// Types previously from cloud.ts, now defined inline
type CloudUserInfo = {
	id?: string
	name?: string
	email?: string
	picture?: string
	organizationId?: string
	organizationName?: string
	organizationRole?: string
	organizationImageUrl?: string
}
type CloudOrganizationMembership = { organization: { id: string; name: string; imageUrl?: string }; role: string }
type ShareVisibility = "organization" | "public"
import type { GitCommit } from "./git.js"
import type { McpServer } from "./mcp.js"
import type { ModelRecord, RouterModels } from "./model.js"
import type { OpenAiCodexRateLimitInfo } from "./providers/openai-codex-rate-limits.js"
import type { SkillMetadata } from "./skills.js"
import type { WorktreeIncludeStatus, WorktreeStatus } from "./worktree.js"

/** Workflow metadata for the launcher UI — mirrors FlowDecl + FlowParam fields from the Slang AST. */
export interface LauncherWorkflow {
	/** Machine identifier — used for `createWorkflow` IPC. */
	name: string
	/** Human-readable title for the card. Falls back to `name` if unset. */
	title: string
	/** Markdown description. Rendered as secondary text in the card. */
	description?: string
	/** Icon key (e.g. "rocket", "gear", "search", "code"). Mapped to lucide icon in the webview. */
	icon?: string
	/** Agent names extracted from `AgentDecl` nodes in the flow body. */
	agents: string[]
	/** Input parameters with optional descriptions. */
	params: Array<{ name: string; type: string; description?: string }>
}

/**
 * Pushed once alongside workflowVizHtml. Contains the flow header metadata
 * that was previously rendered inside the srcdoc iframe. Now rendered natively
 * in TaskHeader (integrated with existing token/cost/context info) so the
 * iframe only needs to hold the diagram + zoom controls.
 */
export interface WorkflowVizMeta {
	/** Icon key (e.g. "rocket", "gear"). TaskHeader maps to a lucide icon. */
	icon?: string
	/** Display title (flow.title || flow.name). */
	displayTitle: string
	/** Machine name of the flow (shown only when title ≠ name). */
	flowName?: string
	/** Markdown description of the flow. */
	description?: string
	/** Input parameters with optional descriptions. */
	params?: Array<{ name: string; type: string; description?: string }>
	/** Convergence condition expression (from ConvergeStmt). */
	convergeCondition?: string
	/** Budget items (from BudgetStmt). */
	budgets?: Array<{ kind: string; value: string }>
	/** Number of agents in this flow. */
	agentCount: number
}

/**
 * A single log line attributed to a specific Task / Workflow instance.
 *
 * Produced by the logging transport: every entry emitted while a task's run
 * loop is on the async call stack is stamped with that task's id (via the
 * AsyncLocalStorage log context) and accumulated in a per-task ring buffer.
 * Rendered by the "Logs" tab in ChatView / WorkflowView.
 */
export interface TaskLogLine {
	/** Absolute timestamp in ms (Date.now() when the line was written). */
	ts: number
	/** Severity: "debug" | "info" | "warn" | "error" | "fatal". */
	level: string
	/** Subsystem context tag (e.g. "Task", "API", "MCP"); absent for un-tagged lines. */
	ctx?: string
	/** Human-readable message (already includes any stringified extra args). */
	message: string
}

/**
 * ExtensionMessage
 * Extension -> Webview | CLI
 */
export interface ExtensionMessage {
	type:
		| "action"
		| "stateInit"
		| "configUpdate"
		| "taskStateUpdate"
		| "taskHistoryUpdated"
		| "taskHistoryItemUpdated"
		| "selectedImages"
		| "theme"
		| "workspaceUpdated"
		| "invoke"
		| "messageUpdated"
		| "shoferMessageAppended"
		| "shoferMessagesPrepended"
		// Per-task/workflow logs for the "Logs" tab: snapshot response + live append.
		| "taskLogs"
		| "taskLogAppended"
		| "blobContent"
		| "mcpServers"
		| "enhancedPrompt"
		| "commitSearchResults"
		| "listApiConfig"
		| "routerModels"
		| "openAiModels"
		| "ollamaModels"
		| "lmStudioModels"
		| "vsCodeLmModels"
		| "vsCodeLmApiAvailable"
		| "updatePrompt"
		| "systemPrompt"
		| "autoApprovalEnabled"
		| "updateCustomMode"
		| "deleteCustomMode"
		| "exportModeResult"
		| "importModeResult"
		| "checkRulesDirectoryResult"
		| "deleteCustomModeCheck"
		| "currentCheckpointUpdated"
		| "checkpointInitWarning"
		| "ttsStart"
		| "ttsStop"
		| "fileSearchResults"
		| "toggleApiConfigPin"
		| "acceptInput"
		| "setHistoryPreviewCollapsed"
		| "commandExecutionStatus"
		| "mcpExecutionStatus"
		| "vsCodeSetting"
		| "authenticatedUser"
		| "condenseTaskContextStarted"
		| "condenseTaskContextResponse"
		| "singleRouterModelFetchResponse"
		| "shoferCreditBalance"
		| "indexingStatusUpdate"
		| "gitIndexingStatusUpdate"
		| "assistantAgentStatusUpdate"
		| "indexCleared"
		| "gitIndexCleared"
		| "codebaseIndexConfig"
		| "marketplaceInstallResult"
		| "marketplaceRemoveResult"
		| "marketplaceData"
		| "shareTaskSuccess"
		| "codeIndexSettingsSaved"
		| "codeIndexSecretStatus"
		| "showDeleteMessageDialog"
		| "showEditMessageDialog"
		| "commands"
		| "insertTextIntoTextarea"
		| "dismissedUpsells"
		| "organizationSwitchResult"
		| "interactionRequired"
		| "customToolsResult"
		| "modes"
		| "taskWithAggregatedCosts"
		| "taskInteractions"
		| "openAiCodexRateLimits"
		// Parallel task response types
		| "parallelTasksUpdated"
		| "taskNotification"
		| "taskNotificationCleared"
		// Workflow response types
		| "workflowsList"
		// Worktree response types
		| "worktreeList"
		| "worktreeResult"
		| "worktreeCopyProgress"
		| "worktreeCreationStep"
		| "branchList"
		| "worktreeDefaults"
		| "worktreeIncludeStatus"
		| "branchWorktreeIncludeResult"
		| "worktreeStatus"
		| "folderSelected"
		| "skills"
		| "loadedSkills"
		| "skillSearchResults"
		| "fileContent"
		| "addContextFiles"
		| "changedFiles/update"
		// Webview health messages
		| "ping"
	text?: string
	/** For fileContent: { path, content, error? } */
	fileContent?: { path: string; content: string | null; error?: string }
	/** For addContextFiles: workspace-relative paths to append to chat context. */
	contextFiles?: Array<{ path: string; isFile: boolean }>
	/** For changedFiles/update: snapshot of files Shofer edited in the current Task. */
	changedFiles?: ChangedFilesPayload
	payload?: any // eslint-disable-line @typescript-eslint/no-explicit-any
	checkpointWarning?: {
		type: "WAIT_TIMEOUT" | "INIT_TIMEOUT"
		timeout: number
	}
	action?:
		| "chatButtonClicked"
		| "settingsButtonClicked"
		| "historyButtonClicked"
		| "marketplaceButtonClicked"
		| "tasksButtonClicked"
		| "launcherButtonClicked"
		| "newMenuButtonClicked"
		| "didBecomeVisible"
		| "focusInput"
		| "switchTab"
		| "toggleAutoApprove"
	invoke?: "newChat" | "sendMessage" | "primaryButtonClick" | "secondaryButtonClick" | "setChatBoxMessage"
	/**
	 * Full state snapshot for stateInit message (replaces the old "state" bulk push).
	 * Sent on webview launch, visibility return, reset, and task switch.
	 */
	state?: ExtensionState
	/** Key for configUpdate message — the setting key that changed. */
	key?: string
	/** Partial task-state update for taskStateUpdate messages. The webview
	 *  merges these fields into its local ExtensionState. */
	taskStateUpdates?: Partial<ExtensionState>
	images?: string[]
	filePaths?: string[]
	openedTabs?: Array<{
		label: string
		isActive: boolean
		path?: string
	}>
	shoferMessage?: ShoferMessage
	/** Batch for shoferMessagesPrepended (older pages loaded in one IPC round-trip). */
	shoferMessages?: ShoferMessage[]
	/** taskLogs: full snapshot of the requested task's log ring buffer. */
	taskLogs?: TaskLogLine[]
	/** taskLogAppended: newly-emitted log lines for the watched task (coalesced batch). */
	taskLogLines?: TaskLogLine[]
	/** taskLogs / taskLogAppended: the task/workflow id these logs belong to. */
	taskLogTaskId?: string
	/** §4.3 blob fetch response: sha256 ↔ content (or undefined if missing). */
	blob?: { sha256: string; bytes: number; content?: string; error?: string }
	routerModels?: RouterModels
	openAiModels?: string[]
	ollamaModels?: ModelRecord
	lmStudioModels?: ModelRecord
	vsCodeLmModels?: { vendor?: string; family?: string; version?: string; id?: string }[]
	mcpServers?: McpServer[]
	commits?: GitCommit[]
	listApiConfig?: ProviderSettingsEntry[]
	mode?: string
	customMode?: ModeConfig
	slug?: string
	success?: boolean
	/** Generic payload for extension messages that use `values` */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	values?: Record<string, any>
	requestId?: string
	promptText?: string
	results?:
		| { path: string; type: "file" | "folder"; label?: string }[]
		| { name: string; description?: string; argumentHint?: string; source: "global" | "project" | "built-in" }[]
	error?: string
	setting?: string
	value?: any // eslint-disable-line @typescript-eslint/no-explicit-any
	hasContent?: boolean
	items?: MarketplaceItem[]
	userInfo?: CloudUserInfo
	organizationAllowList?: OrganizationAllowList
	tab?: string
	marketplaceItems?: MarketplaceItem[]
	organizationMcps?: MarketplaceItem[]
	marketplaceInstalledMetadata?: MarketplaceInstalledMetadata
	errors?: string[]
	visibility?: ShareVisibility
	rulesFolderPath?: string
	settings?: any // eslint-disable-line @typescript-eslint/no-explicit-any
	messageTs?: number
	hasCheckpoint?: boolean
	context?: string
	commands?: Command[]
	queuedMessages?: QueuedMessage[]
	list?: string[] // For dismissedUpsells
	organizationId?: string | null // For organizationSwitchResult
	tools?: SerializedCustomToolDefinition[] // For customToolsResult
	skills?: SkillMetadata[] // For skills response
	loadedSkills?: Record<string, string> // For loadedSkills response (name → path)
	skillSearchResults?: { name: string; path: string; matches: string[] }[] // For skillSearchResults response
	modes?: { slug: string; name: string }[] // For modes response
	aggregatedCosts?: {
		// For taskWithAggregatedCosts response
		totalCost: number
		ownCost: number
		childrenCost: number
	}
	taskInteractions?: TaskInteractionPayload[] // For taskInteractions response (Sequence view)
	// Workflow response properties
	workflows?: Array<LauncherWorkflow>
	// Parallel task response properties
	parallelTasks?: Array<{
		id: string
		name: string
		taskId: string
		workspace: string
		createdAt: number
		lastActiveAt: number
		state: TaskState
		activeTimeMs: number
	}>
	focusedTaskId?: string | null
	taskId?: string
	notification?: {
		taskId: string
		type: string
		message: string
		timestamp: number
	}
	historyItem?: HistoryItem
	taskHistory?: HistoryItem[] // For taskHistoryUpdated: full sorted task history
	/** For taskHistoryItemUpdated: single updated/added history item */
	taskHistoryItem?: HistoryItem
	// Worktree response properties
	worktrees?: Array<{
		path: string
		branch: string
		commitHash: string
		isCurrent: boolean
		isBare: boolean
		isDetached: boolean
		isLocked: boolean
		lockReason?: string
	}>
	isGitRepo?: boolean
	isMultiRoot?: boolean
	isSubfolder?: boolean
	gitRootPath?: string
	worktreeResult?: {
		success: boolean
		message: string
		worktree?: {
			path: string
			branch: string
			commitHash: string
			isCurrent: boolean
			isBare: boolean
			isDetached: boolean
			isLocked: boolean
			lockReason?: string
		}
	}
	localBranches?: string[]
	remoteBranches?: string[]
	currentBranch?: string
	suggestedBranch?: string
	suggestedPath?: string
	worktreeIncludeExists?: boolean
	worktreeIncludeStatus?: WorktreeIncludeStatus
	hasGitignore?: boolean
	gitignoreContent?: string
	// branchWorktreeIncludeResult
	branch?: string
	hasWorktreeInclude?: boolean
	// worktreeCopyProgress (size-based)
	copyProgressBytesCopied?: number
	copyProgressTotalBytes?: number
	copyProgressItemName?: string
	// worktreeCreationStep — current phase during worktree creation
	worktreeCreationStep?: string
	worktreeCreationStepDetail?: string
	// folderSelected
	path?: string
	// worktreeStatus
	worktreeStatus?: WorktreeStatus
}

export interface OpenAiCodexRateLimitsMessage {
	type: "openAiCodexRateLimits"
	values?: OpenAiCodexRateLimitInfo
	error?: string
}

export type ExtensionState = Pick<
	GlobalSettings,
	| "currentApiConfigName"
	| "listApiConfigMeta"
	| "pinnedApiConfigs"
	| "customInstructions"
	| "dismissedUpsells"
	| "autoApprovalEnabled"
	| "alwaysAllowReadOnly"
	| "alwaysAllowReadOnlyOutsideWorkspace"
	| "alwaysAllowWrite"
	| "alwaysAllowWriteOutsideWorkspace"
	| "alwaysAllowWriteProtected"
	| "alwaysAllowBrowser"
	| "alwaysAllowMcp"
	| "alwaysAllowUncategorized"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowFollowupQuestions"
	| "alwaysAllowExecute"
	| "followupAutoApproveTimeoutMs"
	| "allowedCommands"
	| "deniedCommands"
	| "allowedMaxRequests"
	| "allowedMaxCost"
	| "ttsEnabled"
	| "ttsSpeed"
	| "soundEnabled"
	| "soundVolume"
	| "terminalOutputPreviewSize"
	| "terminalShellIntegrationTimeout"
	| "terminalShellIntegrationDisabled"
	| "terminalCommandDelay"
	| "terminalPowershellCounter"
	| "terminalZshClearEolMark"
	| "terminalZshOhMy"
	| "terminalZshP10k"
	| "terminalZdotdir"
	| "execaShellPath"
	| "diagnosticsEnabled"
	| "language"
	| "modeApiConfigs"
	| "customModePrompts"
	| "customSupportPrompts"
	| "enhancementApiConfigId"
	| "customCondensingPrompt"
	| "codebaseIndexConfig"
	| "codebaseIndexModels"
	| "profileThresholds"
	| "includeDiagnosticMessages"
	| "maxDiagnosticMessages"
	| "imageGenerationProvider"
	| "openRouterImageGenerationSelectedModel"
	| "includeTaskHistoryInEnhance"
	| "reasoningBlockCollapsed"
	| "enterBehavior"
	| "includeCurrentTime"
	| "includeCurrentCost"
	| "maxGitStatusFiles"
	| "requestDelaySeconds"
	| "disabledTools"
	| "defaultCostLimit"
	| "archivedTaskRetentionDays"
	| "assistantAgentEnabled"
	| "assistantAgentApiConfigId"
	| "assistantAgentMaxContextTokens"
	| "assistantAgentContextFillThreshold"
	| "logLevel"
	| "logCategories"
> & {
	logCategoriesKnown?: string[]
	lockApiConfigAcrossModes?: boolean
	version: string
	shoferMessages: ShoferMessage[]
	/** T1.B: true when cold-load only read the tail of the message log. */
	hasMoreShoferMessages?: boolean
	currentTaskId?: string
	currentTaskItem?: HistoryItem
	currentTaskTodos?: TodoItem[] // Initial todos for the current task
	apiConfiguration: ProviderSettings
	uriScheme?: string
	shouldShowAnnouncement: boolean

	taskHistory: HistoryItem[]

	writeDelayMs: number

	enableCheckpoints: boolean
	checkpointTimeout: number // Timeout for checkpoint initialization in seconds (default: 15)
	maxOpenTabsContext: number // Maximum number of VSCode open tabs to include in context (0-500)
	maxWorkspaceFiles: number // Maximum number of files to include in current working directory details (0-500)
	showShoferIgnoredFiles: boolean // Whether to show .shoferignore'd files in listings
	enableSubfolderRules: boolean // Whether to load rules from subdirectories
	useAgentRules: boolean // Whether to load AGENTS.md files for agent-specific rules
	maxReadFileLine?: number // Maximum line limit for read_file tool (-1 for default)
	maxImageFileSize: number // Maximum size of image files to process in MB
	maxTotalImageSize: number // Maximum total size for all images in a single read operation in MB

	experiments: Experiments // Map of experiment IDs to their enabled state

	mcpEnabled: boolean

	mode: string
	customModes: ModeConfig[]
	toolRequirements?: Record<string, boolean> // Map of tool names to their requirements (e.g. {"apply_diff": true})

	cwd?: string // Current working directory
	telemetrySetting: TelemetrySetting
	telemetryKey?: string
	machineId?: string

	renderContext: "sidebar" | "editor"

	// Workflow management
	workflows?: Array<LauncherWorkflow>
	/** Self-contained HTML page for the workflow visualization iframe (diagram only, pushed once). */
	workflowVizHtml?: string
	/** Serialized FlowState pushed on each round/step for in-place viz overlays. */
	workflowVizRunState?: Record<string, unknown>
	/** Flow metadata rendered natively in TaskHeader (deduped from iframe header). */
	workflowVizMeta?: WorkflowVizMeta
	// Parallel task management
	parallelTasks?: Array<{
		id: string
		name: string
		taskId: string
		workspace: string
		createdAt: number
		lastActiveAt: number
		state: TaskState
		activeTimeMs: number
	}>
	focusedTaskId?: string | null
	taskNotifications?: Array<{
		taskId: string
		type: string
		message: string
		timestamp: number
	}>
	settingsImportedAt?: number
	historyPreviewCollapsed?: boolean

	cloudUserInfo: CloudUserInfo | null
	cloudIsAuthenticated: boolean
	cloudAuthSkipModel?: boolean // Flag indicating auth completed without model selection (user should pick 3rd-party provider)
	cloudApiUrl?: string
	cloudOrganizations?: CloudOrganizationMembership[]
	sharingEnabled: boolean
	publicSharingEnabled: boolean
	organizationAllowList: OrganizationAllowList
	organizationSettingsVersion?: number

	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	marketplaceItems?: MarketplaceItem[]
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	marketplaceInstalledMetadata?: { project: Record<string, any>; global: Record<string, any> }
	profileThresholds: Record<string, number>
	hasOpenedModeSelector: boolean
	openRouterImageApiKey?: string
	messageQueue?: QueuedMessage[]
	lastShownAnnouncementId?: string
	apiModelId?: string
	mcpServers?: McpServer[]
	mdmCompliant?: boolean
	taskSyncEnabled: boolean
	openAiCodexIsAuthenticated?: boolean
	debug?: boolean
}

export interface Command {
	name: string
	source: "global" | "project" | "built-in"
	filePath?: string
	description?: string
	argumentHint?: string
}

/**
 * WebviewMessage
 * Webview | CLI -> Extension
 */

export type ShoferAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse" | "objectResponse"

export type AudioType = "notification" | "celebration" | "progress_loop"

export interface UpdateTodoListPayload {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	todos: any[]
}

export type EditQueuedMessagePayload = Pick<QueuedMessage, "id" | "text" | "images">

/**
 * Per-file entry describing a file Shofer edited in the current Task.
 *
 * The list is scoped to files Shofer touched at least once. Net state is
 * computed against the per-task working-directory base copy captured at
 * first edit. Files whose net state matches the base are excluded unless a
 * final snapshot exists (preserving the Redo action).
 */
export interface ChangedFileEntry {
	/** Workspace-relative POSIX path. */
	path: string
	insertions: number
	deletions: number
	binary: boolean
	state: "modified" | "added" | "deleted" | "reverted"
	/** Always "working" — the sole backend. */
	source: "working"
	/** Whether an original-content base copy is available for diff/revert. */
	hasOriginalContent: boolean
	/** Whether a final-content copy is available for redo. */
	hasFinalContent: boolean
}

export interface ChangedFilesPayload {
	taskId: string
	entries: ChangedFileEntry[]
	/** Always "working" when entries exist, "none" when no files were edited. */
	backend: "working" | "none"
}

export interface WebviewMessage {
	type:
		| "updateTodoList"
		| "deleteMultipleTasksWithIds"
		| "getBlobContent"
		| "currentApiConfigName"
		| "saveApiConfiguration"
		| "upsertApiConfiguration"
		| "deleteApiConfiguration"
		| "loadApiConfiguration"
		| "setDefaultApiConfiguration"
		| "loadApiConfigurationForEdit"
		| "loadApiConfigurationById"
		| "setTaskApiConfiguration"
		| "setModeApiConfig"
		| "renameApiConfiguration"
		| "getListApiConfiguration"
		| "customInstructions"
		| "webviewDidLaunch"
		| "newTask"
		| "askResponse"
		| "terminalOperation"
		| "clearTask"
		| "didShowAnnouncement"
		| "selectImages"
		| "exportCurrentTask"
		| "exportCurrentTaskJson"
		| "shareCurrentTask"
		| "showTaskWithId"
		| "deleteTaskWithId"
		| "exportTaskWithId"
		| "exportTaskWithIdJson"
		| "importSettings"
		| "exportSettings"
		| "resetState"
		| "flushRouterModels"
		| "requestRouterModels"
		| "requestOpenAiModels"
		| "requestOllamaModels"
		| "requestLmStudioModels"
		| "requestRooModels"
		| "requestRooCreditBalance"
		| "requestVsCodeLmModels"
		| "openImage"
		| "saveImage"
		| "openFile"
		| "readFileContent"
		| "openMention"
		| "cancelTask"
		| "cancelAutoApproval"
		| "updateVSCodeSetting"
		| "getVSCodeSetting"
		| "vsCodeSetting"
		| "updateCondensingPrompt"
		| "playSound"
		| "playTts"
		| "stopTts"
		| "ttsEnabled"
		| "ttsSpeed"
		| "openKeyboardShortcuts"
		| "openMcpSettings"
		| "openProjectMcpSettings"
		| "restartMcpServer"
		| "refreshAllMcpServers"
		| "toggleToolEnabledForPrompt"
		| "toggleMcpServer"
		| "updateMcpTimeout"
		| "walkthroughOpen"
		| "enhancePrompt"
		| "enhancedPrompt"
		| "draggedImages"
		| "deleteMessage"
		| "deleteMessageConfirm"
		| "submitEditedMessage"
		| "editMessageConfirm"
		| "taskSyncEnabled"
		| "searchCommits"
		| "setApiConfigPassword"
		| "mode"
		| "updatePrompt"
		| "getSystemPrompt"
		| "copySystemPrompt"
		| "systemPrompt"
		| "enhancementApiConfigId"
		| "autoApprovalEnabled"
		| "updateCustomMode"
		| "deleteCustomMode"
		| "setopenAiCustomModelInfo"
		| "openCustomModesSettings"
		| "checkpointDiff"
		| "checkpointRestore"
		| "changedFiles/get"
		| "changedFiles/showDiff"
		| "changedFiles/revert"
		| "changedFiles/revertAll"
		| "changedFiles/accept"
		| "changedFiles/acceptAll"
		| "deleteMcpServer"
		| "codebaseIndexEnabled"
		| "telemetrySetting"
		| "grepSearch"
		| "toggleApiConfigPin"
		| "hasOpenedModeSelector"
		| "lockApiConfigAcrossModes"
		| "clearCloudAuthSkipModel"
		| "shoferCloudSignIn"
		| "cloudLandingPageSignIn"
		| "shoferCloudSignOut"
		| "shoferCloudManualUrl"
		| "openAiCodexSignIn"
		| "openAiCodexSignOut"
		| "switchOrganization"
		| "condenseTaskContextRequest"
		| "requestIndexingStatus"
		| "clearIndexData"
		| "clearGitIndexData"
		| "requestGitIndexingStatus"
		| "indexingStatusUpdate"
		| "indexCleared"
		| "assistantAgentAction"
		| "requestAssistantAgentStatus"
		| "toggleWorkspaceIndexing"
		| "setAutoEnableDefault"
		| "focusPanelRequest"
		| "openExternal"
		| "filterMarketplaceItems"
		| "marketplaceButtonClicked"
		| "installMarketplaceItem"
		| "installMarketplaceItemWithParameters"
		| "cancelMarketplaceInstall"
		| "removeInstalledMarketplaceItem"
		| "marketplaceInstallResult"
		| "fetchMarketplaceData"
		| "switchTab"
		| "shareTaskSuccess"
		| "exportMode"
		| "exportModeResult"
		| "importMode"
		| "importModeResult"
		| "checkRulesDirectory"
		| "checkRulesDirectoryResult"
		| "saveCodeIndexSettingsAtomic"
		| "updateCodebaseIndexConfig"
		| "requestCodeIndexSecretStatus"
		| "requestCommands"
		| "openCommandFile"
		| "deleteCommand"
		| "createCommand"
		| "insertTextIntoTextarea"
		| "showMdmAuthRequiredNotification"
		| "imageGenerationSettings"
		| "queueMessage"
		| "removeQueuedMessage"
		| "cancelAndSendQueuedMessages"
		| "editQueuedMessage"
		| "dismissUpsell"
		| "getDismissedUpsells"
		| "openMarkdownPreview"
		| "updateSettings"
		| "allowedCommands"
		| "getTaskWithAggregatedCosts"
		| "getTaskInteractions"
		| "deniedCommands"
		| "openDebugApiHistory"
		| "openDebugUiHistory"
		| "downloadErrorDiagnostics"
		| "requestOpenAiCodexRateLimits"
		| "refreshCustomTools"
		| "requestModes"
		| "switchMode"
		| "debugSetting"
		// Worktree messages
		| "listWorktrees"
		| "createWorktree"
		| "deleteWorktree"
		| "getAvailableBranches"
		| "getWorktreeDefaults"
		| "getWorktreeIncludeStatus"
		| "checkBranchWorktreeInclude"
		| "createWorktreeInclude"
		| "checkoutBranch"
		| "browseForWorktreePath"
		| "getWorktreeStatus"
		// Webview health messages
		| "fatal_error"
		| "pong"
		// Skills messages
		| "loadOlderMessages"
		| "requestSkills"
		| "createSkill"
		| "deleteSkill"
		| "moveSkill"
		| "updateSkillModes"
		| "openSkillFile"
		| "requestLoadedSkills"
		| "searchSkills"
		// Parallel task messages
		| "createParallelTask"
		| "focusParallelTask"
		| "startParallelTask"
		| "pauseParallelTask"
		| "resumeParallelTask"
		| "stopParallelTask"
		| "renameParallelTask"
		| "deleteParallelTask"
		| "archiveParallelTask"
		| "unarchiveParallelTask"
		| "pinParallelTask"
		| "unpinParallelTask"
		| "clearTaskNotification"
		| "approveBackgroundTask"
		| "requestParallelTasks"
		| "updateCostLimit"
		// Workflow messages
		| "listWorkflows"
		| "createWorkflow"
		// Resume a stopped (aborted) WorkflowTask: re-enter the slang loop and
		// continue every agent that still exists.
		| "resumeWorkflow"
		// Re-point a running WorkflowTask (and its future agents) at a worktree
		// the user selects/creates on the workflow surface.
		| "setWorkflowWorktree"
		// Launcher: start a fresh task in the chosen mode (replaces the old plus → new chat)
		| "launchTask"
		// Diagnostic logging from webview → extension OutputChannel
		| "webviewLog"
		// Logs tab: request the current snapshot of a task/workflow's logs (uses `taskId`)
		| "requestTaskLogs"
		// Metrics push from webview → extension host registry (Phase 4)
		| "pushMetrics"
	text?: string
	taskId?: string
	/** §4.3: sha256 of a blob to fetch on `getBlobContent`. */
	sha256?: string
	editedMessageContent?: string
	tab?: "settings" | "history" | "mcp" | "modes" | "chat" | "marketplace" | "cloud"
	disabled?: boolean
	context?: string
	dataUri?: string
	askResponse?: ShoferAskResponse
	apiConfiguration?: ProviderSettings
	images?: string[]
	bool?: boolean
	value?: number
	stepIndex?: number
	isLaunchAction?: boolean
	forceShow?: boolean
	commands?: string[]
	audioType?: AudioType
	serverName?: string
	toolName?: string
	isEnabled?: boolean
	mode?: string
	/**
	 * Pre-task API configuration profile name selected in the chat dropdown,
	 * forwarded with `newTask` so the new task is seeded with this profile
	 * without mutating the global default. Optional — absent means "use the
	 * global Settings default".
	 */
	apiConfigName?: string
	promptMode?: string | "enhance"
	customPrompt?: PromptComponent
	dataUrls?: string[]
	/** Generic payload for webview messages that use `values` */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	values?: Record<string, any>
	query?: string
	setting?: string
	slug?: string
	modeConfig?: ModeConfig
	timeout?: number
	payload?: WebViewMessagePayload
	source?: "global" | "project"
	skillName?: string // For skill operations (createSkill, deleteSkill, moveSkill, openSkillFile)
	/** Typed payload for `pushMetrics` — see {@link WebviewMetricsPush}. */
	metrics?: WebviewMetricsPush
	/** @deprecated Use skillModeSlugs instead */
	skillMode?: string // For skill operations (current mode restriction)
	/** @deprecated Use newSkillModeSlugs instead */
	newSkillMode?: string // For moveSkill (target mode)
	skillDescription?: string // For createSkill (skill description)
	/** Mode slugs for skill operations. undefined/empty = any mode */
	skillModeSlugs?: string[] // For skill operations (mode restrictions)
	/** Target mode slugs for updateSkillModes */
	newSkillModeSlugs?: string[] // For updateSkillModes (new mode restrictions)
	requestId?: string
	ids?: string[]
	terminalOperation?: "continue" | "abort"
	messageTs?: number
	restoreCheckpoint?: boolean
	historyPreviewCollapsed?: boolean
	/** Per-root-task cost-limit payload for the `updateCostLimit` message. */
	costLimit?: CostLimit
	filters?: { type?: string; search?: string; tags?: string[] }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	settings?: any
	url?: string // For openExternal
	mpItem?: MarketplaceItem
	mpInstallOptions?: InstallMarketplaceItemOptions
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	config?: Record<string, any> // Add config to the payload
	visibility?: ShareVisibility // For share visibility
	hasContent?: boolean // For checkRulesDirectoryResult
	checkOnly?: boolean // For deleteCustomMode check
	upsellId?: string // For dismissUpsell
	list?: string[] // For dismissedUpsells response
	organizationId?: string | null // For organization switching
	useProviderSignup?: boolean // For shoferCloudSignIn to use provider signup flow
	codeIndexSettings?: {
		// Global state settings
		codebaseIndexEnabled: boolean
		codebaseIndexQdrantUrl: string
		codebaseIndexEmbedderProvider:
			| "openai"
			| "ollama"
			| "openai-compatible"
			| "gemini"
			| "mistral"
			| "vercel-ai-gateway"
			| "bedrock"
			| "openrouter"
		codebaseIndexEmbedderBaseUrl?: string
		codebaseIndexEmbedderModelId: string
		codebaseIndexEmbedderModelDimension?: number // Generic dimension for all providers
		codebaseIndexOpenAiCompatibleBaseUrl?: string
		codebaseIndexBedrockRegion?: string
		codebaseIndexBedrockProfile?: string
		codebaseIndexSearchMaxResults?: number
		codebaseIndexSearchMinScore?: number
		codebaseIndexOpenRouterSpecificProvider?: string // OpenRouter provider routing

		// Secret settings
		codeIndexOpenAiKey?: string
		codeIndexQdrantApiKey?: string
		codebaseIndexOpenAiCompatibleApiKey?: string
		codebaseIndexGeminiApiKey?: string
		codebaseIndexMistralApiKey?: string
		codebaseIndexVercelAiGatewayApiKey?: string
		codebaseIndexOpenRouterApiKey?: string
	}
	/**
	 * Partial codebase-index config patch.
	 *
	 * Used by `updateCodebaseIndexConfig` to merge a small subset of fields
	 * (e.g. just `codebaseIndexGitEnabled` toggled from the popover) into the
	 * persisted `codebaseIndexConfig` global state without touching unrelated
	 * fields or rewriting any secrets — unlike `saveCodeIndexSettingsAtomic`
	 * which expects the full settings object and reinitializes the manager.
	 */
	codebaseIndexConfigPartial?: Partial<CodebaseIndexConfig>
	updatedSettings?: ShoferSettings
	/** Task configuration applied via `createTask()` when starting a cloud task. */
	taskConfiguration?: ShoferSettings
	// Parallel task properties
	taskName?: string
	// Workflow properties — launching a discovered .slang flow as a WorkflowTask.
	flowName?: string
	flowParams?: Record<string, string>
	// Worktree properties
	worktreePath?: string
	/** Embedded worktree directory for new tasks scoped to a git worktree subdirectory. */
	worktreeDir?: string
	/** When true, the host auto-creates a worktree before starting the new task. */
	autoCreateWorktree?: boolean
	worktreeBranch?: string
	worktreeBaseBranch?: string
	worktreeCreateNewBranch?: boolean
	worktreeForce?: boolean
	worktreeIncludeContent?: string
	/** When true, run git submodule update --init in the new worktree. */
	initSubmodules?: boolean
	/** When true, copy .shofer/worktreeinclude files into the new worktree. */
	copyWorktreeInclude?: boolean
}

export interface RequestOpenAiCodexRateLimitsMessage {
	type: "requestOpenAiCodexRateLimits"
}

export const checkoutDiffPayloadSchema = z.object({
	ts: z.number().optional(),
	previousCommitHash: z.string().optional(),
	commitHash: z.string(),
	mode: z.enum(["full", "checkpoint", "from-init", "to-current"]),
})

export type CheckpointDiffPayload = z.infer<typeof checkoutDiffPayloadSchema>

export const checkoutRestorePayloadSchema = z.object({
	ts: z.number(),
	commitHash: z.string(),
	mode: z.enum(["preview", "restore"]),
})

export type CheckpointRestorePayload = z.infer<typeof checkoutRestorePayloadSchema>

export interface IndexingStatusPayload {
	state: "Standby" | "Indexing" | "Indexed" | "Error" | "Stopping"
	message: string
}

export interface IndexClearedPayload {
	success: boolean
	error?: string
}

export const installMarketplaceItemWithParametersPayloadSchema = z.object({
	item: marketplaceItemSchema,
	parameters: z.record(z.string(), z.any()),
})

export type InstallMarketplaceItemWithParametersPayload = z.infer<
	typeof installMarketplaceItemWithParametersPayloadSchema
>

export type WebViewMessagePayload =
	| CheckpointDiffPayload
	| CheckpointRestorePayload
	| IndexingStatusPayload
	| IndexClearedPayload
	| InstallMarketplaceItemWithParametersPayload
	| UpdateTodoListPayload
	| EditQueuedMessagePayload

export interface IndexingStatus {
	systemStatus: string
	message?: string
	processedItems: number
	totalItems: number
	currentItemUnit?: string
	workspacePath?: string
	workspaceEnabled?: boolean
	autoEnableDefault?: boolean
	/**
	 * Cumulative number of files currently held in the code-index cache
	 * (i.e. the number of files presently represented in Qdrant). Survives
	 * restart. Surfaced in the popover so users can verify the fast-path
	 * didn't silently drop any files.
	 */
	indexedFileCount?: number
	/**
	 * Most recent file the orchestrator/watcher (re)indexed since the
	 * extension started. Empty when no files have been touched yet this
	 * session (e.g. cold-start with all files unchanged on disk).
	 */
	lastFileIndexed?: string
}

export interface IndexingStatusUpdateMessage {
	type: "indexingStatusUpdate"
	values: IndexingStatus
}

/**
 * Payload pushed to the webview with the current git-history-index status.
 * Mirrors {@link IndexingStatus} but with commit-oriented diagnostics.
 */
export interface GitIndexingStatus {
	systemStatus: string
	message?: string
	processedItems: number
	totalItems: number
	currentItemUnit?: string
	workspacePath?: string
	/** Number of commits currently held in the git-index cache. */
	indexedCommitCount?: number
	/** Short SHA (7 chars) of the most recent commit known to the indexer. */
	latestCommitHash?: string
}

export interface GitIndexingStatusUpdateMessage {
	type: "gitIndexingStatusUpdate"
	values: GitIndexingStatus
}

export interface LanguageModelChatSelector {
	vendor?: string
	family?: string
	version?: string
	id?: string
}

export interface ShoferSayTool {
	tool:
		| "editedExistingFile"
		| "appliedDiff"
		| "newFileCreated"
		| "ragSearch"
		| "lspSearch"
		| "readFile"
		| "readCommandOutput"
		| "listFilesTopLevel"
		| "listFilesRecursive"
		| "grepSearch"
		| "switchMode"
		| "newTask"
		| "finishTask"
		| "generateImage"
		| "imageGenerated"
		| "runSlashCommand"
		| "updateTodoList"
		| "skills"
		| "saveSkill"
		| "deleteSkill"
		| "createDirectory"
		| "createNewWorkspace"
		| "findFiles"
		| "viewImage"
		| "waitForTask"
		| "checkTaskStatus"
		| "listBackgroundTasks"
		| "cancelTasks"
		| "answerSubtaskQuestion"
		| "sendMessageToTask"
		| "getErrors"
		| "getChangedFiles"
		| "getProjectSetupInfo"
		// getSearchResults removed — merged into grep_search
		| "readProjectStructure"
		| "listCodeUsages"
		| "fetchWebPage"
		| "renameSymbol"
		| "setTaskTitle"
		| "giveFeedback"
		| "insertEdit"
		| "removeFile"
		| "moveFile"
		| "askAssistantAgent"
		| "gitSearch"
		| "callMcpToolAsync"
		| "checkMcpCallStatus"
		| "waitForMcpCall"
		| "sleep"
	path?: string
	/** For `removeFile` / `moveFile`: the rm/mv subcommand. */
	fileOp?: "rm" | "mv"
	/** For `moveFile`: destination path relative to workspace. */
	destination?: string
	// For readCommandOutput
	readStart?: number
	readEnd?: number
	totalBytes?: number
	searchPattern?: string
	matchCount?: number
	diff?: string
	content?: string
	// Original file content before first edit (for merged diff display in FileChangesPanel)
	originalContent?: string
	// Unified diff statistics computed by the extension
	diffStats?: { added: number; removed: number }
	regex?: string
	filePattern?: string
	mode?: string
	reason?: string
	isOutsideWorkspace?: boolean
	isProtected?: boolean
	additionalFileCount?: number // Number of additional files in the same read_file request
	lineNumber?: number
	startLine?: number // Starting line for read_file operations (for navigation on click)
	query?: string
	batchFiles?: Array<{
		path: string
		lineSnippet: string
		isOutsideWorkspace?: boolean
		key: string
		content?: string
	}>
	batchDiffs?: Array<{
		path: string
		changeCount: number
		key: string
		content: string
		// Per-file unified diff statistics computed by the extension
		diffStats?: { added: number; removed: number }
		diffs?: Array<{
			content: string
			startLine?: number
		}>
	}>
	batchDirs?: Array<{
		path: string
		recursive: boolean
		isOutsideWorkspace?: boolean
		key: string
	}>
	question?: string
	imageData?: string // Base64 encoded image data for generated images
	// Properties for runSlashCommand tool
	command?: string
	args?: string
	source?: string
	description?: string
	// Properties for skill tool
	skill?: string
	// Properties for background-task status tools (waitForTask / checkTaskStatus / listBackgroundTasks).
	// `task_id` / `task_ids` identify the target background child task(s).
	// `task_title` / `task_titles` are the human-readable labels shown in the UI instead of raw UUIDs.
	// `wait` is the wait_for_task strategy ("all" | "any").
	// `timeout` is the wait_for_task cap in seconds.
	// `tasks` carries the snapshot rendered by list_background_tasks.
	task_id?: string
	task_ids?: string[]
	task_title?: string
	task_titles?: string[]
	/** For `sendMessageToTask`: the message body sent to the peer task. */
	message?: string
	wait?: "all" | "any"
	timeout?: number
	results?: Array<{
		task_id: string
		title?: string
		was_running: boolean
		status: string
		error?: string
	}>
	tasks?: Array<{
		task_id: string
		title: string
		status: string
		created_at?: number
	}>
	// Properties for new_task tool. `peer_task_ids` carries the list of sibling
	// task IDs explicitly granted peer access at spawn time.
	// `is_background` flags background (async) subtasks.
	// `todos` carries the initial todo list for the subtask.
	todos?: string
	peer_task_ids?: string[]
	is_background?: boolean
	softResultLength?: number
	softTimeoutSec?: number
	// Properties for ask_assistant_agent. The `question` field above carries the
	// prompt sent to the assistant agent; these carry the answer + metadata that
	// only become known after the assistant agent responds (emitted via a follow-up
	// `task.say("tool", ...)` once the call returns).
	answer?: string
	contextFiles?: string[]
	timeoutMs?: number
	durationMs?: number
	tokensTotal?: number
	costUSD?: number
}

/**
 * Payload for `say: "tool_result"` messages. Emitted after every tool execution so
 * the ChatRow can show the raw tool output in an expandable section beneath the
 * tool invocation block.
 */
export interface ShoferSayToolResult {
	/** The canonical tool name that produced this result (e.g. "read_file", "grep_search"). */
	tool: string
	/** The raw result text returned by the tool execution. */
	output: string
}

export interface ShoferAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource"
	toolName?: string
	arguments?: string
	uri?: string
	response?: string
	/**
	 * When true, this `use_mcp_server` envelope was synthesised by Shofer to
	 * visualise an external VS Code language-model tool call (registered via
	 * `vscode.lm.tools`) — not a real MCP server invocation. Mirrors the
	 * `external_lm_tool` flag on {@link McpToolCallInfo}; the webview uses it
	 * to render the tool call with the correct header/badge.
	 */
	external_lm_tool?: boolean
	/**
	 * When true, this MCP tool call was initiated asynchronously via
	 * `call_mcp_tool_async`. The chat UI may render an ``async`` badge to
	 * distinguish fire-and-forget calls from synchronous ``use_mcp_tool``
	 * invocations.
	 */
	async?: boolean
}

export interface ShoferApiReqInfo {
	request?: string
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	cancelReason?: ShoferApiReqCancelReason
	streamingFailedMessage?: string
	apiProtocol?: "anthropic" | "openai"
	model?: string
	/** Number of times this request has been retried before this attempt. */
	retryAttempt?: number
	/** Structured error information when this API call fails. */
	error?: ApiReqError
	/** Serialised wire-level request metadata captured before the call. */
	wireRequest?: string
	/** The underlying model that actually served the request (may differ from
	 *  'model' when failover or multi-provider routing is active). */
	actualModel?: string
	/** Time to first byte in milliseconds. */
	ttfbMs?: number
	/** Total time in milliseconds. */
	ttlbMs?: number
	/** Number of provider attempts (1 = first try succeeded). */
	attempts?: number
	/** Error message from the LLM provider when the request failed. */
	responseError?: string
}

export type ShoferApiReqCancelReason = "streaming_failed" | "user_cancelled"

/** Structured error info for a failed API call. */
export interface ApiReqError {
	/** Human-readable error message. */
	message: string
	/** Provider-reported error type or code (e.g. "rate_limit_error", "invalid_request_error"). */
	type?: string
	/** HTTP status code if available. */
	statusCode?: number
	/** Stack trace at the point of the error. */
	stack?: string
}
