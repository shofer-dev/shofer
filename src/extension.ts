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
		webviewLog.warn("Failed to load environment variables:", e)
	}
}

import { TelemetryService, PostHogTelemetryClient, OtelTelemetryClient } from "@shofer/telemetry"
import { setHost, createVsCodeHost } from "./host/host-bridge"
import { customToolRegistry, pluginRegistry } from "@shofer/core"
import { registerGlobalStorageFsPath } from "@shofer/core"

import "@shofer/core" // Necessary to install String.prototype.toPosix at runtime (implementation lives in @shofer/core).
import { createDualLogger, createOutputChannelLogger } from "@shofer/core"
import { setOutputChannel } from "@shofer/core"
import { bootstrapLogging, setLogLevel, setLogCategories } from "@shofer/core"
import { webviewLog } from "@shofer/core"
import { setTokenCounter } from "@shofer/core"
import { setModelsCacheDirProvider } from "@shofer/core"
import { registerNativeApiHandler } from "@shofer/core"
import { setMcpHubFactory } from "@shofer/core"
import { VsCodeLmHandler } from "./api/providers/vscode-lm"
import { OpenAiCodexHandler } from "./api/providers/openai-codex"
import { countTokens as countTokensWithWorker } from "./utils/countTokens"
import { getCacheDirectoryPath } from "@shofer/core"
import { setCustomStoragePathResolver } from "@shofer/core"
import { getConfiguredCustomStoragePath } from "./utils/storage"
import { initializeNetworkProxy } from "./utils/networkProxy"

import { Package } from "@shofer/core"
import { formatLanguage } from "@shofer/types"
import { ContextProxy } from "./core/config/ContextProxy"
import { ShoferProvider } from "./core/webview/ShoferProvider"
import { ContextDropZoneProvider, addUrisToContext } from "./core/webview/ContextDropZoneProvider"
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"
import { TerminalRegistry } from "@shofer/core"
import { openAiCodexOAuthManager } from "./integrations/openai-codex/oauth"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { setMcpOutputChannel } from "@shofer/core"
import { autoImportSettings } from "./utils/autoImportSettings"
import { API } from "./extension/api"
import { syncExperimentContextKeys } from "./activate/experimentContextKeys"
import { registry } from "@shofer/core"

import {
	handleUri,
	registerCommands,
	registerCodeActions,
	registerTerminalActions,
	CodeActionProvider,
} from "./activate"
import { SlangEditorProvider } from "./core/webview/SlangEditorProvider"
import { initializeI18n } from "@shofer/core"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

let outputChannel: vscode.OutputChannel
let extensionContext: vscode.ExtensionContext

// Re-export from the leaf module so existing `import { getOutputChannel } from
// ".../extension"` call sites keep working, while the canonical source lives in
// a dependency-free module (avoids the WorkflowTask import cycle). New callers
// should import from "@shofer/core" directly.
export { getOutputChannel } from "@shofer/core"

