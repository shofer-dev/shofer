// npx vitest src/core/webview/__tests__/ShoferProvider.exportAndPluginUi.test.ts

/**
 * Two provider surfaces that leave the extension: the task EXPORTERS and the
 * plugin-UI channel. Both are "assemble something, hand it to someone else", and
 * both fail quietly when they regress — an export writes a file the user opens
 * later, and a plugin UI message goes to a component nobody is watching from
 * here.
 *
 * The invariants the groups below carry:
 *
 *  - **A web host cannot be handed a save dialog.** `showSaveDialog` on
 *    code-server writes to the SERVER, so every exporter offers a browser
 *    download whose bytes travel over the webview bridge instead.
 *  - **A cancelled JSON export is ABANDONED, not saved.** The walker returns a
 *    partial tree, and prompting to save it would silently produce a truncated
 *    trace that looks complete.
 *  - **A plugin UI REQUEST is answered, always.** `resolvePluginUiRequest` posts
 *    a response for the failure case too; a plugin whose request neither
 *    resolves nor rejects hangs its own panel forever.
 *  - **`postPluginUiMessage` fans out to BOTH surfaces** — the sidebar webview
 *    and any standalone panel — because a plugin's `ctx.ui` push has no idea
 *    which one its component is mounted in.
 *
 * The mock preamble and harness are shared with
 * `ShoferProvider.publicSurface.test.ts`.
 */

import * as vscode from "vscode"
import { TelemetryService } from "@shofer/telemetry"

import { ContextProxy } from "../../config/ContextProxy"
import { ShoferProvider } from "../ShoferProvider"

// Mock setup
vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

// `ShoferProvider` reaches `fs/promises` both ways — a namespace default import
// for the export temp-file dance and named imports elsewhere — so the double has
// to answer to both spellings over ONE set of spies.
vi.mock("fs/promises", () => {
	const api = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue(""),
		readdir: vi.fn().mockResolvedValue([]),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		access: vi.fn().mockResolvedValue(undefined),
		rm: vi.fn().mockResolvedValue(undefined),
	}
	return { ...api, default: api }
})

vi.mock("axios", () => ({
	default: {
		get: vi.fn().mockResolvedValue({ data: { data: [] } }),
		post: vi.fn(),
	},
	get: vi.fn().mockResolvedValue({ data: { data: [] } }),
	post: vi.fn(),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
	CallToolResultSchema: {},
	ListResourcesResultSchema: {},
	ListResourceTemplatesResultSchema: {},
	ListToolsResultSchema: {},
	ReadResourceResultSchema: {},
	ErrorCode: {
		InvalidRequest: "InvalidRequest",
		MethodNotFound: "MethodNotFound",
		InternalError: "InternalError",
	},
	McpError: class McpError extends Error {
		code: string
		constructor(code: string, message: string) {
			super(message)
			this.code = code
			this.name = "McpError"
		}
	},
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		listTools: vi.fn().mockResolvedValue({ tools: [] }),
		callTool: vi.fn().mockResolvedValue({ content: [] }),
	})),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(() => ({
		connect: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: {
		// Real enough for the webview document builder, which joins asset paths
		// and hands the result to `asWebviewUri`.
		joinPath: (base: { fsPath?: string }, ...parts: string[]) => {
			const fsPath = [base?.fsPath ?? "/ext", ...parts].join("/")
			return { fsPath, path: fsPath, toString: () => `file://${fsPath}` }
		},
		file: (p: string) => ({ fsPath: p, path: p, toString: () => `file://${p}` }),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		visibleTextEditors: [],
		tabGroups: { all: [], onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })) },
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({
			dispose: vi.fn(),
		})),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
	TreeItem: class {
		label: string
		collapsibleState: number
		constructor(label: string, collapsibleState?: number) {
			this.label = label
			this.collapsibleState = collapsibleState ?? 0
		}
	},
	TreeItemCollapsibleState: {
		None: 0,
		Collapsed: 1,
		Expanded: 2,
	},
	EventEmitter: class {
		event = vi.fn()
		fire = vi.fn()
		dispose = vi.fn()
	},
	ThemeIcon: class {
		constructor(public readonly id: string) {}
	},
	version: "1.85.0",
}))

vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		})),
	}
})

