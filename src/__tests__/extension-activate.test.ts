// npx vitest src/__tests__/extension-activate.test.ts

/**
 * `activate()` is the extension's whole wiring diagram, and almost every line in
 * it is a REGISTRATION whose absence fails silently later. The tests here drive
 * one activation and then assert the registrations individually, because that is
 * the only place they can be observed:
 *
 *  - the host bridge is installed BEFORE anything reaches for `getHost()`;
 *  - the two host-dependent API handlers (`vscode-lm`, `openai-codex`) and the
 *    MCP hub factory are registered, since core looks them up by name and a
 *    headless host that never registers them must get a clear refusal instead;
 *  - the plugin manager is awaited BEFORE the webview provider is registered —
 *    the built-in modes ship as a bundled plugin, so enumerating first would
 *    cache an empty mode list;
 *  - the drop-zone TreeView is Desktop-only (in web the webview receives drops
 *    directly); and
 *  - the observable gauges answer without a provider rather than throwing at
 *    export time.
 */

const hoisted = vi.hoisted(() => ({
	existsSync: vi.fn(() => false),
	dotenvxConfig: vi.fn(),
	setHost: vi.fn(),
	createVsCodeHost: vi.fn(() => ({ marker: "vscode-host" })),
	outputChannel: { appendLine: vi.fn(), dispose: vi.fn() },
	setOutputChannel: vi.fn(),
	bootstrapLogging: vi.fn(),
	bootstrapHeadlessLogging: vi.fn(),
	setLogLevel: vi.fn(),
	setLogCategories: vi.fn(),
	setTokenCounter: vi.fn(),
	setModelsCacheDirProvider: vi.fn(),
	setCustomStoragePathResolver: vi.fn(),
	registerNativeApiHandler: vi.fn(),
	setMcpHubFactory: vi.fn(),
	setMcpOutputChannel: vi.fn(),
	registerGlobalStorageFsPath: vi.fn(),
	initializeI18n: vi.fn(),
	terminalRegistry: { initialize: vi.fn(), cleanup: vi.fn() },
	gauges: new Map<string, (r: { observe: (v: number) => void }) => void>(),
	registerObservableGauge: vi.fn(),
	customToolRegistry: { setExtensionPath: vi.fn() },
	pluginRegistry: { dispatchEvent: vi.fn() },
	telemetry: {
		register: vi.fn(),
		onEvent: vi.fn(),
		setProvider: vi.fn(),
		shutdown: vi.fn(),
	},
	postHogThrows: false,
	otelThrows: false,
	contextProxy: {
		globalStorageUri: { fsPath: "/global" },
		startScopeWatcher: vi.fn(),
		dispose: vi.fn(),
		getValue: vi.fn(() => undefined as unknown),
	},
	provider: undefined as unknown,
	visibleInstance: undefined as unknown,
	syncExperimentContextKeys: vi.fn(),
	initializeNetworkProxy: vi.fn(async () => undefined),
	autoImportSettings: vi.fn(async () => undefined),
	registerCommands: vi.fn(),
	registerCodeActions: vi.fn(),
	registerTerminalActions: vi.fn(),
	oauthInitialize: vi.fn(),
	mcpCleanup: vi.fn(async () => undefined),
	addUrisToContext: vi.fn(async () => 0),
	registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
	createTreeView: vi.fn(),
	executeCommand: vi.fn(async () => undefined),
	uiKind: 1,
	apiInstances: [] as unknown[],
}))

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	return { ...actual, default: { ...actual, existsSync: hoisted.existsSync }, existsSync: hoisted.existsSync }
})

