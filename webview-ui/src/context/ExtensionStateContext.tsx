import React, { createContext, useCallback, useContext, useEffect, useState } from "react"

import {
	type ProviderSettings,
	type ProviderSettingsEntry,
	type CustomModePrompts,
	type ModeConfig,
	type ExperimentId,
	type TodoItem,
	type TelemetrySetting,
	type OrganizationAllowList,
	type ExtensionMessage,
	type ExtensionState,
	type MarketplaceInstalledMetadata,
	type SkillMetadata,
	type Command,
	type McpServer,
	type VsCodeLmChatInfo,
	RouterModels,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
} from "@shofer/types"

import { findLastIndex } from "@shofer/shared/array"

import { checkExistKey } from "@shofer/shared/checkExistApiConfig"
import { Mode, defaultModeSlug, defaultPrompts } from "@shofer/shared/modes"
import { CustomSupportPrompts } from "@shofer/shared/support-prompt"
import { experimentDefault } from "@shofer/shared/experiments"

import { vscode } from "@src/utils/vscode"
import { convertTextMateToHljs } from "@src/utils/textMateToHljs"

export interface ManagedTask {
	id: string
	name: string
	taskId: string
	workspace: string
	createdAt: number
	lastActiveAt: number
	state: string
}

export interface TaskNotification {
	taskId: string
	type: "needs_input" | "completed" | "error" | "file_conflict"
	message: string
	timestamp: number
}

