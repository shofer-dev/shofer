// npx vitest src/core/webview/__tests__/ShoferProvider.pluginSeams.test.ts

/**
 * The host seams behind a granted plugin's `ctx.*`. Per the Core Self-Sufficiency
 * Rule everything deployment-specific lives in a plugin, so these closures are
 * the whole surface a plugin gets — and their failure modes are what a plugin
 * author experiences as an unexplainable absence:
 *
 *  - `ctx.host.search` is documented FAIL-SOFT: an absent or unconfigured
 *    rag-indexing plugin answers "no results", never an exception, so a plugin
 *    can probe for a capability without special-casing its absence.
 *  - `ctx.agent.deliver` is the ONE delivery door and it THROWS with no target
 *    rather than starting a task — a delivery must never become a billed spawn
 *    nobody asked for.
 *  - `ctx.ai.embed` refuses LOUDLY, naming the plugin to configure, because core
 *    keeps no embedder of its own.
 *  - `ctx.mcp.callTool` refuses on a host with no hub rather than reporting an
 *    empty tool result.
 */

import * as vscode from "vscode"
import type { HistoryItem, ExtensionMessage } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { ContextProxy } from "../../config/ContextProxy"
import { ShoferProvider } from "../ShoferProvider"

// Mock setup
vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	readdir: vi.fn().mockResolvedValue([]),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))

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
	SymbolKind: { 4: "Class", 11: "Function" },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	languages: { getDiagnostics: vi.fn(() => [] as unknown[]) },
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
	Task: vi.fn().mockImplementation((options: any) => {
		const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
		return {
			api: undefined,
			start: vi.fn(),
			startFromHistory: vi.fn(),
			preloadShoferMessages: vi.fn(async () => undefined),
			messagesReady: Promise.resolve(),
			mailboxReady: Promise.resolve(),
			hasMoreShoferMessages: false,
			instanceId: 1,
			cwd: "/w",
			reassignCwd: vi.fn(),
			say: vi.fn(async () => undefined),
			deliver: vi.fn(async (e: unknown) => e),
			combineMessages: (m: unknown[]) => m,
			messageManager: { rewindToTimestamp: vi.fn(async () => undefined) },
			messageQueueService: { addMessage: vi.fn() },
			cancelCurrentRequest: vi.fn(),
			abandoned: false,
			abort: false,
			isStreaming: false,
			didFinishAbortingStream: true,
			isWaitingForFirstChunk: false,
			didExecuteAttemptCompletion: false,
			on: (event: string, cb: (...args: unknown[]) => void) => {
				listeners.set(event, [...(listeners.get(event) ?? []), cb])
			},
			off: vi.fn(),
			fire: (event: string, ...args: unknown[]) => {
				for (const cb of listeners.get(event) ?? []) cb(...args)
			},
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
		}
	}),
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

import { pluginRegistry } from "@shofer/core"

const vscodeMock = vscode as unknown as {
	languages: { getDiagnostics: ReturnType<typeof vi.fn> }
	commands: { executeCommand: ReturnType<typeof vi.fn> }
	DiagnosticSeverity: Record<string, number>
}

function makeContext() {
	const globalState: Record<string, unknown> = { mode: "code", taskHistory: [] }
	const secrets: Record<string, string | undefined> = {}
	return {
		extensionPath: "/test/path",
		extensionUri: { fsPath: "/ext" } as never,
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
	} as unknown as vscode.ExtensionContext
}

async function makeProvider() {
	const context = makeContext()
	const logLines: string[] = []
	const outputChannel = { appendLine: vi.fn(), clear: vi.fn(), dispose: vi.fn() } as unknown as vscode.OutputChannel
	const contextProxy = new ContextProxy(context)
	await contextProxy.initialize()
	const provider = new ShoferProvider(context, outputChannel, "sidebar", contextProxy)
	await new Promise((resolve) => setTimeout(resolve, 10))
	vi.spyOn(provider, "log").mockImplementation((m: string) => void logLines.push(m))
	provider.postMessageToWebview = vi.fn(async () => undefined) as never
	return { provider, logLines }
}

