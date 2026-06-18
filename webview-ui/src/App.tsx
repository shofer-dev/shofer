import React, { useCallback, useEffect, useRef, useState, useMemo } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ExtensionMessage } from "@shofer/types"
import { getAllModes } from "@shofer/shared/modes"

import TranslationProvider from "./i18n/TranslationContext"

import { vscode } from "./utils/vscode"
import { telemetryClient } from "./utils/TelemetryClient"
import { initializeSourceMaps, exposeSourceMapsForDebugging } from "./utils/sourceMapInitializer"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import ChatView, { ChatViewRef } from "./components/chat/ChatView"
import WorkflowView, { WorkflowViewRef } from "./components/chat/WorkflowView"
import { TaskSelector } from "./components/chat/TaskSelector"
import HistoryView from "./components/history/HistoryView"
import SettingsView, { SettingsViewRef } from "./components/settings/SettingsView"
import WelcomeView from "./components/welcome/WelcomeViewProvider"
import { LauncherView } from "./components/launcher/LauncherView"
import { LauncherMenu } from "./components/launcher/LauncherMenu"
import { CheckpointRestoreDialog } from "./components/chat/CheckpointRestoreDialog"
import { DeleteMessageDialog, EditMessageDialog } from "./components/chat/MessageModificationConfirmationDialog"
import ErrorBoundary from "./components/ErrorBoundary"
import { useAddNonInteractiveClickListener } from "./components/ui/hooks/useNonInteractiveClick"
import { TooltipProvider } from "./components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "./components/ui/standard-tooltip"

type Tab = "settings" | "history" | "chat" | "launcher"

interface DeleteMessageDialogState {
	isOpen: boolean
	messageTs: number
	hasCheckpoint: boolean
}

interface EditMessageDialogState {
	isOpen: boolean
	messageTs: number
	text: string
	hasCheckpoint: boolean
	images?: string[]
}

// Memoize dialog components to prevent unnecessary re-renders
const MemoizedDeleteMessageDialog = React.memo(DeleteMessageDialog)
const MemoizedEditMessageDialog = React.memo(EditMessageDialog)
const MemoizedCheckpointRestoreDialog = React.memo(CheckpointRestoreDialog)
const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	historyButtonClicked: "history",
	launcherButtonClicked: "launcher",
}

