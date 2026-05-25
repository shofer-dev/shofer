import * as vscode from "vscode"
import * as v8 from "v8"
import * as path from "path"
import fs from "fs/promises"
import delay from "delay"

import type { CommandId } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { Package } from "../shared/package"
import { getCommand } from "../utils/commands"
import { ShoferProvider } from "../core/webview/ShoferProvider"
import { ContextProxy } from "../core/config/ContextProxy"
import { focusPanel } from "../utils/focusPanel"
import { EXPERIMENT_IDS, experiments } from "../shared/experiments"
import { handleNewTask } from "./handleTask"
import { CodeIndexManager } from "../services/code-index/manager"
import { GitIndexManager } from "../services/git-index/git-index-manager"
import { AssistantAgentManager } from "../services/assistant-agent/manager"
import { showAssistantAgentChatPanel } from "../core/webview/AssistantAgentChatProvider"
import { importSettingsWithFeedback } from "../core/config/importExport"
import { defaultModeSlug } from "../shared/modes"
import { t } from "../i18n"

/**
 * Helper to get the visible ShoferProvider instance or log if not found.
 */
export function getVisibleProviderOrLog(outputChannel: vscode.OutputChannel): ShoferProvider | undefined {
	const visibleProvider = ShoferProvider.getVisibleInstance()
	if (!visibleProvider) {
		outputChannel.appendLine("Cannot find any visible Shofer instances.")
		return undefined
	}
	return visibleProvider
}