/** The private seam builders, reached the way the plugin manager reaches them. */
function seams(provider: ShoferProvider) {
	const p = provider as unknown as {
		buildPluginAiProvider: () => Record<string, (...a: never[]) => Promise<never>>
		buildPluginMcpProvider: () => Record<string, (...a: never[]) => Promise<never>>
		buildPluginAgentProvider: () => Record<string, (...a: never[]) => never>
		buildPluginTaskProvider: () => Record<string, (...a: never[]) => Promise<never>>
		buildPluginSearchProvider: () => Record<string, (...a: never[]) => Promise<never>>
	}
	return {
		ai: p.buildPluginAiProvider(),
		mcp: p.buildPluginMcpProvider(),
		agent: p.buildPluginAgentProvider(),
		task: p.buildPluginTaskProvider(),
		search: p.buildPluginSearchProvider(),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	if (!TelemetryService.hasInstance()) {
		TelemetryService.createInstance([])
	}
	vscodeMock.languages.getDiagnostics = vi.fn(() => [])
	vscodeMock.commands.executeCommand = vi.fn(async () => undefined)
})

describe("ctx.ai", () => {
	it("builds a handler from the ACTIVE configuration when no profile is named", async () => {
		const { provider } = await makeProvider()

		await expect(seams(provider).ai.buildHandler()).resolves.toBeDefined()
	})

	it("resolves a profileRef by NAME first, then by id", async () => {
		const { provider } = await makeProvider()
		const getProfile = vi
			.spyOn(provider.providerSettingsManager, "getProfile")
			.mockRejectedValueOnce(new Error("no such name"))
			.mockResolvedValueOnce({ id: "cfg-1", name: "prod", apiProvider: "anthropic" } as never)

		await seams(provider).ai.buildHandler("cfg-1" as never)

		expect(getProfile).toHaveBeenNthCalledWith(1, { name: "cfg-1" })
		expect(getProfile).toHaveBeenNthCalledWith(2, { id: "cfg-1" })
	})

	it("REFUSES to embed when no plugin provides an embedder, naming the one to configure", async () => {
		const { provider } = await makeProvider()
		vi.spyOn(pluginRegistry, "request").mockRejectedValue(new Error("no such plugin"))

		await expect(seams(provider).ai.embed(["text"] as never)).rejects.toThrow(/RAG Indexing plugin/)
	})

	it("REFUSES an embedder that answered with nothing rather than returning an empty matrix", async () => {
		const { provider } = await makeProvider()
		vi.spyOn(pluginRegistry, "request").mockResolvedValue(undefined as never)

		await expect(seams(provider).ai.embed(["text"] as never)).rejects.toThrow(/no embedder available/)
	})

	it("returns the embeddings a plugin produced", async () => {
		const { provider } = await makeProvider()
		vi.spyOn(pluginRegistry, "request").mockResolvedValue([[0.1, 0.2]] as never)

		await expect(seams(provider).ai.embed(["text"] as never)).resolves.toEqual([[0.1, 0.2]])
	})
})

describe("ctx.mcp", () => {
	it("REFUSES on a host with no MCP hub rather than reporting an empty tool result", async () => {
		const { provider } = await makeProvider()
		vi.spyOn(provider, "getMcpHub").mockReturnValue(undefined)

		await expect(seams(provider).mcp.callTool("srv" as never, "tool" as never, {} as never)).rejects.toThrow(
			/no MCP hub/,
		)
	})

	it("passes NO source — the hub resolves whichever scope defined the server", async () => {
		const { provider } = await makeProvider()
		const callTool = vi.fn(async () => ({ content: [] }))
		vi.spyOn(provider, "getMcpHub").mockReturnValue({ callTool } as never)

		await seams(provider).mcp.callTool(
			"srv" as never,
			"tool" as never,
			{ a: 1 } as never,
			{
				taskId: "t-1",
			} as never,
		)

		expect(callTool).toHaveBeenCalledWith("srv", "tool", { a: 1 }, undefined, "t-1", undefined, undefined)
	})
})