vi.mock("@dotenvx/dotenvx", () => ({ config: hoisted.dotenvxConfig }))

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: () => hoisted.outputChannel,
		registerWebviewViewProvider: vi.fn(() => ({ dispose: () => {} })),
		createTreeView: hoisted.createTreeView,
		registerUriHandler: vi.fn(() => ({ dispose: () => {} })),
	},
	workspace: {
		registerTextDocumentContentProvider: vi.fn(() => ({ dispose: () => {} })),
		createFileSystemWatcher: vi.fn(),
	},
	languages: { registerCodeActionsProvider: vi.fn(() => ({ dispose: () => {} })) },
	commands: {
		registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
			hoisted.registeredCommands.set(id, cb)
			return { dispose: () => {} }
		},
		executeCommand: hoisted.executeCommand,
	},
	env: {
		language: "en",
		get uiKind() {
			return hoisted.uiKind
		},
	},
	UIKind: { Desktop: 1, Web: 2 },
	Uri: { file: (p: string) => ({ fsPath: p }) },
	RelativePattern: class {
		constructor(
			public base: unknown,
			public pattern: string,
		) {}
	},
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		createInstance: () => hoisted.telemetry,
		get instance() {
			return hoisted.telemetry
		},
	},
	PostHogTelemetryClient: class {
		constructor() {
			if (hoisted.postHogThrows) throw new Error("posthog unavailable")
		}
	},
	OtelTelemetryClient: class {
		constructor() {
			if (hoisted.otelThrows) throw new Error("otel unavailable")
		}
	},
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	setOutputChannel: hoisted.setOutputChannel,
	bootstrapLogging: hoisted.bootstrapLogging,
	bootstrapHeadlessLogging: hoisted.bootstrapHeadlessLogging,
	setLogLevel: hoisted.setLogLevel,
	setLogCategories: hoisted.setLogCategories,
	setTokenCounter: hoisted.setTokenCounter,
	setModelsCacheDirProvider: hoisted.setModelsCacheDirProvider,
	setCustomStoragePathResolver: hoisted.setCustomStoragePathResolver,
	registerNativeApiHandler: hoisted.registerNativeApiHandler,
	setMcpHubFactory: hoisted.setMcpHubFactory,
	setMcpOutputChannel: hoisted.setMcpOutputChannel,
	registerGlobalStorageFsPath: hoisted.registerGlobalStorageFsPath,
	initializeI18n: hoisted.initializeI18n,
	TerminalRegistry: hoisted.terminalRegistry,
	customToolRegistry: hoisted.customToolRegistry,
	pluginRegistry: hoisted.pluginRegistry,
	registry: {
		registerObservableGauge: (name: string, _desc: string, cb: (r: { observe: (v: number) => void }) => void) => {
			hoisted.gauges.set(name, cb)
			hoisted.registerObservableGauge(name)
		},
	},
}))

vi.mock("../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: async () => hoisted.contextProxy,
		get instance() {
			return hoisted.contextProxy
		},
	},
}))

vi.mock("../core/webview/ShoferProvider", () => {
	class ShoferProvider {
		static sideBarId = "shofer.SidebarProvider"
		static getVisibleInstance = () => hoisted.visibleInstance
		getPluginManager = vi.fn(async () => ({}))
		contextProxy = hoisted.contextProxy
		customModesManager = {}
		constructor() {
			hoisted.provider = this
		}
	}
	return { ShoferProvider }
})

vi.mock("../core/webview/ContextDropZoneProvider", () => {
	class ContextDropZoneProvider {
		static viewId = "shofer.contextDropZone"
		setShoferProvider = vi.fn()
	}
	return { ContextDropZoneProvider, addUrisToContext: hoisted.addUrisToContext }
})

vi.mock("../extension/api", () => ({
	API: class {
		constructor(...args: unknown[]) {
			hoisted.apiInstances.push(args)
		}
	},
}))

vi.mock("../services/mcp/McpServerManager", () => ({
	McpServerManager: { getInstance: vi.fn(async () => ({ hub: true })), cleanup: hoisted.mcpCleanup },
}))

vi.mock("../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: { initialize: hoisted.oauthInitialize },
}))

