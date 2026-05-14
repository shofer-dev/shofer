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
		console.warn("Failed to load environment variables:", e)
	}
}

import { TelemetryService, PostHogTelemetryClient } from "@shofer/telemetry"
import { customToolRegistry } from "@shofer/core"

import "./utils/path" // Necessary to have access to String.prototype.toPosix.
import { createOutputChannelLogger, createDualLogger } from "./utils/outputChannelLogger"
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
import { HelperAgentManager } from "./services/helper-agent/manager"
import { migrateSettings } from "./utils/migrateSettings"
import { autoImportSettings } from "./utils/autoImportSettings"
import { API } from "./extension/api"

import {
	handleUri,
	registerCommands,
	registerCodeActions,
	registerTerminalActions,
	CodeActionProvider,
} from "./activate"
import { initializeI18n } from "./i18n"
import { initializeModelCacheRefresh } from "./api/providers/fetchers/modelCache"

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
		console.warn("Failed to register PostHogTelemetryClient:", error)
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

			// Initialize helper agent manager for this workspace folder.
			const helperAgentManager = HelperAgentManager.getInstance(context, folder.uri.fsPath)

			if (helperAgentManager) {
				// Initialize in background; do not block extension activation
				void helperAgentManager.initialize().catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					outputChannel.appendLine(
						`[HelperAgentManager] Error during initialization for ${folder.uri.fsPath}: ${message}`,
					)
				})

				context.subscriptions.push(helperAgentManager)
			}
		}
	}

	// Initialize the provider.
	const provider = new ShoferProvider(context, outputChannel, "sidebar", contextProxy, undefined)

	// Finish initializing the provider.
	TelemetryService.instance.setProvider(provider)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ShoferProvider.sideBarId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

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

		console.log(
			`♻️♻️♻️ Core auto-reloading: Watching for changes in ${watchPaths.map(({ path }) => path).join(", ")}`,
		)

		// Create a debounced reload function to prevent excessive reloads
		let reloadTimeout: NodeJS.Timeout | undefined
		const DEBOUNCE_DELAY = 1_000

		const debouncedReload = (uri: vscode.Uri) => {
			if (reloadTimeout) {
				clearTimeout(reloadTimeout)
			}

			console.log(`♻️ ${uri.fsPath} changed; scheduling reload...`)

			reloadTimeout = setTimeout(() => {
				console.log(`♻️ Reloading host after debounce delay...`)
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

	// Initialize background model cache refresh
	initializeModelCacheRefresh()

	return new API(outputChannel, provider, socketPath, enableLogging)
}

// This method is called when your extension is deactivated.
export async function deactivate() {
	outputChannel.appendLine(`${Package.name} extension deactivated`)

	await McpServerManager.cleanup(extensionContext)
	HelperAgentManager.disposeAll()
	CodeIndexManager.disposeAll()
	TelemetryService.instance.shutdown()
	TerminalRegistry.cleanup()
}