export interface ExtensionStateContextType extends ExtensionState {
	historyPreviewCollapsed?: boolean // Add the new state property
	didHydrateState: boolean
	showWelcome: boolean
	theme: any
	mcpServers: McpServer[]
	currentCheckpoint?: string
	currentTaskTodos?: TodoItem[] // Initial todos for the current task
	filePaths: string[]
	openedTabs: Array<{ label: string; isActive: boolean; path?: string }>
	commands: Command[]
	organizationAllowList: OrganizationAllowList
	organizationSettingsVersion: number
	cloudIsAuthenticated: boolean
	cloudOrganizations?: any[]
	sharingEnabled: boolean
	publicSharingEnabled: boolean
	mdmCompliant?: boolean
	hasOpenedModeSelector: boolean // New property to track if user has opened mode selector
	// Parallel task management
	parallelTasks: ManagedTask[]
	focusedTaskId: string | null
	taskNotifications: TaskNotification[]
	setHasOpenedModeSelector: (value: boolean) => void // Setter for the new property
	alwaysAllowFollowupQuestions: boolean // New property for follow-up questions auto-approve
	setAlwaysAllowFollowupQuestions: (value: boolean) => void // Setter for the new property
	followupAutoApproveTimeoutMs: number | undefined // Timeout in ms for auto-approving follow-up questions
	setFollowupAutoApproveTimeoutMs: (value: number) => void // Setter for the timeout
	marketplaceItems?: any[]
	marketplaceInstalledMetadata?: MarketplaceInstalledMetadata
	profileThresholds: Record<string, number>
	setProfileThresholds: (value: Record<string, number>) => void
	setApiConfiguration: (config: ProviderSettings) => void
	setCustomInstructions: (value?: string) => void
	setAlwaysAllowReadOnly: (value: boolean) => void
	setAlwaysAllowReadOnlyOutsideWorkspace: (value: boolean) => void
	setAlwaysAllowWrite: (value: boolean) => void
	setAlwaysAllowWriteOutsideWorkspace: (value: boolean) => void
	setAlwaysAllowBrowser: (value: boolean) => void
	setAlwaysAllowExecute: (value: boolean) => void
	setAlwaysAllowMcp: (value: boolean) => void
	setAlwaysAllowUncategorized: (value: boolean) => void
	setAlwaysAllowModeSwitch: (value: boolean) => void
	setAlwaysAllowSubtasks: (value: boolean) => void
	setShowShoferIgnoredFiles: (value: boolean) => void
	setEnableSubfolderRules: (value: boolean) => void
	setShowAnnouncement: (value: boolean) => void
	setAllowedCommands: (value: string[]) => void
	setDeniedCommands: (value: string[]) => void
	setAllowedMaxRequests: (value: number | undefined) => void
	setAllowedMaxCost: (value: number | undefined) => void
	setSoundEnabled: (value: boolean) => void
	setSoundVolume: (value: number) => void
	terminalShellIntegrationTimeout?: number
	setTerminalShellIntegrationTimeout: (value: number) => void
	terminalShellIntegrationDisabled?: boolean
	setTerminalShellIntegrationDisabled: (value: boolean) => void
	terminalZdotdir?: boolean
	setTerminalZdotdir: (value: boolean) => void
	setTtsEnabled: (value: boolean) => void
	setTtsSpeed: (value: number) => void
	setEnableCheckpoints: (value: boolean) => void
	checkpointTimeout: number
	setCheckpointTimeout: (value: number) => void
	setWriteDelayMs: (value: number) => void
	terminalOutputPreviewSize?: "small" | "medium" | "large"
	setTerminalOutputPreviewSize: (value: "small" | "medium" | "large") => void
	mcpEnabled: boolean
	setMcpEnabled: (value: boolean) => void
	taskSyncEnabled: boolean
	setTaskSyncEnabled: (value: boolean) => void
	setCurrentApiConfigName: (value: string) => void
	setListApiConfigMeta: (value: ProviderSettingsEntry[]) => void
	mode: Mode
	setMode: (value: Mode) => void
	setCustomModePrompts: (value: CustomModePrompts) => void
	setCustomSupportPrompts: (value: CustomSupportPrompts) => void
	enhancementApiConfigId?: string
	setEnhancementApiConfigId: (value: string) => void
	setExperimentEnabled: (id: ExperimentId, enabled: boolean) => void
	setAutoApprovalEnabled: (value: boolean) => void
	customModes: ModeConfig[]
	setCustomModes: (value: ModeConfig[]) => void
	setMaxOpenTabsContext: (value: number) => void
	maxWorkspaceFiles: number
	setMaxWorkspaceFiles: (value: number) => void
	setTelemetrySetting: (value: TelemetrySetting) => void
	awsUsePromptCache?: boolean
	setAwsUsePromptCache: (value: boolean) => void
	maxImageFileSize: number
	setMaxImageFileSize: (value: number) => void
	maxTotalImageSize: number
	setMaxTotalImageSize: (value: number) => void
	machineId?: string
	pinnedApiConfigs?: Record<string, boolean>
	setPinnedApiConfigs: (value: Record<string, boolean>) => void
	togglePinnedApiConfig: (configName: string) => void
	setHistoryPreviewCollapsed: (value: boolean) => void
	setReasoningBlockCollapsed: (value: boolean) => void
	enterBehavior?: "send" | "newline"
	setEnterBehavior: (value: "send" | "newline") => void
	autoCondenseContext: boolean
	setAutoCondenseContext: (value: boolean) => void
	autoCondenseContextPercent: number
	setAutoCondenseContextPercent: (value: number) => void
	routerModels?: RouterModels
	vsCodeLmModels: VsCodeLmChatInfo[]
	includeDiagnosticMessages?: boolean
	setIncludeDiagnosticMessages: (value: boolean) => void
	maxDiagnosticMessages?: number
	setMaxDiagnosticMessages: (value: number) => void
	includeTaskHistoryInEnhance?: boolean
	setIncludeTaskHistoryInEnhance: (value: boolean) => void
	includeCurrentTime?: boolean
	setIncludeCurrentTime: (value: boolean) => void
	includeCurrentCost?: boolean
	setIncludeCurrentCost: (value: boolean) => void
	skills?: SkillMetadata[]
	loadedSkills?: Record<string, string>
	// Webview-only: when set on the home screen (no active task), the next
	// `newTask`/`createParallelTask` will use this as `worktreeDir` so the
	// task is scoped to the chosen worktree. Cleared once consumed. Not
	// persisted across reloads and not synced to the extension host.
	pendingWorktreeDir: string | null
	setPendingWorktreeDir: (value: string | null) => void
}

export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)