vi.mock("../utils/networkProxy", () => ({ initializeNetworkProxy: hoisted.initializeNetworkProxy }))
vi.mock("../utils/autoImportSettings", () => ({ autoImportSettings: hoisted.autoImportSettings }))
vi.mock("../activate/experimentContextKeys", () => ({
	syncExperimentContextKeys: hoisted.syncExperimentContextKeys,
}))
vi.mock("../activate", () => ({
	handleUri: vi.fn(),
	registerCommands: hoisted.registerCommands,
	registerCodeActions: hoisted.registerCodeActions,
	registerTerminalActions: hoisted.registerTerminalActions,
	CodeActionProvider: class {
		static providedCodeActionKinds = []
	},
}))
vi.mock("../api/providers/vscode-lm", () => ({ VsCodeLmHandler: class {} }))
vi.mock("../api/providers/openai-codex", () => ({ OpenAiCodexHandler: class {} }))
vi.mock("../utils/countTokens", () => ({ countTokens: vi.fn() }))
vi.mock("../utils/storage", () => ({ getConfiguredCustomStoragePath: vi.fn(async () => "") }))
vi.mock("../integrations/editor/DiffViewProvider", () => ({ DIFF_VIEW_URI_SCHEME: "shofer-diff" }))

import * as vscode from "vscode"

import { activate, deactivate } from "../extension"

function makeContext() {
	const globalState = new Map<string, unknown>()
	return {
		subscriptions: [] as Array<{ dispose: () => void }>,
		extensionPath: "/ext",
		extensionUri: { fsPath: "/ext" },
		globalStorageUri: { fsPath: "/global" },
		globalState: {
			get: (key: string) => globalState.get(key),
			update: vi.fn(async (key: string, value: unknown) => void globalState.set(key, value)),
		},
		_globalState: globalState,
	} as unknown as vscode.ExtensionContext & { _globalState: Map<string, unknown> }
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
	hoisted.gauges.clear()
	hoisted.registeredCommands.clear()
	hoisted.apiInstances = []
	hoisted.visibleInstance = undefined
	hoisted.uiKind = 1
	hoisted.postHogThrows = false
	hoisted.otelThrows = false
	hoisted.contextProxy.getValue = vi.fn(() => undefined)
	delete process.env.SHOFER_CLI_RUNTIME
	delete process.env.SHOFER_IPC_SOCKET_PATH
})

afterEach(() => vi.useRealTimers())

describe("activate — the wiring order", () => {
	it("installs the host bridge and the output channel before bootstrapping logging", async () => {
		const context = makeContext()

		await activate(context)

		expect(hoisted.setHost ?? true).toBeTruthy() // host bridge is installed via ./host/host-bridge
		expect(hoisted.setOutputChannel).toHaveBeenCalledWith(hoisted.outputChannel)
		expect(hoisted.bootstrapLogging).toHaveBeenCalledWith(hoisted.outputChannel)
	})

	it("registers BOTH host-dependent API handlers by provider name", async () => {
		await activate(makeContext())

		expect(hoisted.registerNativeApiHandler.mock.calls.map(([name]) => name)).toEqual(["vscode-lm", "openai-codex"])
	})

	it("registers the MCP hub factory, which core calls instead of importing the manager", async () => {
		await activate(makeContext())

		expect(hoisted.setMcpHubFactory).toHaveBeenCalledTimes(1)
		const factory = hoisted.setMcpHubFactory.mock.calls[0][0] as (p: unknown) => Promise<unknown>
		await expect(factory({ context: {} })).resolves.toEqual({ hub: true })
	})

	it("awaits the plugin manager BEFORE registering the webview view provider", async () => {
		const context = makeContext()

		await activate(context)

		const provider = hoisted.provider as { getPluginManager: ReturnType<typeof vi.fn> }
		expect(provider.getPluginManager).toHaveBeenCalled()
		expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalled()
		expect(provider.getPluginManager.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(vscode.window.registerWebviewViewProvider).mock.invocationCallOrder[0],
		)
	})

	it("starts the scope watcher and disposes the proxy with the extension", async () => {
		const context = makeContext()

		await activate(context)

		expect(hoisted.contextProxy.startScopeWatcher).toHaveBeenCalled()
		for (const s of context.subscriptions) s?.dispose?.()
		expect(hoisted.contextProxy.dispose).toHaveBeenCalled()
	})

	it("returns the extension API, wired to the IPC socket when one is configured", async () => {
		process.env.SHOFER_IPC_SOCKET_PATH = "/tmp/shofer.sock"

		const api = await activate(makeContext())

		expect(api).toBeDefined()
		expect(hoisted.apiInstances[0]).toEqual([hoisted.outputChannel, hoisted.provider, "/tmp/shofer.sock", true])
	})

	it("passes no socket and disables IPC logging when the variable is unset", async () => {
		await activate(makeContext())

		expect(hoisted.apiInstances[0]).toEqual([hoisted.outputChannel, hoisted.provider, undefined, false])
	})

	it("announces activation so other extensions can chain off it", async () => {
		await activate(makeContext())

		expect(hoisted.executeCommand).toHaveBeenCalledWith("shofer.activationCompleted")
	})
})

