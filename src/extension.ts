// H5.a — Raise libuv's POSIX thread pool size BEFORE any module that touches
// `fs` is imported. libuv reads UV_THREADPOOL_SIZE exactly once, on first use
// of the pool; setting it after the first fs call has no effect. The default
// of 4 is easily exhausted by concurrent task switch + background saves +
// checkpoint writes (each `safeWriteJson` is 3 fs ops: tmp/fsync/rename),
// producing artificial head-of-line blocking. 16 is a conservative ceiling
// that costs ~16 MB of thread stack reservation.
//
// LLM hint: this assignment MUST stay above every other import. Do not
// reorganize the import block to alphabetize or group these lines.
if (!process.env.UV_THREADPOOL_SIZE) {
	process.env.UV_THREADPOOL_SIZE = "16"
}

import * as vscode from "vscode"
import * as dotenvx from "@dotenvx/dotenvx"
import * as fs from "fs"
import * as path from "path"

// Load environment variables from .env file
// The extension-level .env is optional (not shipped in production builds).
// Avoid calling dotenvx when the file doesn't exist, otherwise dotenvx emits
// a noisy [MISSING_ENV_FILE] error to the extension host console.
const envPath = path.join(__dirname, "..", ".env")
if (fs.existsSync(envPath)) {
	try {
		dotenvx.config({ path: envPath })
	} catch (e) {
		// Best-effort only: never fail extension activation due to optional env loading.
		outputWarn("Failed to load environment variables:", e)
	}
}

import { TelemetryService, PostHogTelemetryClient } from "@shofer/telemetry"
import { customToolRegistry } from "@shofer/core"

import "./utils/path" // Necessary to have access to String.prototype.toPosix.
import {
	createDualLogger,
	createOutputChannelLogger,
	outputWarn,
	setExtensionOutputChannel,
} from "./utils/outputChannelLogger"
import { initializeNetworkProxy } from "./utils/networkProxy"

import { Package } from "./shared/package"
import { formatLanguage } from "./shared/language"
import { ContextProxy } from "./core/config/ContextProxy"
import { ShoferProvider } from "./core/webview/ShoferProvider"
import { ContextDropZoneProvider, addUrisToContext } from "./core/webview/ContextDropZoneProvider"
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"
import { TerminalRegistry } from "./integrations/terminal/TerminalRegistry"
import { openAiCodexOAuthManager } from "./integrations/openai-codex/oauth"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { MARKETPLACE_ENABLED } from "@shofer/types"
import { setMcpOutputChannel } from "./services/mcp/mcpLogger"
import { CodeIndexManager } from "./services/code-index/manager"
import { GitIndexManager } from "./services/git-index/git-index-manager"
import { AssistantAgentManager } from "./services/assistant-agent/manager"
import { migrateSettings } from "./utils/migrateSettings"
import { autoImportSettings } from "./utils/autoImportSettings"
import { API } from "./extension/api"
import { startMetricsServer, stopMetricsServer } from "./metrics/server"
import {
	updateMemoryMetrics,
	updateEventListenerMetrics,
	updateTaskMetrics,
	updateFocusedTaskMetrics,
	registry,
} from "./metrics/registry"

import {
	handleUri,
	registerCommands,
	registerCodeActions,
	registerTerminalActions,
	CodeActionProvider,
} from "./activate"
import { initializeI18n } from "./i18n"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

let outputChannel: vscode.OutputChannel
let extensionContext: vscode.ExtensionContext

/**
 * Get the extension's output channel for logging.
 * Returns undefined if called before extension activation.
 */
