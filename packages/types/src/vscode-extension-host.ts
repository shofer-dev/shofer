import { z } from "zod"

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
import type { ToolGroup } from "./tool.js"
import type { OrganizationAllowList } from "./organization.js"
import type { SerializedCustomToolDefinition } from "./custom-tool.js"
import type { WebviewMetricsPush } from "./metrics.js"
import type { ShoferNodesState, ShoferNodeRequest } from "./shofer-node.js"
import type { PluginsState, PluginRequest, PluginUiContributionsState, PluginUiMessageEnvelope } from "./plugin.js"

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
	/**
	 * Id of the WorkflowTask this metadata (and its companion `workflowVizHtml`)
	 * belongs to. These viz fields are pushed through *global* ExtensionState keys
	 * that any live workflow writes to, so the webview uses this to scope them to
	 * the task it is actually displaying — preventing a background workflow's
	 * diagram from bleeding into another task's view.
	 */
	taskId?: string
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
		// Aggregated active-time stats for the workflow "Stats" tab.
		| "workflowStats"
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
		| "marketplaceInstallResult"
		| "marketplaceRemoveResult"
		| "marketplaceData"
		| "shareTaskSuccess"
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
		| "folderSelected"
		| "skills"
		| "loadedSkills"
		| "skillSearchResults"
		| "fileContent"
		| "addContextFiles"
		// Shofer Nodes (remote agents) — full nodes snapshot push
		| "shoferNodes"
		// Plugins (Settings → Plugins tab) — discovered plugins snapshot push
		| "plugins"
		// Plugin UI contributions (design §6.8) — per-region contributions snapshot push
		| "pluginUiContributions"
		// Plugin UI channel (design §6.8) — extension → a plugin's UI (scoped/namespaced)
		| "pluginUiMessage"
		// Stream an exported file to the webview so the browser downloads it
		// (used when the editor is accessed over the web — code-server / vscode.dev).
		| "browserDownload"
		// Webview health messages
		| "ping"
	text?: string
	/** For `browserDownload`: the file the browser should save client-side. */
	browserDownload?: { fileName: string; content: string; mime: string }
	/** For `shoferNodes`: registry + live status of every node (no secrets). */
	shoferNodes?: ShoferNodesState
	/** For `plugins`: discovered plugins + enabled state (design §12). */
	plugins?: PluginsState
	/** For `pluginUiContributions`: enabled plugins' UI contributions per region (design §6.8). */
	pluginUiContributions?: PluginUiContributionsState
	/** For `pluginUiMessage`: a scoped plugin-UI channel message (extension → the plugin's UI). */
	pluginUiMessage?: PluginUiMessageEnvelope
	/** For fileContent: { path, content, error? } */
	fileContent?: { path: string; content: string | null; error?: string }
	/** For addContextFiles: workspace-relative paths to append to chat context. */
	contextFiles?: Array<{ path: string; isFile: boolean }>
	payload?: any // eslint-disable-line @typescript-eslint/no-explicit-any
	action?:
		| "chatButtonClicked"
		| "settingsButtonClicked"
		| "historyButtonClicked"
		| "marketplaceButtonClicked"
		| "tasksButtonClicked"
		| "launcherButtonClicked"
		| "newMenuButtonClicked"
		| "welcomeButtonClicked"
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
	/** workflowStats: the root task id this aggregation is for (correlation). */
	workflowStatsRootId?: string
	/**
	 * workflowStats: per-task `api_req_finished` payloads (the message `.text`
	 * JSON strings), keyed by task id. The webview breaks each task down on its
	 * own timeline, then sums — see `taskStats.ts`.
	 */
	workflowStatsRequests?: Record<string, string[]>
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
		| {
				name: string
				description?: string
				argumentHint?: string
				source: "global" | "project" | "built-in" | "plugin"
		  }[]
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
	/**
	 * For showDeleteMessageDialog / showEditMessageDialog: whether a plugin holds a
	 * restorable snapshot after this message, so the dialog can offer to roll the
	 * workspace back along with the conversation.
	 */
	hasRestorableState?: boolean
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
		// Token totals across the whole subtree (own + all descendants).
		tokensIn: number
		tokensOut: number
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
	// folderSelected
	path?: string
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
	| "allowedReadPaths"
	| "allowedWritePaths"
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
	| "customModePrompts"
	| "customSupportPrompts"
	| "enhancementApiConfigId"
	| "customCondensingPrompt"
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
	| "maxParallelTasks"
	| "logLevel"
	| "logCategories"