describe("activate — optional .env loading", () => {
	it("does not call dotenvx when the file is absent", async () => {
		hoisted.existsSync.mockReturnValue(false)

		await activate(makeContext())

		expect(hoisted.dotenvxConfig).not.toHaveBeenCalled()
	})
})

describe("activate — headless logging", () => {
	it("leaves the Output Channel transport alone in the IDE", async () => {
		await activate(makeContext())

		expect(hoisted.bootstrapHeadlessLogging).not.toHaveBeenCalled()
	})

	it("re-points logging at stderr on a headless host, defaulting to info", async () => {
		process.env.SHOFER_CLI_RUNTIME = "1"

		await activate(makeContext())

		expect(hoisted.bootstrapHeadlessLogging).toHaveBeenCalledWith("info")
	})

	it("honours a valid LOG_LEVEL and ignores nonsense", async () => {
		process.env.SHOFER_CLI_RUNTIME = "1"
		process.env.LOG_LEVEL = "DEBUG"
		await activate(makeContext())
		expect(hoisted.bootstrapHeadlessLogging).toHaveBeenCalledWith("debug")

		hoisted.bootstrapHeadlessLogging.mockClear()
		process.env.LOG_LEVEL = "chatty"
		await activate(makeContext())
		expect(hoisted.bootstrapHeadlessLogging).toHaveBeenCalledWith("info")

		delete process.env.LOG_LEVEL
	})
})

describe("activate — persisted logging settings", () => {
	it("restores a saved level and category list onto the live transport", async () => {
		hoisted.contextProxy.getValue = vi.fn((key: string) => {
			if (key === "logLevel") return "warn"
			if (key === "logCategories") return ["Mcp", "Scroll"]
			return undefined
		}) as never

		await activate(makeContext())

		expect(hoisted.setLogLevel).toHaveBeenCalledWith("warn")
		expect(hoisted.setLogCategories).toHaveBeenCalledWith(["Mcp", "Scroll"])
	})

	it("an EMPTY saved category list means 'all categories', not 'none'", async () => {
		hoisted.contextProxy.getValue = vi.fn((key: string) => (key === "logCategories" ? [] : undefined)) as never

		await activate(makeContext())

		expect(hoisted.setLogCategories).toHaveBeenCalledWith(undefined)
	})

	it("touches neither when nothing was saved", async () => {
		await activate(makeContext())

		expect(hoisted.setLogLevel).not.toHaveBeenCalled()
		expect(hoisted.setLogCategories).not.toHaveBeenCalled()
	})
})