// The export helpers are the provider's collaborators here, not the subject:
// each is covered by its own suite (`integrations/misc/__tests__/export-*`), and
// standing them in is what lets these tests assert the ROUTING — which
// destination gets which bytes, and what is remembered afterwards.
const {
	pickDestination,
	saveMarkdown,
	rememberExportPath,
	resolveSaveUri,
	downloadJson,
	buildTrace,
	buildTraceTree,
	stringifyToFile,
} = vi.hoisted(() => ({
	pickDestination: vi.fn(async (): Promise<string | undefined> => "save"),
	saveMarkdown: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	rememberExportPath: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	resolveSaveUri: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ fsPath: "/default.md" })),
	downloadJson: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	buildTrace: vi.fn((..._args: unknown[]) => ({ taskId: "t-1", calls: [] })),
	buildTraceTree: vi.fn(async (..._args: unknown[]) => ({ taskId: "t-1", children: [] })),
	stringifyToFile: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
}))

vi.mock("../../../integrations/misc/export-destination", () => ({ pickExportDestination: pickDestination }))

vi.mock("../../../integrations/misc/export-markdown", () => ({
	buildTaskMarkdown: vi.fn(() => "# task"),
	getTaskFileName: vi.fn(() => "task.md"),
	saveMarkdownFile: saveMarkdown,
}))

vi.mock("../../../integrations/misc/export-json", () => ({
	buildJsonTrace: buildTrace,
	buildJsonTraceTree: buildTraceTree,
	downloadJsonTask: downloadJson,
	getJsonExportFileName: vi.fn(() => "task.json"),
}))

vi.mock("../../../utils/exportJsonWorker", () => ({ stringifyJsonToFile: stringifyToFile }))

vi.mock("../../../utils/export", () => ({
	resolveDefaultSaveUri: resolveSaveUri,
	saveLastExportPath: rememberExportPath,
}))

// The task-metadata port TaskHistoryStore writes each `history_item.json`
// through. Hoisted so the barrel mock below can hand out the SAME
// `safeWriteJson` these tests inject a failure into.
//
// These specs mock the FILE layer rather than writing to a real directory, so
// the port stands in the same way: a write goes through the mocked
// `safeWriteJson`, and nothing reads back — which is exactly how the unwritten
// `/test` paths behaved when the store called `safeWriteJson` itself.
const { mockSafeWriteJson, mockMetadataPort } = vi.hoisted(() => {
	const safeWriteJson = vi.fn().mockResolvedValue(undefined)
	return {
		mockSafeWriteJson: safeWriteJson,
		mockMetadataPort: {
			writeTaskMetadata: (item: { id: string }) => safeWriteJson(`/test/task/path/history_item.json`, item),
			readTaskMetadata: async () => undefined,
			deleteTaskMetadata: async () => {},
			listTaskMetadataIds: async () => [],
		},
	}
})

// NOTE: Task + getChangedFiles/restore*/accept* moved into @shofer/core during the v3
// carve-out. There must be a SINGLE vi.mock("@shofer/core") — a second one silently
// clobbers the first — so all of these (formerly a standalone @shofer/core mock and
// vi.mock("../../task/Task")) live in this one partial barrel mock.
vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	resolveTaskPersistence: vi.fn().mockResolvedValue(mockMetadataPort),
	Task: vi.fn().mockImplementation((options: any) => ({
		api: undefined,
		start: vi.fn(),
		startFromHistory: vi.fn(),
		preloadShoferMessages: vi.fn(async () => undefined),
		messagesReady: Promise.resolve(),
		hasMoreShoferMessages: false,
		instanceId: 1,
		costLimit: options?.historyItem?.costLimit,
		abortTask: vi.fn(),
		handleWebviewAskResponse: vi.fn(),
		shoferMessages: [],
		apiConversationHistory: [],
		overwriteShoferMessages: vi.fn(),
		overwriteApiConversationHistory: vi.fn(),
		getTaskNumber: vi.fn().mockReturnValue(0),
		setTaskNumber: vi.fn(),
		setParentTask: vi.fn(),
		setRootTask: vi.fn(),
		taskId: options?.historyItem?.id || "test-task-id",
		emit: vi.fn(),
	})),
	getChangedFiles: vi.fn().mockResolvedValue({ taskId: "", entries: [], backend: "none" }),
	restoreFile: vi.fn().mockResolvedValue(undefined),
	restoreAll: vi.fn().mockResolvedValue(undefined),
	acceptFile: vi.fn().mockResolvedValue(undefined),
	acceptAll: vi.fn().mockResolvedValue(undefined),
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	extractTextFromFile: vi.fn().mockResolvedValue("file content"),
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
	safeWriteJson: mockSafeWriteJson,
	modes: [{ slug: "code", name: "Code Mode", roleDefinition: "You are a code assistant", tools: ["read", "write"] }],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		tools: ["read", "write"],
	}),
	getGroupName: vi.fn().mockReturnValue("General Tools"),
	defaultModeSlug: "code",
}))

vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: { getInstance: vi.fn(async () => undefined), unregisterProvider: vi.fn(), cleanup: vi.fn() },
}))

import { EXPERIMENT_IDS } from "@shofer/types"

type Harness = {
	provider: ShoferProvider
	posted: ReturnType<typeof vi.fn>
	postedOfType: (type: string) => Array<Record<string, unknown>>
	globalState: Record<string, unknown>
	logLines: string[]
}

function makeContext(globalState: Record<string, unknown>) {
	const secrets: Record<string, string | undefined> = {}
	return {
		extensionPath: "/test/path",
		extensionUri: {} as never,
		globalState: {
			get: (key: string) => globalState[key],
			update: vi.fn(async (key: string, value: unknown) => void (globalState[key] = value)),
			keys: () => Object.keys(globalState),
		},
		secrets: {
			get: async (key: string) => secrets[key],
			store: async (key: string, value: string) => void (secrets[key] = value),
			delete: async (key: string) => void delete secrets[key],
		},
		workspaceState: { get: () => undefined, update: vi.fn(async () => undefined), keys: () => [] },
		subscriptions: [],
		extension: { packageJSON: { version: "1.0.0" } },
		globalStorageUri: { fsPath: "/test/storage/path" },
	} as unknown as import("vscode").ExtensionContext
}

async function makeHarness(globalStateOverrides: Record<string, unknown> = {}): Promise<Harness> {
	const globalState: Record<string, unknown> = {
		mode: "code",
		currentApiConfigName: "current-config",
		taskHistory: [],
		...globalStateOverrides,
	}
	const context = makeContext(globalState)
	const logLines: string[] = []
	const outputChannel = {
		appendLine: (line: string) => logLines.push(line),
		clear: vi.fn(),
		dispose: vi.fn(),
	} as unknown as import("vscode").OutputChannel

	// The proxy caches globalState at initialize() time; an uninitialized one
	// answers `undefined` for everything the harness seeded.
	const contextProxy = new ContextProxy(context)
	await contextProxy.initialize()

	const provider = new ShoferProvider(context, outputChannel, "sidebar", contextProxy)
	// The constructor kicks off TaskHistoryStore initialization fire-and-forget.
	await new Promise((resolve) => setTimeout(resolve, 10))

	const posted = vi.fn(async (..._args: unknown[]): Promise<void> => undefined)
	provider.postMessageToWebview = posted as never
	// `log()` goes to the shared subsystem logger, not to the output channel the
	// constructor was handed, so capture it at the provider's own seam.
	vi.spyOn(provider, "log").mockImplementation((message: string) => void logLines.push(message))

	return {
		provider,
		posted,
		postedOfType: (type: string) =>
			posted.mock.calls.map(([m]) => m as Record<string, unknown>).filter((m) => m?.type === type),
		globalState,
		logLines,
	}
}

/** A task double with just the surface the provider's stack operations touch. */
function makeTask(taskId: string, extra: Record<string, unknown> = {}) {
	return {
		taskId,
		instanceId: 1,
		parentTaskId: undefined,
		emit: vi.fn(),
		once: vi.fn(),
		off: vi.fn(),
		abortTask: vi.fn(async () => undefined),
		apiConfiguration: {},
		...extra,
	} as never
}

beforeEach(() => {
	vi.clearAllMocks()
	if (!TelemetryService.hasInstance()) {
		TelemetryService.createInstance([])
	}
})

afterEach(() => {
	// A test that times out never reaches its own `useRealTimers`, and a frozen
	// clock then hangs every later harness (which awaits a real setTimeout).
	vi.useRealTimers()
})

