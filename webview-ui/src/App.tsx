import React, { useCallback, useEffect, useRef, useState, useMemo } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ExtensionMessage } from "@shofer/types"
import { getAllModes } from "@shofer/types"

import TranslationProvider from "./i18n/TranslationContext"

import { vscode } from "./utils/vscode"
import { triggerBrowserDownload } from "./utils/browserDownload"
import { telemetryClient } from "./utils/TelemetryClient"
import { initializeSourceMaps, exposeSourceMapsForDebugging } from "./utils/sourceMapInitializer"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import ChatView, { ChatViewRef } from "./components/chat/ChatView"
import { TaskSelector } from "./components/chat/TaskSelector"
import HistoryView from "./components/history/HistoryView"
import SettingsView, { SettingsViewRef } from "./components/settings/SettingsView"
import WelcomeView from "./components/welcome/WelcomeViewProvider"
import { LauncherView } from "./components/launcher/LauncherView"
import { MessageRewindDialog } from "./components/chat/MessageRewindDialog"
import { DeleteMessageDialog, EditMessageDialog } from "./components/chat/MessageModificationConfirmationDialog"
import ErrorBoundary from "./components/ErrorBoundary"
import { useAddNonInteractiveClickListener } from "./components/ui/hooks/useNonInteractiveClick"
import { TooltipProvider } from "./components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "./components/ui/standard-tooltip"

type Tab = "settings" | "history" | "chat" | "launcher"

interface DeleteMessageDialogState {
	isOpen: boolean
	messageTs: number
	hasRestorableState: boolean
}

interface EditMessageDialogState {
	isOpen: boolean
	messageTs: number
	text: string
	hasRestorableState: boolean
	images?: string[]
}

// Memoize dialog components to prevent unnecessary re-renders
const MemoizedDeleteMessageDialog = React.memo(DeleteMessageDialog)
const MemoizedEditMessageDialog = React.memo(EditMessageDialog)
const MemoizedMessageRewindDialog = React.memo(MessageRewindDialog)
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
		cwd,
	} = useExtensionState()

	// Merge built-in and custom modes into a flat slug→name lookup for
	// the TaskSelector subtitle. Rebuild whenever customModes change.
	const allModes = useMemo(
		() =>
			getAllModes(customModes).map((m) => ({
				slug: m.slug,
				name: m.name,
			})),
		[customModes],
	)

	// Richer mode metadata for the launcher — each card shows the mode name plus
	// a short description so the user can pick intentionally.
	const launcherModes = useMemo(
		() =>
			getAllModes(customModes).map((m) => ({
				slug: m.slug,
				name: m.name,
				description: m.description || m.whenToUse,
			})),
		[customModes],
	)

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
		hasRestorableState: false,
	})

	const [editMessageDialogState, setEditMessageDialogState] = useState<EditMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		text: "",
		hasRestorableState: false,
		images: [],
	})

	const settingsRef = useRef<SettingsViewRef>(null)
	const chatViewRef = useRef<ChatViewRef>(null)

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

	const onMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if (message.type === "action" && message.action) {
				// The welcome/onboarding panel stays up while the user explores the
				// title-bar buttons (their pop-ups/drawers overlay it). Only actually
				// creating a task — i.e. opening the launcher — replaces it.
				if (message.action === "launcherButtonClicked") {
					setWelcomeClosed(true)
				}

				// The "Show Welcome" overflow-menu entry re-opens the welcome /
				// onboarding panel on demand, even after it was dismissed.
				if (message.action === "welcomeButtonClicked") {
					setWelcomeClosed(false)
					setWelcomeSticky(true)
					return
				}

				// The Tasks title-bar button toggles the parallel-tasks side
				// drawer rendered inside TaskHeader / TaskSelector. We re-emit
				// it as a window event so the (deeply nested) drawer can listen
				// without us having to thread state through the component tree.
				if (message.action === "tasksButtonClicked") {
					window.dispatchEvent(new CustomEvent("shofer.taskSidebarToggle"))
					return
				}

				// The "+" title-bar button opens the launcher (the mode cards).
				// It toggles: a second "+" click returns to chat without starting
				// anything.
				if (message.action === "newMenuButtonClicked") {
					setWelcomeClosed(true)
					switchTab(tabRef.current === "launcher" ? "chat" : "launcher")
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
					}
				}
			}

			if (message.type === "showDeleteMessageDialog" && message.messageTs) {
				setDeleteMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					hasRestorableState: message.hasRestorableState || false,
				})
			}

			if (message.type === "showEditMessageDialog" && message.messageTs && message.text) {
				setEditMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					text: message.text,
					hasRestorableState: message.hasRestorableState || false,
					images: message.images || [],
				})
			}

			// When the host launches a new task it sends invoke:"newChat" to reset
			// ChatView state. App-level routing must also switch to the "chat" tab so
			// the view becomes visible (e.g. after picking a mode in LauncherView,
			// which leaves the tab on "launcher").
			if (message.type === "invoke" && message.invoke === "newChat") {
				switchTab("chat")
			}

			// The host streams an exported file here when the editor is accessed over
			// the web (code-server / vscode.dev), so the browser saves it onto the
			// user's own machine rather than the remote server's filesystem.
			if (message.type === "browserDownload" && message.browserDownload) {
				const { fileName, content, mime } = message.browserDownload
				triggerBrowserDownload(fileName, content, mime)
			}

			if (message.type === "acceptInput") {
				chatViewRef.current?.acceptInput()
			}
		},
		[switchTab],
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
					{tab === "launcher" && <LauncherView modes={launcherModes} onClose={() => switchTab("chat")} />}
					{tab === "settings" && (
						<SettingsView ref={settingsRef} onDone={() => setTab("chat")} targetSection={currentSection} />
					)}
					<ChatView
						ref={chatViewRef}
						isHidden={tab !== "chat"}
						showAnnouncement={showAnnouncement}
						hideAnnouncement={() => setShowAnnouncement(false)}
					/>
					{deleteMessageDialogState.hasRestorableState ? (
						<MemoizedMessageRewindDialog
							open={deleteMessageDialogState.isOpen}
							type="delete"
							hasRestorableState={deleteMessageDialogState.hasRestorableState}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreState: boolean) => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
									restoreState,
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
					{editMessageDialogState.hasRestorableState ? (
						<MemoizedMessageRewindDialog
							open={editMessageDialogState.isOpen}
							type="edit"
							hasRestorableState={editMessageDialogState.hasRestorableState}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreState: boolean) => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									restoreState,
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
					 * plugin popovers, …). Lives at the App root —
					 * always visible — so popovers never mount into a `display:none` view.
					 * ChatView must NOT render its own `#shofer-portal`: a duplicate id makes
					 * `getElementById` resolve to the hidden copy, so dropdowns render
					 * behind/under the view. */}
				</>
			)}
			{/* The portal target for always-mounted popovers (the Tasks drawer).
			 * It must live OUTSIDE the welcome/main branch so it is never unmounted — useShoferPortal resolves it once on mount, so a
			 * conditionally-rendered container would leave those popovers with a
			 * detached/missing node when the welcome panel (or any non-chat view)
			 * is active. Rendered exactly once to keep the id unique. */}
			<div id="shofer-portal" />
			{/* Mounted regardless of the welcome panel, so the title-bar Tasks
			 * drawer pops up over it without dismissing it. */}
			<TaskSelector
				taskHistory={taskHistory || []}
				parallelTasks={parallelTasks || []}
				currentTaskId={currentTaskItem?.id}
				modes={allModes}
				workspacePath={cwd ?? ""}
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