describe("ctx.agent", () => {
	it("deliver THROWS with no target — a delivery must never become an unasked-for spawn", async () => {
		const { provider } = await makeProvider()

		await expect(seams(provider).agent.deliver({ body: "hi" } as never)).rejects.toThrow(
			/there is nobody to deliver to/,
		)
	})

	it("registerMailboxTransport hands back an UNREGISTER function", async () => {
		const { provider } = await makeProvider()
		const transport = { plane: "mesh", canRoute: vi.fn(async () => true) }

		const unregister = seams(provider).agent.registerMailboxTransport(transport as never) as unknown as () => void
		expect(provider.mailboxTransportForPlane("mesh" as never)).toBe(transport)

		unregister()
		expect(provider.mailboxTransportForPlane("mesh" as never)).toBeUndefined()
	})

	it("findMailboxTransport offers transports IN REGISTRATION ORDER", async () => {
		const { provider } = await makeProvider()
		const first = { plane: "a", canRoute: vi.fn(async () => true) }
		const second = { plane: "b", canRoute: vi.fn(async () => true) }
		seams(provider).agent.registerMailboxTransport(first as never)
		seams(provider).agent.registerMailboxTransport(second as never)

		await expect(provider.findMailboxTransport("agent:x", "agent:me")).resolves.toBe(first)
		expect(second.canRoute).not.toHaveBeenCalled()
	})

	it("SKIPS a transport whose canRoute throws rather than failing the whole send", async () => {
		const { provider, logLines } = await makeProvider()
		const broken = {
			plane: "a",
			canRoute: vi.fn(async () => {
				throw new Error("directory down")
			}),
		}
		const good = { plane: "b", canRoute: vi.fn(async () => true) }
		seams(provider).agent.registerMailboxTransport(broken as never)
		seams(provider).agent.registerMailboxTransport(good as never)

		await expect(provider.findMailboxTransport("agent:x", "agent:me")).resolves.toBe(good)
		expect(logLines.join(" ")).toContain("failed canRoute")
	})

	it("mailboxRoutingUnavailable takes the FIRST reason offered, skipping transports that have none", async () => {
		const { provider } = await makeProvider()
		seams(provider).agent.registerMailboxTransport({ plane: "a", canRoute: async () => false } as never)
		seams(provider).agent.registerMailboxTransport({
			plane: "b",
			canRoute: async () => false,
			unavailableReason: async () => "the agent directory is unreachable",
		} as never)

		await expect(provider.mailboxRoutingUnavailable("agent:x", "agent:me")).resolves.toBe(
			"the agent directory is unreachable",
		)
	})

	it("mailboxRoutingUnavailable DEGRADES to no reason when the diagnosis itself fails", async () => {
		const { provider, logLines } = await makeProvider()
		seams(provider).agent.registerMailboxTransport({
			plane: "a",
			canRoute: async () => false,
			unavailableReason: async () => {
				throw new Error("also down")
			},
		} as never)

		await expect(provider.mailboxRoutingUnavailable("agent:x", "agent:me")).resolves.toBeUndefined()
		expect(logLines.join(" ")).toContain("failed unavailableReason")
	})

	it("mailboxRoutingUnavailable ignores a transport that answered with no reason", async () => {
		const { provider } = await makeProvider()
		seams(provider).agent.registerMailboxTransport({
			plane: "a",
			canRoute: async () => false,
			unavailableReason: async () => undefined,
		} as never)

		await expect(provider.mailboxRoutingUnavailable("agent:x", "agent:me")).resolves.toBeUndefined()
	})

	it("cancel is a no-op for a task this host does not hold", async () => {
		const { provider } = await makeProvider()

		await expect(seams(provider).agent.cancel("ghost" as never)).resolves.toBeUndefined()
	})
})