/** A history item the exporters can address. */
function seedHistory(id = "t-1") {
	return [{ id, ts: 1700000000000, task: "do a thing", mode: "code", childIds: [] }]
}

/**
 * `withProgress` is absent from the shared vscode mock (nothing else in the
 * preamble needs it). Both JSON export legs run inside one, so install a
 * pass-through that calls the body with a progress reporter and a token.
 */
function installWithProgress(cancelled = false) {
	const withProgress = vi.fn(
		async (
			_options: unknown,
			body: (
				progress: { report: (v: unknown) => void },
				token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => void },
			) => Promise<unknown>,
		) =>
			body(
				{ report: vi.fn() },
				{
					isCancellationRequested: cancelled,
					onCancellationRequested: (cb: () => void) => {
						if (cancelled) cb()
					},
				},
			),
	)
	;(vscode.window as unknown as Record<string, unknown>).withProgress = withProgress
	return withProgress
}

describe("markdown export", () => {
	it("streams the bytes over the webview bridge when the user picks a browser download", async () => {
		const { provider, postedOfType } = await makeHarness({ taskHistory: seedHistory() })
		pickDestination.mockResolvedValue("browser")

		await provider.exportTaskWithId("t-1")

		const [download] = postedOfType("browserDownload")
		expect(download).toBeDefined()
		expect((download.browserDownload as Record<string, unknown>).mime).toBe("text/markdown")
		// A browser download must not also open a save dialog on the server.
		expect(saveMarkdown).not.toHaveBeenCalled()
	})

	it("writes through the save dialog and REMEMBERS the directory for next time", async () => {
		const { provider } = await makeHarness({ taskHistory: seedHistory() })
		pickDestination.mockResolvedValue("save")
		saveMarkdown.mockResolvedValue({ fsPath: "/home/u/Downloads/task.md" })

		await provider.exportTaskWithId("t-1")

		expect(saveMarkdown).toHaveBeenCalled()
		expect(rememberExportPath).toHaveBeenCalledWith(expect.anything(), "lastTaskExportPath", {
			fsPath: "/home/u/Downloads/task.md",
		})
	})

	it("remembers NOTHING when the save dialog was dismissed", async () => {
		const { provider } = await makeHarness({ taskHistory: seedHistory() })
		pickDestination.mockResolvedValue("save")
		saveMarkdown.mockResolvedValue(undefined)

		await provider.exportTaskWithId("t-1")

		expect(rememberExportPath).not.toHaveBeenCalled()
	})

	it("does nothing at all when the DESTINATION picker is dismissed", async () => {
		const { provider, posted } = await makeHarness({ taskHistory: seedHistory() })
		pickDestination.mockResolvedValue(undefined)

		await provider.exportTaskWithId("t-1")

		expect(saveMarkdown).not.toHaveBeenCalled()
		expect(posted.mock.calls.filter(([m]) => (m as { type: string }).type === "browserDownload")).toHaveLength(0)
	})

	it("REFUSES a task that is not in history rather than exporting an empty file", async () => {
		const { provider } = await makeHarness({ taskHistory: [] })

		await expect(provider.exportTaskWithId("missing")).rejects.toThrow(/Task not found/)
	})
})