export const mergeExtensionState = (prevState: ExtensionState, newState: Partial<ExtensionState>) => {
	const { customModePrompts: prevCustomModePrompts, experiments: prevExperiments, ...prevRest } = prevState

	const {
		apiConfiguration,
		customModePrompts: newCustomModePrompts,
		customSupportPrompts,
		experiments: newExperiments,
		...newRest
	} = newState

	const customModePrompts = { ...prevCustomModePrompts, ...(newCustomModePrompts ?? {}) }
	const experiments = { ...prevExperiments, ...(newExperiments ?? {}) }
	// Defensive: message queues and task identifiers can arrive as undefined
	// from the backend (optional chaining returns undefined). When serialised
	// through VS Code's webview.postMessage (JSON), undefined values are
	// stripped. Without explicit defaults the spread below preserves the
	// previous stale value from a different task.
	const rest = {
		...prevRest,
		...newRest,
		messageQueue: newRest.messageQueue ?? [],
		currentTaskId: newRest.currentTaskId ?? prevRest.currentTaskId,
		currentTaskItem: newRest.currentTaskItem ?? prevRest.currentTaskItem,
	}

	// Protect shoferMessages from stale state pushes using sequence numbering.
	// Multiple async event sources (cloud auth, settings, task streaming) can trigger
	// concurrent state pushes. If a stale push arrives after a newer one, its shoferMessages
	// would overwrite the newer messages. The sequence number prevents this by only applying
	// shoferMessages when the incoming seq is strictly greater than the last applied seq.
	if (
		newState.shoferMessagesSeq !== undefined &&
		prevState.shoferMessagesSeq !== undefined &&
		newState.shoferMessagesSeq <= prevState.shoferMessagesSeq &&
		newState.shoferMessages !== undefined
	) {
		rest.shoferMessages = prevState.shoferMessages
		rest.shoferMessagesSeq = prevState.shoferMessagesSeq
	}

	// Note that we completely replace the previous apiConfiguration and customSupportPrompts objects
	// with new ones since the state that is broadcast is the entire objects so merging is not necessary.
	return {
		...rest,
		apiConfiguration: apiConfiguration ?? prevState.apiConfiguration,
		customModePrompts,
		customSupportPrompts: customSupportPrompts ?? prevState.customSupportPrompts,
		experiments,
	}
}