describe("ctx.task", () => {
	it("marker REFUSES when there is no task to append to", async () => {
		const { provider } = await makeProvider()

		await expect(seams(provider).task.marker("p" as never, { text: "x" } as never)).rejects.toThrow(
			/no task to append to/,
		)
	})

	it("listMarkers answers EMPTY when there is neither a live task nor an id", async () => {
		const { provider } = await makeProvider()

		await expect(seams(provider).task.listMarkers("p" as never)).resolves.toEqual([])
	})

	it("listMarkers reads a DORMANT task's markers off the PERSISTED transcript", async () => {
		const { provider } = await makeProvider()
		const core = await import("@shofer/core")
		vi.spyOn(core, "readTaskMessages").mockResolvedValue([
			{ ts: 1, type: "say", say: "plugin_marker", text: "mine", marker: { pluginName: "p", kind: "k" } },
			{ ts: 2, type: "say", say: "plugin_marker", text: "theirs", marker: { pluginName: "other", kind: "k" } },
			{ ts: 3, type: "say", say: "text", text: "chatter" },
		] as never)

		const markers = (await seams(provider).task.listMarkers("p" as never, "t-9" as never)) as Array<
			Record<string, unknown>
		>

		expect(markers).toEqual([
			{
				ts: 1,
				pluginName: "p",
				kind: "k",
				text: "mine",
				data: undefined,
				restorable: undefined,
				suppress: undefined,
			},
		])
	})

	it("setCwd REFUSES when there is no task to re-point", async () => {
		const { provider } = await makeProvider()

		await expect(seams(provider).task.setCwd("p" as never, "/other" as never)).rejects.toThrow(
			/no task to re-point/,
		)
	})

	it("rewind REFUSES with no current task", async () => {
		const { provider } = await makeProvider()

		await expect(seams(provider).task.rewind("p" as never, 1 as never)).rejects.toThrow(/no current task/)
	})

	it("openTask REFUSES when the host could not create one", async () => {
		const { provider } = await makeProvider()
		vi.spyOn(provider, "createManagedTask").mockResolvedValue(undefined as never)

		await expect(seams(provider).task.openTask("p" as never, {} as never)).rejects.toThrow(
			/could not create a task/,
		)
	})

	it("openTask returns the id, and logs where it landed", async () => {
		const { provider, logLines } = await makeProvider()
		vi.spyOn(provider, "createManagedTask").mockResolvedValue("t-new" as never)

		await expect(
			seams(provider).task.openTask("p" as never, { name: "n", cwd: "/worktree" } as never),
		).resolves.toBe("t-new")
		expect(logLines.join(" ")).toContain("opened task t-new in /worktree")
	})
})