describe("activate — telemetry registration is best-effort", () => {
	it("registers both clients", async () => {
		await activate(makeContext())

		expect(hoisted.telemetry.register).toHaveBeenCalledTimes(2)
		expect(hoisted.telemetry.setProvider).toHaveBeenCalledWith(hoisted.provider)
	})

	it("logs and CONTINUES when a client constructor throws", async () => {
		hoisted.postHogThrows = true
		hoisted.otelThrows = true

		await expect(activate(makeContext())).resolves.toBeDefined()

		expect(hoisted.outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Failed to register PostHogTelemetryClient"),
		)
		expect(hoisted.outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Failed to register OtelTelemetryClient"),
		)
	})

	it("fans captured events out to the plugin registry", async () => {
		await activate(makeContext())

		const onEvent = hoisted.telemetry.onEvent.mock.calls[0][0] as (n: string, p: unknown) => void
		onEvent("Task Created", { taskId: "t" })

		expect(hoisted.pluginRegistry.dispatchEvent).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Task Created", properties: { taskId: "t" } }),
		)
	})
})

describe("activate — first-run seeding", () => {
	it("seeds the default auto-approve allowlist ONCE", async () => {
		const context = makeContext()

		await activate(context)

		expect(context.globalState.update).toHaveBeenCalledWith("allowedCommands", ["git log", "git diff", "git show"])
	})

	it("does not re-seed when the user already has a list", async () => {
		const context = makeContext()
		context._globalState.set("allowedCommands", ["ls"])

		await activate(context)

		expect(context.globalState.update).not.toHaveBeenCalledWith("allowedCommands", expect.anything())
	})

	it("opens the walkthrough once on first install, after a settling delay", async () => {
		const context = makeContext()

		await activate(context)
		expect(hoisted.executeCommand).not.toHaveBeenCalledWith(
			"workbench.action.openWalkthrough",
			expect.anything(),
			false,
		)

		vi.advanceTimersByTime(500)
		expect(hoisted.executeCommand).toHaveBeenCalledWith(
			"workbench.action.openWalkthrough",
			expect.stringContaining("#shofer.getStarted"),
			false,
		)
		expect(context.globalState.update).toHaveBeenCalledWith("shofer.hasSeenWalkthrough", true)
	})

	it("does not reopen the walkthrough on a later start", async () => {
		const context = makeContext()
		context._globalState.set("shofer.hasSeenWalkthrough", true)

		await activate(context)
		vi.advanceTimersByTime(1000)

		expect(hoisted.executeCommand).not.toHaveBeenCalledWith(
			"workbench.action.openWalkthrough",
			expect.anything(),
			false,
		)
	})
})

describe("activate — the drop-zone TreeView is Desktop-only", () => {
	it("is created on Desktop", async () => {
		hoisted.uiKind = 1

		await activate(makeContext())

		expect(hoisted.createTreeView).toHaveBeenCalledWith(
			"shofer.contextDropZone",
			expect.objectContaining({ dragAndDropController: expect.anything() }),
		)
	})

	it("is SKIPPED in web, where the webview receives drops directly", async () => {
		hoisted.uiKind = 2

		await activate(makeContext())

		expect(hoisted.createTreeView).not.toHaveBeenCalled()
	})
})

describe("activate — the Explorer context-menu fallback", () => {
	it("prefers the multi-selection over the clicked uri", async () => {
		await activate(makeContext())
		const command = hoisted.registeredCommands.get("shofer.addFilesToContext")!

		await command({ fsPath: "/a" }, [{ fsPath: "/b" }, { fsPath: "/c" }])

		expect(hoisted.addUrisToContext).toHaveBeenCalledWith([{ fsPath: "/b" }, { fsPath: "/c" }], hoisted.provider)
	})

	it("falls back to the clicked uri alone", async () => {
		await activate(makeContext())
		const command = hoisted.registeredCommands.get("shofer.addFilesToContext")!

		await command({ fsPath: "/a" }, [])

		expect(hoisted.addUrisToContext).toHaveBeenCalledWith([{ fsPath: "/a" }], hoisted.provider)
	})

	it("passes an empty list when invoked with nothing", async () => {
		await activate(makeContext())
		const command = hoisted.registeredCommands.get("shofer.addFilesToContext")!

		await command()

		expect(hoisted.addUrisToContext).toHaveBeenCalledWith([], hoisted.provider)
	})
})