const App = () => {
	const {
		didHydrateState,
		showWelcome,
		shouldShowAnnouncement,
		telemetrySetting,
		telemetryKey,
		machineId,
		cloudUserInfo: _cloudUserInfo,
		cloudIsAuthenticated: _cloudIsAuthenticated,
		cloudApiUrl: _cloudApiUrl,
		cloudOrganizations: _cloudOrganizations,
		renderContext,
		mdmCompliant,
		taskHistory,
		parallelTasks,
		currentTaskItem,
		customModes,
	} = useExtensionState()

	// Merge built-in and custom modes into a flat slug→name lookup for
	// the TaskSelector subtitle. Rebuild whenever customModes change.
	const allModes = useMemo(() => getAllModes(customModes).map((m) => ({ slug: m.slug, name: m.name })), [customModes])

	// Richer mode metadata for the launcher "New Task" stage — each card shows
	// the mode name plus a short description so the user can pick intentionally.
	const launcherModes = useMemo(
		() =>
			getAllModes(customModes).map((m) => ({
				slug: m.slug,
				name: m.name,
				description: m.description || m.whenToUse,
			})),
		[customModes],
	)

	// Worktree list — populated by worktreeList window messages from the
	// extension host (same mechanism WorktreeIndicator uses).
	const [worktrees, setWorktrees] = useState<Array<{ path: string; branch: string }>>([])
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (e.data?.type === "worktreeList") {
				setWorktrees(e.data.worktrees || [])
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

	const [showAnnouncement, setShowAnnouncement] = useState(false)
	const [tab, setTab] = useState<Tab>("chat")
	// Mirror `tab` into a ref so the rarely-recreated message handler can read
	// the live tab without a stale closure (used by the Settings gear toggle).
	const tabRef = useRef(tab)
	tabRef.current = tab

	// The welcome/onboarding panel appears on first run (no provider configured).
	// Keep it visible once shown — even after the user configures a provider via
	// its inline form — until they explicitly close it (X), so they can still
	// follow the remaining steps. Returning users (provider already set) never
	// see it because `showWelcome` is false from the start.
	const [welcomeClosed, setWelcomeClosed] = useState(false)
	const [welcomeSticky, setWelcomeSticky] = useState(false)
	useEffect(() => {
		if (showWelcome) {
			setWelcomeSticky(true)
		}
	}, [showWelcome])

	const [deleteMessageDialogState, setDeleteMessageDialogState] = useState<DeleteMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		hasCheckpoint: false,
	})

	const [editMessageDialogState, setEditMessageDialogState] = useState<EditMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		text: "",
		hasCheckpoint: false,
		images: [],
	})

	const settingsRef = useRef<SettingsViewRef>(null)
	const chatViewRef = useRef<ChatViewRef>(null)
	const workflowViewRef = useRef<WorkflowViewRef>(null)

	const switchTab = useCallback(
		(newTab: Tab) => {
			// Only check MDM compliance if mdmCompliant is explicitly false (meaning there's an MDM policy and user is non-compliant)
			// If mdmCompliant is undefined or true, allow tab switching
			if (mdmCompliant === false) {
				// Notify the user that authentication is required by their organization
				vscode.postMessage({ type: "showMdmAuthRequiredNotification" })
				return
			}

			setCurrentSection(undefined)

			if (settingsRef.current?.checkUnsaveChanges) {
				settingsRef.current.checkUnsaveChanges(() => setTab(newTab))
			} else {
				setTab(newTab)
			}
		},
		[mdmCompliant],
	)

	const [currentSection, setCurrentSection] = useState<string | undefined>(undefined)
	// Which stage the launcher opens at, set by the native New Task / New
	// Workflow title-bar dropdown items ("task" → mode cards, "workflow" →
	// workflow cards).
	const [launcherStage, setLauncherStage] = useState<"task" | "workflow">("task")

	// The native "+" title-bar button opens this in-webview chooser (anchored
	// below the button) rather than a native QuickPick, so it can show per-item
	// icons + a one-line description. Picking an item opens LauncherView.
	const [newMenuOpen, setNewMenuOpen] = useState(false)
	// Timestamp of the last dismissal, used to make the "+" button toggle
	// robustly: if the menu was dismissed (e.g. by a focus-out triggered by the
	// same "+" click) just before the host's toggle message arrives, we must not
	// immediately reopen it.
	const newMenuClosedAtRef = useRef(0)

	const onMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if (message.type === "action" && message.action) {
				// The welcome/onboarding panel stays up while the user explores the
				// title-bar buttons (their pop-ups/drawers overlay it). Only actually
				// creating a task/workflow — i.e. opening the launcher — replaces it.
				if (message.action === "launcherButtonClicked") {
					setWelcomeClosed(true)
				}

				// The Tasks title-bar button toggles the parallel-tasks side
				// drawer rendered inside TaskHeader / TaskSelector. We re-emit
				// it as a window event so the (deeply nested) drawer can listen
				// without us having to thread state through the component tree.
				if (message.action === "tasksButtonClicked") {
					window.dispatchEvent(new CustomEvent("shofer.taskSidebarToggle"))
					return
				}

				// The "+" title-bar button opens the in-webview New Task / New
				// Workflow chooser (anchored under the button), staying on the
				// current tab until the user picks.
				if (message.action === "newMenuButtonClicked") {
					// Toggle: a second "+" click closes the chooser without a choice.
					setNewMenuOpen((prev) => {
						if (prev) {
							return false
						}
						// If it was dismissed in the last 300ms, this same "+" click is
						// what closed it (via focus-out) — leave it closed instead of
						// reopening.
						if (Date.now() - newMenuClosedAtRef.current < 300) {
							return false
						}
						return true
					})
					return
				}

				// The Settings gear toggles: pressing it again while already on the
				// Settings tab closes it back to chat (matching the "+" and Tasks
				// title-bar buttons, which also toggle). Section-targeted opens — from
				// warnings/popovers that pass `values.section` (e.g.
				// CommandExecutionError → terminal) — always open and never toggle-close.
				if (
					message.action === "settingsButtonClicked" &&
					!message.values?.section &&
					tabRef.current === "settings"
				) {
					switchTab("chat")
					return
				}

				// Handle switchTab action with tab parameter
				if (message.action === "switchTab" && message.tab) {
					const targetTab = message.tab as Tab
					switchTab(targetTab)
					// Extract targetSection from values if provided
					const targetSection = message.values?.section as string | undefined
					setCurrentSection(targetSection)
				} else {
					// Handle other actions using the mapping
					const newTab = tabsByMessageAction[message.action]
					const section = message.values?.section as string | undefined

					if (newTab) {
						switchTab(newTab)
						setCurrentSection(section)
						if (message.action === "launcherButtonClicked") {
							const stage = message.values?.launcherStage as "task" | "workflow" | undefined
							setLauncherStage(stage === "workflow" ? "workflow" : "task")
						}
					}
				}
			}

			if (message.type === "showDeleteMessageDialog" && message.messageTs) {
				setDeleteMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					hasCheckpoint: message.hasCheckpoint || false,
				})
			}

			if (message.type === "showEditMessageDialog" && message.messageTs && message.text) {
				setEditMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					text: message.text,
					hasCheckpoint: message.hasCheckpoint || false,
					images: message.images || [],
				})
			}

			// When the host launches a new task or workflow it sends invoke:"newChat"
			// to reset ChatView/WorkflowView state. App-level routing must also switch
			// to the "chat" tab so the correct view becomes visible (e.g. after clicking
			// a workflow from LauncherView which leaves the tab on "launcher").
			if (message.type === "invoke" && message.invoke === "newChat") {
				switchTab("chat")
			}

			if (message.type === "acceptInput") {
				if (currentTaskItem?.isWorkflow) {
					workflowViewRef.current?.acceptInput()
				} else {
					chatViewRef.current?.acceptInput()
				}
			}
		},
		[switchTab, currentTaskItem?.isWorkflow],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		if (shouldShowAnnouncement && tab === "chat") {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement, tab])

	useEffect(() => {
		if (didHydrateState) {
			telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, machineId)
		}
	}, [telemetrySetting, telemetryKey, machineId, didHydrateState])

	// Tell the extension that we are ready to receive messages.
	useEffect(() => vscode.postMessage({ type: "webviewDidLaunch" }), [])

	// Initialize source map support for better error reporting
	useEffect(() => {
		// Initialize source maps for better error reporting in production
		initializeSourceMaps()

		// Expose source map debugging utilities in production
		if (process.env.NODE_ENV === "production") {
			exposeSourceMapsForDebugging()
		}

		// Log initialization for debugging
		console.debug("App initialized with source map support")
	}, [])

	// Focus the WebView when non-interactive content is clicked (only in editor/tab mode)
	useAddNonInteractiveClickListener(
		useCallback(() => {
			// Only send focus request if we're in editor (tab) mode, not sidebar
			if (renderContext === "editor") {
				vscode.postMessage({ type: "focusPanelRequest" })
			}
		}, [renderContext]),
	)

	if (!didHydrateState) {
		return null
	}

	// Do not conditionally load ChatView, it's expensive and there's state we
	// don't want to lose (user input, disableInput, askResponse promise, etc.)
	const renderWelcome = (showWelcome || welcomeSticky) && !welcomeClosed
	return (
		<>
			{renderWelcome ? (
				<WelcomeView
					onClose={() => {
						setWelcomeClosed(true)
						setTab("chat")
					}}
				/>
			) : (
				<>
					{tab === "history" && <HistoryView onDone={() => switchTab("chat")} />}
					{tab === "launcher" && (
						<LauncherView
							modes={launcherModes}
							initialStage={launcherStage}
							onClose={() => switchTab("chat")}
						/>
					)}
					{tab === "settings" && (
						<SettingsView ref={settingsRef} onDone={() => setTab("chat")} targetSection={currentSection} />
					)}
					<ChatView
						ref={chatViewRef}
						isHidden={tab !== "chat" || !!currentTaskItem?.isWorkflow}
						showAnnouncement={showAnnouncement}
						hideAnnouncement={() => setShowAnnouncement(false)}
					/>
					{/* WorkflowView mirrors ChatView for WorkflowTasks. Both stay mounted
					 * and are toggled via isHidden so webview-local state survives task
					 * switches; visibility is mutually exclusive based on whether the
					 * focused task is a workflow. */}
					<WorkflowView
						ref={workflowViewRef}
						isHidden={tab !== "chat" || !currentTaskItem?.isWorkflow}
						showAnnouncement={showAnnouncement}
						hideAnnouncement={() => setShowAnnouncement(false)}
					/>
					{deleteMessageDialogState.hasCheckpoint ? (
						<MemoizedCheckpointRestoreDialog
							open={deleteMessageDialogState.isOpen}
							type="delete"
							hasCheckpoint={deleteMessageDialogState.hasCheckpoint}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreCheckpoint: boolean) => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
									restoreCheckpoint,
								})
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					) : (
						<MemoizedDeleteMessageDialog
							open={deleteMessageDialogState.isOpen}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={() => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
								})
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					)}
					{editMessageDialogState.hasCheckpoint ? (
						<MemoizedCheckpointRestoreDialog
							open={editMessageDialogState.isOpen}
							type="edit"
							hasCheckpoint={editMessageDialogState.hasCheckpoint}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreCheckpoint: boolean) => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									restoreCheckpoint,
								})
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					) : (
						<MemoizedEditMessageDialog
							open={editMessageDialogState.isOpen}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={() => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									images: editMessageDialogState.images,
								})
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					)}
					{/* Single shared portal target for popovers/dropdowns (AutoApproveDropdown,
					 * WorktreeIndicator, LiveMemoryStatusBadge, …). Lives at the App root —
					 * always visible — so popovers never mount into a `display:none` view.
					 * ChatView and WorkflowView must NOT render their own `#shofer-portal`:
					 * duplicate ids made `getElementById` resolve to the hidden ChatView copy,
					 * which is why workflow-mode dropdowns rendered behind/under the view. */}
					<div id="shofer-portal" />
				</>
			)}
			{/* Overlays mounted regardless of the welcome panel, so the title-bar
			 * "+" chooser and Tasks drawer pop up over it without dismissing it.
			 * Only picking New Task/Workflow (which opens the launcher) replaces it. */}
			<LauncherMenu
				open={newMenuOpen}
				onOpenChange={(open) => {
					if (!open) {
						newMenuClosedAtRef.current = Date.now()
					}
					setNewMenuOpen(open)
				}}
				onPick={(stage) => {
					setNewMenuOpen(false)
					setWelcomeClosed(true)
					setLauncherStage(stage)
					switchTab("launcher")
				}}
			/>
			<TaskSelector
				taskHistory={taskHistory || []}
				parallelTasks={parallelTasks || []}
				currentTaskId={currentTaskItem?.id}
				modes={allModes}
				worktrees={worktrees}
			/>
		</>
	)
}

const queryClient = new QueryClient()

const AppWithProviders = () => (
	<ErrorBoundary>
		<ExtensionStateContextProvider>
			<TranslationProvider>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
						<App />
					</TooltipProvider>
				</QueryClientProvider>
			</TranslationProvider>
		</ExtensionStateContextProvider>
	</ErrorBoundary>
)

export default AppWithProviders
