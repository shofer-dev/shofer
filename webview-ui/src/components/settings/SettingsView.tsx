import React, {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import {
	CheckCheck,
	GitBranch,
	Bell,
	MessageCircle,
	Archive,
	Database,
	SquareTerminal,
	FlaskConical,
	AlertTriangle,
	Globe,
	Info,
	MessageSquare,
	LucideIcon,
	SquareSlash,
	Glasses,
	Plug,
	Server,
	Users2,
	ArrowLeft,
	GitCommitVertical,
	GraduationCap,
	Wrench,
	ScrollText,
} from "lucide-react"

import {
	type ProviderSettings,
	type ExperimentId,
	type TelemetrySetting,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	ImageGenerationProvider,
} from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { ExtensionStateContextType, useExtensionState } from "@src/context/ExtensionStateContext"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogCancel,
	AlertDialogAction,
	AlertDialogHeader,
	AlertDialogFooter,
	Button,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	StandardTooltip,
} from "@src/components/ui"

import { Tab, TabContent, TabHeader, TabList, TabTrigger } from "../common/Tab"
import { SetCachedStateField, SetExperimentEnabled } from "./types"
import { SectionHeader } from "./SectionHeader"
import ApiConfigManager from "./ApiConfigManager"
import ApiOptions from "./ApiOptions"
import { AutoApproveSettings } from "./AutoApproveSettings"
import { CheckpointSettings } from "./CheckpointSettings"
import { NotificationSettings } from "./NotificationSettings"
import { AssistantAgentSettings } from "./AssistantAgentSettings"
import { ContextManagementSettings } from "./ContextManagementSettings"
import { TerminalSettings } from "./TerminalSettings"
import { ExperimentalSettings } from "./ExperimentalSettings"
import { LanguageSettings } from "./LanguageSettings"
import { About } from "./About"
import { Section } from "./Section"
import { LoggingSettings } from "./LoggingSettings"
import PromptsSettings from "./PromptsSettings"
import { SlashCommandsSettings } from "./SlashCommandsSettings"
import { SkillsSettings } from "./SkillsSettings"
import { ToolsSettings, type ToolsSettingsRef } from "./ToolsSettings"
import { UISettings } from "./UISettings"
import ModesView, { type ModesViewRef } from "../modes/ModesView"
import McpView from "../mcp/McpView"
import { WorktreesView } from "../worktrees/WorktreesView"
import { SettingsSearch } from "./SettingsSearch"
import { useSearchIndexRegistry, SearchIndexProvider } from "./useSettingsSearch"
import { RagIndexerSettings, type RagIndexerSettingsRef } from "./RagIndexerSettings"

export const settingsTabsContainer = "flex flex-1 overflow-hidden [&.narrow_.tab-label]:hidden"
export const settingsTabList =
	"w-48 data-[compact=true]:w-12 flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden border-r border-vscode-sideBar-background"
export const settingsTabTrigger =
	"whitespace-nowrap overflow-hidden min-w-0 h-12 px-4 py-3 box-border flex items-center border-l-2 border-transparent text-vscode-foreground opacity-70 hover:bg-vscode-list-hoverBackground data-[compact=true]:w-12 data-[compact=true]:p-4"
export const settingsTabTriggerActive = "opacity-100 border-vscode-focusBorder bg-vscode-list-activeSelectionBackground"

export interface SettingsViewRef {
	checkUnsaveChanges: (then: () => void) => void
}

export const sectionNames = [
	"providers",
	"autoApprove",
	"tools",
	"slashCommands",
	"skills",
	"checkpoints",
	"notifications",
	"assistantAgent",
	"contextManagement",
	"terminal",
	"codebaseIndex",
	"modes",
	"mcp",
	"worktrees",
	"prompts",
	"ui",
	"experimental",
	"language",
	"logging",
	"about",
] as const

export type SectionName = (typeof sectionNames)[number]

type SettingsViewProps = {
	onDone: () => void
	targetSection?: string
}