// Store panel references in both modes
let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/**
 * Set panel references
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
		tabPanel = undefined
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
		sidebarPanel = undefined
	}
}

export type RegisterCommandOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	provider: ShoferProvider
}

export const registerCommands = (options: RegisterCommandOptions) => {
	const { context } = options

	for (const [id, callback] of Object.entries(getCommandsMap(options))) {
		const command = getCommand(id as CommandId)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

const getCommandsMap = ({ context, outputChannel, provider }: RegisterCommandOptions): Record<CommandId, any> => ({
	activationCompleted: () => {},
	plusButtonClicked: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("plus")

		// Pop current task WITHOUT aborting - it continues in background
		const poppedTask = visibleProvider.popFromStackWithoutAborting()
		if (poppedTask) {
			// Register as background task so it shows correct state indicators
			visibleProvider.taskManager.registerBackgroundTask(poppedTask)
			visibleProvider.log(
				`[plusButtonClicked] Task ${poppedTask.taskId} moved to background (parallel execution)`,
			)
		}

		// Sticky-mode: a fresh "new task" surface starts in the upstream
		// default mode (`defaultModeSlug`, currently "code"), regardless
		// of which mode the previously focused task was using. The popped
		// task keeps its own mode persisted on its `_taskMode` and in the
		// history item, so it's restored on refocus.
		await visibleProvider.handleUserModeSwitch(defaultModeSlug)

		await visibleProvider.refreshWorkspace()
		await visibleProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		// Notify the UI to reset the chat input and save the outgoing task's
		// draft, so text typed in the previous task stays with that task.
		await visibleProvider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
		// Send focusInput action immediately after chatButtonClicked
		// This ensures the focus happens after the view has switched
		await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
	},
	popoutButtonClicked: () => {
		TelemetryService.instance.captureTitleButtonClicked("popout")

		return openShoferInNewTab({ context, outputChannel })
	},
	openInNewTab: () => openShoferInNewTab({ context, outputChannel }),
	settingsButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("settings")

		visibleProvider.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
		// Also explicitly post the visibility message to trigger scroll reliably
		visibleProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
	},
	historyButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("history")

		visibleProvider.postMessageToWebview({ type: "action", action: "historyButtonClicked" })
	},
	tasksButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("tasks")

		// Surface the parallel-tasks side panel inside the webview.
		visibleProvider.postMessageToWebview({ type: "action", action: "tasksButtonClicked" })
	},
	marketplaceButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) return
		visibleProvider.postMessageToWebview({ type: "action", action: "marketplaceButtonClicked" })
	},
	newTask: handleNewTask,
	setCustomStoragePath: async () => {
		const { promptForCustomStoragePath } = await import("../utils/storage")
		await promptForCustomStoragePath()
	},
	importSettings: async (filePath?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}

		await importSettingsWithFeedback(
			{
				providerSettingsManager: visibleProvider.providerSettingsManager,
				contextProxy: visibleProvider.contextProxy,
				customModesManager: visibleProvider.customModesManager,
				provider: visibleProvider,
			},
			filePath,
		)
	},
	focusInput: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)

			// Send focus input message only for sidebar panels
			if (sidebarPanel && getPanel() === sidebarPanel) {
				provider.postMessageToWebview({ type: "action", action: "focusInput" })
			}
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	focusPanel: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)
		} catch (error) {
			outputChannel.appendLine(`Error focusing panel: ${error}`)
		}
	},
	acceptInput: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({ type: "acceptInput" })
	},
	toggleAutoApprove: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({
			type: "action",
			action: "toggleAutoApprove",
		})
	},

	// ─── Assistant Agent ──────────────────────────────────────────────────
	// The Assistant Agent's status indicator and action menu live in the
	// Shofer chat-input toolbar (AssistantAgentStatusBadge → AssistantAgentPopover),
	// not in the VS Code status bar. The commands below back the popover
	// actions and are also exposed through the command palette.
	"assistantAgent.showChat": () => {
		showAssistantAgentChatPanel(context.extensionUri)
	},
	"assistantAgent.start": async () => {
		// `initialize()` swallows configuration/connection errors and sets the
		// manager state to "Error" rather than throwing. Surface the failure to
		// the user instead of unconditionally claiming success.
		const managers = AssistantAgentManager.getAllInstances()
		await Promise.all(managers.map((mgr) => mgr.initialize()))
		const failed = managers.filter((mgr) => mgr.state === "Error")
		if (failed.length > 0) {
			const detail = failed[0].stateMessage || "Unknown error"
			vscode.window.showErrorMessage(`Assistant Agent failed to start: ${detail}`)
			return
		}
		const standby = managers.filter((mgr) => mgr.state === "Standby")
		if (standby.length === managers.length && managers.length > 0) {
			vscode.window.showWarningMessage(`Assistant Agent is on standby: ${standby[0].stateMessage}`)
			return
		}
		vscode.window.showInformationMessage("Assistant Agent started.")
	},
	"assistantAgent.stop": () => {
		// Cancel pending work, then dispose every instance. disposeAll() calls
		// dispose() on each, which already cancels questions and tears down
		// watchers/emitters; the explicit cancel here is defensive in case a
		// caller invokes stop() repeatedly.
		for (const mgr of AssistantAgentManager.getAllInstances()) {
			mgr.cancelAllQuestions()
		}
		AssistantAgentManager.disposeAll()
		vscode.window.showInformationMessage("Assistant Agent stopped.")
	},
	"assistantAgent.clearContext": async () => {
		const managers = AssistantAgentManager.getAllInstances()
		await Promise.all(managers.map((mgr) => mgr.clearContext()))
		vscode.window.showInformationMessage("Assistant Agent context cleared.")
	},
	"assistantAgent.openSettings": () => {
		// Assistant Agent settings live in ContextProxy (Typed Settings Rule), not
		// in package.json `configuration` contributions, so the in-app
		// SettingsView is the single source of truth for editing them. Route
		// through the standard `settingsButtonClicked` action with a target
		// `section`, mirroring how `settingsButtonClicked` above works.
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}
		visibleProvider.postMessageToWebview({
			type: "action",
			action: "settingsButtonClicked",
			values: { section: "assistantAgent" },
		})
		visibleProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
	},
	// ─── Git Index ────────────────────────────────────────────────────────
	startGitIndexing: async () => {
		const manager = GitIndexManager.getInstance(context)
		if (!manager) {
			vscode.window.showErrorMessage("Cannot start git indexing: No workspace folder open.")
			return
		}
		if (manager.isFeatureEnabled && manager.isFeatureConfigured) {
			await manager.initialize(provider.contextProxy)
			manager.startIndexing()
			vscode.window.showInformationMessage("Git history indexing started.")
		} else {
			vscode.window.showWarningMessage(
				"Git indexing is not enabled or not configured. Check Settings → RAG Indexer.",
			)
		}
	},
	stopGitIndexing: () => {
		const manager = GitIndexManager.getInstance(context)
		if (manager) {
			manager.stopIndexing()
			vscode.window.showInformationMessage("Git history indexing stopped.")
		}
	},
	heapSnapshot: async () => {
		const writeHeapSnapshot = (v8 as unknown as { writeHeapSnapshot: (filename?: string) => string })
			.writeHeapSnapshot
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
		const snapshotDir = path.join(workspacePath, ".shofer", "heap-snapshots")
		await fs.mkdir(snapshotDir, { recursive: true })
		// `v8.writeHeapSnapshot()` without an arg writes to `process.cwd()` —
		// ignoring the prepared directory.  Pass an explicit path so the
		// snapshot lands inside `.shofer/heap-snapshots/`.
		const targetPath = path.join(snapshotDir, `heap-${timestamp}.heapsnapshot`)
		const filePath = writeHeapSnapshot(targetPath)
		outputChannel.appendLine(`[heapSnapshot] Heap snapshot written to: ${filePath}`)
		vscode.window.showInformationMessage(`Heap snapshot written to ${filePath}`)
	},

	clearGitIndexData: async () => {
		const manager = GitIndexManager.getInstance(context)
		if (!manager) {
			vscode.window.showErrorMessage("Cannot clear git index: No workspace folder open.")
			return
		}
		await manager.clearIndexData()
		vscode.window.showInformationMessage("Git history index cleared.")
	},
	// ─── Webview ──────────────────────────────────────────────────────────
	refreshWebview: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}
		// Gated: disabled when the webview liveness monitor experiment is off.
		// Defence-in-depth — the toolbar button is also hidden via a `when`
		// clause keyed on `shofer:webviewLivenessMonitorEnabled`, but the
		// command id remains invokable from the Command Palette.
		const exps = visibleProvider.contextProxy.getValue("experiments") ?? {}
		if (!experiments.isEnabled(exps, EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR)) {
			outputChannel.appendLine("[refreshWebview] Skipped (webview liveness monitor experiment disabled)")
			return
		}
		await visibleProvider.refreshWebview()
	},
	reloadWindow: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}
		// Gated: disabled when the webview liveness monitor experiment is off.
		const exps = visibleProvider.contextProxy.getValue("experiments") ?? {}
		if (!experiments.isEnabled(exps, EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR)) {
			outputChannel.appendLine("[reloadWindow] Skipped (webview liveness monitor experiment disabled)")
			return
		}
		// Show a confirmation dialog before nuking the VS Code window.
		// This is a last-resort recovery for when the webview iframe is
		// stuck at the workbench level and refreshWebview() didn't help.
		const answer = await vscode.window.showWarningMessage(
			"Reload the entire VS Code window? All unsaved editor changes will be lost.",
			{ modal: true },
			"Reload Window",
		)
		if (answer === "Reload Window") {
			await vscode.commands.executeCommand("workbench.action.reloadWindow")
		}
	},
	// ─── Walkthrough ──────────────────────────────────────────────────────
	"walkthrough.openDocumentation": async () => {
		await vscode.env.openExternal(
			vscode.Uri.parse("https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md"),
		)
	},
	"walkthrough.joinDiscord": async () => {
		await vscode.env.openExternal(vscode.Uri.parse("https://discord.gg/x39UEEQ2"))
	},
	"walkthrough.openCopilotGuide": async () => {
		await vscode.env.openExternal(
			vscode.Uri.parse("https://github.com/shofer-dev/shofer/blob/master/docs/shofer_for_copilot_users.md"),
		)
	},
	"walkthrough.open": async () => {
		await vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			"shofer-dev.shofer#shofer.getStarted",
			false,
		)
	},
	"walkthrough.openRoocodeGuide": async () => {
		await vscode.env.openExternal(
			vscode.Uri.parse("https://github.com/shofer-dev/shofer/blob/master/docs/shofer_for_roocode_users.md"),
		)
	},
})

export const openShoferInNewTab = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => {
	// (This example uses webviewProvider activation event which is necessary to
	// deserialize cached webview, but since we use retainContextWhenHidden, we
	// don't need to use that event).
	// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	const contextProxy = await ContextProxy.getInstance(context)
	const codeIndexManager = CodeIndexManager.getInstance(context)

	const tabProvider = new ShoferProvider(context, outputChannel, "editor", contextProxy, undefined)
	const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

	// Check if there are any visible text editors, otherwise open a new group
	// to the right.
	const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

	if (!hasVisibleEditors) {
		await vscode.commands.executeCommand("workbench.action.newGroupRight")
	}

	const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

	const newPanel = vscode.window.createWebviewPanel(ShoferProvider.tabPanelId, "Shofer", targetCol, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [context.extensionUri],
	})

	// Save as tab type panel.
	setPanel(newPanel, "tab")

	// TODO: Use better svg icon with light and dark variants (see
	// https://stackoverflow.com/questions/58365687/vscode-extension-iconpath).
	newPanel.iconPath = {
		light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_light.png"),
		dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_dark.png"),
	}

	await tabProvider.resolveWebviewView(newPanel)

	// Add listener for visibility changes to notify webview
	newPanel.onDidChangeViewState(
		(e) => {
			const panel = e.webviewPanel
			if (panel.visible) {
				panel.webview.postMessage({ type: "action", action: "didBecomeVisible" }) // Use the same message type as in SettingsView.tsx
			}
		},
		null, // First null is for `thisArgs`
		context.subscriptions, // Register listener for disposal
	)

	// Handle panel closing events.
	newPanel.onDidDispose(
		() => {
			setPanel(undefined, "tab")
		},
		null,
		context.subscriptions, // Also register dispose listener
	)

	// Lock the editor group so clicking on files doesn't open them over the panel.
	await delay(100)
	await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

	return tabProvider
}