describe("ctx.host.search is fail-soft", () => {
	it("ragSearch answers EMPTY when no plugin provides an index", async () => {
		const { provider } = await makeProvider()
		vi.spyOn(pluginRegistry, "request").mockRejectedValue(new Error("no such plugin"))

		await expect(seams(provider).search.ragSearch("query" as never)).resolves.toEqual([])
	})

	it("ragSearch fills in DEFAULTS for a result missing its payload fields", async () => {
		const { provider } = await makeProvider()
		vi.spyOn(pluginRegistry, "request").mockResolvedValue([{}] as never)

		await expect(seams(provider).search.ragSearch("query" as never)).resolves.toEqual([
			{ filePath: "", startLine: 0, endLine: 0, score: 0, snippet: "" },
		])
	})

	it("ragSearch TRUNCATES a snippet so one result cannot flood a prompt", async () => {
		const { provider } = await makeProvider()
		vi.spyOn(pluginRegistry, "request").mockResolvedValue([
			{ score: 0.9, payload: { filePath: "a.ts", startLine: 1, endLine: 2, codeChunk: "x".repeat(2000) } },
		] as never)

		const [result] = (await seams(provider).search.ragSearch("query" as never)) as Array<{ snippet: string }>

		expect(result.snippet).toHaveLength(800)
	})

	it("gitSearch answers empty when no plugin provides it, and maps a commit otherwise", async () => {
		const { provider } = await makeProvider()
		const request = vi.spyOn(pluginRegistry, "request").mockRejectedValueOnce(new Error("absent"))
		await expect(seams(provider).search.gitSearch("query" as never)).resolves.toEqual([])

		request.mockResolvedValueOnce([
			{
				score: 0.5,
				payload: {
					commit_hash: "abcdef0",
					short_hash: "abcdef",
					author: "a",
					author_date: "2026-01-01",
					subject: "fix",
				},
			},
		] as never)

		await expect(seams(provider).search.gitSearch("query" as never)).resolves.toEqual([
			{
				commitHash: "abcdef0",
				shortHash: "abcdef",
				author: "a",
				authorDate: "2026-01-01",
				subject: "fix",
				body: "",
				score: 0.5,
			},
		])
	})

	it("codeUsages answers empty when no symbol provider replies", async () => {
		const { provider } = await makeProvider()

		await expect(seams(provider).search.codeUsages("Foo" as never)).resolves.toEqual([])
	})

	it("codeUsages reports the symbol KIND and a ONE-BASED line", async () => {
		const { provider } = await makeProvider()
		vscodeMock.commands.executeCommand = vi.fn(async () => [
			{ name: "Foo", kind: 4, location: { uri: { fsPath: "/w/a.ts" }, range: { start: { line: 4 } } } },
		])

		const [usage] = (await seams(provider).search.codeUsages("Foo" as never)) as Array<Record<string, unknown>>

		expect(usage).toMatchObject({ name: "Foo", kind: "Class", line: 5 })
	})

	it("codeUsages honours the path filter and the result cap", async () => {
		const { provider } = await makeProvider()
		vscodeMock.commands.executeCommand = vi.fn(async () => [
			{ name: "A", kind: 4, location: { uri: { fsPath: "/w/a.ts" }, range: { start: { line: 0 } } } },
			{ name: "B", kind: 4, location: { uri: { fsPath: "/w/b.ts" }, range: { start: { line: 0 } } } },
		])

		const all = (await seams(provider).search.codeUsages("x" as never, { maxResults: 1 } as never)) as unknown[]

		expect(all).toHaveLength(1)
	})

	it("diagnostics maps every severity and reports ONE-BASED positions", async () => {
		const { provider } = await makeProvider()
		vscodeMock.languages.getDiagnostics = vi.fn(() => [
			[
				{ fsPath: "/w/a.ts" },
				[
					{ range: { start: { line: 0, character: 3 } }, severity: 0, message: "err", source: "ts" },
					{ range: { start: { line: 1, character: 0 } }, severity: 1, message: "warn" },
					{ range: { start: { line: 2, character: 0 } }, severity: 2, message: "info" },
					{ range: { start: { line: 3, character: 0 } }, severity: 3, message: "hint" },
				],
			],
		])

		const out = (await seams(provider).search.diagnostics()) as Array<Record<string, unknown>>

		expect(out[0]).toMatchObject({ line: 1, column: 4, severity: "error", message: "err", source: "ts" })
		expect(out.map((d) => d.severity)).toEqual(["error", "warning", "info", "hint"])
	})

	it("diagnostics honours a path filter", async () => {
		const { provider } = await makeProvider()
		vscodeMock.languages.getDiagnostics = vi.fn(() => [
			[{ fsPath: "/w/a.ts" }, [{ range: { start: { line: 0, character: 0 } }, severity: 0, message: "a" }]],
			[{ fsPath: "/w/b.ts" }, [{ range: { start: { line: 0, character: 0 } }, severity: 0, message: "b" }]],
		])

		const out = (await seams(provider).search.diagnostics("/w/b.ts" as never)) as unknown[]

		expect(out).toHaveLength(1)
	})
})