const SettingsView = forwardRef<SettingsViewRef, SettingsViewProps>(({ onDone, targetSection }, ref) => {
	const { t } = useAppTranslation()

	const extensionState = useExtensionState()
	const { currentApiConfigName, listApiConfigMeta, uriScheme, settingsImportedAt } = extensionState

	const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
	const [isChangeDetected, setChangeDetected] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
	const [activeTab, setActiveTab] = useState<SectionName>(
		targetSection && sectionNames.includes(targetSection as SectionName)
			? (targetSection as SectionName)
			: "providers",
	)

	const scrollPositions = useRef<Record<SectionName, number>>(
		Object.fromEntries(sectionNames.map((s) => [s, 0])) as Record<SectionName, number>,
	)
	const contentRef = useRef<HTMLDivElement | null>(null)

	// editingConfigName tracks which config the user is currently editing.
	// It is separate from currentApiConfigName (the global default).
	// Changing the edit dropdown does NOT change the global default.
	const [editingConfigName, setEditingConfigName] = useState<string>(currentApiConfigName || "default")

	// pendingDefaultConfigName is a local buffer for the Default Configuration
	// dropdown. Changes are staged here and only persisted when Save is clicked.
	// This decouples the dropdown from the live host-side currentApiConfigName
	// so the user can change the default without an immediate side-effect.
	const [pendingDefaultConfigName, setPendingDefaultConfigName] = useState<string>(currentApiConfigName || "")

	// Tracks whether a Save that includes a pendingDefaultConfigName change is
	// in flight.  While true the re-sync useEffect below skips reverting the
	// buffer to the stale currentApiConfigName, suppressing the new→old→new
	// flicker between setChangeDetected(false) and the host round-trip.
	const savingDefault = useRef(false)

	const _prevApiConfigName = useRef(currentApiConfigName)
	const confirmDialogHandler = useRef<() => void>()
	// Imperative handle to ModesView so the Save / Discard flow can commit or drop
	// the per-mode text buffers it holds internally (see ModesView.commitBuffers
	// for why those buffers are not folded into SettingsView's cachedState).
	const modesViewRef = useRef<ModesViewRef>(null)
	const toolsSettingsRef = useRef<ToolsSettingsRef>(null)
	const ragIndexerRef = useRef<RagIndexerSettingsRef>(null)

	const [cachedState, setCachedState] = useState(() => extensionState)

	const {
		autoApprovalEnabled,
		alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace,
		allowedCommands,
		deniedCommands,
		allowedMaxRequests,
		allowedMaxCost,
		language,
		alwaysAllowExecute,
		alwaysAllowMcp,
		alwaysAllowUncategorized,
		alwaysAllowModeSwitch,
		alwaysAllowSubtasks,
		alwaysAllowWrite,
		alwaysAllowBrowser,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		autoCondenseContext,
		autoCondenseContextPercent,
		enableCheckpoints,
		checkpointTimeout,
		disabledTools,
		experiments,
		maxOpenTabsContext,
		maxWorkspaceFiles,
		mcpEnabled,
		soundEnabled,
		ttsEnabled,
		ttsSpeed,
		soundVolume,
		telemetrySetting,
		terminalOutputPreviewSize,
		terminalShellIntegrationTimeout,
		terminalShellIntegrationDisabled, // Added from upstream
		terminalCommandDelay,
		terminalPowershellCounter,
		terminalZshClearEolMark,
		terminalZshOhMy,
		terminalZshP10k,
		terminalZdotdir,
		writeDelayMs,
		showShoferIgnoredFiles,
		enableSubfolderRules,
		useAgentRules,
		maxImageFileSize,
		maxTotalImageSize,
		customSupportPrompts,
		profileThresholds,
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		includeDiagnosticMessages,
		maxDiagnosticMessages,
		includeTaskHistoryInEnhance,
		enhancementApiConfigId,
		imageGenerationProvider,
		openRouterImageApiKey,
		openRouterImageGenerationSelectedModel,
		reasoningBlockCollapsed,
		enterBehavior,
		includeCurrentTime,
		includeCurrentCost,
		maxGitStatusFiles,
		defaultCostLimit,
		archivedTaskRetentionDays,
		assistantAgentEnabled,
		assistantAgentApiConfigId,
		assistantAgentMaxContextTokens,
		assistantAgentContextFillThreshold,
		codebaseIndexConfig,
		logLevel,
		logCategories,
	} = cachedState

	const apiConfiguration = useMemo(() => cachedState.apiConfiguration ?? {}, [cachedState.apiConfiguration])

	// Sync cachedState + editingConfigName when the host pushes a new
	// apiConfiguration. The host can change apiConfiguration independently
	// of currentApiConfigName (via loadApiConfigurationForEdit), so we
	// track the incoming apiConfiguration shape as a fingerprint.
	const apiConfigFingerprint = useRef<string>("")

	useEffect(() => {
		const fp = JSON.stringify(extensionState.apiConfiguration ?? {})
		if (apiConfigFingerprint.current === fp) {
			return
		}
		apiConfigFingerprint.current = fp
		setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
		setChangeDetected(false)
	}, [extensionState])

	// Bust the cache when settings are imported.
	useEffect(() => {
		if (settingsImportedAt) {
			setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
			setChangeDetected(false)
		}
	}, [settingsImportedAt, extensionState])

	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = useCallback((field, value) => {
		setCachedState((prevState) => {
			if (prevState[field] === value) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, [field]: value }
		})
	}, [])

	const setApiConfigurationField = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K], isUserAction: boolean = true) => {
			setCachedState((prevState) => {
				if (prevState.apiConfiguration?.[field] === value) {
					return prevState
				}

				const previousValue = prevState.apiConfiguration?.[field]

				// Helper to check if two values are semantically equal
				const areValuesEqual = (a: any, b: any): boolean => {
					if (a === b) return true
					if (a == null && b == null) return true
					if (typeof a !== typeof b) return false
					if (typeof a === "object" && typeof b === "object") {
						return JSON.stringify(a) === JSON.stringify(b)
					}
					return false
				}

				// Only skip change detection for automatic initialization (not user actions)
				// This prevents the dirty state when the component initializes and auto-syncs values
				const isInitialSync =
					!isUserAction &&
					(previousValue === undefined || previousValue === "" || previousValue === null) &&
					value !== undefined &&
					value !== "" &&
					value !== null

				// Also skip if it's an automatic sync with semantically equal values
				const isAutomaticNoOpSync = !isUserAction && areValuesEqual(previousValue, value)

				if (!isInitialSync && !isAutomaticNoOpSync) {
					setChangeDetected(true)
				}
				return { ...prevState, apiConfiguration: { ...prevState.apiConfiguration, [field]: value } }
			})
		},
		[],
	)

	const setExperimentEnabled: SetExperimentEnabled = useCallback((id: ExperimentId, enabled: boolean) => {
		setCachedState((prevState) => {
			if (prevState.experiments?.[id] === enabled) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, experiments: { ...prevState.experiments, [id]: enabled } }
		})
	}, [])

	const setTelemetrySetting = useCallback((setting: TelemetrySetting) => {
		setCachedState((prevState) => {
			if (prevState.telemetrySetting === setting) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, telemetrySetting: setting }
		})
	}, [])

	const setDebug = useCallback((debug: boolean) => {
		setCachedState((prevState) => {
			if (prevState.debug === debug) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, debug }
		})
	}, [])

	const setImageGenerationProvider = useCallback((provider: ImageGenerationProvider) => {
		setCachedState((prevState) => {
			if (prevState.imageGenerationProvider !== provider) {
				setChangeDetected(true)
			}

			return { ...prevState, imageGenerationProvider: provider }
		})
	}, [])

	const setOpenRouterImageApiKey = useCallback((apiKey: string) => {
		setCachedState((prevState) => {
			if (prevState.openRouterImageApiKey !== apiKey) {
				setChangeDetected(true)
			}

			return { ...prevState, openRouterImageApiKey: apiKey }
		})
	}, [])

	const setImageGenerationSelectedModel = useCallback((model: string) => {
		setCachedState((prevState) => {
			if (prevState.openRouterImageGenerationSelectedModel !== model) {
				setChangeDetected(true)
			}

			return { ...prevState, openRouterImageGenerationSelectedModel: model }
		})
	}, [])

	const setCustomSupportPromptsField = useCallback((prompts: Record<string, string | undefined>) => {
		setCachedState((prevState) => {
			const previousStr = JSON.stringify(prevState.customSupportPrompts)
			const newStr = JSON.stringify(prompts)

			if (previousStr === newStr) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, customSupportPrompts: prompts }
		})
	}, [])

	const isSettingValid = !errorMessage

	const handleSubmit = () => {
		if (isSettingValid) {
			vscode.postMessage({
				type: "updateSettings",
				updatedSettings: {
					language,
					autoApprovalEnabled: autoApprovalEnabled ?? false,
					alwaysAllowReadOnly: alwaysAllowReadOnly ?? undefined,
					alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? undefined,
					alwaysAllowWrite: alwaysAllowWrite ?? undefined,
					alwaysAllowBrowser: alwaysAllowBrowser ?? undefined,
					alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? undefined,
					alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? undefined,
					alwaysAllowExecute: alwaysAllowExecute ?? undefined,
					alwaysAllowMcp,
					alwaysAllowUncategorized,
					alwaysAllowModeSwitch,
					allowedCommands: allowedCommands ?? [],
					deniedCommands: deniedCommands ?? [],
					// Note that we use `null` instead of `undefined` since `JSON.stringify`
					// will omit `undefined` when serializing the object and passing it to the
					// extension host. We may need to do the same for other nullable fields.
					allowedMaxRequests: allowedMaxRequests ?? null,
					allowedMaxCost: allowedMaxCost ?? null,
					autoCondenseContext,
					autoCondenseContextPercent,
					soundEnabled: soundEnabled ?? true,
					soundVolume: soundVolume ?? 0.5,
					ttsEnabled,
					ttsSpeed,
					enableCheckpoints: enableCheckpoints ?? false,
					checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
					writeDelayMs,
					terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? 30_000,
					terminalShellIntegrationDisabled,
					terminalCommandDelay,
					terminalPowershellCounter,
					terminalZshClearEolMark,
					terminalZshOhMy,
					terminalZshP10k,
					terminalZdotdir,
					terminalOutputPreviewSize: terminalOutputPreviewSize ?? "medium",
					mcpEnabled,
					maxOpenTabsContext: Math.min(Math.max(0, maxOpenTabsContext ?? 20), 500),
					maxWorkspaceFiles: Math.min(Math.max(0, maxWorkspaceFiles ?? 200), 500),
					showShoferIgnoredFiles: showShoferIgnoredFiles ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					useAgentRules: useAgentRules ?? true,
					maxImageFileSize: maxImageFileSize ?? 5,
					maxTotalImageSize: maxTotalImageSize ?? 20,
					includeDiagnosticMessages:
						includeDiagnosticMessages !== undefined ? includeDiagnosticMessages : true,
					maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
					alwaysAllowSubtasks,
					alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
					followupAutoApproveTimeoutMs,
					includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
					enhancementApiConfigId: enhancementApiConfigId ?? "",
					reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
					enterBehavior: enterBehavior ?? "send",
					includeCurrentTime: includeCurrentTime ?? true,
					includeCurrentCost: includeCurrentCost ?? true,
					maxGitStatusFiles: maxGitStatusFiles ?? 0,
					defaultCostLimit: defaultCostLimit ?? null,
					archivedTaskRetentionDays: archivedTaskRetentionDays ?? null,
					profileThresholds,
					imageGenerationProvider,
					openRouterImageApiKey,
					openRouterImageGenerationSelectedModel,
					experiments,
					customSupportPrompts,
					disabledTools: disabledTools ?? [],
					assistantAgentEnabled: assistantAgentEnabled ?? true,
					assistantAgentApiConfigId: assistantAgentApiConfigId ?? "",
					assistantAgentMaxContextTokens: assistantAgentMaxContextTokens,
					assistantAgentContextFillThreshold: assistantAgentContextFillThreshold,
					codebaseIndexConfig,
					logLevel,
					logCategories,
				},
			})

			// Save the edited configuration under the editing config name,
			// NOT the global default. The Default dropdown controls currentApiConfigName.
			// activate=true when saving the currently-active default profile so
			// the live contextProxy settings and running task API handlers are
			// refreshed. activate=false when saving a different profile so the
			// global default is not clobbered.
			const activate = editingConfigName === currentApiConfigName
			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: editingConfigName,
				apiConfiguration,
				bool: activate,
			})

			// Persist the pending default config name (if changed) so the Save
			// button applies the Default Configuration dropdown selection.
			// This is the ONLY writer of currentApiConfigName from the Settings view.
			if (pendingDefaultConfigName && pendingDefaultConfigName !== currentApiConfigName) {
				savingDefault.current = true
				vscode.postMessage({ type: "setDefaultApiConfiguration", text: pendingDefaultConfigName })
			}
			vscode.postMessage({ type: "telemetrySetting", text: telemetrySetting })
			vscode.postMessage({ type: "debugSetting", bool: cachedState.debug })

			// Commit buffered Modes-tab text edits (role/description/whenToUse/customInstructions
			// per mode + global customInstructions) — these are held inside ModesView per the
			// AGENTS.md "Settings View Pattern" and only persisted on Save.
			modesViewRef.current?.commitBuffers()

			// Apply staged MCP per-tool enable/disable changes (Tools tab).
			toolsSettingsRef.current?.commitToolBuffers()

			// Flush code-index secret fields (API keys) that are managed
			// inside CodeIndexConfigForm via its own atomic-save path.
			ragIndexerRef.current?.saveCodeIndexSecrets()

			setChangeDetected(false)
		}
	}

	const checkUnsaveChanges = useCallback(
		(then: () => void) => {
			if (isChangeDetected) {
				confirmDialogHandler.current = then
				setDiscardDialogShow(true)
			} else {
				then()
			}
		},
		[isChangeDetected],
	)

	useImperativeHandle(ref, () => ({ checkUnsaveChanges }), [checkUnsaveChanges])

	const onConfirmDialogResult = useCallback(
		(confirm: boolean) => {
			if (confirm) {
				// Discard changes: Reset state and flag
				setCachedState(extensionState) // Revert to original state
				setChangeDetected(false) // Reset change flag
				// Reset the buffered default config name so a previously-
				// discarded dropdown selection doesn't leak into a later Save.
				setPendingDefaultConfigName(currentApiConfigName || "")
				// Also drop any per-mode text buffers held inside ModesView.
				modesViewRef.current?.discardBuffers()
				toolsSettingsRef.current?.discardToolBuffers()
				confirmDialogHandler.current?.() // Execute the pending action (e.g., tab switch)
			}
			// If confirm is false (Cancel), do nothing, dialog closes automatically
		},
		[extensionState, currentApiConfigName], // Sync with live default name
	)

	// Re-sync the default-config buffer when the host pushes a new value
	// (e.g. another window changed it, or the host confirmed our Save).
	// Only sync when the form is NOT dirty so we don't clobber a pending
	// user selection.  When a Save that changed the default is in flight
	// (savingDefault ref) we skip the sync — the stale currentApiConfigName
	// would flicker the dropdown before the host round-trip confirms it.
	useEffect(() => {
		if (savingDefault.current) {
			savingDefault.current = false
			return
		}
		if (!isChangeDetected && currentApiConfigName && currentApiConfigName !== pendingDefaultConfigName) {
			setPendingDefaultConfigName(currentApiConfigName)
		}
	}, [currentApiConfigName, isChangeDetected, pendingDefaultConfigName])

	// Handle tab changes with unsaved changes check
	const handleTabChange = useCallback(
		(newTab: SectionName) => {
			if (contentRef.current) {
				scrollPositions.current[activeTab] = contentRef.current.scrollTop
			}
			setActiveTab(newTab)
		},
		[activeTab],
	)

	useLayoutEffect(() => {
		if (contentRef.current) {
			contentRef.current.scrollTop = scrollPositions.current[activeTab] ?? 0
		}
	}, [activeTab])

	// Store direct DOM element refs for each tab
	const tabRefs = useRef<Record<SectionName, HTMLButtonElement | null>>(
		Object.fromEntries(sectionNames.map((name) => [name, null])) as Record<SectionName, HTMLButtonElement | null>,
	)

	// Track whether we're in compact mode
	const [isCompactMode, setIsCompactMode] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	// Setup resize observer to detect when we should switch to compact mode
	useEffect(() => {
		if (!containerRef.current) return

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				// If container width is less than 500px, switch to compact mode
				setIsCompactMode(entry.contentRect.width < 500)
			}
		})

		observer.observe(containerRef.current)

		return () => {
			observer?.disconnect()
		}
	}, [])

	const sections: { id: SectionName; icon: LucideIcon }[] = useMemo(
		() => [
			{ id: "providers", icon: Plug },
			{ id: "modes", icon: Users2 },
			{ id: "skills", icon: GraduationCap },
			{ id: "slashCommands", icon: SquareSlash },
			{ id: "autoApprove", icon: CheckCheck },
			{ id: "tools", icon: Wrench },
			{ id: "mcp", icon: Server },
			{ id: "checkpoints", icon: GitCommitVertical },
			{ id: "notifications", icon: Bell },
			{ id: "assistantAgent", icon: MessageCircle },
			{ id: "contextManagement", icon: Database },
			{ id: "terminal", icon: SquareTerminal },
			{ id: "codebaseIndex", icon: Archive },
			{ id: "prompts", icon: MessageSquare },
			{ id: "worktrees", icon: GitBranch },
			{ id: "ui", icon: Glasses },
			{ id: "experimental", icon: FlaskConical },
			{ id: "language", icon: Globe },
			{ id: "logging", icon: ScrollText },
			{ id: "about", icon: Info },
		],
		[], // No dependencies needed now
	)

	// Update target section logic to set active tab
	useEffect(() => {
		if (targetSection && sectionNames.includes(targetSection as SectionName)) {
			setActiveTab(targetSection as SectionName)
		}
	}, [targetSection])

	// Function to scroll the active tab into view for vertical layout
	const scrollToActiveTab = useCallback(() => {
		const activeTabElement = tabRefs.current[activeTab]

		if (activeTabElement) {
			activeTabElement.scrollIntoView({
				behavior: "auto",
				block: "nearest",
			})
		}
	}, [activeTab])

	// Effect to scroll when the active tab changes
	useEffect(() => {
		scrollToActiveTab()
	}, [activeTab, scrollToActiveTab])

	// Effect to scroll when the webview becomes visible
	useLayoutEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "action" && message.action === "didBecomeVisible") {
				scrollToActiveTab()
			}
		}

		window.addEventListener("message", handleMessage)

		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [scrollToActiveTab])

	// Search index registry - settings register themselves on mount
	const getSectionLabel = useCallback((section: SectionName) => t(`settings:sections.${section}`), [t])
	const { contextValue: searchContextValue, index: searchIndex } = useSearchIndexRegistry(getSectionLabel)

	// Track which tabs have been indexed (visited at least once)
	const [indexingTabIndex, setIndexingTabIndex] = useState(0)
	const initialTab = useRef<SectionName>(activeTab)
	const isIndexing = indexingTabIndex < sectionNames.length
	const isIndexingComplete = !isIndexing
	const tabTitlesRegistered = useRef(false)

	// Index all tabs by cycling through them on mount
	useLayoutEffect(() => {
		if (indexingTabIndex >= sectionNames.length) {
			// All tabs indexed, now register tab titles as searchable items
			if (!tabTitlesRegistered.current && searchContextValue) {
				sections.forEach(({ id }) => {
					const tabTitle = t(`settings:sections.${id}`)
					// Register each tab title as a searchable item
					// Using a special naming convention for tab titles: "tab-{sectionName}"
					searchContextValue.registerSetting({
						settingId: `tab-${id}`,
						section: id,
						label: tabTitle,
					})
				})
				tabTitlesRegistered.current = true
				// Return to initial tab
				setActiveTab(initialTab.current)
			}
			return
		}

		// Move to the next tab on next render
		setIndexingTabIndex((prev) => prev + 1)
	}, [indexingTabIndex, searchContextValue, sections, t])

	// Determine which tab content to render (for indexing or active display)
	const renderTab = isIndexing ? sectionNames[indexingTabIndex] : activeTab

	// Handle search navigation - switch to the correct tab and scroll to the element
	const handleSearchNavigate = useCallback(
		(section: SectionName, settingId: string) => {
			// Switch to the correct tab
			handleTabChange(section)

			// Wait for the tab to render, then find element by settingId and scroll to it
			requestAnimationFrame(() => {
				setTimeout(() => {
					const element = document.querySelector(`[data-setting-id="${settingId}"]`)
					if (element) {
						element.scrollIntoView({ behavior: "smooth", block: "center" })

						// Add highlight animation
						element.classList.add("settings-highlight")
						setTimeout(() => {
							element.classList.remove("settings-highlight")
						}, 1500)
					}
				}, 100) // Small delay to ensure tab content is rendered
			})
		},
		[handleTabChange],
	)

	return (
		<Tab>
			<TabHeader className="flex justify-between items-center gap-2">
				<div className="flex items-center gap-2 grow">
					<StandardTooltip content={t("settings:header.doneButtonTooltip")}>
						<Button variant="ghost" className="px-1.5 -ml-2" onClick={() => checkUnsaveChanges(onDone)}>
							<ArrowLeft />
							<span className="sr-only">{t("settings:common.done")}</span>
						</Button>
					</StandardTooltip>
					<h3 className="text-vscode-foreground m-0 flex-shrink-0">{t("settings:header.title")}</h3>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					{isIndexingComplete && (
						<SettingsSearch index={searchIndex} onNavigate={handleSearchNavigate} sections={sections} />
					)}
					<StandardTooltip
						content={
							!isSettingValid
								? errorMessage
								: isChangeDetected
									? t("settings:header.saveButtonTooltip")
									: t("settings:header.nothingChangedTooltip")
						}>
						<Button
							variant={isSettingValid ? "primary" : "secondary"}
							className={!isSettingValid ? "!border-vscode-errorForeground" : ""}
							onClick={handleSubmit}
							disabled={!isChangeDetected || !isSettingValid}
							data-testid="save-button">
							{t("settings:common.save")}
						</Button>
					</StandardTooltip>
				</div>
			</TabHeader>

			{/* Vertical tabs layout */}
			<div ref={containerRef} className={cn(settingsTabsContainer, isCompactMode && "narrow")}>
				{/* Tab sidebar */}
				<TabList
					value={activeTab}
					onValueChange={(value) => handleTabChange(value as SectionName)}
					className={cn(settingsTabList)}
					data-compact={isCompactMode}
					data-testid="settings-tab-list">
					{sections.map(({ id, icon: Icon }) => {
						const isSelected = id === activeTab
						const onSelect = () => handleTabChange(id)

						// Base TabTrigger component definition
						// We pass isSelected manually for styling, but onSelect is handled conditionally
						const triggerComponent = (
							<TabTrigger
								ref={(element) => (tabRefs.current[id] = element)}
								value={id}
								isSelected={isSelected} // Pass manually for styling state
								className={cn(
									isSelected // Use manual isSelected for styling
										? `${settingsTabTrigger} ${settingsTabTriggerActive}`
										: settingsTabTrigger,
									"cursor-pointer focus:ring-0", // Remove the focus ring styling
								)}
								data-testid={`tab-${id}`}
								data-compact={isCompactMode}>
								<div className={cn("flex items-center gap-2", isCompactMode && "justify-center")}>
									<Icon className="w-4 h-4" />
									<span className="tab-label">{t(`settings:sections.${id}`)}</span>
								</div>
							</TabTrigger>
						)

						if (isCompactMode) {
							// Wrap in Tooltip and manually add onClick to the trigger
							return (
								<TooltipProvider key={id} delayDuration={300}>
									<Tooltip>
										<TooltipTrigger asChild onClick={onSelect}>
											{/* Clone to avoid ref issues if triggerComponent itself had a key */}
											{React.cloneElement(triggerComponent)}
										</TooltipTrigger>
										<TooltipContent side="right" className="text-base">
											<p className="m-0">{t(`settings:sections.${id}`)}</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							)
						} else {
							// Render trigger directly; TabList will inject onSelect via cloning
							// Ensure the element passed to TabList has the key
							return React.cloneElement(triggerComponent, { key: id })
						}
					})}
				</TabList>

				{/* Content area - renders only the active tab (or indexing tab during initial indexing) */}
				<TabContent
					ref={contentRef}
					className={cn("p-0 flex-1 overflow-auto", isIndexing && "opacity-0")}
					data-testid="settings-content">
					<SearchIndexProvider value={searchContextValue}>
						{/* Providers Section */}
						{renderTab === "providers" && (
							<div>
								<SectionHeader>{t("settings:sections.providers")}</SectionHeader>

								<Section>
									<ApiConfigManager
										currentApiConfigName={pendingDefaultConfigName}
										editingConfigName={editingConfigName}
										listApiConfigMeta={listApiConfigMeta}
										onSelectConfigForEdit={(configName: string) => {
											// Commit the edit-target switch ONLY after the unsaved-changes
											// guard resolves. If editingConfigName were set before the guard
											// and the user then cancelled the discard dialog, the dropdown
											// would show the new profile while ApiOptions still held the old
											// profile's apiConfiguration — and a subsequent Save would write
											// the old data under the new profile's name (data corruption).
											checkUnsaveChanges(() => {
												setEditingConfigName(configName)
												vscode.postMessage({
													type: "loadApiConfigurationForEdit",
													text: configName,
												})
											})
										}}
										onSelectConfigAsDefault={(configName: string) => {
											// Buffer the selection locally — do NOT persist
											// immediately.  The new default is applied when the
											// user clicks the global Save button.
											setPendingDefaultConfigName(configName)
											setChangeDetected(true)
										}}
										onDeleteConfig={(configName: string) => {
											setEditingConfigName(currentApiConfigName || "default")
											vscode.postMessage({ type: "deleteApiConfiguration", text: configName })
										}}
										onRenameConfig={(oldName: string, newName: string) => {
											setEditingConfigName(newName)
											vscode.postMessage({
												type: "renameApiConfiguration",
												values: { oldName, newName },
												apiConfiguration,
											})
										}}
										onUpsertConfig={(configName: string) => {
											setEditingConfigName(configName)
											// upsertEditor backs this so settings stick before Save
											vscode.postMessage({
												type: "upsertApiConfiguration",
												text: configName,
												apiConfiguration,
											})
										}}
									/>
									<ApiOptions
										uriScheme={uriScheme}
										apiConfiguration={apiConfiguration}
										setApiConfigurationField={setApiConfigurationField}
										errorMessage={errorMessage}
										setErrorMessage={setErrorMessage}
									/>
								</Section>
							</div>
						)}

						{/* Auto-Approve Section */}
						{renderTab === "autoApprove" && (
							<AutoApproveSettings
								autoApprovalEnabled={autoApprovalEnabled}
								alwaysAllowReadOnly={alwaysAllowReadOnly}
								alwaysAllowReadOnlyOutsideWorkspace={alwaysAllowReadOnlyOutsideWorkspace}
								alwaysAllowWrite={alwaysAllowWrite}
								alwaysAllowBrowser={alwaysAllowBrowser}
								alwaysAllowWriteOutsideWorkspace={alwaysAllowWriteOutsideWorkspace}
								alwaysAllowWriteProtected={alwaysAllowWriteProtected}
								alwaysAllowMcp={alwaysAllowMcp}
								alwaysAllowUncategorized={alwaysAllowUncategorized}
								alwaysAllowModeSwitch={alwaysAllowModeSwitch}
								alwaysAllowSubtasks={alwaysAllowSubtasks}
								alwaysAllowExecute={alwaysAllowExecute}
								alwaysAllowFollowupQuestions={alwaysAllowFollowupQuestions}
								followupAutoApproveTimeoutMs={followupAutoApproveTimeoutMs}
								allowedCommands={allowedCommands}
								allowedMaxRequests={allowedMaxRequests ?? undefined}
								allowedMaxCost={allowedMaxCost ?? undefined}
								deniedCommands={deniedCommands}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Tools Section */}
						{renderTab === "tools" && (
							<ToolsSettings
								ref={toolsSettingsRef}
								onToolsDirty={() => setChangeDetected(true)}
								disabledTools={disabledTools}
								setCachedStateField={setCachedStateField}
								mcpServers={extensionState.mcpServers}
							/>
						)}

						{/* Slash Commands Section */}
						{renderTab === "slashCommands" && <SlashCommandsSettings />}

						{/* Skills Section */}
						{renderTab === "skills" && <SkillsSettings />}

						{/* Checkpoints Section */}
						{renderTab === "checkpoints" && (
							<CheckpointSettings
								enableCheckpoints={enableCheckpoints}
								checkpointTimeout={checkpointTimeout}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Notifications Section */}
						{renderTab === "notifications" && (
							<NotificationSettings
								ttsEnabled={ttsEnabled}
								ttsSpeed={ttsSpeed}
								soundEnabled={soundEnabled}
								soundVolume={soundVolume}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Assistant Agent Section */}
						{renderTab === "assistantAgent" && (
							<AssistantAgentSettings
								assistantAgentEnabled={assistantAgentEnabled}
								assistantAgentApiConfigId={assistantAgentApiConfigId}
								assistantAgentMaxContextTokens={assistantAgentMaxContextTokens}
								assistantAgentContextFillThreshold={assistantAgentContextFillThreshold}
								listApiConfigMeta={listApiConfigMeta ?? []}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Context Management Section */}
						{renderTab === "contextManagement" && (
							<ContextManagementSettings
								autoCondenseContext={autoCondenseContext}
								autoCondenseContextPercent={autoCondenseContextPercent}
								listApiConfigMeta={listApiConfigMeta ?? []}
								maxOpenTabsContext={maxOpenTabsContext}
								maxWorkspaceFiles={maxWorkspaceFiles ?? 200}
								showShoferIgnoredFiles={showShoferIgnoredFiles}
								enableSubfolderRules={enableSubfolderRules}
								useAgentRules={useAgentRules}
								maxImageFileSize={maxImageFileSize}
								maxTotalImageSize={maxTotalImageSize}
								profileThresholds={profileThresholds}
								includeDiagnosticMessages={includeDiagnosticMessages}
								maxDiagnosticMessages={maxDiagnosticMessages}
								writeDelayMs={writeDelayMs}
								includeCurrentTime={includeCurrentTime}
								includeCurrentCost={includeCurrentCost}
								maxGitStatusFiles={maxGitStatusFiles}
								defaultCostLimit={defaultCostLimit ?? undefined}
								customSupportPrompts={customSupportPrompts || {}}
								setCustomSupportPrompts={setCustomSupportPromptsField}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Terminal Section */}
						{renderTab === "terminal" && (
							<TerminalSettings
								terminalOutputPreviewSize={terminalOutputPreviewSize}
								terminalShellIntegrationTimeout={terminalShellIntegrationTimeout}
								terminalShellIntegrationDisabled={terminalShellIntegrationDisabled}
								terminalCommandDelay={terminalCommandDelay}
								terminalPowershellCounter={terminalPowershellCounter}
								terminalZshClearEolMark={terminalZshClearEolMark}
								terminalZshOhMy={terminalZshOhMy}
								terminalZshP10k={terminalZshP10k}
								terminalZdotdir={terminalZdotdir}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Codebase Index Section */}
						{renderTab === "codebaseIndex" && (
							<RagIndexerSettings
								ref={ragIndexerRef}
								codebaseIndexConfig={codebaseIndexConfig}
								setCachedStateField={setCachedStateField as any}
							/>
						)}

						{/* Modes Section */}
						{renderTab === "modes" && (
							<ModesView
								ref={modesViewRef}
								onModesDirty={() => setChangeDetected(true)}
								pendingDefaultConfigName={pendingDefaultConfigName}
								setPendingDefaultConfigName={setPendingDefaultConfigName}
							/>
						)}

						{/* MCP Section */}
						{renderTab === "mcp" && <McpView />}

						{/* Worktrees Section */}
						{renderTab === "worktrees" && <WorktreesView />}

						{/* Prompts Section */}
						{renderTab === "prompts" && (
							<PromptsSettings
								customSupportPrompts={customSupportPrompts || {}}
								setCustomSupportPrompts={setCustomSupportPromptsField}
								includeTaskHistoryInEnhance={includeTaskHistoryInEnhance}
								setIncludeTaskHistoryInEnhance={(value) =>
									setCachedStateField("includeTaskHistoryInEnhance", value)
								}
								enhancementApiConfigId={enhancementApiConfigId}
								setEnhancementApiConfigId={(value) =>
									setCachedStateField("enhancementApiConfigId", value)
								}
							/>
						)}

						{/* UI Section */}
						{renderTab === "ui" && (
							<UISettings
								reasoningBlockCollapsed={reasoningBlockCollapsed ?? true}
								enterBehavior={enterBehavior ?? "send"}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Advanced Section (internally still keyed "experimental") */}
						{renderTab === "experimental" && (
							<ExperimentalSettings
								setExperimentEnabled={setExperimentEnabled}
								experiments={experiments}
								apiConfiguration={apiConfiguration}
								setApiConfigurationField={setApiConfigurationField}
								archivedTaskRetentionDays={archivedTaskRetentionDays}
								setCachedStateField={setCachedStateField}
								imageGenerationProvider={imageGenerationProvider}
								openRouterImageApiKey={openRouterImageApiKey as string | undefined}
								openRouterImageGenerationSelectedModel={
									openRouterImageGenerationSelectedModel as string | undefined
								}
								setImageGenerationProvider={setImageGenerationProvider}
								setOpenRouterImageApiKey={setOpenRouterImageApiKey}
								setImageGenerationSelectedModel={setImageGenerationSelectedModel}
							/>
						)}

						{/* Language Section */}
						{renderTab === "language" && (
							<LanguageSettings language={language || "en"} setCachedStateField={setCachedStateField} />
						)}

						{/* Logging Section */}
						{renderTab === "logging" && (
							<LoggingSettings
								logLevel={logLevel as "debug" | "info" | "warn" | "error" | "fatal"}
								logCategories={logCategories as string[] | undefined}
								logCategoriesKnown={cachedState.logCategoriesKnown as string[] | undefined}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* About Section */}
						{renderTab === "about" && (
							<About
								telemetrySetting={telemetrySetting}
								setTelemetrySetting={setTelemetrySetting}
								debug={cachedState.debug}
								setDebug={setDebug}
							/>
						)}
					</SearchIndexProvider>
				</TabContent>
			</div>

			<AlertDialog open={isDiscardDialogShow} onOpenChange={setDiscardDialogShow}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<AlertTriangle className="w-5 h-5 text-yellow-500" />
							{t("settings:unsavedChangesDialog.title")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:unsavedChangesDialog.description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => onConfirmDialogResult(false)}>
							{t("settings:unsavedChangesDialog.cancelButton")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={() => onConfirmDialogResult(true)}>
							{t("settings:unsavedChangesDialog.discardButton")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Tab>
	)
})

export default memo(SettingsView)
