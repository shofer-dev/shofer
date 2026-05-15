import * as vscode from "vscode"
import delay from "delay"

import type { CommandId } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { Package } from "../shared/package"
import { getCommand } from "../utils/commands"
import { ShoferProvider } from "../core/webview/ShoferProvider"
import { ContextProxy } from "../core/config/ContextProxy"
import { focusPanel } from "../utils/focusPanel"
import { handleNewTask } from "./handleTask"
import { CodeIndexManager } from "../services/code-index/manager"
import { HelperAgentManager } from "../services/helper-agent/manager"
import { showHelperAgentChatPanel } from "../core/webview/HelperAgentChatProvider"
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
		await visibleProvider.handleModeSwitch(defaultModeSlug)

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

	// ─── Helper Agent ──────────────────────────────────────────────────
	// The Helper Agent's status indicator and action menu live in the
	// Shofer chat-input toolbar (HelperAgentStatusBadge → HelperAgentPopover),
	// not in the VS Code status bar. The commands below back the popover
	// actions and are also exposed through the command palette.
	"helperAgent.showChat": () => {
		showHelperAgentChatPanel(context.extensionUri)
	},
	"helperAgent.start": async () => {
		const managers = HelperAgentManager.getAllInstances()
		await Promise.all(managers.map((mgr) => mgr.initialize()))
		vscode.window.showInformationMessage("Helper Agent started.")
	},
	"helperAgent.stop": () => {
		// Cancel pending work, then dispose every instance. disposeAll() calls
		// dispose() on each, which already cancels questions and tears down
		// watchers/emitters; the explicit cancel here is defensive in case a
		// caller invokes stop() repeatedly.
		for (const mgr of HelperAgentManager.getAllInstances()) {
			mgr.cancelAllQuestions()
		}
		HelperAgentManager.disposeAll()
		vscode.window.showInformationMessage("Helper Agent stopped.")
	},
	"helperAgent.clearContext": async () => {
		const managers = HelperAgentManager.getAllInstances()
		await Promise.all(managers.map((mgr) => mgr.clearContext()))
		vscode.window.showInformationMessage("Helper Agent context cleared.")
	},
	"helperAgent.openSettings": async () => {
		await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:shofer.shofer helperAgent")
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