describe("the Plugins panel state", () => {
	function fakeManager(overrides: Record<string, unknown> = {}) {
		return {
			listPlugins: () => (overrides.plugins as unknown[]) ?? [],
			isAiConsented: () => Boolean(overrides.aiConsented),
			setEnabled: vi.fn(async () => undefined),
			setAiConsent: vi.fn(async () => undefined),
			reloadPlugin: vi.fn(async () => undefined),
			uninstall: vi.fn(async () => undefined),
			getUiAssetRoots: () => [],
			getContributedUiContributions: () => [],
			getContributedLocales: async () => [],
			...overrides,
		}
	}

	function plugin(overrides: Record<string, unknown> = {}) {
		return {
			name: "live-memory",
			version: "1.0.0",
			description: "d",
			scope: "global",
			firstParty: false,
			readOnly: false,
			enabled: true,
			hasCode: true,
			contributionCounts: {},
			manifest: {},
			...overrides,
		}
	}

	async function withManager(manager: ReturnType<typeof fakeManager>) {
		const { provider } = await makeProvider()
		vi.spyOn(provider, "getPluginManager").mockResolvedValue(manager as never)
		const posted: Array<Record<string, unknown>> = []
		provider.postMessageToWebview = vi.fn(async (m: unknown) => {
			posted.push(m as Record<string, unknown>)
		}) as never
		return { provider, posted }
	}

	it("projects each plugin onto the panel's view model", async () => {
		const { provider, posted } = await withManager(fakeManager({ plugins: [plugin()] }))

		await provider.pushPluginsState()

		const state = posted.find((m) => m.type === "plugins")!.plugins as { plugins: Array<Record<string, unknown>> }
		expect(state.plugins[0]).toMatchObject({
			name: "live-memory",
			version: "1.0.0",
			scope: "global",
			enabled: true,
			usesAi: false,
			aiConsented: false,
		})
	})

	it("marks a plugin that asks for BILLED AI, and reports its consent separately", async () => {
		const { provider, posted } = await withManager(
			fakeManager({ plugins: [plugin({ manifest: { permissions: { ai: true } } })], aiConsented: true }),
		)

		await provider.pushPluginsState()

		const state = posted.find((m) => m.type === "plugins")!.plugins as { plugins: Array<Record<string, unknown>> }
		expect(state.plugins[0]).toMatchObject({ usesAi: true, aiConsented: true })
	})

	it("surfaces WHY an enabled plugin is inactive, so the panel can say so", async () => {
		const { provider, posted } = await withManager(
			fakeManager({ plugins: [plugin({ disabledReason: "unmet dependency: basics" })] }),
		)

		await provider.pushPluginsState()

		const state = posted.find((m) => m.type === "plugins")!.plugins as { plugins: Array<Record<string, unknown>> }
		expect(state.plugins[0].disabledReason).toBe("unmet dependency: basics")
	})

	it("NEVER ships a secret's value — only whether one is stored", async () => {
		const { provider, posted } = await withManager(
			fakeManager({
				plugins: [
					plugin({
						manifest: { config: { properties: { apiKey: { type: "string", secret: true } } } },
					}),
				],
			}),
		)

		await provider.pushPluginsState()

		const state = posted.find((m) => m.type === "plugins")!.plugins as { plugins: Array<Record<string, unknown>> }
		expect(JSON.stringify(state.plugins[0].config)).not.toContain("sk-")
	})

	it("handlePluginRequest('list') just re-pushes the state", async () => {
		const manager = fakeManager({ plugins: [plugin()] })
		const { provider, posted } = await withManager(manager)

		await provider.handlePluginRequest({ action: "list" } as never)

		expect(posted.some((m) => m.type === "plugins")).toBe(true)
	})

	it("setEnabled toggles the plugin and RE-SYNCS the discovery-dependent subsystems", async () => {
		const manager = fakeManager({ plugins: [plugin()] })
		const { provider } = await withManager(manager)
		const invalidate = vi.spyOn(provider.customModesManager, "invalidateCache").mockImplementation(() => undefined)

		await provider.handlePluginRequest({ action: "setEnabled", name: "live-memory", enabled: false } as never)

		expect(manager.setEnabled).toHaveBeenCalledWith("live-memory", false)
		expect(invalidate).toHaveBeenCalled()
	})

	it("setAiConsent records the separate consent gate", async () => {
		const manager = fakeManager({ plugins: [plugin()] })
		const { provider } = await withManager(manager)

		await provider.handlePluginRequest({ action: "setAiConsent", name: "live-memory", consented: true } as never)

		expect(manager.setAiConsent).toHaveBeenCalledWith("live-memory", true)
	})

	it("uninstall removes the plugin and re-syncs", async () => {
		const manager = fakeManager({ plugins: [plugin()] })
		const { provider } = await withManager(manager)

		await provider.handlePluginRequest({ action: "uninstall", name: "live-memory" } as never)

		expect(manager.uninstall).toHaveBeenCalledWith("live-memory")
	})

	it("setConfig persists the PLAIN half and reloads the plugin so ctx.config is live", async () => {
		const manager = fakeManager({
			plugins: [plugin({ manifest: { config: { properties: { endpoint: { type: "string" } } } } })],
		})
		const { provider } = await withManager(manager)

		await provider.handlePluginRequest({
			action: "setConfig",
			name: "live-memory",
			config: { endpoint: "https://x" },
		} as never)

		expect(provider.getValue("pluginConfigs")).toEqual({ "live-memory": { endpoint: "https://x" } })
		expect(manager.reloadPlugin).toHaveBeenCalledWith("live-memory")
	})

	it("setConfig SPLITS a declared secret out of the stored config", async () => {
		const manager = fakeManager({
			plugins: [
				plugin({
					manifest: {
						config: {
							properties: { endpoint: { type: "string" }, apiKey: { type: "string", secret: true } },
						},
					},
				}),
			],
		})
		const { provider } = await withManager(manager)

		await provider.handlePluginRequest({
			action: "setConfig",
			name: "live-memory",
			config: { endpoint: "https://x", apiKey: "sk-secret" },
		} as never)

		expect(JSON.stringify(provider.getValue("pluginConfigs"))).not.toContain("sk-secret")
	})
})