describe("JSON trace export", () => {
	it("ABANDONS a cancelled walk instead of offering to save a partial trace", async () => {
		const { provider } = await makeHarness({ taskHistory: seedHistory() })
		installWithProgress(true)

		await provider.exportTaskWithIdJson("t-1")

		expect(pickDestination).not.toHaveBeenCalled()
		expect(downloadJson).not.toHaveBeenCalled()
	})

	it("saves through the dialog and remembers the directory", async () => {
		const { provider } = await makeHarness({ taskHistory: seedHistory() })
		installWithProgress()
		pickDestination.mockResolvedValue("save")
		downloadJson.mockResolvedValue({ fsPath: "/home/u/Downloads/task.json" })

		await provider.exportTaskWithIdJson("t-1")

		expect(buildTraceTree).toHaveBeenCalled()
		expect(rememberExportPath).toHaveBeenCalledWith(expect.anything(), "lastTaskExportPath", {
			fsPath: "/home/u/Downloads/task.json",
		})
	})

	it("serializes a browser download through the WORKER and a temp file, then cleans up", async () => {
		const { provider, postedOfType } = await makeHarness({ taskHistory: seedHistory() })
		installWithProgress()
		pickDestination.mockResolvedValue("browser")
		const fsPromises = await import("fs/promises")
		vi.mocked(fsPromises.readFile).mockResolvedValue('{"trace":1}' as never)

		await provider.exportTaskWithIdJson("t-1")

		// Stringifying a whole descendant tree on the main thread would freeze
		// the webview, so the bytes come back off a worker-written temp file.
		expect(stringifyToFile).toHaveBeenCalled()
		expect(vi.mocked(fsPromises.unlink)).toHaveBeenCalled()
		const [download] = postedOfType("browserDownload")
		expect((download.browserDownload as Record<string, unknown>).mime).toBe("application/json")
	})

	it("stops at a dismissed destination picker", async () => {
		const { provider } = await makeHarness({ taskHistory: seedHistory() })
		installWithProgress()
		pickDestination.mockResolvedValue(undefined)

		await provider.exportTaskWithIdJson("t-1")

		expect(downloadJson).not.toHaveBeenCalled()
		expect(stringifyToFile).not.toHaveBeenCalled()
	})

	it("builds a node from persisted state, and SURVIVES unreadable ui messages", async () => {
		const { provider } = await makeHarness({ taskHistory: seedHistory() })

		const node = await (
			provider as unknown as {
				loadJsonTraceNode: (id: string) => Promise<{ trace: unknown; childIds: string[] }>
			}
		).loadJsonTraceNode("t-1")

		expect(buildTrace).toHaveBeenCalled()
		expect(node.childIds).toEqual([])
	})
})

describe("the plugin UI channel", () => {
	function makeManager(overrides: Record<string, unknown> = {}) {
		return {
			getContributedUiContributions: vi.fn(() => [] as unknown[]),
			getContributedLocales: vi.fn(async () => ({})),
			listPlugins: vi.fn(() => [] as unknown[]),
			discover: vi.fn(async () => undefined),
			setEnabled: vi.fn(async () => undefined),
			...overrides,
		}
	}

	it("pushes an EMPTY snapshot rather than skipping the message — a slot must be told it has nothing", async () => {
		const { provider, postedOfType, logLines } = await makeHarness()
		vi.spyOn(provider, "getPluginManager").mockResolvedValue(makeManager() as never)

		await provider.pushPluginUiContributions()

		const [pushed] = postedOfType("pluginUiContributions")
		expect(pushed).toBeDefined()
		expect((pushed.pluginUiContributions as { contributions: unknown[] }).contributions).toEqual([])
		expect(logLines.join(" ")).toContain("pushing 0 UI contributions")
	})

	it("names the UI-declaring plugins in the diagnostic when it pushed nothing", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider, "getPluginManager").mockResolvedValue(
			makeManager({
				listPlugins: vi.fn(() => [
					{
						name: "quiet",
						enabled: true,
						disabledReason: undefined,
						manifest: { permissions: { ui: ["x"] } },
					},
					{ name: "no-ui", enabled: true, manifest: { permissions: {} } },
				]),
			}) as never,
		)

		await provider.pushPluginUiContributions()

		expect(logLines.join(" ")).toContain("quiet(enabled=true,inactive=no)")
		expect(logLines.join(" ")).not.toContain("no-ui(")
	})

	it("carries the plugins' own LOCALES with the contributions", async () => {
		const { provider, postedOfType } = await makeHarness()
		vi.spyOn(provider, "getPluginManager").mockResolvedValue(
			makeManager({
				getContributedUiContributions: vi.fn(() => [
					{ pluginName: "p", region: "tab", componentId: "c", source: undefined },
				]),
				getContributedLocales: vi.fn(async () => ({ en: { p: { title: "P" } } })),
			}) as never,
		)

		await provider.pushPluginUiContributions()

		const [pushed] = postedOfType("pluginUiContributions")
		// A bundle cannot reach the host's catalogue, so its strings must travel
		// with it or the mounted component renders raw keys.
		expect((pushed.pluginUiContributions as { locales: unknown }).locales).toEqual({ en: { p: { title: "P" } } })
	})

	it("reports NO-SOURCE for a contribution the detached webview could not resolve", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider, "getPluginManager").mockResolvedValue(
			makeManager({
				getContributedUiContributions: vi.fn(() => [
					{ pluginName: "p", region: "tab", componentId: "c", source: undefined },
				]),
			}) as never,
		)

		await provider.pushPluginUiContributions()

		expect(logLines.join(" ")).toContain("NO-SOURCE(co-bundled fallback)")
		expect(logLines.join(" ")).toContain("DETACHED")
	})

	it("fans a host → UI message out to BOTH the webview and any standalone panel", async () => {
		const { provider, postedOfType } = await makeHarness()
		const broadcast = vi.fn()
		;(provider as unknown as { pluginPanelManager: { broadcast: unknown } }).pluginPanelManager.broadcast =
			broadcast

		await provider.postPluginUiMessage("p", { hello: true })

		const [posted] = postedOfType("pluginUiMessage")
		expect(posted.pluginUiMessage).toEqual({ pluginName: "p", message: { hello: true } })
		expect(broadcast).toHaveBeenCalledWith("p", { hello: true })
	})

	it("routes a plain UI → host message to the named plugin's observer only", async () => {
		const { provider } = await makeHarness()
		const core = await import("@shofer/core")
		const dispatch = vi.spyOn(core.pluginRegistry, "dispatchUiMessage").mockResolvedValue(undefined as never)

		await provider.handlePluginUiMessage({ pluginName: "p", message: { kind: "tick" } } as never)

		expect(dispatch).toHaveBeenCalledWith("p", { kind: "tick" })
	})

	it("ANSWERS a UI request with its result", async () => {
		const { provider, postedOfType } = await makeHarness()
		const core = await import("@shofer/core")
		vi.spyOn(core.pluginRegistry, "request").mockResolvedValue({ ok: 1 } as never)

		await provider.handlePluginUiMessage({
			pluginName: "p",
			message: { __pluginRequest: { id: "r1", method: "m", params: { a: 1 } } },
		} as never)

		const [posted] = postedOfType("pluginUiMessage")
		expect((posted.pluginUiMessage as { message: unknown }).message).toEqual({
			__pluginResponse: { id: "r1", result: { ok: 1 } },
		})
	})

	it("ANSWERS a FAILING UI request too — an unanswered request hangs the panel forever", async () => {
		const { provider, postedOfType } = await makeHarness()
		const core = await import("@shofer/core")
		vi.spyOn(core.pluginRegistry, "request").mockRejectedValue(new Error("no such method"))

		await provider.handlePluginUiMessage({
			pluginName: "p",
			message: { __pluginRequest: { id: "r2", method: "nope" } },
		} as never)

		const [posted] = postedOfType("pluginUiMessage")
		expect((posted.pluginUiMessage as { message: unknown }).message).toEqual({
			__pluginResponse: { id: "r2", error: "no such method" },
		})
	})
})