// §11/§12: exported from the bundle so a headless front-end (the `shofer serve` /
// `shofer acp` CLI commands) can drive the activated ShoferExtensionApi over HTTP or ACP.
export { runAcpAgentOverShoferApi, serveHttpOverShoferApi } from "@shofer/core"

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context
	// §9: install the VS Code host bridge so host-agnostic code reaches the editor
	// through `getHost()` instead of importing `vscode` directly.
	setHost(createVsCodeHost(context))
	outputChannel = vscode.window.createOutputChannel(Package.outputChannel)
	// Publish to the dependency-free holder so tools/leaf modules can read it
	// without importing this entrypoint (avoids the WorkflowTask import cycle).
	setOutputChannel(outputChannel)

	// Bootstrap the shared logging transport — must happen before any module
	// uses `getLogger()` so the Output Channel is wired.
	bootstrapLogging(outputChannel)

	// Offload token counting to the extension's worker pool. Host-agnostic core
	// (e.g. BaseProvider) calls `countTokens` from @shofer/core, which defaults to
	// the portable synchronous tiktoken implementation; here we register the
	// worker-backed counter so the extension host keeps its off-thread offload.
	setTokenCounter((content) => countTokensWithWorker(content, { useWorker: true }))

	// Root the model/model-endpoint fetcher caches under the extension's global
	// storage (host-agnostic core defaults to an OS-temp dir when unregistered).
	// The async resolver honors the user's customStoragePath; the sync resolver
	// (cold-start disk reads) mirrors the previous globalStorage/cache behavior.
	setModelsCacheDirProvider({
		getDir: async () => getCacheDirectoryPath(ContextProxy.instance.globalStorageUri.fsPath),
		getDirSync: () => path.join(ContextProxy.instance.globalStorageUri.fsPath, "cache"),
	})

	// The storage base-path logic lives in host-agnostic core; register the VS Code
	// resolver that reads the user's `customStoragePath` setting (headless hosts
	// leave this unset and fall back to the default global-storage path).
	setCustomStoragePathResolver(getConfiguredCustomStoragePath)

	// Register the "native" (host-dependent) API handlers that cannot live in
	// host-agnostic @shofer/core: vscode-lm (VS Code Language Model API) and
	// openai-codex (extension-owned OAuth). buildApiHandler (in core) looks these
	// up by provider name; headless callers that never register them get a clear
	// "requires the VS Code host" error instead of a missing-provider crash.
	registerNativeApiHandler("vscode-lm", (o) => new VsCodeLmHandler(o))
	registerNativeApiHandler("openai-codex", (o) => new OpenAiCodexHandler(o))

	// Register the host factory the portable Task core uses to obtain the MCP hub.
	// The lifecycle owner (McpServerManager) needs a vscode.ExtensionContext and the
	// concrete ShoferProvider, neither of which core may depend on; core calls this
	// registered factory instead. Headless hosts leave it unset (no MCP).
	setMcpHubFactory(async (provider) =>
		McpServerManager.getInstance(
			provider.context as Parameters<typeof McpServerManager.getInstance>[0],
			provider as unknown as Parameters<typeof McpServerManager.getInstance>[1],
		),
	)

	context.subscriptions.push(outputChannel)
	setMcpOutputChannel(outputChannel)
	outputChannel.appendLine(`${Package.name} extension activated - ${JSON.stringify(Package)}`)

	// Initialize network proxy configuration early, before any network requests.
	// When proxyUrl is configured, all HTTP/HTTPS traffic will be routed through it.
	// Only applied in debug mode (F5).
	await initializeNetworkProxy(context, outputChannel)

	// Set extension path for custom tool registry to find bundled esbuild
	customToolRegistry.setExtensionPath(context.extensionPath)

	// Initialize telemetry service.
	const telemetryService = TelemetryService.createInstance()

	try {
		telemetryService.register(new PostHogTelemetryClient())
	} catch (error) {
		outputChannel.appendLine(`[WARN] Failed to register PostHogTelemetryClient: ${error}`)
	}

	// §8: emit the typed event catalog through OpenTelemetry. No-op until an OTel
	// SDK is registered by the host, so it is zero-overhead by default.
	try {
		telemetryService.register(new OtelTelemetryClient())
	} catch (error) {
		outputChannel.appendLine(`[WARN] Failed to register OtelTelemetryClient: ${error}`)
	}

	// §10: fan captured agent events out to plugins' `onEvent` hooks. No-op while no
	// plugins are registered.
	telemetryService.onEvent((name, properties) =>
		pluginRegistry.dispatchEvent({ name, properties, timestamp: Date.now() }),
	)

	// Initialize i18n for internationalization support.
	initializeI18n(context.globalState.get("language") ?? formatLanguage(vscode.env.language))

	// Initialize terminal shell execution handlers.
	TerminalRegistry.initialize()

	// Initialize OpenAI Codex OAuth manager for ChatGPT subscription-based access.
	openAiCodexOAuthManager.initialize(context, (message) => outputChannel.appendLine(message))

	// Seed the default auto-approve allowlist into globalState (the single source of
	// truth) on first run. The default moved here from the removed
	// `shofer.allowedCommands` VS Code config default (config-cleanup.md Part A/D3).
	if (!context.globalState.get("allowedCommands")) {
		context.globalState.update("allowedCommands", ["git log", "git diff", "git show"])
	}

	const contextProxy = await ContextProxy.getInstance(context)

	// Let the context-free core loaders (commands/skills/rules) resolve the
	// org-global scope's standalone default (`<globalStorage>/.shofer`); the
	// SHOFER_GLOBAL_DIR env still wins when set.
	registerGlobalStorageFsPath(context.globalStorageUri.fsPath)

	// Apply `.shofer/` edits made outside this host without a restart — the mechanism a
	// multi-host workspace converges on (docs/workspace_agent_pool.md §5). Started here
	// rather than in getInstance so a unit test that builds a proxy watches nothing.
	contextProxy.startScopeWatcher()
	context.subscriptions.push({ dispose: () => contextProxy.dispose() })

	// Restore persisted logging settings onto the live transport so they
	// survive a VS Code restart.  bootstrapLogging() started the transport
	// with defaults; the ContextProxy now has the user's saved values.
	const savedLogLevel = contextProxy.getValue("logLevel") as string | undefined
	const savedLogCategories = contextProxy.getValue("logCategories") as string[] | undefined
	if (savedLogLevel) {
		setLogLevel(savedLogLevel as "debug" | "info" | "warn" | "error" | "fatal")
	}
	if (savedLogCategories !== undefined) {
		setLogCategories(savedLogCategories.length > 0 ? savedLogCategories : undefined)
	}

	const _experimentsConfig = contextProxy.getValue("experiments") ?? {}
	// Drive `when`-clause visibility for experiment-gated UI (Refresh
	// Webview / Reload Window toolbar buttons today). Re-fired by the
	// webview message handler on every experiments mutation.
	syncExperimentContextKeys(_experimentsConfig)

	const focusedTask = () => {
		const provider = ShoferProvider.getVisibleInstance()
		const id = provider?.taskManager.getFocusedTaskId()
		return id ? provider!.taskManager.getManagedTaskInstance(id) : undefined
	}

	// §8: process / task gauges as OTel observable gauges. The SDK (when the
	// host registers one) polls these callbacks at export time, so values are
	// always current without an event-loop-waking timer. No-op until an SDK is
	// registered. process.memoryUsage() is O(1).
	registry.registerObservableGauge("shofer_heap_used_bytes", "process.memoryUsage().heapUsed.", (r) =>
		r.observe(process.memoryUsage().heapUsed),
	)
	registry.registerObservableGauge("shofer_heap_total_bytes", "process.memoryUsage().heapTotal.", (r) =>
		r.observe(process.memoryUsage().heapTotal),
	)
	registry.registerObservableGauge("shofer_rss_bytes", "process.memoryUsage().rss.", (r) =>
		r.observe(process.memoryUsage().rss),
	)
	registry.registerObservableGauge(
		"shofer_event_listeners_total",
		"Number of listeners attached to ShoferProvider.",
		(r) => {
			const provider = ShoferProvider.getVisibleInstance()
			if (provider) r.observe(provider.listenerCount("ShoferEvent"))
		},
	)
	registry.registerObservableGauge("shofer_tasks_total", "Total tasks in history store.", (r) => {
		const provider = ShoferProvider.getVisibleInstance()
		if (provider) r.observe(provider.taskHistoryStore.getAll().length)
	})
	registry.registerObservableGauge("shofer_active_tasks", "Active managed tasks (abort === false).", (r) => {
		const provider = ShoferProvider.getVisibleInstance()
		if (provider) r.observe(provider.taskManager.getActiveManagedTasks().length)
	})
	registry.registerObservableGauge("shofer_messages_total", "Messages on focused task.", (r) => {
		const task = focusedTask()
		if (task) r.observe(task.shoferMessages.length)
	})
	registry.registerObservableGauge("shofer_messages_bytes", "Serialized byte size of focused task messages.", (r) => {
		const task = focusedTask()
		if (task) r.observe(Buffer.byteLength(JSON.stringify(task.shoferMessages), "utf8"))
	})

	// Initialize the provider.
	const provider = new ShoferProvider(context, outputChannel, "sidebar", contextProxy, undefined)

	// Finish initializing the provider.
	TelemetryService.instance.setProvider(provider)

	// Discover plugins before anything reads a mode, a workflow or a skill. Shofer's
	// built-in modes ship as the bundled `builtin-config` plugin, so an enumeration that
	// ran first would see — and `CustomModesManager` would then cache and persist — a
	// mode list with no modes in it. Only declarative discovery is awaited here; code
	// plugins keep loading in the background.
	await provider.getPluginManager()

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ShoferProvider.sideBarId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// ─── End Live Memory Chat View ───────────────────────────────────

	// Native TreeView used as a reliable file drop target on Desktop.  See
	// ContextDropZoneProvider for rationale.  Registered collapsed-by-default
	// via the view contribution in package.json so it stays out of the way.
	//
	// In code-server / VSCode Web the webview-root drop handler
	// (ChatView.handleWebviewDrop) receives drops onto the main chat window
	// directly — the Electron overlay that swallows those events is
	// Desktop-only — so the TreeView is redundant in web and we skip it.
	// The matching `"when": "!isWeb"` clause on the view contribution in
	// package.json keeps the view itself hidden there.
	if (vscode.env.uiKind === vscode.UIKind.Desktop) {
		const contextDropZoneProvider = new ContextDropZoneProvider()
		contextDropZoneProvider.setShoferProvider(provider)
		context.subscriptions.push(
			vscode.window.createTreeView(ContextDropZoneProvider.viewId, {
				treeDataProvider: contextDropZoneProvider,
				dragAndDropController: contextDropZoneProvider,
			}),
		)
	}

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
			contextProxy: provider.contextProxy,
			customModesManager: provider.customModesManager,
		})
	} catch (error) {
		outputChannel.appendLine(
			`[AutoImport] Error during auto-import: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	registerCommands({ context, outputChannel, provider })

	// Register custom editor for .slang files (opens as an editor tab)
	SlangEditorProvider.register(context)

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

	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register code actions provider.
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider({ pattern: "**/*" }, new CodeActionProvider(), {
			providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds,
		}),
	)

	registerCodeActions(context)
	registerTerminalActions(context)

	// Auto-open the "Get Started with Shofer" walkthrough on first install
	// (when the user has no task history yet). Uses a persisted flag so it
	// only fires once, not on every restart.
	const hasSeenWalkthrough = context.globalState.get<boolean>("shofer.hasSeenWalkthrough")
	if (!hasSeenWalkthrough) {
		// Defer slightly so the UI has time to settle after activation.
		setTimeout(() => {
			vscode.commands.executeCommand(
				"workbench.action.openWalkthrough",
				`${Package.publisher}.${Package.name}#shofer.getStarted`,
				false,
			)
		}, 500)
		await context.globalState.update("shofer.hasSeenWalkthrough", true)
	}

	// Allows other extensions to activate once Shofer is ready.
	vscode.commands.executeCommand(`${Package.name}.activationCompleted`)

	// Implements the `ShoferExtensionApi` interface.
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

	const api = new API(outputChannel, provider, socketPath, enableLogging)

	return api
}

// This method is called when your extension is deactivated.
export async function deactivate() {
	outputChannel.appendLine(`${Package.name} extension deactivated`)

	await McpServerManager.cleanup(extensionContext)
	TelemetryService.instance.shutdown()
	TerminalRegistry.cleanup()
}