describe("ctx.agent.spawn", () => {
	async function spawnHarness() {
		const { provider } = await makeProvider()
		vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([] as never)
		return { provider, agent: seams(provider).agent }
	}

	it("VALIDATES a caller-named mode against the effective mode list before spawning", async () => {
		const { provider, agent } = await spawnHarness()
		const getCustomModes = vi.spyOn(provider.customModesManager, "getCustomModes")

		await agent.spawn("do it" as never, { mode: "code" } as never)

		expect(getCustomModes).toHaveBeenCalled()
	})

	it("returns a HANDLE whose result settles with the agent's own answer", async () => {
		const { agent } = await spawnHarness()

		const handle = (await agent.spawn("do it" as never, {} as never)) as unknown as {
			taskId: string
			result: () => Promise<Record<string, unknown>>
		}
		const task = (await import("@shofer/core")).Task as unknown as { mock: { results: Array<{ value: never }> } }
		const instance = task.mock.results.at(-1)!.value as unknown as {
			fire: (e: string, ...a: unknown[]) => void
			shoferMessages: Array<Record<string, unknown>>
		}
		instance.shoferMessages.push({ ts: 1, type: "say", say: "completion_result", text: '{"score":9}' })
		instance.fire("taskCompleted")

		await expect(handle.result()).resolves.toMatchObject({
			status: "completed",
			output: '{"score":9}',
		})
	})

	it("settles ABORTED when the task is torn down instead", async () => {
		const { agent } = await spawnHarness()

		const handle = (await agent.spawn("do it" as never, { metadata: { job: "j-1" } } as never)) as unknown as {
			result: () => Promise<Record<string, unknown>>
		}
		const task = (await import("@shofer/core")).Task as unknown as { mock: { results: Array<{ value: never }> } }
		const instance = task.mock.results.at(-1)!.value as unknown as { fire: (e: string) => void }
		instance.fire("taskAborted")

		await expect(handle.result()).resolves.toMatchObject({ status: "aborted", metadata: { job: "j-1" } })
	})

	it("onEvent projects the task's message stream, and hands back an unsubscribe", async () => {
		const { agent } = await spawnHarness()

		const handle = (await agent.spawn("do it" as never, {} as never)) as unknown as {
			onEvent: (cb: (e: Record<string, unknown>) => void) => () => void
		}
		const seen: Array<Record<string, unknown>> = []
		const unsubscribe = handle.onEvent((event) => seen.push(event))

		const task = (await import("@shofer/core")).Task as unknown as { mock: { results: Array<{ value: never }> } }
		const instance = task.mock.results.at(-1)!.value as unknown as { fire: (e: string, ...a: unknown[]) => void }
		instance.fire("message", { action: "created" })

		expect(seen[0]).toMatchObject({ properties: { action: "created" } })
		expect(unsubscribe).toBeTypeOf("function")
		unsubscribe()
	})

	it("cancel tears the spawned task down destructively", async () => {
		const { agent } = await spawnHarness()

		const handle = (await agent.spawn("do it" as never, {} as never)) as unknown as { cancel: () => Promise<void> }
		await handle.cancel()

		const task = (await import("@shofer/core")).Task as unknown as { mock: { results: Array<{ value: never }> } }
		const instance = task.mock.results.at(-1)!.value as unknown as { abortTask: ReturnType<typeof vi.fn> }
		expect(instance.abortTask).toHaveBeenCalledWith(true)
	})
})