describe("installing a plugin", () => {
	function managerDouble() {
		return { discover: vi.fn(async () => undefined), setEnabled: vi.fn(async () => undefined) }
	}

	it("is a NO-OP when the file picker is cancelled", async () => {
		const { provider } = await makeHarness()
		;(vscode.window as unknown as Record<string, unknown>).showOpenDialog = vi.fn(async () => undefined)
		const manager = managerDouble()

		await (provider as unknown as { installPluginFromFile: (m: unknown) => Promise<void> }).installPluginFromFile(
			manager,
		)

		expect(manager.discover).not.toHaveBeenCalled()
	})

	it("REFUSES an empty URL with a message rather than downloading nothing", async () => {
		const { provider } = await makeHarness()
		const manager = managerDouble()

		await (
			provider as unknown as { installPluginFromUrl: (m: unknown, url: string) => Promise<void> }
		).installPluginFromUrl(manager, "   ")

		expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalledWith("Enter a plugin URL to install.")
		expect(manager.discover).not.toHaveBeenCalled()
	})

	it("surfaces a failed download as an error NOTIFICATION, never a crash", async () => {
		const { provider } = await makeHarness()
		const core = await import("@shofer/core")
		vi.spyOn(core, "installPluginFromUrl").mockRejectedValue(new Error("404"))
		const manager = managerDouble()

		await expect(
			(
				provider as unknown as { installPluginFromUrl: (m: unknown, url: string) => Promise<void> }
			).installPluginFromUrl(manager, "https://example/p.shofer-plugin"),
		).resolves.toBeUndefined()

		expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalledWith(
			expect.stringContaining("Failed to install plugin"),
		)
	})
})