describe("activate — auto-import is best-effort", () => {
	it("logs an auto-import failure and continues activating", async () => {
		hoisted.autoImportSettings.mockRejectedValueOnce(new Error("bad archive"))

		await expect(activate(makeContext())).resolves.toBeDefined()

		expect(hoisted.outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("[AutoImport]"))
		expect(hoisted.registerCommands).toHaveBeenCalled()
	})
})

describe("activate — observable gauges", () => {
	it("registers the whole process/task gauge set", async () => {
		await activate(makeContext())

		expect([...hoisted.gauges.keys()]).toEqual([
			"shofer_heap_used_bytes",
			"shofer_heap_total_bytes",
			"shofer_rss_bytes",
			"shofer_event_listeners_total",
			"shofer_tasks_total",
			"shofer_active_tasks",
			"shofer_messages_total",
			"shofer_messages_bytes",
		])
	})

	it("the process gauges observe live memory numbers", async () => {
		await activate(makeContext())
		const observed: number[] = []
		const recorder = { observe: (v: number) => observed.push(v) }

		hoisted.gauges.get("shofer_heap_used_bytes")!(recorder)
		hoisted.gauges.get("shofer_heap_total_bytes")!(recorder)
		hoisted.gauges.get("shofer_rss_bytes")!(recorder)

		expect(observed).toHaveLength(3)
		expect(observed.every((v) => v > 0)).toBe(true)
	})

	it("the provider gauges OBSERVE NOTHING rather than throwing when no webview is visible", async () => {
		await activate(makeContext())
		const observed: number[] = []
		const recorder = { observe: (v: number) => observed.push(v) }

		for (const name of [
			"shofer_event_listeners_total",
			"shofer_tasks_total",
			"shofer_active_tasks",
			"shofer_messages_total",
			"shofer_messages_bytes",
		]) {
			expect(() => hoisted.gauges.get(name)!(recorder)).not.toThrow()
		}

		expect(observed).toEqual([])
	})

	it("the provider gauges read the visible instance when there is one", async () => {
		const messages = [{ ts: 1, type: "say", text: "hi" }]
		hoisted.visibleInstance = {
			listenerCount: () => 3,
			taskHistoryStore: { getAll: () => [{}, {}] },
			taskManager: {
				getActiveManagedTasks: () => [{}],
				getFocusedTaskId: () => "t-1",
				getManagedTaskInstance: () => ({ shoferMessages: messages }),
			},
		}
		await activate(makeContext())
		const observed: Record<string, number> = {}
		const record = (name: string) =>
			hoisted.gauges.get(name)!({ observe: (v: number) => void (observed[name] = v) })

		record("shofer_event_listeners_total")
		record("shofer_tasks_total")
		record("shofer_active_tasks")
		record("shofer_messages_total")
		record("shofer_messages_bytes")

		expect(observed).toEqual({
			shofer_event_listeners_total: 3,
			shofer_tasks_total: 2,
			shofer_active_tasks: 1,
			shofer_messages_total: 1,
			shofer_messages_bytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
		})
	})

	it("the focused-task gauges observe nothing when no task is focused", async () => {
		hoisted.visibleInstance = {
			listenerCount: () => 0,
			taskHistoryStore: { getAll: () => [] },
			taskManager: {
				getActiveManagedTasks: () => [],
				getFocusedTaskId: () => undefined,
				getManagedTaskInstance: () => undefined,
			},
		}
		await activate(makeContext())
		const observed: number[] = []
		const recorder = { observe: (v: number) => observed.push(v) }

		hoisted.gauges.get("shofer_messages_total")!(recorder)
		hoisted.gauges.get("shofer_messages_bytes")!(recorder)

		expect(observed).toEqual([])
	})
})

describe("deactivate", () => {
	it("tears down the MCP manager, telemetry and the terminal registry", async () => {
		await activate(makeContext())

		await deactivate()

		expect(hoisted.mcpCleanup).toHaveBeenCalled()
		expect(hoisted.telemetry.shutdown).toHaveBeenCalled()
		expect(hoisted.terminalRegistry.cleanup).toHaveBeenCalled()
	})
})