describe("ctx.task write paths", () => {
	it("marker appends a NON-INTERACTIVE row tagged with the owning plugin", async () => {
		const { provider } = await makeProvider()
		const task = await provider.createTask("seed")
		void task

		await seams(provider).task.marker("live-memory" as never, { text: "checkpoint", kind: "snapshot" } as never)

		const say = (provider.getCurrentTask() as unknown as { say: ReturnType<typeof vi.fn> }).say
		expect(say).toHaveBeenCalledWith(
			"plugin_marker",
			"checkpoint",
			undefined,
			undefined,
			undefined,
			expect.objectContaining({
				isNonInteractive: true,
				marker: expect.objectContaining({ pluginName: "live-memory", kind: "snapshot" }),
			}),
		)
	})

	it("listMarkers reads the LIVE task's own markers", async () => {
		const { provider } = await makeProvider()
		await provider.createTask("seed")
		const current = provider.getCurrentTask() as unknown as { shoferMessages: Array<Record<string, unknown>> }
		current.shoferMessages.push({
			ts: 1,
			type: "say",
			say: "plugin_marker",
			text: "mine",
			marker: { pluginName: "live-memory", kind: "k" },
		})

		const markers = (await seams(provider).task.listMarkers("live-memory" as never)) as unknown[]

		expect(markers).toHaveLength(1)
	})

	it("setCwd re-points the task and PERSISTS the new directory", async () => {
		const { provider } = await makeProvider()
		await provider.createTask("seed")
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({ historyItem: { id: "t-1" } } as never)
		const update = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([] as never)

		await seams(provider).task.setCwd("live-memory" as never, "/worktree" as never)

		const reassign = (provider.getCurrentTask() as unknown as { reassignCwd: ReturnType<typeof vi.fn> }).reassignCwd
		expect(reassign).toHaveBeenCalledWith("/worktree")
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/worktree" }))
	})

	it("setCwd still re-points a task that has no history row yet", async () => {
		const { provider } = await makeProvider()
		await provider.createTask("seed")
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("Task not found"))

		await expect(seams(provider).task.setCwd("live-memory" as never, "/worktree" as never)).resolves.toBeUndefined()
	})

	it("rewind REFUSES a timestamp the transcript does not carry", async () => {
		const { provider } = await makeProvider()
		await provider.createTask("seed")

		await expect(seams(provider).task.rewind("live-memory" as never, 999 as never)).rejects.toThrow(
			/no message at ts 999/,
		)
	})

	it("rewind ACCOUNTS for the discarded cost before truncating, then restarts the loop", async () => {
		const { provider } = await makeProvider()
		await provider.createTask("seed")
		const current = provider.getCurrentTask() as unknown as {
			shoferMessages: Array<Record<string, unknown>>
			messageManager: { rewindToTimestamp: ReturnType<typeof vi.fn> }
			say: ReturnType<typeof vi.fn>
		}
		current.shoferMessages.push({ ts: 10, type: "say", say: "text", text: "keep" })
		current.shoferMessages.push({ ts: 20, type: "say", say: "text", text: "discard" })

		await seams(provider).task.rewind("live-memory" as never, 10 as never)

		expect(current.messageManager.rewindToTimestamp).toHaveBeenCalledWith(10, { includeTargetMessage: false })
		expect(current.say).toHaveBeenCalledWith("api_req_deleted", expect.any(String))
	})
})

describe("plugin config reloads", () => {
	it("reloadPlugins is a no-op for an empty list", async () => {
		const { provider } = await makeProvider()
		const getManager = vi.spyOn(provider, "getPluginManager")

		await provider.reloadPlugins([])

		expect(getManager).not.toHaveBeenCalled()
	})

	it("reloadPlugins CONTINUES past a plugin that fails to reload", async () => {
		const { provider, logLines } = await makeProvider()
		const reloadPlugin = vi.fn().mockRejectedValueOnce(new Error("bad module")).mockResolvedValueOnce(undefined)
		vi.spyOn(provider, "getPluginManager").mockResolvedValue({
			reloadPlugin,
			listPlugins: () => [],
			getUiAssetRoots: () => [],
			getContributedUiContributions: () => [],
			getContributedLocales: async () => [],
		} as never)

		await provider.reloadPlugins(["a", "b"])

		expect(reloadPlugin).toHaveBeenCalledTimes(2)
		expect(logLines.join(" ")).toContain("reload after config sync failed for a")
	})
})