> & {
	logCategoriesKnown?: string[]
	lockApiConfigAcrossModes?: boolean
	/** Per-mode API-config associations. A read-only projection of
	 *  `modeApiConfigs` in the providerProfiles store (the single source of
	 *  truth, secrets-backed) — the webview never persists its own copy. */
	modeApiConfigs?: Record<string, string>
	version: string
	shoferMessages: ShoferMessage[]
	/** T1.B: true when cold-load only read the tail of the message log. */
	hasMoreShoferMessages?: boolean
	currentTaskId?: string
	currentTaskItem?: HistoryItem
	currentTaskTodos?: TodoItem[] // Initial todos for the current task
	apiConfiguration: ProviderSettings
	/** When the Settings → Providers "Edit Configuration" dropdown loads a
	 *  non-default config for editing, its settings are pushed here so the
	 *  form renders them WITHOUT corrupting the global apiConfiguration
	 *  that running tasks and the chat UI depend on. */
	editingApiConfiguration?: ProviderSettings
	uriScheme?: string
	shouldShowAnnouncement: boolean

	taskHistory: HistoryItem[]

	writeDelayMs: number

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
	/** Shofer Nodes registry + live status (Local + remotes) for cold-load render. */
	shoferNodes?: ShoferNodesState
}

export interface Command {
	name: string
	source: "global" | "project" | "built-in" | "plugin"
	filePath?: string
	description?: string
	argumentHint?: string
	/** When source === "plugin", the contributing plugin's name (attribution). */
	pluginName?: string
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
		| "updateMcpServerConfig"
		| "setMcpToolGroup"
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
		| "deleteMcpServer"
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
		| "trustOutsideWorkspacePath"
		| "allowedCommands"
		| "getTaskWithAggregatedCosts"
		| "getTaskInteractions"
		| "deniedCommands"
		| "allowedReadPaths"
		| "allowedWritePaths"
		| "openDebugApiHistory"
		| "openDebugUiHistory"
		| "downloadErrorDiagnostics"
		| "requestOpenAiCodexRateLimits"
		| "refreshCustomTools"
		| "requestModes"
		| "switchMode"
		| "debugSetting"
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
		// Launcher: start a fresh task in the chosen mode (replaces the old plus → new chat)
		| "launchTask"
		// Diagnostic logging from webview → extension OutputChannel
		| "webviewLog"
		// Logs tab: request the current snapshot of a task/workflow's logs (uses `taskId`)
		| "requestTaskLogs"
		// Stats tab: request aggregated active-time data for a set of tasks (a tree)
		| "requestWorkflowStats"
		// Metrics push from webview → extension host registry (Phase 4)
		| "pushMetrics"
		// Shofer Nodes (remote agents) — registry CRUD + connect/disconnect/test
		| "shoferNode"
		// Plugins (Settings → Plugins tab) — list + enable/disable
		| "plugin"
		// Plugin UI channel (design §6.8) — a plugin's UI → its extension-side plugin (scoped)
		| "pluginUiMessage"
	text?: string
	taskId?: string
	/** For `shoferNode`: the node registry/connection request. */
	shoferNode?: ShoferNodeRequest
	/** For `plugin`: list / enable-disable request (design §12). */
	plugin?: PluginRequest
	/** For `pluginUiMessage`: a scoped plugin-UI channel message (the plugin's UI → extension). */
	pluginUiMessage?: PluginUiMessageEnvelope
	/** requestWorkflowStats: the subtree task ids to aggregate stats over. */
	workflowStatsTaskIds?: string[]
	/** §4.3: sha256 of a blob to fetch on `getBlobContent`. */
	sha256?: string
	editedMessageContent?: string
	tab?: "settings" | "history" | "mcp" | "modes" | "chat" | "marketplace" | "cloud"
	disabled?: boolean
	context?: string
	dataUri?: string
	askResponse?: ShoferAskResponse
	/**
	 * UUID v7 of the `ShoferMessage.askId` that the webview is responding
	 * to. Echoed back from the ask message so the host can validate that
	 * the response targets the currently-outstanding ask.
	 */
	askId?: string
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
	/**
	 * Target tool group (category) for `setMcpToolGroup`. One of the
	 * {@link ToolGroup} values, or `null` to clear the per-tool override so the
	 * tool falls back to its server-declared group / `"uncategorized"`.
	 */
	toolGroup?: ToolGroup | null
	/**
	 * Partial MCP server configuration patch sent from the Settings → MCP
	 * Servers editor. Keys map to `mcp.json` fields (command, args, cwd, env,
	 * url, headers, watchPaths, type, …); a value of `undefined`/`null` clears
	 * that field. Consumed by the `updateMcpServerConfig` handler.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	serverConfig?: Record<string, any>
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
	/** For deleteMessageConfirm / editMessageConfirm: also roll back plugin-held state. */
	restoreState?: boolean
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
	updatedSettings?: ShoferSettings
	/** For `trustOutsideWorkspacePath`: the directory to task-scope trust (the pending file's parent dir). */
	outsideWorkspacePath?: string
	/** For `trustOutsideWorkspacePath`: whether to trust read only, or read+write (write-group tool). */
	outsideWorkspaceAccess?: "read" | "write"
	/**
	 * For `trustOutsideWorkspacePath`: when `true`, persist the directory to the global
	 * `allowedReadPaths`/`allowedWritePaths` allowlist (survives restarts, synced to nodes)
	 * instead of the default in-memory, current-task-only trust.
	 */
	outsideWorkspacePersist?: boolean
	/** Task configuration applied via `createTask()` when starting a cloud task. */
	taskConfiguration?: ShoferSettings
	// Parallel task properties
	taskName?: string
	// Workflow properties — launching a discovered .slang flow as a WorkflowTask.
	flowName?: string
	flowParams?: Record<string, string>
	/**
	 * Shofer Nodes L2: caller-preferred executor for this new task. When enabled +
	 * assignable it wins owner selection; otherwise the pool round-robins. Carried
	 * on `newTask`; the picker UI that sets it is optional (L3).
	 */
	preferredNodeId?: string
}

export interface RequestOpenAiCodexRateLimitsMessage {
	type: "requestOpenAiCodexRateLimits"
}

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
		| "readOutputChannel"
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
	/**
	 * The resolved absolute path of the file this tool touches, needed to match against the
	 * outside-workspace path allowlist (`allowedReadPaths`/`allowedWritePaths`); the
	 * workspace-relative `path` can't be matched against absolute prefixes. Set alongside
	 * `isOutsideWorkspace` at tool sites.
	 */
	absolutePath?: string
	isProtected?: boolean
	additionalFileCount?: number // Number of additional files in the same read_file request
	lineNumber?: number
	startLine?: number // Starting line for read_file operations (for navigation on click)
	query?: string
	batchFiles?: Array<{
		path: string
		lineSnippet: string
		isOutsideWorkspace?: boolean
		/** Resolved absolute path for this batch entry — matched against the path allowlist. */
		absolutePath?: string
		key: string
		content?: string
	}>
	batchDiffs?: Array<{
		path: string
		changeCount: number
		/** Resolved absolute path for this batch entry — matched against the path allowlist. */
		absolutePath?: string
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
	contextFiles?: string[]
	// answer_subtask_question: the answer text rendered back into the chat row.
	answer?: string
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