describe("deleting a task", () => {
	/** History whose root `p` has child `c`, which itself has grandchild `g`. */
	function tree() {
		return [
			{ id: "p", ts: 1, task: "parent", childIds: ["c"] },
			{ id: "c", ts: 2, task: "child", childIds: ["g"] },
			{ id: "g", ts: 3, task: "grandchild", childIds: [] },
			{ id: "unrelated", ts: 4, task: "other", childIds: [] },
		]
	}

	it("CASCADES to the whole descendant tree — a deleted parent must not leave zombies", async () => {
		const { provider } = await makeHarness({ taskHistory: tree() })
		const deleteMany = vi.spyOn(
			(provider as unknown as { taskHistoryStore: { deleteMany: (ids: string[]) => Promise<void> } })
				.taskHistoryStore,
			"deleteMany",
		)

		await provider.deleteTaskWithId("p")

		expect(deleteMany).toHaveBeenCalledWith(["p", "c", "g"])
	})

	it("deletes ONLY the named task when the caller opts out of cascading", async () => {
		const { provider } = await makeHarness({ taskHistory: tree() })
		const deleteMany = vi.spyOn(
			(provider as unknown as { taskHistoryStore: { deleteMany: (ids: string[]) => Promise<void> } })
				.taskHistoryStore,
			"deleteMany",
		)

		await provider.deleteTaskWithId("p", false)

		expect(deleteMany).toHaveBeenCalledWith(["p"])
	})

	it("tears down each descendant's LIVE instance, not just its history row", async () => {
		const { provider } = await makeHarness({ taskHistory: tree() })
		const deleteManaged = vi
			.spyOn(
				(provider as unknown as { taskManager: { deleteManagedTask: (id: string) => Promise<void> } })
					.taskManager,
				"deleteManagedTask",
			)
			.mockResolvedValue(undefined)

		await provider.deleteTaskWithId("p")

		// The root itself is popped off the stack instead; the descendants are
		// what would otherwise survive in the parallel-task map.
		expect(deleteManaged.mock.calls.map(([id]) => id)).toEqual(["c", "g"])
	})

	it("survives a descendant whose history row is already gone", async () => {
		const { provider } = await makeHarness({
			taskHistory: [{ id: "p", ts: 1, task: "parent", childIds: ["ghost"] }],
		})
		const deleteMany = vi.spyOn(
			(provider as unknown as { taskHistoryStore: { deleteMany: (ids: string[]) => Promise<void> } })
				.taskHistoryStore,
			"deleteMany",
		)

		await expect(provider.deleteTaskWithId("p")).resolves.toBeUndefined()

		expect(deleteMany).toHaveBeenCalledWith(["p", "ghost"])
	})

	it("pops the CURRENT task off the stack when it is the one being deleted", async () => {
		const { provider } = await makeHarness({ taskHistory: tree() })
		const task = makeTask("p")
		await provider.addShoferToStack(task)

		await provider.deleteTaskWithId("p")

		expect(provider.getTaskStackSize()).toBe(0)
	})

	it("falls back to a state-only removal for a task with no history row", async () => {
		const { provider } = await makeHarness({ taskHistory: [] })
		const remove = vi.spyOn(provider, "deleteTaskFromState").mockResolvedValue(undefined)

		await expect(provider.deleteTaskWithId("missing")).resolves.toBeUndefined()

		expect(remove).toHaveBeenCalledWith("missing")
	})

	it("tells plugins to drop their per-task state BEFORE the directory goes", async () => {
		const { provider } = await makeHarness({ taskHistory: tree() })
		const core = await import("@shofer/core")
		const notify = vi.spyOn(core.pluginRegistry, "notifyTaskDeleted").mockResolvedValue(undefined as never)

		await provider.deleteTaskWithId("p")

		// A plugin keeps state OUTSIDE the task directory; removing the directory
		// first would orphan it with nothing left to name it.
		expect(notify.mock.calls.map(([arg]) => (arg as { taskId: string }).taskId)).toEqual(["p", "c", "g"])
	})
})