export function getOutputChannel(): vscode.OutputChannel | undefined {
	return outputChannel
}

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context
	outputChannel = vscode.window.createOutputChannel(Package.outputChannel)

	// Set VS Code context key for marketplace visibility
	vscode.commands.executeCommand("setContext", "shofer:marketplaceEnabled", MARKETPLACE_ENABLED)
	context.subscriptions.push(outputChannel)
	setMcpOutputChannel(outputChannel)
	setExtensionOutputChannel(outputChannel)
	outputChannel.appendLine(`${Package.name} extension activated - ${JSON.stringify(Package)}`)

	// Initialize network proxy configuration early, before any network requests.
	// When proxyUrl is configured, all HTTP/HTTPS traffic will be routed through it.
	// Only applied in debug mode (F5).
	await initializeNetworkProxy(context, outputChannel)

	// Set extension path for custom tool registry to find bundled esbuild
	customToolRegistry.setExtensionPath(context.extensionPath)

	// Migrate old settings to new
	await migrateSettings(context, outputChannel)

	// Initialize telemetry service.
	const telemetryService = TelemetryService.createInstance()

	try {
		telemetryService.register(new PostHogTelemetryClient())
	} catch (error) {
		outputChannel.appendLine(`[WARN] Failed to register PostHogTelemetryClient: ${error}`)
	}

	// Initialize i18n for internationalization support.
	initializeI18n(context.globalState.get("language") ?? formatLanguage(vscode.env.language))

	// Initialize terminal shell execution handlers.
	TerminalRegistry.initialize()

	// Initialize OpenAI Codex OAuth manager for ChatGPT subscription-based access.
	openAiCodexOAuthManager.initialize(context, (message) => outputChannel.appendLine(message))

	// Get default commands from configuration.
	const defaultCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>("allowedCommands") || []

	// Initialize global state if not already set.
	if (!context.globalState.get("allowedCommands")) {
		context.globalState.update("allowedCommands", defaultCommands)
	}

	const contextProxy = await ContextProxy.getInstance(context)

	// Start the Prometheus metrics server on a random ephemeral port.
	// A per-PID port file is written under globalStorage/metrics-ports/ for
	// scraper discovery (multiple windows on one host are all distinct).
	const _workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	await startMetricsServer(context.globalStoragePath, _workspace)

	// Register on-scrape collectors so /metrics returns up-to-date values
	// without an event-loop-waking timer.  process.memoryUsage() is O(1).
	registry.registerCollector(() => {
		updateMemoryMetrics()
		const provider = ShoferProvider.getVisibleInstance()
		if (provider) {
			updateEventListenerMetrics(provider.listenerCount("ShoferEvent"))

			// Task-count gauges: history total and live active count.
			const historyCount = provider.taskHistoryStore.getAll().length
			const activeCount = provider.taskManager.getActiveManagedTasks().length
			updateTaskMetrics(historyCount, activeCount)

			// Focused-task message gauges: message count and serialized byte size.
			const focusedId = provider.taskManager.getFocusedTaskId()
			if (focusedId) {
				const task = provider.taskManager.getManagedTaskInstance(focusedId)
				if (task) {
					const msgs = task.shoferMessages
					const bytes = Buffer.byteLength(JSON.stringify(msgs), "utf8")
					updateFocusedTaskMetrics(msgs.length, bytes)
				}
			}
		}
	})

	// Initialize code index managers for all workspace folders.
	const codeIndexManagers: CodeIndexManager[] = []

	if (vscode.workspace.workspaceFolders) {
		for (const folder of vscode.workspace.workspaceFolders) {
			const manager = CodeIndexManager.getInstance(context, folder.uri.fsPath)

			if (manager) {
				codeIndexManagers.push(manager)

				// Initialize in background; do not block extension activation
				void manager.initialize(contextProxy).catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					outputChannel.appendLine(
						`[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for ${folder.uri.fsPath}: ${message}`,
					)
				})

				context.subscriptions.push(manager)
			}

			// Initialize git index manager for this workspace folder.
			const gitIndexManager = GitIndexManager.getInstance(context, folder.uri.fsPath)

			if (gitIndexManager) {
				// Initialize in background; do not block extension activation
				void gitIndexManager.initialize(contextProxy).catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					outputChannel.appendLine(
						`[GitIndexManager] Error during background GitIndexManager initialization for ${folder.uri.fsPath}: ${message}`,
					)
				})

				context.subscriptions.push(gitIndexManager)
			}

			// Initialize assistant agent manager for this workspace folder.
			const assistantAgentManager = AssistantAgentManager.getInstance(context, folder.uri.fsPath)

			if (assistantAgentManager) {
				// Initialize in background; do not block extension activation
				void assistantAgentManager.initialize().catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					outputChannel.appendLine(
						`[AssistantAgentManager] Error during initialization for ${folder.uri.fsPath}: ${message}`,
					)
				})

				context.subscriptions.push(assistantAgentManager)
			}
		}
	}

	// ─── Assistant Agent ──────────────────────────────────────────────────
	// The Assistant Agent's status indicator and action menu live in the
	// Shofer chat-input toolbar (AssistantAgentStatusBadge → AssistantAgentPopover),
	// not in the VS Code status bar. Commands are registered through
	// registerCommands() (typed CommandId system) below.

	// Initialize the provider.
	const provider = new ShoferProvider(context, outputChannel, "sidebar", contextProxy, undefined)

	// Finish initializing the provider.
	TelemetryService.instance.setProvider(provider)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ShoferProvider.sideBarId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// ─── End Assistant Agent Chat View ───────────────────────────────────

	// Native TreeView used as a reliable file drop target.  See
	// ContextDropZoneProvider for rationale.  Registered collapsed-by-default
	// via the view contribution in package.json so it stays out of the way.
	const contextDropZoneProvider = new ContextDropZoneProvider()
	contextDropZoneProvider.setShoferProvider(provider)
	context.subscriptions.push(
		vscode.window.createTreeView(ContextDropZoneProvider.viewId, {
			treeDataProvider: contextDropZoneProvider,
			dragAndDropController: contextDropZoneProvider,
		}),
	)

	// Explorer context-menu command: "Add to Shofer Context".  This is the
	// fallback for runtimes where HTML5 drag/drop into the webview iframe is
	// blocked by the host (VSCode Desktop overlay, code-server browser tab).
	// VSCode invokes this with (clickedUri, allSelectedUris) when triggered
	// from the Explorer context menu.
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"shofer.addFilesToContext",
			async (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
				const uris: vscode.Uri[] =
					selectedUris && selectedUris.length > 0 ? selectedUris : clickedUri ? [clickedUri] : []
				await addUrisToContext(uris, provider)
			},
		),
	)

	// Auto-import configuration if specified in settings.
	try {
		await autoImportSettings(outputChannel, {
			providerSettingsManager: provider.providerSettingsManager,
			contextProxy: provider.contextProxy,
			customModesManager: provider.customModesManager,
		})
	} catch (error) {
		outputChannel.appendLine(
			`[AutoImport] Error during auto-import: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	registerCommands({ context, outputChannel, provider })

	/**
	 * We use the text document content provider API to show the left side for diff
	 * view by creating a virtual document for the original content. This makes it
	 * readonly so users know to edit the right side if they want to keep their changes.
	 *
	 * This API allows you to create readonly documents in VSCode from arbitrary
	 * sources, and works by claiming an uri-scheme for which your provider then
	 * returns text contents. The scheme must be provided when registering a
	 * provider and cannot change afterwards.
	 *
	 * Note how the provider doesn't create uris for virtual documents - its role
	 * is to provide contents given such an uri. In return, content providers are
	 * wired into the open document logic so that providers are always considered.
	 *
	 * https://code.visualstudio.com/api/extension-guides/virtual-documents
	 */
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
	)

	// `shofer-original:` virtual scheme used by the FileChangesPanel to display
	// "original (Shofer's start) ↔ current" diffs in the main editor area without
	// touching disk. Content is carried base64-encoded in the URI's `query` so
	// each invocation is self-contained (no runtime registry to keep in sync
	// with task lifecycle).
	const shoferOriginalProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider("shofer-original", shoferOriginalProvider),
	)

	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register code actions provider.
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider({ pattern: "**/*" }, new CodeActionProvider(), {
			providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds,
		}),
	)

	registerCodeActions(context)
	registerTerminalActions(context)

	// Allows other extensions to activate once Shofer is ready.
	vscode.commands.executeCommand(`${Package.name}.activationCompleted`)

	// Implements the `ShoferAPI` interface.
	const socketPath = process.env.SHOFER_IPC_SOCKET_PATH
	const enableLogging = typeof socketPath === "string"

	// Watch the core files and automatically reload the extension host.
	if (process.env.NODE_ENV === "development") {
		const watchPaths = [
			{ path: context.extensionPath, pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/types"), pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/telemetry"), pattern: "**/*.ts" },
		]

		outputChannel.appendLine(
			`♻️♻️♻️ Core auto-reloading: Watching for changes in ${watchPaths.map(({ path }) => path).join(", ")}`,
		)

		// Create a debounced reload function to prevent excessive reloads
		let reloadTimeout: NodeJS.Timeout | undefined
		const DEBOUNCE_DELAY = 1_000

		const debouncedReload = (uri: vscode.Uri) => {
			if (reloadTimeout) {
				clearTimeout(reloadTimeout)
			}

			outputChannel.appendLine(`♻️ ${uri.fsPath} changed; scheduling reload...`)

			reloadTimeout = setTimeout(() => {
				outputChannel.appendLine(`♻️ Reloading host after debounce delay...`)
				vscode.commands.executeCommand("workbench.action.reloadWindow")
			}, DEBOUNCE_DELAY)
		}

		watchPaths.forEach(({ path: watchPath, pattern }) => {
			const relPattern = new vscode.RelativePattern(vscode.Uri.file(watchPath), pattern)
			const watcher = vscode.workspace.createFileSystemWatcher(relPattern, false, false, false)

			// Listen to all change types to ensure symlinked file updates trigger reloads.
			watcher.onDidChange(debouncedReload)
			watcher.onDidCreate(debouncedReload)
			watcher.onDidDelete(debouncedReload)

			context.subscriptions.push(watcher)
		})

		// Clean up the timeout on deactivation
		context.subscriptions.push({
			dispose: () => {
				if (reloadTimeout) {
					clearTimeout(reloadTimeout)
				}
			},
		})
	}

	return new API(outputChannel, provider, socketPath, enableLogging)
}

// This method is called when your extension is deactivated.
export async function deactivate() {
	outputChannel.appendLine(`${Package.name} extension deactivated`)

	await McpServerManager.cleanup(extensionContext)
	AssistantAgentManager.disposeAll()
	CodeIndexManager.disposeAll()
	TelemetryService.instance.shutdown()
	TerminalRegistry.cleanup()
	await stopMetricsServer()
}