export const ExtensionStateContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [state, setState] = useState<ExtensionState>({
		apiConfiguration: {},
		version: "",
		shoferMessages: [],
		taskHistory: [],
		shouldShowAnnouncement: false,
		allowedCommands: [],
		deniedCommands: [],
		soundEnabled: false,
		soundVolume: 0.5,
		ttsEnabled: false,
		ttsSpeed: 1.0,
		enableCheckpoints: true,
		checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS, // Default to 15 seconds
		language: "en", // Default language code
		writeDelayMs: 1000,
		terminalShellIntegrationTimeout: 4000,
		mcpEnabled: true,
		taskSyncEnabled: false,
		currentApiConfigName: "default",
		listApiConfigMeta: [],
		mode: defaultModeSlug,
		customModePrompts: defaultPrompts,
		customSupportPrompts: {},
		experiments: experimentDefault,
		enhancementApiConfigId: "",
		hasOpenedModeSelector: false, // Default to false (not opened yet)
		autoApprovalEnabled: false,
		customModes: [],
		maxOpenTabsContext: 20,
		maxWorkspaceFiles: 200,
		cwd: "",
		telemetrySetting: "unset",
		showShoferIgnoredFiles: true, // Default to showing .shoferignore'd files with lock symbol (current behavior).
		enableSubfolderRules: false, // Default to disabled - must be enabled to load rules from subdirectories
		renderContext: "sidebar",
		maxReadFileLine: -1, // Default max line limit for read_file tool (-1 for default)
		maxImageFileSize: 5, // Default max image file size in MB
		maxTotalImageSize: 20, // Default max total image size in MB
		pinnedApiConfigs: {}, // Empty object for pinned API configs
		terminalZshOhMy: false, // Default Oh My Zsh integration setting
		terminalZshP10k: false, // Default Powerlevel10k integration setting
		terminalZdotdir: false, // Default ZDOTDIR handling setting
		historyPreviewCollapsed: false, // Initialize the new state (default to expanded)
		reasoningBlockCollapsed: true, // Default to collapsed
		enterBehavior: "send", // Default: Enter sends, Shift+Enter creates newline
		cloudUserInfo: null,
		cloudIsAuthenticated: false,
		cloudOrganizations: [],
		sharingEnabled: false,
		publicSharingEnabled: false,
		organizationAllowList: ORGANIZATION_ALLOW_ALL,
		organizationSettingsVersion: -1,
		autoCondenseContext: true,
		autoCondenseContextPercent: 100,
		profileThresholds: {},
		codebaseIndexConfig: {
			codebaseIndexEnabled: true,
			codebaseIndexQdrantUrl: "http://localhost:6333",
			codebaseIndexEmbedderProvider: "openai",
			codebaseIndexEmbedderBaseUrl: "",
			codebaseIndexEmbedderModelId: "",
			codebaseIndexSearchMaxResults: undefined,
			codebaseIndexSearchMinScore: undefined,
		},
		codebaseIndexModels: { ollama: {}, openai: {} },
		includeDiagnosticMessages: true,
		maxDiagnosticMessages: 50,
		openRouterImageApiKey: "",
		openRouterImageGenerationSelectedModel: "",
		includeCurrentTime: true,
		includeCurrentCost: true,
		lockApiConfigAcrossModes: false,
		// Parallel task management
		parallelTasks: [],
		focusedTaskId: null,
		taskNotifications: [],
	})

	const [didHydrateState, setDidHydrateState] = useState(false)
	const [showWelcome, setShowWelcome] = useState(false)
	const [theme, setTheme] = useState<any>(undefined)
	const [filePaths, setFilePaths] = useState<string[]>([])
	const [openedTabs, setOpenedTabs] = useState<Array<{ label: string; isActive: boolean; path?: string }>>([])
	const [commands, setCommands] = useState<Command[]>([])
	const [mcpServers, setMcpServers] = useState<McpServer[]>([])
	const [currentCheckpoint, setCurrentCheckpoint] = useState<string>()
	const [extensionRouterModels, setExtensionRouterModels] = useState<RouterModels | undefined>(undefined)
	const [vsCodeLmModels, setVsCodeLmModels] = useState<VsCodeLmChatInfo[]>([])
	const [marketplaceItems, setMarketplaceItems] = useState<any[]>([])
	const [alwaysAllowFollowupQuestions, setAlwaysAllowFollowupQuestions] = useState(false) // Add state for follow-up questions auto-approve
	const [followupAutoApproveTimeoutMs, setFollowupAutoApproveTimeoutMs] = useState<number | undefined>(undefined) // Will be set from global settings
	const [marketplaceInstalledMetadata, setMarketplaceInstalledMetadata] = useState<MarketplaceInstalledMetadata>({
		project: {},
		global: {},
	})
	const [skills, setSkills] = useState<SkillMetadata[]>([])
	const [loadedSkills, setLoadedSkills] = useState<Record<string, string>>({})
	const [includeTaskHistoryInEnhance, setIncludeTaskHistoryInEnhance] = useState(true)
	const [pendingWorktreeDir, setPendingWorktreeDir] = useState<string | null>(null)
	const [prevCloudIsAuthenticated, setPrevCloudIsAuthenticated] = useState(false)
	const [includeCurrentTime, setIncludeCurrentTime] = useState(true)
	const [includeCurrentCost, setIncludeCurrentCost] = useState(true)

	const setListApiConfigMeta = useCallback(
		(value: ProviderSettingsEntry[]) => setState((prevState) => ({ ...prevState, listApiConfigMeta: value })),
		[],
	)

	const setApiConfiguration = useCallback((value: ProviderSettings) => {
		setState((prevState) => ({
			...prevState,
			apiConfiguration: {
				...prevState.apiConfiguration,
				...value,
			},
		}))
	}, [])

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			switch (message.type) {
				case "state": {
					const newState = message.state ?? {}
					if (newState.apiConfiguration !== undefined) {
						const prevProvider = state.apiConfiguration?.apiProvider
						const nextProvider = newState.apiConfiguration?.apiProvider
						if (prevProvider !== nextProvider) {
							console.log(
								`[ExtensionStateContext] state push overwriting apiProvider: "${prevProvider}" -> "${nextProvider}"`,
							)
						}
					}
					setState((prevState) => mergeExtensionState(prevState, newState))
					setShowWelcome(!checkExistKey(newState.apiConfiguration))
					setDidHydrateState(true)
					// Update alwaysAllowFollowupQuestions if present in state message
					if ((newState as any).alwaysAllowFollowupQuestions !== undefined) {
						setAlwaysAllowFollowupQuestions((newState as any).alwaysAllowFollowupQuestions)
					}
					// Update followupAutoApproveTimeoutMs if present in state message
					if ((newState as any).followupAutoApproveTimeoutMs !== undefined) {
						setFollowupAutoApproveTimeoutMs((newState as any).followupAutoApproveTimeoutMs)
					}
					// Update includeTaskHistoryInEnhance if present in state message
					if ((newState as any).includeTaskHistoryInEnhance !== undefined) {
						setIncludeTaskHistoryInEnhance((newState as any).includeTaskHistoryInEnhance)
					}
					// Update includeCurrentTime if present in state message
					if ((newState as any).includeCurrentTime !== undefined) {
						setIncludeCurrentTime((newState as any).includeCurrentTime)
					}
					// Update includeCurrentCost if present in state message
					if ((newState as any).includeCurrentCost !== undefined) {
						setIncludeCurrentCost((newState as any).includeCurrentCost)
					}
					// Handle marketplace data if present in state message
					if (newState.marketplaceItems !== undefined) {
						setMarketplaceItems(newState.marketplaceItems)
					}
					if (newState.marketplaceInstalledMetadata !== undefined) {
						setMarketplaceInstalledMetadata(newState.marketplaceInstalledMetadata)
					}
					break
				}
				case "action": {
					if (message.action === "toggleAutoApprove") {
						// Toggle the auto-approval state
						setState((prevState) => {
							const newValue = !(prevState.autoApprovalEnabled ?? false)
							// Also send the update to the extension
							vscode.postMessage({ type: "autoApprovalEnabled", bool: newValue })
							return { ...prevState, autoApprovalEnabled: newValue }
						})
					}
					break
				}
				case "theme": {
					if (message.text) {
						setTheme(convertTextMateToHljs(JSON.parse(message.text)))
					}
					break
				}
				case "workspaceUpdated": {
					const paths = message.filePaths ?? []
					const tabs = message.openedTabs ?? []

					setFilePaths(paths)
					setOpenedTabs(tabs)
					break
				}
				case "commands": {
					setCommands(message.commands ?? [])
					break
				}
				case "messageUpdated": {
					const shoferMessage = message.shoferMessage!
					setState((prevState) => {
						// worth noting it will never be possible for a more up-to-date message to be sent here or in normal messages post since the presentAssistantContent function uses lock
						const lastIndex = findLastIndex(prevState.shoferMessages, (msg) => msg.ts === shoferMessage.ts)
						if (lastIndex !== -1) {
							const newShoferMessages = [...prevState.shoferMessages]
							newShoferMessages[lastIndex] = shoferMessage
							return { ...prevState, shoferMessages: newShoferMessages }
						}
						// Log a warning if messageUpdated arrives for a timestamp not in the
						// frontend's shoferMessages. With the seq guard and cloud event isolation
						// (layers 1+2), this should not happen under normal conditions. If it
						// does, it signals a state synchronization issue worth investigating.
						console.warn(
							`[messageUpdated] Received update for unknown message ts=${shoferMessage.ts}, dropping. ` +
								`Frontend has ${prevState.shoferMessages.length} messages.`,
						)
						return prevState
					})
					break
				}
				case "skills": {
					console.log(
						"[ExtensionStateContext] received 'skills' message. loadedSkills:",
						message.loadedSkills,
					)
					if (message.skills) {
						setSkills(message.skills)
					}
					if (message.loadedSkills) {
						setLoadedSkills(message.loadedSkills)
					}
					break
				}
				case "mcpServers": {
					setMcpServers(message.mcpServers ?? [])
					break
				}
				case "currentCheckpointUpdated": {
					setCurrentCheckpoint(message.text)
					break
				}
				case "listApiConfig": {
					setListApiConfigMeta(message.listApiConfig ?? [])
					break
				}
				case "routerModels": {
					setExtensionRouterModels(message.routerModels)
					break
				}
				case "vsCodeLmModels": {
					setVsCodeLmModels(message.vsCodeLmModels ?? [])
					break
				}
				case "marketplaceData": {
					if (message.marketplaceItems !== undefined) {
						setMarketplaceItems(message.marketplaceItems)
					}
					if (message.marketplaceInstalledMetadata !== undefined) {
						setMarketplaceInstalledMetadata(message.marketplaceInstalledMetadata)
					}
					break
				}
				case "taskHistoryUpdated": {
					// Efficiently update just the task history without replacing entire state
					if (message.taskHistory !== undefined) {
						setState((prevState) => ({
							...prevState,
							taskHistory: message.taskHistory!,
						}))
					}
					break
				}
				case "taskHistoryItemUpdated": {
					const item = message.taskHistoryItem
					if (!item) {
						break
					}
					console.log(`[DIAG-WEBVIEW-RX] id=${item.id} status=${item.taskExecutionState}`)
					setState((prevState) => {
						const existingIndex = prevState.taskHistory.findIndex((h) => h.id === item.id)
						let nextHistory: typeof prevState.taskHistory
						if (existingIndex === -1) {
							nextHistory = [item, ...prevState.taskHistory]
						} else {
							nextHistory = [...prevState.taskHistory]
							nextHistory[existingIndex] = item
						}
						// Keep UI semantics consistent with extension: newest-first ordering.
						nextHistory.sort((a, b) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts))
						return {
							...prevState,
							taskHistory: nextHistory,
							currentTaskItem:
								prevState.currentTaskItem?.id === item.id ? item : prevState.currentTaskItem,
						}
					})
					break
				}
				case "parallelTasksUpdated": {
					if (message.parallelTasks) {
						setState((prevState) => ({
							...prevState,
							parallelTasks: message.parallelTasks!,
							// Use focusedTaskId from backend if provided, otherwise keep current
							focusedTaskId:
								message.focusedTaskId !== undefined
									? message.focusedTaskId
									: message.parallelTasks!.length > 0
										? prevState.focusedTaskId
										: null,
						}))
					}
					break
				}
				case "taskNotification": {
					if (message.notification) {
						setState((prevState) => ({
							...prevState,
							taskNotifications: [
								...(prevState.taskNotifications ?? []).filter(
									(n) =>
										!(
											n.taskId === message.notification!.taskId &&
											n.type === message.notification!.type
										),
								),
								message.notification!,
							],
						}))
					}
					break
				}
				case "taskNotificationCleared": {
					setState((prevState) => ({
						...prevState,
						taskNotifications: (prevState.taskNotifications ?? []).filter(
							(n) => n.taskId !== message.taskId,
						),
						...(message.parallelTasks && { parallelTasks: message.parallelTasks }),
					}))
					break
				}
			}
		},
		[setListApiConfigMeta, state.apiConfiguration?.apiProvider],
	)

	useEffect(() => {
		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [handleMessage])

	// Only send webviewDidLaunch once on mount. Re-sending it causes the
	// extension host to push a full state snapshot (postStateToWebview),
	// which overwrites any unsaved local apiConfiguration edits — including
	// provider selections made in the WelcomeView dropdown.
	useEffect(() => {
		vscode.postMessage({ type: "webviewDidLaunch" })
	}, [])

	// Proactively request VS Code LM models so the dynamic list is
	// available before the user opens settings or starts a chat with
	// a vscode-lm model. Without this, vsCodeLmModels stays empty
	// until the settings panel sends its own requestVsCodeLmModels.
	useEffect(() => {
		if (state.apiConfiguration?.apiProvider === "vscode-lm") {
			vscode.postMessage({ type: "requestVsCodeLmModels" })
		}
	}, [state.apiConfiguration?.apiProvider])

	// Watch for authentication state changes and refresh Shofer models
	useEffect(() => {
		const currentAuth = state.cloudIsAuthenticated ?? false
		const currentProvider = state.apiConfiguration?.apiProvider
		if (!prevCloudIsAuthenticated && currentAuth && currentProvider === "shofer") {
			// User just authenticated and Shofer is the active provider - refresh Shofer models
			vscode.postMessage({ type: "requestRooModels" })
		}
		setPrevCloudIsAuthenticated(currentAuth)
	}, [state.cloudIsAuthenticated, prevCloudIsAuthenticated, state.apiConfiguration?.apiProvider])

	const contextValue: ExtensionStateContextType = {
		...state,
		reasoningBlockCollapsed: state.reasoningBlockCollapsed ?? true,
		didHydrateState,
		showWelcome,
		theme,
		mcpServers,
		currentCheckpoint,
		filePaths,
		openedTabs,
		commands,
		soundVolume: state.soundVolume,
		ttsSpeed: state.ttsSpeed,
		writeDelayMs: state.writeDelayMs,
		routerModels: extensionRouterModels,
		vsCodeLmModels,
		cloudIsAuthenticated: state.cloudIsAuthenticated ?? false,
		cloudOrganizations: state.cloudOrganizations ?? [],
		organizationSettingsVersion: state.organizationSettingsVersion ?? -1,
		marketplaceItems,
		marketplaceInstalledMetadata,
		profileThresholds: state.profileThresholds ?? {},
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		taskSyncEnabled: state.taskSyncEnabled,
		setExperimentEnabled: (id, enabled) =>
			setState((prevState) => ({ ...prevState, experiments: { ...prevState.experiments, [id]: enabled } })),
		setApiConfiguration,
		setCustomInstructions: (value) => setState((prevState) => ({ ...prevState, customInstructions: value })),
		setAlwaysAllowReadOnly: (value) => setState((prevState) => ({ ...prevState, alwaysAllowReadOnly: value })),
		setAlwaysAllowReadOnlyOutsideWorkspace: (value) =>
			setState((prevState) => ({ ...prevState, alwaysAllowReadOnlyOutsideWorkspace: value })),
		setAlwaysAllowWrite: (value) => setState((prevState) => ({ ...prevState, alwaysAllowWrite: value })),
		setAlwaysAllowWriteOutsideWorkspace: (value) =>
			setState((prevState) => ({ ...prevState, alwaysAllowWriteOutsideWorkspace: value })),
		setAlwaysAllowBrowser: (value) => setState((prevState) => ({ ...prevState, alwaysAllowBrowser: value })),
		setAlwaysAllowExecute: (value) => setState((prevState) => ({ ...prevState, alwaysAllowExecute: value })),
		setAlwaysAllowMcp: (value) => setState((prevState) => ({ ...prevState, alwaysAllowMcp: value })),
		setAlwaysAllowUncategorized: (value) =>
			setState((prevState) => ({ ...prevState, alwaysAllowUncategorized: value })),
		setAlwaysAllowModeSwitch: (value) => setState((prevState) => ({ ...prevState, alwaysAllowModeSwitch: value })),
		setAlwaysAllowSubtasks: (value) => setState((prevState) => ({ ...prevState, alwaysAllowSubtasks: value })),
		setAlwaysAllowFollowupQuestions,
		setFollowupAutoApproveTimeoutMs: (value) =>
			setState((prevState) => ({ ...prevState, followupAutoApproveTimeoutMs: value })),
		setShowAnnouncement: (value) => setState((prevState) => ({ ...prevState, shouldShowAnnouncement: value })),
		setAllowedCommands: (value) => setState((prevState) => ({ ...prevState, allowedCommands: value })),
		setDeniedCommands: (value) => setState((prevState) => ({ ...prevState, deniedCommands: value })),
		setAllowedMaxRequests: (value) => setState((prevState) => ({ ...prevState, allowedMaxRequests: value })),
		setAllowedMaxCost: (value) => setState((prevState) => ({ ...prevState, allowedMaxCost: value })),
		setSoundEnabled: (value) => setState((prevState) => ({ ...prevState, soundEnabled: value })),
		setSoundVolume: (value) => setState((prevState) => ({ ...prevState, soundVolume: value })),
		setTtsEnabled: (value) => setState((prevState) => ({ ...prevState, ttsEnabled: value })),
		setTtsSpeed: (value) => setState((prevState) => ({ ...prevState, ttsSpeed: value })),
		setEnableCheckpoints: (value) => setState((prevState) => ({ ...prevState, enableCheckpoints: value })),
		setCheckpointTimeout: (value) => setState((prevState) => ({ ...prevState, checkpointTimeout: value })),
		setWriteDelayMs: (value) => setState((prevState) => ({ ...prevState, writeDelayMs: value })),
		setTerminalOutputPreviewSize: (value) =>
			setState((prevState) => ({ ...prevState, terminalOutputPreviewSize: value })),
		setTerminalShellIntegrationTimeout: (value) =>
			setState((prevState) => ({ ...prevState, terminalShellIntegrationTimeout: value })),
		setTerminalShellIntegrationDisabled: (value) =>
			setState((prevState) => ({ ...prevState, terminalShellIntegrationDisabled: value })),
		setTerminalZdotdir: (value) => setState((prevState) => ({ ...prevState, terminalZdotdir: value })),
		setMcpEnabled: (value) => setState((prevState) => ({ ...prevState, mcpEnabled: value })),
		setTaskSyncEnabled: (value) => setState((prevState) => ({ ...prevState, taskSyncEnabled: value }) as any),
		setCurrentApiConfigName: (value) => setState((prevState) => ({ ...prevState, currentApiConfigName: value })),
		setListApiConfigMeta,
		setMode: (value: Mode) => setState((prevState) => ({ ...prevState, mode: value })),
		setCustomModePrompts: (value) => setState((prevState) => ({ ...prevState, customModePrompts: value })),
		setCustomSupportPrompts: (value) => setState((prevState) => ({ ...prevState, customSupportPrompts: value })),
		setEnhancementApiConfigId: (value) =>
			setState((prevState) => ({ ...prevState, enhancementApiConfigId: value })),
		setAutoApprovalEnabled: (value) => setState((prevState) => ({ ...prevState, autoApprovalEnabled: value })),
		setCustomModes: (value) => setState((prevState) => ({ ...prevState, customModes: value })),
		setMaxOpenTabsContext: (value) => setState((prevState) => ({ ...prevState, maxOpenTabsContext: value })),
		setMaxWorkspaceFiles: (value) => setState((prevState) => ({ ...prevState, maxWorkspaceFiles: value })),
		setTelemetrySetting: (value) => setState((prevState) => ({ ...prevState, telemetrySetting: value })),
		setShowShoferIgnoredFiles: (value) =>
			setState((prevState) => ({ ...prevState, showShoferIgnoredFiles: value })),
		setEnableSubfolderRules: (value) => setState((prevState) => ({ ...prevState, enableSubfolderRules: value })),
		setAwsUsePromptCache: (value) => setState((prevState) => ({ ...prevState, awsUsePromptCache: value })),
		setMaxImageFileSize: (value) => setState((prevState) => ({ ...prevState, maxImageFileSize: value })),
		setMaxTotalImageSize: (value) => setState((prevState) => ({ ...prevState, maxTotalImageSize: value })),
		setPinnedApiConfigs: (value) => setState((prevState) => ({ ...prevState, pinnedApiConfigs: value })),
		togglePinnedApiConfig: (configId) =>
			setState((prevState) => {
				const currentPinned = prevState.pinnedApiConfigs || {}
				const newPinned = {
					...currentPinned,
					[configId]: !currentPinned[configId],
				}

				// If the config is now unpinned, remove it from the object
				if (!newPinned[configId]) {
					delete newPinned[configId]
				}

				return { ...prevState, pinnedApiConfigs: newPinned }
			}),
		setHistoryPreviewCollapsed: (value) =>
			setState((prevState) => ({ ...prevState, historyPreviewCollapsed: value })),
		setReasoningBlockCollapsed: (value) =>
			setState((prevState) => ({ ...prevState, reasoningBlockCollapsed: value })),
		enterBehavior: state.enterBehavior ?? "send",
		setEnterBehavior: (value) => setState((prevState) => ({ ...prevState, enterBehavior: value })),
		setHasOpenedModeSelector: (value) => setState((prevState) => ({ ...prevState, hasOpenedModeSelector: value })),
		setAutoCondenseContext: (value) => setState((prevState) => ({ ...prevState, autoCondenseContext: value })),
		setAutoCondenseContextPercent: (value) =>
			setState((prevState) => ({ ...prevState, autoCondenseContextPercent: value })),
		setProfileThresholds: (value) => setState((prevState) => ({ ...prevState, profileThresholds: value })),
		includeDiagnosticMessages: state.includeDiagnosticMessages,
		setIncludeDiagnosticMessages: (value) => {
			setState((prevState) => ({ ...prevState, includeDiagnosticMessages: value }))
		},
		maxDiagnosticMessages: state.maxDiagnosticMessages,
		setMaxDiagnosticMessages: (value) => {
			setState((prevState) => ({ ...prevState, maxDiagnosticMessages: value }))
		},
		includeTaskHistoryInEnhance,
		setIncludeTaskHistoryInEnhance,
		pendingWorktreeDir,
		setPendingWorktreeDir,
		includeCurrentTime,
		setIncludeCurrentTime,
		includeCurrentCost,
		setIncludeCurrentCost,
		skills,
		loadedSkills,
		// Parallel task management
		parallelTasks: state.parallelTasks ?? [],
		focusedTaskId: state.focusedTaskId ?? null,
		taskNotifications: (state.taskNotifications ?? []) as TaskNotification[],
	}

	return <ExtensionStateContext.Provider value={contextValue}>{children}</ExtensionStateContext.Provider>
}

export const useExtensionState = () => {
	const context = useContext(ExtensionStateContext)

	if (context === undefined) {
		throw new Error("useExtensionState must be used within an ExtensionStateContextProvider")
	}

	return context
}