describe("the HMR document", () => {
	function makeWebview() {
		return {
			cspSource: "vscode-webview://host",
			asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `wv:/${uri.fsPath}` }),
		} as never
	}

	it("points every script at the Vite dev server and ships the shared-React import map", async () => {
		const { provider } = await makeHarness()

		const html = await (
			provider as unknown as { getHMRHtmlContent: (w: unknown) => Promise<string> }
		).getHMRHtmlContent(makeWebview())

		expect(html).toContain('<script type="importmap"')
		// A plugin bundle dynamic-imports "react"; without the map it resolves
		// nothing and the component never mounts.
		expect(html).toContain('"react":"http://localhost:5173/plugin-host/react.js"')
		expect(html).toContain('src="http://localhost:5173/src/index.tsx"')
		expect(html).toContain("@react-refresh")
	})

	it("names the configured OpenRouter origin in connect-src so the model list can load", async () => {
		const { provider } = await makeHarness({
			apiProvider: "openrouter",
			openRouterBaseUrl: "https://proxy.test/v1",
		})

		const html = await (
			provider as unknown as { getHMRHtmlContent: (w: unknown) => Promise<string> }
		).getHMRHtmlContent(makeWebview())

		expect(html).toContain("https://proxy.test")
	})

	it("FALLS BACK to the built document when no dev server answers", async () => {
		const { provider } = await makeHarness()
		const axios = (await import("axios")).default
		vi.mocked(axios.get).mockRejectedValueOnce(new Error("ECONNREFUSED"))

		const html = await (
			provider as unknown as { getHMRHtmlContent: (w: unknown) => Promise<string> }
		).getHMRHtmlContent(makeWebview())

		// The built document has no dev-server script tag at all.
		expect(html).not.toContain("@react-refresh")
		expect(html).toContain("<!DOCTYPE html>")
	})
})

describe("resuming a managed task", () => {
	it("approves an ask the task is ALREADY parked on", async () => {
		const { provider } = await makeHarness()
		const approveAsk = vi.fn()
		vi.spyOn(provider, "focusTask").mockResolvedValue(undefined as never)
		vi.spyOn(
			(provider as unknown as { taskManager: { getManagedTaskInstance: (id: string) => unknown } }).taskManager,
			"getManagedTaskInstance",
		).mockReturnValue({ resumableAsk: {}, approveAsk, once: vi.fn(), off: vi.fn() } as never)

		await provider.resumeManagedTask("t-1")

		expect(approveAsk).toHaveBeenCalled()
	})

	it("waits for TaskResumable when the ask has not landed yet, and approves only ITS task", async () => {
		const { provider } = await makeHarness()
		const approveAsk = vi.fn()
		const listeners = new Map<string, (arg: string) => void>()
		vi.spyOn(provider, "focusTask").mockResolvedValue(undefined as never)
		vi.spyOn(
			(provider as unknown as { taskManager: { getManagedTaskInstance: (id: string) => unknown } }).taskManager,
			"getManagedTaskInstance",
		).mockReturnValue({
			resumableAsk: undefined,
			approveAsk,
			once: vi.fn((event: string, cb: (arg: string) => void) => void listeners.set(event, cb)),
			off: vi.fn(),
		} as never)

		await provider.resumeManagedTask("t-1")
		expect(approveAsk).not.toHaveBeenCalled()

		listeners.get("taskResumable")?.("someone-else")
		expect(approveAsk).not.toHaveBeenCalled()

		listeners.get("taskResumable")?.("t-1")
		expect(approveAsk).toHaveBeenCalled()
	})

	it("gives up quietly when the task has no live instance", async () => {
		const { provider } = await makeHarness()
		const focus = vi.spyOn(provider, "focusTask").mockResolvedValue(undefined as never)
		vi.spyOn(
			(provider as unknown as { taskManager: { getManagedTaskInstance: (id: string) => unknown } }).taskManager,
			"getManagedTaskInstance",
		).mockReturnValue(undefined as never)

		// The diagnostic goes to `debug()`, which is off unless the debug
		// experiment is on, so the observable behaviour is the quiet return.
		await expect(provider.resumeManagedTask("t-1")).resolves.toBeUndefined()
		expect(focus).toHaveBeenCalledWith("t-1")
	})

	it("LOGS rather than throwing when the focus itself fails", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider, "focusTask").mockRejectedValue(new Error("gone"))

		await expect(provider.resumeManagedTask("t-1")).resolves.toBeUndefined()
		expect(logLines.join(" ")).toContain("Failed to resume managed task")
	})
})
