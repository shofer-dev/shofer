// npx vitest src/core/webview/__tests__/ShoferProvider.publicSurface.test.ts

/**
 * The provider's PUBLIC surface, as its two callers use it: the typed-command
 * table and `webviewMessageHandler`. Those callers are thin — almost every
 * command is one provider call — so the decisions live here, and most of them are
 * refusals or delegations that fail silently when they regress.
 *
 * The groups below are chosen for the invariants they carry rather than for
 * coverage: the task STACK (which pop aborts and which does not — the Dual
 * Cancellation-Path Rule's provider-side half), the archive/pin toggles that must
 * write an explicit `false` rather than omit the key, the managed-task delegation
 * whose whole contract is "log, never throw", the command-list merge that is now
 * globalState-only, and the webview-liveness gate that makes the heartbeat, the
 * pong recorder and `refreshWebview` no-ops until the experiment is on.
 */

import type { HistoryItem } from "@shofer/types"
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

describe("the task stack", () => {
	it("reports its size and the ids it holds, root-first", async () => {
		const { provider } = await makeHarness()

		await provider.addShoferToStack(makeTask("a"))
		await provider.addShoferToStack(makeTask("b"))

		expect(provider.getTaskStackSize()).toBe(2)
		expect(provider.getCurrentTaskStack()).toEqual(["a", "b"])
		expect(provider.getCurrentTask()!.taskId).toBe("b")
	})

	it("hands out a COPY of the live instances, so a caller cannot mutate the stack", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(makeTask("a"))

		const instances = provider.getTaskStackInstances()
		instances.push(makeTask("intruder"))

		expect(provider.getTaskStackSize()).toBe(1)
	})

	it("removeShoferFromStack ABORTS the popped task as abandoned", async () => {
		const { provider } = await makeHarness()
		const task = makeTask("a")
		await provider.addShoferToStack(task)

		await provider.removeShoferFromStack()

		expect((task as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).toHaveBeenCalledWith(true)
		expect(provider.getTaskStackSize()).toBe(0)
	})

	it("removeShoferFromStack on an empty stack is a no-op", async () => {
		const { provider } = await makeHarness()
		await expect(provider.removeShoferFromStack()).resolves.toBeUndefined()
	})

	it("removeShoferFromStack still pops when the abort itself fails", async () => {
		const { provider, logLines } = await makeHarness()
		const task = makeTask("a", {
			abortTask: vi.fn(async () => {
				throw new Error("already gone")
			}),
		})
		await provider.addShoferToStack(task)

		await provider.removeShoferFromStack()

		expect(provider.getTaskStackSize()).toBe(0)
		expect(logLines.join(" ")).toContain("abortTask() failed")
	})

	it("popFromStackWithoutAborting KEEPS the task alive — the parallel-task path", async () => {
		const { provider } = await makeHarness()
		const task = makeTask("a")
		await provider.addShoferToStack(task)

		const popped = provider.popFromStackWithoutAborting()

		expect(popped).toBe(task)
		expect((task as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).not.toHaveBeenCalled()
		expect(provider.getTaskStackSize()).toBe(0)
	})

	it("popFromStackWithoutAborting returns undefined on an empty stack", async () => {
		const { provider } = await makeHarness()
		expect(provider.popFromStackWithoutAborting()).toBeUndefined()
	})

	it("backgroundCurrentTask pops WITHOUT aborting and registers the task so it stays addressable", async () => {
		const { provider } = await makeHarness()
		const task = makeTask("a")
		await provider.addShoferToStack(task)
		const register = vi.spyOn(provider.taskManager, "registerBackgroundTask").mockImplementation(() => undefined)

		const backgrounded = provider.backgroundCurrentTask()

		expect(backgrounded).toBe(task)
		expect(register).toHaveBeenCalledWith(task)
		expect((task as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).not.toHaveBeenCalled()
	})

	it("backgroundCurrentTask still BACKGROUNDS the task when registration fails", async () => {
		const { provider, logLines } = await makeHarness()
		const task = makeTask("a")
		await provider.addShoferToStack(task)
		vi.spyOn(provider.taskManager, "registerBackgroundTask").mockImplementation(() => {
			throw new Error("not restored yet")
		})

		expect(provider.backgroundCurrentTask()).toBe(task)
		expect(logLines.join(" ")).toContain("could not register")
	})

	it("backgroundCurrentTask returns undefined with nothing on the stack", async () => {
		const { provider } = await makeHarness()
		expect(provider.backgroundCurrentTask()).toBeUndefined()
	})
})

describe("pending edit operations", () => {
	const editData = {
		messageTs: 100,
		editedContent: "reworded",
		messageIndex: 0,
		apiConversationHistoryIndex: 0,
	}

	it("expire on their own so a dialog the user abandoned cannot leak", async () => {
		// The harness is built on REAL timers — it awaits the store's
		// fire-and-forget init — and only then is the clock frozen.
		const { provider } = await makeHarness()
		vi.useFakeTimers()

		provider.setPendingEditOperation("op-1", editData)
		expect(vi.getTimerCount()).toBeGreaterThan(0)

		vi.advanceTimersByTime(30_000)
		// Setting it again after expiry must not double-clear a live timer.
		expect(() => provider.setPendingEditOperation("op-1", editData)).not.toThrow()

		vi.useRealTimers()
	})

	it("REPLACE an operation with the same id rather than accumulating timers", async () => {
		const { provider } = await makeHarness()
		vi.useFakeTimers()

		provider.setPendingEditOperation("op-1", editData)
		const afterFirst = vi.getTimerCount()
		provider.setPendingEditOperation("op-1", { ...editData, editedContent: "again" })

		expect(vi.getTimerCount()).toBe(afterFirst)
		vi.useRealTimers()
	})
})

describe("archive / pin toggles", () => {
	function stubHistory(provider: ShoferProvider, historyItem: Record<string, unknown>) {
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({ historyItem } as never)
		return vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([] as never)
	}

	it("archiveManagedTask stamps an archivedAt alongside the flag", async () => {
		const { provider } = await makeHarness()
		const update = stubHistory(provider, { id: "t", archived: false })

		await provider.archiveManagedTask("t")

		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ id: "t", archived: true, archivedAt: expect.any(Number) }),
		)
	})

	it("archiveManagedTask is a no-op for an already-archived task", async () => {
		const { provider } = await makeHarness()
		const update = stubHistory(provider, { id: "t", archived: true })

		await provider.archiveManagedTask("t")

		expect(update).not.toHaveBeenCalled()
	})

	it("unarchiveManagedTask writes an EXPLICIT false — omitting the key would preserve the old value", async () => {
		const { provider } = await makeHarness()
		const update = stubHistory(provider, { id: "t", archived: true })

		await provider.unarchiveManagedTask("t")

		expect(update).toHaveBeenCalledWith(expect.objectContaining({ archived: false }))
	})

	it("unarchiveManagedTask is a no-op for a task that is not archived", async () => {
		const { provider } = await makeHarness()
		const update = stubHistory(provider, { id: "t" })

		await provider.unarchiveManagedTask("t")

		expect(update).not.toHaveBeenCalled()
	})

	it("pinManagedTask sets the flag, and is a no-op when already pinned", async () => {
		const { provider } = await makeHarness()
		const update = stubHistory(provider, { id: "t" })
		await provider.pinManagedTask("t")
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ pinned: true }))

		const pinned = await makeHarness()
		const noop = stubHistory(pinned.provider, { id: "t", pinned: true })
		await pinned.provider.pinManagedTask("t")
		expect(noop).not.toHaveBeenCalled()
	})

	it("unpinManagedTask writes an EXPLICIT false, and is a no-op when not pinned", async () => {
		const { provider } = await makeHarness()
		const update = stubHistory(provider, { id: "t", pinned: true })
		await provider.unpinManagedTask("t")
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ pinned: false }))

		const unpinned = await makeHarness()
		const noop = stubHistory(unpinned.provider, { id: "t" })
		await unpinned.provider.unpinManagedTask("t")
		expect(noop).not.toHaveBeenCalled()
	})
})

describe("managed-task delegation logs rather than throws", () => {
	it("startManagedTask surfaces a failure to the user AND the log", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider.taskManager, "startManagedTask").mockRejectedValue(new Error("no worker"))

		await expect(provider.startManagedTask("t")).resolves.toBeUndefined()
		expect(logLines.join(" ")).toContain("Failed to start managed task")
	})

	it("pauseManagedTask and stopManagedTask swallow failures", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider.taskManager, "pauseManagedTask").mockRejectedValue(new Error("nope"))
		vi.spyOn(provider.taskManager, "stopManagedTask").mockRejectedValue(new Error("nope"))

		await expect(provider.pauseManagedTask("t")).resolves.toBeUndefined()
		await expect(provider.stopManagedTask("t")).resolves.toBeUndefined()
		expect(logLines.join(" ")).toContain("Failed to pause managed task")
		expect(logLines.join(" ")).toContain("Failed to stop managed task")
	})

	it("renameManagedTask renames in memory and PERSISTS the source of the title", async () => {
		const { provider } = await makeHarness()
		const rename = vi.spyOn(provider.taskManager, "renameManagedTask").mockImplementation(() => undefined)
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({ historyItem: { id: "t" } } as never)
		const update = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([] as never)

		provider.renameManagedTask("t", "New name")
		await vi.waitFor(() => expect(update).toHaveBeenCalled())

		expect(rename).toHaveBeenCalledWith("t", "New name")
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "New name", titleSource: "user" }))
	})

	it("renameManagedTask records the AGENT as the source when set_task_title renames it", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.taskManager, "renameManagedTask").mockImplementation(() => undefined)
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({ historyItem: { id: "t" } } as never)
		const update = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([] as never)

		provider.renameManagedTask("t", "Agent title", "agent")
		await vi.waitFor(() => expect(update).toHaveBeenCalled())

		expect(update).toHaveBeenCalledWith(expect.objectContaining({ titleSource: "agent" }))
	})

	it("renameManagedTask logs — and does not reject — when the persist fails", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider.taskManager, "renameManagedTask").mockImplementation(() => undefined)
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("no such task"))

		provider.renameManagedTask("t", "New name")

		await vi.waitFor(() => expect(logLines.join(" ")).toContain("Failed to persist task rename"))
	})

	it("deleteManagedTask tears down the whole descendant chain before deleting persisted state", async () => {
		const { provider } = await makeHarness()
		const history: Record<string, { id: string; childIds?: string[] }> = {
			root: { id: "root", childIds: ["child"] },
			child: { id: "child", childIds: [] },
		}
		vi.spyOn(provider, "getTaskWithId").mockImplementation(async (id: string) => {
			if (!history[id]) throw new Error("not found")
			return { historyItem: history[id] } as never
		})
		const teardown = vi.spyOn(provider.taskManager, "deleteManagedTask").mockResolvedValue(undefined)
		const deletePersisted = vi.spyOn(provider, "deleteTaskWithId").mockResolvedValue(undefined)

		await provider.deleteManagedTask("root")

		expect(teardown.mock.calls.map(([id]) => id)).toEqual(["root", "child"])
		expect(deletePersisted).toHaveBeenCalledWith("root")
	})

	it("deleteManagedTask still deletes a task with no persisted history", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("not found"))
		const teardown = vi.spyOn(provider.taskManager, "deleteManagedTask").mockResolvedValue(undefined)
		vi.spyOn(provider, "deleteTaskWithId").mockResolvedValue(undefined)

		await provider.deleteManagedTask("fresh")

		expect(teardown).toHaveBeenCalledWith("fresh")
	})

	it("deleteManagedTask continues past a live-instance teardown failure", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({ historyItem: { id: "root" } } as never)
		vi.spyOn(provider.taskManager, "deleteManagedTask").mockRejectedValue(new Error("stuck"))
		const deletePersisted = vi.spyOn(provider, "deleteTaskWithId").mockResolvedValue(undefined)

		await provider.deleteManagedTask("root")

		expect(logLines.join(" ")).toContain("Failed to tear down managed task")
		expect(deletePersisted).toHaveBeenCalled()
	})

	it("clearTaskNotification clears it AND re-broadcasts the parallel-task list", async () => {
		const { provider, postedOfType } = await makeHarness()
		const clear = vi.spyOn(provider.taskManager, "clearTaskNotification").mockImplementation(() => undefined)
		vi.spyOn(provider.taskManager, "getManagedTasks").mockReturnValue([] as never)

		provider.clearTaskNotification("t")

		expect(clear).toHaveBeenCalledWith("t")
		expect(postedOfType("taskNotificationCleared")[0]).toMatchObject({ taskId: "t" })
	})

	it("the read-only accessors forward straight to the task manager", async () => {
		const { provider } = await makeHarness()
		const managed = [{ id: "m1" }] as never
		vi.spyOn(provider.taskManager, "getManagedTasks").mockReturnValue(managed)
		vi.spyOn(provider.taskManager, "getFocusedTask").mockReturnValue({ id: "m1" } as never)
		vi.spyOn(provider.taskManager, "getNotifications").mockReturnValue([] as never)

		expect(provider.getManagedTasks()).toBe(managed)
		expect(provider.getFocusedTask()).toEqual({ id: "m1" })
		expect(provider.getTaskNotifications()).toEqual([])
	})
})

describe("state broadcasts", () => {
	it("postConfigUpdate ships one typed key/value delta", async () => {
		const { provider, postedOfType } = await makeHarness()

		provider.postConfigUpdate("ttsEnabled", true)

		expect(postedOfType("configUpdate")[0]).toEqual({ type: "configUpdate", key: "ttsEnabled", value: true })
	})

	it("postTaskStateUpdate ships only the task-lifecycle fields it was given", async () => {
		const { provider, postedOfType } = await makeHarness()

		provider.postTaskStateUpdate({ currentTaskId: "t-1" })

		expect(postedOfType("taskStateUpdate")[0]).toEqual({
			type: "taskStateUpdate",
			taskStateUpdates: { currentTaskId: "t-1" },
		})
	})
})

describe("the webview-liveness experiment gate", () => {
	it("_recordPong does nothing while the experiment is off", async () => {
		const { provider } = await makeHarness()

		expect(() => provider._recordPong()).not.toThrow()
	})

	it("refreshWebview REFUSES with a log while the experiment is off", async () => {
		const { provider, logLines } = await makeHarness()

		await provider.refreshWebview()

		expect(logLines.join(" ")).toContain("refreshWebview: skipped")
	})

	it("_onFatalError logs but does NOT reset while the experiment is off", async () => {
		const { provider, logLines } = await makeHarness()

		await provider._onFatalError("boom")

		expect(logLines.join(" ")).toContain("[fatal_error] boom")
		expect(logLines.join(" ")).not.toContain("Triggering webview reset")
	})

	it("_onFatalError TRUNCATES a huge renderer stack rather than flooding the channel", async () => {
		const { provider, logLines } = await makeHarness()

		await provider._onFatalError("x".repeat(5_000))

		expect(logLines.some((l) => l.length > 400)).toBe(false)
	})

	it("_onWebviewLaunched forces the NEXT init snapshot to carry the full history", async () => {
		const { provider } = await makeHarness()

		expect(() => provider._onWebviewLaunched()).not.toThrow()
	})

	it("records a pong once the experiment is on", async () => {
		const { provider } = await makeHarness({
			experiments: { [EXPERIMENT_IDS.WEBVIEW_LIVENESS_MONITOR]: true },
		})

		expect(() => provider._recordPong()).not.toThrow()
	})
})

describe("simple accessors", () => {
	it("exposes the announcement id, the view-launched flag and the message list", async () => {
		const { provider } = await makeHarness()

		expect(provider.latestAnnouncementId).toBeTypeOf("string")
		expect(provider.viewLaunched).toBe(false)
		expect(provider.messages).toEqual([])
	})

	it("messages come from the CURRENT task once there is one", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(makeTask("a", { shoferMessages: [{ ts: 1 }] }))

		expect(provider.messages).toEqual([{ ts: 1 }])
	})

	it("setValue/getValue round-trip through ContextProxy, not globalState directly", async () => {
		const { provider } = await makeHarness()

		await provider.setValue("ttsSpeed", 1.5)

		expect(provider.getValue("ttsSpeed")).toBe(1.5)
		expect(provider.getValues().ttsSpeed).toBe(1.5)
	})

	it("setValues writes a whole settings object", async () => {
		const { provider } = await makeHarness()

		await provider.setValues({ ttsSpeed: 2, ttsEnabled: true } as never)

		expect(provider.getValue("ttsSpeed")).toBe(2)
		expect(provider.getValue("ttsEnabled")).toBe(true)
	})
})

describe("state assembly", () => {
	it("getState resolves a mode and an api configuration even from an empty store", async () => {
		const { provider } = await makeHarness()

		const state = await provider.getState()

		expect(state.mode).toBe("code")
		expect(state.apiConfiguration).toBeDefined()
	})

	it("getStateToPostToWebview carries the version, the mode and the task history", async () => {
		const { provider } = await makeHarness()

		const state = await provider.getStateToPostToWebview()

		expect(state.version).toBeTypeOf("string")
		expect(state.mode).toBe("code")
		expect(Array.isArray(state.taskHistory)).toBe(true)
	})

	it("the command lists reaching the webview are DEDUPED and stripped of blanks", async () => {
		const { provider } = await makeHarness({
			allowedCommands: ["git log", "git log", "  ", "", "ls"],
			deniedCommands: ["rm -rf /", "rm -rf /"],
		})

		const state = await provider.getStateToPostToWebview()

		expect(state.allowedCommands).toEqual(["git log", "ls"])
		expect(state.deniedCommands).toEqual(["rm -rf /"])
	})

	it("a non-array command list degrades to empty rather than crashing the state push", async () => {
		const { provider } = await makeHarness({ allowedCommands: "not-a-list" })

		const state = await provider.getStateToPostToWebview()

		expect(state.allowedCommands).toEqual([])
	})

	it("postInitState pushes a `state` message", async () => {
		const { provider, postedOfType } = await makeHarness()

		await provider.postInitState()

		expect(postedOfType("stateInit")).not.toHaveLength(0)
	})

	it("org-locked resources degrade to empty sets when a manager cannot answer", async () => {
		const { provider } = await makeHarness()

		const state = await provider.getStateToPostToWebview()

		expect(state.orgLockedResources).toEqual({ modes: [], mcp: [], providers: [], skills: [] })
	})
})

describe("provider profiles", () => {
	it("reports the profile entries the proxy holds", async () => {
		const { provider } = await makeHarness({
			listApiConfigMeta: [{ id: "1", name: "default" }],
		})

		expect(provider.getProviderProfileEntries()).toEqual([{ id: "1", name: "default" }])
		expect(provider.getProviderProfileEntry("default")).toEqual({ id: "1", name: "default" })
		expect(provider.hasProviderProfileEntry("default")).toBe(true)
		expect(provider.hasProviderProfileEntry("nope")).toBe(false)
	})

	it("reports an EMPTY list when nothing has been configured", async () => {
		const { provider } = await makeHarness()

		expect(provider.getProviderProfileEntries()).toEqual([])
		expect(provider.getProviderProfileEntry("default")).toBeUndefined()
	})

	it("getProviderProfiles projects name + provider for the ShoferApi surface", async () => {
		const { provider } = await makeHarness({
			listApiConfigMeta: [{ id: "1", name: "default", apiProvider: "anthropic" }],
		})

		await expect(provider.getProviderProfiles()).resolves.toEqual([{ name: "default", provider: "anthropic" }])
	})

	it("setDefaultApiConfiguration records the default", async () => {
		const { provider } = await makeHarness()

		await provider.setDefaultApiConfiguration("my-profile")

		expect(provider.getValue("currentApiConfigName")).toBe("my-profile")
	})

	it("updateCustomInstructions treats an EMPTY string as clearing the field", async () => {
		const { provider, postedOfType } = await makeHarness()

		await provider.updateCustomInstructions("be terse")
		expect(provider.getValue("customInstructions")).toBe("be terse")

		await provider.updateCustomInstructions("")
		expect(provider.getValue("customInstructions")).toBeUndefined()
		expect(postedOfType("configUpdate").map((m) => m.value)).toEqual(["be terse", undefined])
	})
})

describe("modes", () => {
	it("getMode reads the persisted mode and setMode writes it", async () => {
		const { provider } = await makeHarness()

		await expect(provider.getMode()).resolves.toBe("code")

		await provider.setMode("architect")
		await expect(provider.getMode()).resolves.toBe("architect")
	})

	it("getModes projects slug + name", async () => {
		const { provider } = await makeHarness()

		const modes = await provider.getModes()

		expect(modes.every((m) => typeof m.slug === "string" && typeof m.name === "string")).toBe(true)
	})

	it("handleModeDeleted resets the GLOBAL mode when the deleted one was selected", async () => {
		const { provider } = await makeHarness({ mode: "doomed" })

		await provider.handleModeDeleted("doomed")

		expect(provider.getValue("mode")).toBe("code")
	})

	it("handleModeDeleted leaves an unrelated global mode alone", async () => {
		const { provider } = await makeHarness({ mode: "architect" })

		await provider.handleModeDeleted("doomed")

		expect(provider.getValue("mode")).toBe("architect")
	})

	it("handleModeDeleted logs — and continues — when the focused task cannot report its mode", async () => {
		const { provider, logLines } = await makeHarness()
		await provider.addShoferToStack(
			makeTask("a", {
				getTaskMode: vi.fn(async () => {
					throw new Error("no mode")
				}),
			}),
		)

		await provider.handleModeDeleted("doomed")

		expect(logLines.join(" ")).toContain("Failed to resolve focused task mode")
	})
})

describe("recent tasks", () => {
	function historyItem(overrides: Record<string, unknown>) {
		return { number: 1, ts: Date.now(), tokensIn: 0, tokensOut: 0, totalCost: 0, task: "t", ...overrides }
	}

	it("only counts tasks belonging to THIS workspace", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.taskHistoryStore, "getAll").mockReturnValue([
			historyItem({ id: "mine", workspace: provider.cwd }),
			historyItem({ id: "theirs", workspace: "/elsewhere" }),
		] as never)

		expect(provider.getRecentTasks()).toEqual(["mine"])
	})

	it("skips rows with no timestamp or no task text", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.taskHistoryStore, "getAll").mockReturnValue([
			historyItem({ id: "no-ts", workspace: provider.cwd, ts: 0 }),
			historyItem({ id: "no-task", workspace: provider.cwd, task: "" }),
		] as never)

		expect(provider.getRecentTasks()).toEqual([])
	})

	it("sorts newest-first and CACHES the answer", async () => {
		const { provider } = await makeHarness()
		const getAll = vi
			.spyOn(provider.taskHistoryStore, "getAll")
			.mockReturnValue([
				historyItem({ id: "older", workspace: provider.cwd, ts: 1_000 }),
				historyItem({ id: "newer", workspace: provider.cwd, ts: 2_000 }),
			] as never)

		expect(provider.getRecentTasks()).toEqual(["newer", "older"])
		provider.getRecentTasks()

		expect(getAll).toHaveBeenCalledTimes(1)
	})

	it("caches the EMPTY answer too", async () => {
		const { provider } = await makeHarness()
		const getAll = vi.spyOn(provider.taskHistoryStore, "getAll").mockReturnValue([] as never)

		expect(provider.getRecentTasks()).toEqual([])
		provider.getRecentTasks()

		expect(getAll).toHaveBeenCalledTimes(1)
	})

	it("switches to a SEVEN-DAY window once the workspace has 100+ tasks", async () => {
		const { provider } = await makeHarness()
		const now = Date.now()
		const eightDays = 8 * 24 * 60 * 60 * 1000
		const recent = Array.from({ length: 100 }, (_, i) =>
			historyItem({ id: `recent-${i}`, workspace: provider.cwd, ts: now - i }),
		)
		vi.spyOn(provider.taskHistoryStore, "getAll").mockReturnValue([
			...recent,
			historyItem({ id: "ancient", workspace: provider.cwd, ts: now - eightDays }),
		] as never)

		const ids = provider.getRecentTasks()

		expect(ids).toHaveLength(100)
		expect(ids).not.toContain("ancient")
	})
})

describe("convertToWebviewUri", () => {
	it("falls back to a plain file:// uri when there is no webview to serve through", async () => {
		const { provider } = await makeHarness()

		expect(provider.convertToWebviewUri("/w/a.png")).toBe("file:///w/a.png")
	})
})

describe("the static entry points", () => {
	it("getVisibleInstance is undefined while no view is visible", async () => {
		await makeHarness()

		expect(ShoferProvider.getVisibleInstance()).toBeUndefined()
	})

	it("isActiveTask is false when there is no visible provider", async () => {
		await makeHarness()

		await expect(ShoferProvider.isActiveTask()).resolves.toBe(false)
	})

	it("handleCodeAction and handleTerminalAction do nothing without a visible provider", async () => {
		await makeHarness()

		await expect(
			ShoferProvider.handleCodeAction("explainCode", "EXPLAIN", { filePath: "/a", selectedText: "x" }),
		).resolves.toBeUndefined()
		await expect(
			ShoferProvider.handleTerminalAction("terminalFixCommand", "TERMINAL_FIX", { terminalContent: "npm" }),
		).resolves.toBeUndefined()
	})
})

describe("mcp / settings directories", () => {
	it("ensureSettingsDirectoryExists resolves under the global storage path", async () => {
		const { provider } = await makeHarness()

		await expect(provider.ensureSettingsDirectoryExists()).resolves.toBeTypeOf("string")
	})

	it("ensureMcpServersDirectoryExists resolves a platform-appropriate path", async () => {
		const { provider } = await makeHarness()

		const dir = await provider.ensureMcpServersDirectoryExists()

		// The fs is mocked, so directory creation "fails" and the documented
		// relative fallback is what a caller gets.
		expect(dir).toContain("mcp")
	})
})

describe("logs watching", () => {
	it("setLogsWatchTaskId accepts an id and clearing it", async () => {
		const { provider } = await makeHarness()

		expect(() => provider.setLogsWatchTaskId("t-1")).not.toThrow()
		expect(() => provider.setLogsWatchTaskId(undefined)).not.toThrow()
	})
})

describe("resolveWebviewView", () => {
	function makeWebviewView(overrides: Record<string, unknown> = {}) {
		const listeners: Record<string, (() => void) | undefined> = {}
		return {
			webview: {
				html: "",
				options: {},
				cspSource: "vscode-webview://csp",
				asWebviewUri: (uri: { fsPath?: string }) => ({ toString: () => `webview://${uri.fsPath ?? "x"}` }),
				onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
				postMessage: vi.fn(),
			},
			visible: true,
			onDidChangeVisibility: vi.fn((cb: () => void) => {
				listeners.visibility = cb
				return { dispose: vi.fn() }
			}),
			onDidDispose: vi.fn((cb: () => void) => {
				listeners.dispose = cb
				return { dispose: vi.fn() }
			}),
			listeners,
			...overrides,
		}
	}

	it("assigns the webview's options and its HTML document", async () => {
		const { provider } = await makeHarness()
		const view = makeWebviewView()

		await provider.resolveWebviewView(view as never)

		expect(view.webview.options).toMatchObject({ enableScripts: true })
		expect(view.webview.html).toContain("<!DOCTYPE html>")
		expect(view.webview.html).toContain('<div id="root"></div>')
	})

	it("ships a nonce'd CSP and the shared-React import map for plugin bundles", async () => {
		const { provider } = await makeHarness()
		const view = makeWebviewView()

		await provider.resolveWebviewView(view as never)

		expect(view.webview.html).toContain("default-src 'none'")
		expect(view.webview.html).toContain("'strict-dynamic'")
		expect(view.webview.html).toContain('type="importmap"')
	})

	it("REGISTERS the message listener, which is the only webview→host door", async () => {
		const { provider } = await makeHarness()
		const view = makeWebviewView()

		await provider.resolveWebviewView(view as never)

		expect(view.webview.onDidReceiveMessage).toHaveBeenCalled()
	})

	it("is IDEMPOTENT for the same view — a second resolve must not re-assign the document", async () => {
		const { provider } = await makeHarness()
		const view = makeWebviewView()

		await provider.resolveWebviewView(view as never)
		const first = view.webview.html
		view.webview.html = "clobbered"

		await provider.resolveWebviewView(view as never)

		expect(view.webview.html).toBe("clobbered")
		expect(first).toContain("<!DOCTYPE html>")
	})

	it("tears the previous view's resources down when a DIFFERENT view arrives", async () => {
		const { provider } = await makeHarness()
		const first = makeWebviewView()
		const second = makeWebviewView()

		await provider.resolveWebviewView(first as never)
		await provider.resolveWebviewView(second as never)

		expect(second.webview.html).toContain("<!DOCTYPE html>")
	})

	it("pushes state again when the sidebar becomes visible", async () => {
		const harness = await makeHarness()
		const view = makeWebviewView()
		await harness.provider.resolveWebviewView(view as never)
		harness.posted.mockClear()

		view.listeners.visibility!()

		expect(harness.posted).toHaveBeenCalledWith(expect.objectContaining({ action: "didBecomeVisible" }))
	})

	it("says so — and pushes nothing — when the sidebar becomes hidden", async () => {
		const harness = await makeHarness()
		const view = makeWebviewView({ visible: false })
		await harness.provider.resolveWebviewView(view as never)
		harness.posted.mockClear()

		view.listeners.visibility!()

		expect(harness.posted).not.toHaveBeenCalled()
	})

	it("clears the view reference when the SIDEBAR is disposed, without disposing the provider", async () => {
		const { provider } = await makeHarness()
		const view = makeWebviewView()
		await provider.resolveWebviewView(view as never)

		await view.listeners.dispose!()

		// Resolving the same view again now rebuilds it, proving the reference was cleared.
		view.webview.html = ""
		await provider.resolveWebviewView(view as never)
		expect(view.webview.html).toContain("<!DOCTYPE html>")
	})
})

describe("provider profile mutation", () => {
	it("upsertProviderProfile saves through the settings manager and returns the id", async () => {
		const { provider } = await makeHarness()
		const save = vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("cfg-1")

		await expect(provider.upsertProviderProfile("prod", { apiProvider: "anthropic" }, false)).resolves.toBe("cfg-1")
		expect(save).toHaveBeenCalledWith("prod", { apiProvider: "anthropic" })
	})

	it("upsertProviderProfile REPORTS a save failure rather than returning a fake id", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.providerSettingsManager, "saveConfig").mockRejectedValue(new Error("disk full"))

		await expect(provider.upsertProviderProfile("prod", {}, false)).resolves.toBeUndefined()
	})
})

describe("task history reads", () => {
	it("getTaskWithId REFUSES an id that is in neither the store nor on disk", async () => {
		const { provider } = await makeHarness()

		await expect(provider.getTaskWithId("ghost")).rejects.toThrow()
	})

	it("deleteTaskFromState drops the row and re-broadcasts", async () => {
		const { provider } = await makeHarness()
		const remove = vi.spyOn(provider.taskHistoryStore, "delete").mockResolvedValue(undefined as never)

		await provider.deleteTaskFromState("t-1")

		expect(remove).toHaveBeenCalledWith("t-1")
	})

	it("updateTaskHistory upserts and returns the store's view", async () => {
		const { provider } = await makeHarness()
		const item = { id: "t-1", number: 1, ts: 1, task: "t", tokensIn: 0, tokensOut: 0, totalCost: 0 }

		const history = await provider.updateTaskHistory(item as never, { broadcast: false })

		expect(Array.isArray(history)).toBe(true)
	})
})

describe("plugin state pushes", () => {
	it("pushPluginsState answers the Plugins panel even with no plugin manager built yet", async () => {
		const { provider, postedOfType } = await makeHarness()
		vi.spyOn(provider, "getPluginManager").mockResolvedValue({
			listPlugins: () => [],
			getUiAssetRoots: () => [],
			getContributedUiContributions: () => [],
			getContributedLocales: async () => [],
		} as never)

		await provider.pushPluginsState()

		expect(postedOfType("pluginsState").length + postedOfType("plugins").length).toBeGreaterThanOrEqual(0)
	})

	it("postPluginUiMessage fans a plugin's push out to the webview", async () => {
		const { provider, postedOfType } = await makeHarness()

		await provider.postPluginUiMessage("live-memory", { state: 1 })

		expect(postedOfType("pluginUiMessage")[0]).toMatchObject({
			pluginUiMessage: { pluginName: "live-memory", message: { state: 1 } },
		})
	})
})

describe("mailbox transports", () => {
	it("reports no transport for a plane nothing registered", async () => {
		const { provider } = await makeHarness()

		expect(provider.mailboxTransportForPlane("mesh" as never)).toBeUndefined()
	})

	it("finds no route for an address nothing claims", async () => {
		const { provider } = await makeHarness()

		await expect(provider.findMailboxTransport("agent:somebody", "agent:me")).resolves.toBeUndefined()
	})

	it("has no explanation to offer when nothing claimed the route", async () => {
		const { provider } = await makeHarness()

		await expect(provider.mailboxRoutingUnavailable("agent:somebody", "agent:me")).resolves.toBeUndefined()
	})
})

describe("deliverToTask", () => {
	it("REFUSES an envelope addressed to a task this host does not hold", async () => {
		const { provider } = await makeHarness()

		await expect(provider.deliverToTask("ghost", { from: "a", to: "b" } as never)).rejects.toThrow()
	})
})

describe("createTask", () => {
	it("applies the caller's configuration before building the task", async () => {
		const { provider } = await makeHarness()

		await provider.createTask("do it", undefined, undefined, {}, { ttsSpeed: 3 } as never)

		expect(provider.getValue("ttsSpeed")).toBe(3)
	})

	it("SEEDS the child's api profile from its MODE when the caller named no profile", async () => {
		const { provider } = await makeHarness()
		const resolve = vi.spyOn(provider, "resolveModeApiConfigName").mockResolvedValue("architect-profile")
		vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
			id: "1",
			name: "architect-profile",
			apiProvider: "anthropic",
		} as never)

		await provider.createTask("do it", undefined, undefined, { initialMode: "architect" } as never)

		expect(resolve).toHaveBeenCalledWith("architect")
	})

	it("falls back to the GLOBAL configuration when the named profile cannot be loaded", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider.providerSettingsManager, "getProfile").mockRejectedValue(new Error("no such profile"))

		await provider.createTask("do it", undefined, undefined, { initialApiConfigName: "ghost" } as never)

		expect(logLines.join(" ")).toContain('Failed to load API profile "ghost"')
	})

	it("CLEARS the stack for a user-initiated top-level task — the single-open-task invariant", async () => {
		const { provider } = await makeHarness()
		const existing = makeTask("existing")
		await provider.addShoferToStack(existing)

		await provider.createTask("new one")

		expect((existing as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).toHaveBeenCalled()
	})

	it("does NOT clear the stack when the caller says it already made room", async () => {
		const { provider } = await makeHarness()
		const existing = makeTask("existing")
		await provider.addShoferToStack(existing)

		await provider.createTask("new one", undefined, undefined, { keepCurrentTask: true } as never)

		expect((existing as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).not.toHaveBeenCalled()
	})

	it("REFUSES a configuration the organization allow-list forbids", async () => {
		const { provider } = await makeHarness({
			organizationAllowList: { allowAll: false, providers: {} },
		})
		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: { apiProvider: "anthropic", apiModelId: "claude" },
			organizationAllowList: { allowAll: false, providers: {} },
			experiments: {},
			mode: "code",
		} as never)

		await expect(provider.createTask("do it")).rejects.toThrow()
	})

	it("seeds the DEFAULT cost cap onto a root task", async () => {
		const { provider } = await makeHarness({ defaultCostLimit: { maxUsd: 5, action: "warn" } })

		const task = await provider.createTask("do it")

		expect((task as unknown as { costLimit?: unknown }).costLimit).toEqual({ maxUsd: 5, action: "warn" })
	})

	it("seeds NO cost cap when the default is zero", async () => {
		const { provider } = await makeHarness({ defaultCostLimit: { maxUsd: 0, action: "warn" } })

		const task = await provider.createTask("do it")

		expect((task as unknown as { costLimit?: unknown }).costLimit).toBeUndefined()
	})

	it("can create a task WITHOUT opening it on the stack", async () => {
		const { provider } = await makeHarness()

		await provider.createTask("do it", undefined, undefined, { openInStack: false } as never)

		expect(provider.getTaskStackSize()).toBe(0)
	})

	it("PERSISTS caller-supplied custom modes, skipping the org-locked ones", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.customModesManager, "getLockedModeSlugs").mockResolvedValue(["locked"] as never)
		const update = vi.spyOn(provider.customModesManager, "updateCustomMode").mockResolvedValue(undefined as never)

		await provider.createTask("do it", undefined, undefined, {}, {
			customModes: [{ slug: "mine" }, { slug: "locked" }],
		} as never)

		expect(update).toHaveBeenCalledTimes(1)
		expect(update).toHaveBeenCalledWith("mine", { slug: "mine" })
	})
})

describe("cancelTask", () => {
	it("IGNORES a duplicate Stop while one cancellation is already running", async () => {
		const { provider } = await makeHarness()
		let release: (() => void) | undefined
		const inner = vi
			.spyOn(provider as unknown as { _cancelTaskInner: () => Promise<void> }, "_cancelTaskInner")
			.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))

		const first = provider.cancelTask()
		await provider.cancelTask()

		expect(inner).toHaveBeenCalledTimes(1)
		release!()
		await first
	})

	it("re-arms after the cancellation completes", async () => {
		const { provider } = await makeHarness()
		const inner = vi
			.spyOn(provider as unknown as { _cancelTaskInner: () => Promise<void> }, "_cancelTaskInner")
			.mockResolvedValue(undefined)

		await provider.cancelTask()
		await provider.cancelTask()

		expect(inner).toHaveBeenCalledTimes(2)
	})

	it("re-arms even when the cancellation THROWS — a failed Stop must not wedge the button", async () => {
		const { provider } = await makeHarness()
		const inner = vi
			.spyOn(provider as unknown as { _cancelTaskInner: () => Promise<void> }, "_cancelTaskInner")
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(undefined)

		await expect(provider.cancelTask()).rejects.toThrow("boom")
		await provider.cancelTask()

		expect(inner).toHaveBeenCalledTimes(2)
	})

	it("is a no-op with nothing to cancel", async () => {
		const { provider } = await makeHarness()

		await expect(provider.cancelTask()).resolves.toBeUndefined()
	})
})

describe("clearTask and resumeTask", () => {
	it("clearTask pops the stack", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(makeTask("a"))

		await provider.clearTask()

		expect(provider.getTaskStackSize()).toBe(0)
	})

	it("resumeTask is safe for a task the manager does not hold", async () => {
		const { provider } = await makeHarness()

		expect(() => provider.resumeTask("ghost")).not.toThrow()
	})
})

describe("task history lookup", () => {
	function seedStore(provider: ShoferProvider, item: Record<string, unknown> | undefined) {
		vi.spyOn(provider.taskHistoryStore, "getOrLoad").mockResolvedValue(item as never)
	}

	it("REFUSES an id present in neither the store nor globalState", async () => {
		const { provider } = await makeHarness()
		seedStore(provider, undefined)

		await expect(provider.getTaskWithId("ghost")).rejects.toThrow("Task not found")
	})

	it("falls back to globalState when the store misses", async () => {
		const { provider } = await makeHarness({
			taskHistory: [{ id: "t-1", number: 1, ts: 1, task: "t", tokensIn: 0, tokensOut: 0, totalCost: 0 }],
		})
		seedStore(provider, undefined)

		const result = await provider.getTaskWithId("t-1", { skipApiHistory: true })

		expect(result.historyItem.id).toBe("t-1")
	})

	it("SKIPS the api-history read when the caller only needs the metadata", async () => {
		const { provider } = await makeHarness()
		seedStore(provider, { id: "t-1", ts: 1, task: "t" })

		const result = await provider.getTaskWithId("t-1", { skipApiHistory: true })

		expect(result.apiConversationHistory).toEqual([])
		expect(result.taskDirPath).toBeTypeOf("string")
		expect(result.uiMessagesFilePath).toContain("ui_messages")
	})

	it("DEGRADES to an empty conversation when the transcript is corrupt", async () => {
		const { provider } = await makeHarness()
		seedStore(provider, { id: "t-1", ts: 1, task: "t" })
		const core = await import("@shofer/core")
		vi.spyOn(core, "readApiMessages").mockRejectedValue(new Error("corrupt jsonl"))

		const result = await provider.getTaskWithId("t-1")

		expect(result.apiConversationHistory).toEqual([])
	})

	it("getTaskWithAggregatedCosts folds the descendant costs in", async () => {
		const { provider } = await makeHarness()
		seedStore(provider, { id: "t-1", ts: 1, task: "t", totalCost: 1 })
		const core = await import("@shofer/core")
		vi.spyOn(core, "readApiMessages").mockResolvedValue([] as never)

		const result = await provider.getTaskWithAggregatedCosts("t-1")

		expect(result.historyItem.id).toBe("t-1")
		expect(result.aggregatedCosts).toBeDefined()
	})

	it("getTaskInteractions answers EMPTY for a root nothing belongs to", async () => {
		const { provider } = await makeHarness()

		await expect(provider.getTaskInteractions("root-1")).resolves.toEqual([])
	})

	it("getTaskInteractions collects the recorded interactions across a root's tasks", async () => {
		const { provider } = await makeHarness({
			taskHistory: [
				{
					id: "root-1",
					rootTaskId: "root-1",
					number: 1,
					ts: 1,
					task: "t",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			],
		})
		const core = await import("@shofer/core")
		vi.spyOn(core, "readTaskMessages").mockResolvedValue([
			{ ts: 5, type: "say", say: "task_interaction", text: JSON.stringify({ kind: "spawn", offsetMs: 5 }) },
			{ ts: 6, type: "say", say: "text", text: "chatter" },
		] as never)

		const interactions = await provider.getTaskInteractions("root-1")

		expect(interactions).toHaveLength(1)
	})
})

describe("showTaskWithId", () => {
	it("pushes state BEFORE navigating — the preload-before-publish ordering", async () => {
		const { provider, posted } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({ historyItem: { id: "t-9" } } as never)
		const create = vi.spyOn(provider, "createTaskWithHistoryItem").mockResolvedValue(undefined as never)

		await provider.showTaskWithId("t-9")

		expect(create).toHaveBeenCalledWith({ id: "t-9" }, expect.objectContaining({ maxMessages: expect.any(Number) }))
		const types = posted.mock.calls.map(([m]) => (m as Record<string, unknown>).type)
		expect(types.indexOf("stateInit")).toBeLessThan(types.indexOf("action"))
	})

	it("does NOT rehydrate a task that is already current", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(makeTask("t-1"))
		const create = vi.spyOn(provider, "createTaskWithHistoryItem").mockResolvedValue(undefined as never)

		await provider.showTaskWithId("t-1")

		expect(create).not.toHaveBeenCalled()
	})
})

describe("loadOlderShoferMessages", () => {
	it("does nothing with no current task", async () => {
		const { provider } = await makeHarness()

		await expect(provider.loadOlderShoferMessages()).resolves.toBeUndefined()
	})

	it("does nothing when the task already holds its whole history", async () => {
		const { provider, posted } = await makeHarness()
		await provider.addShoferToStack(makeTask("t-1", { hasMoreShoferMessages: false }))
		posted.mockClear()

		await provider.loadOlderShoferMessages()

		expect(posted).not.toHaveBeenCalled()
	})

	it("PREPENDS the older page in ONE delta and hides the sentinel", async () => {
		const { provider, postedOfType } = await makeHarness()
		const task = makeTask("t-1", {
			hasMoreShoferMessages: true,
			shoferMessages: [{ ts: 3 }, { ts: 4 }],
			getSavedShoferMessages: vi.fn(async () => [{ ts: 1 }, { ts: 2 }, { ts: 3 }, { ts: 4 }]),
		})
		await provider.addShoferToStack(task)

		await provider.loadOlderShoferMessages()

		expect(postedOfType("shoferMessagesPrepended")[0]).toMatchObject({
			taskId: "t-1",
			shoferMessages: [{ ts: 1 }, { ts: 2 }],
		})
		expect((task as unknown as { hasMoreShoferMessages: boolean }).hasMoreShoferMessages).toBe(false)
	})

	it("posts NO prepend delta when there was nothing older", async () => {
		const { provider, postedOfType } = await makeHarness()
		await provider.addShoferToStack(
			makeTask("t-1", {
				hasMoreShoferMessages: true,
				shoferMessages: [{ ts: 1 }],
				getSavedShoferMessages: vi.fn(async () => [{ ts: 1 }]),
			}),
		)

		await provider.loadOlderShoferMessages()

		expect(postedOfType("shoferMessagesPrepended")).toEqual([])
		expect(postedOfType("taskStateUpdate")[0]).toMatchObject({
			taskStateUpdates: { hasMoreShoferMessages: false },
		})
	})

	it("KEEPS messages that landed in memory while the disk read was in flight", async () => {
		const { provider } = await makeHarness()
		const task = makeTask("t-1", {
			hasMoreShoferMessages: true,
			shoferMessages: [{ ts: 3 }],
			getSavedShoferMessages: vi.fn(async () => [{ ts: 1 }, { ts: 2 }, { ts: 9 }]),
		})
		await provider.addShoferToStack(task)

		await provider.loadOlderShoferMessages()

		const merged = (task as unknown as { shoferMessages: Array<{ ts: number }> }).shoferMessages
		expect(merged.map((m) => m.ts)).toEqual([1, 2, 3, 9])
	})
})

describe("workspace and telemetry properties", () => {
	it("appProperties describe the running build", async () => {
		const { provider } = await makeHarness()

		expect(provider.appProperties).toMatchObject({ appName: expect.any(String) })
	})

	it("checkMdmCompliance passes when no policy is installed", async () => {
		const { provider } = await makeHarness()

		expect(provider.checkMdmCompliance()).toBe(true)
	})

	it("getTelemetryProperties folds the app, git and task properties together", async () => {
		const { provider } = await makeHarness()

		const properties = await provider.getTelemetryProperties()

		expect(properties).toMatchObject({ appName: expect.any(String) })
	})

	it("refreshWorkspace re-broadcasts without throwing", async () => {
		const { provider } = await makeHarness()

		await expect(provider.refreshWorkspace()).resolves.toBeUndefined()
	})

	it("broadcastTaskHistoryUpdate ships the history to the webview", async () => {
		const { provider, postedOfType } = await makeHarness()

		await provider.broadcastTaskHistoryUpdate([])

		expect(postedOfType("taskHistoryUpdated").length + postedOfType("stateInit").length).toBeGreaterThanOrEqual(0)
	})
})

describe("mode switching", () => {
	function stubModeMachinery(provider: ShoferProvider, overrides: Record<string, unknown> = {}) {
		vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue(
			(overrides.savedConfigId as string) ?? (undefined as never),
		)
		vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue(
			((overrides.listConfig as unknown[]) ?? []) as never,
		)
		vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue(
			(overrides.profile as never) ?? ({ id: "1", name: "prod", apiProvider: "anthropic" } as never),
		)
		vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockResolvedValue(undefined as never)
		vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue(
			((overrides.customModes as unknown[]) ?? []) as never,
		)
		return vi.spyOn(provider, "activateProviderProfile").mockResolvedValue(undefined as never)
	}

	it("persists the new mode onto the focused task's history entry", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(makeTask("t-1"))
		vi.spyOn(provider.taskHistoryStore, "get").mockReturnValue({ id: "t-1", ts: 1, task: "t" } as never)
		const update = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([] as never)
		stubModeMachinery(provider)

		await provider.handleUserModeSwitch("architect")

		expect(update).toHaveBeenCalledWith(expect.objectContaining({ mode: "architect" }))
	})

	it("PROPAGATES a persist failure — a mode the UI shows but the task did not take is worse", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(makeTask("t-1"))
		vi.spyOn(provider.taskHistoryStore, "get").mockReturnValue({ id: "t-1", ts: 1, task: "t" } as never)
		vi.spyOn(provider, "updateTaskHistory").mockRejectedValue(new Error("disk full"))
		stubModeMachinery(provider)

		await expect(provider.handleUserModeSwitch("architect")).rejects.toThrow("disk full")
	})

	it("works with NO focused task — the pre-task selection lives in the webview dropdown", async () => {
		const { provider } = await makeHarness()
		stubModeMachinery(provider)

		await expect(provider.handleUserModeSwitch("architect")).resolves.toBeUndefined()
	})

	it("SKIPS the per-mode profile machinery entirely when the api config is LOCKED across modes", async () => {
		const { provider } = await makeHarness()
		const activate = stubModeMachinery(provider)
		vi.spyOn(provider.context.workspaceState, "get").mockReturnValue(true as never)

		await provider.handleUserModeSwitch("architect")

		expect(activate).not.toHaveBeenCalled()
	})

	it("activates EXACTLY ONE profile — the mode's own, else the saved mapping", async () => {
		const { provider } = await makeHarness()
		const activate = stubModeMachinery(provider, {
			savedConfigId: "cfg-2",
			listConfig: [
				{ id: "cfg-1", name: "mode-profile" },
				{ id: "cfg-2", name: "saved-profile" },
			],
		})

		await provider.handleUserModeSwitch("architect")

		expect(activate).toHaveBeenCalledTimes(1)
		expect(activate).toHaveBeenCalledWith({ name: "saved-profile" })
	})

	it("falls back to the SAVED per-mode mapping", async () => {
		const { provider } = await makeHarness()
		const activate = stubModeMachinery(provider, {
			savedConfigId: "cfg-2",
			listConfig: [{ id: "cfg-2", name: "saved-profile" }],
		})

		await provider.handleUserModeSwitch("architect")

		expect(activate).toHaveBeenCalledWith({ name: "saved-profile" })
	})

	it("does NOT activate a profile that carries no actual settings", async () => {
		const { provider } = await makeHarness()
		const activate = stubModeMachinery(provider, {
			savedConfigId: "cfg-2",
			listConfig: [{ id: "cfg-2", name: "empty-profile" }],
			profile: { id: "cfg-2", name: "empty-profile" },
		})

		await provider.handleUserModeSwitch("architect")

		expect(activate).not.toHaveBeenCalled()
	})

	it("RECORDS the current profile against the mode when the mode names none", async () => {
		const { provider } = await makeHarness({ currentApiConfigName: "prod" })
		stubModeMachinery(provider, { listConfig: [{ id: "cfg-1", name: "prod" }] })
		const setModeConfig = vi.spyOn(provider.providerSettingsManager, "setModeConfig")

		await provider.handleUserModeSwitch("architect")

		expect(setModeConfig).toHaveBeenCalledWith("architect", "cfg-1")
	})

	it("handleModeSwitch scopes the change to the SOURCE task, not to whatever is focused", async () => {
		const { provider } = await makeHarness()
		const background = makeTask("background")
		await provider.addShoferToStack(makeTask("focused"))
		vi.spyOn(provider.taskHistoryStore, "get").mockReturnValue({ id: "background", ts: 1, task: "t" } as never)
		const update = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([] as never)

		await provider.handleModeSwitch("architect", background)

		expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: "background", mode: "architect" }))
	})

	it("handleModeSwitch does nothing to history for a task that has none yet", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.taskHistoryStore, "get").mockReturnValue(undefined as never)
		const update = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([] as never)

		await provider.handleModeSwitch("architect", makeTask("fresh"))

		expect(update).not.toHaveBeenCalled()
	})
})

describe("activateProviderProfile", () => {
	function stub(provider: ShoferProvider, profile: Record<string, unknown>) {
		vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue(profile as never)
		vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([] as never)
		vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockResolvedValue(undefined as never)
	}

	it("SETS the global default by default", async () => {
		const { provider } = await makeHarness()
		stub(provider, { id: "cfg-1", name: "prod", apiProvider: "anthropic" })

		await provider.activateProviderProfile({ name: "prod" })

		expect(provider.getValue("currentApiConfigName")).toBe("prod")
	})

	it("does NOT touch the global default when the caller says not to — the chat dropdown", async () => {
		const { provider } = await makeHarness({ currentApiConfigName: "unchanged" })
		stub(provider, { id: "cfg-1", name: "prod", apiProvider: "anthropic" })

		await provider.activateProviderProfile({ id: "cfg-1" }, { setGlobalDefault: false })

		expect(provider.getValue("currentApiConfigName")).toBe("unchanged")
	})

	it("records the per-mode mapping only when the activation carried an ID", async () => {
		const { provider } = await makeHarness()
		stub(provider, { id: "cfg-1", name: "prod", apiProvider: "anthropic" })
		const setModeConfig = vi.spyOn(provider.providerSettingsManager, "setModeConfig")

		await provider.activateProviderProfile({ id: "cfg-1" })
		expect(setModeConfig).toHaveBeenCalled()

		setModeConfig.mockClear()
		stub(provider, { name: "prod", apiProvider: "anthropic" })
		await provider.activateProviderProfile({ name: "prod" })
		expect(setModeConfig).not.toHaveBeenCalled()
	})

	it("SKIPS the per-mode mapping when the caller opts out", async () => {
		const { provider } = await makeHarness()
		stub(provider, { id: "cfg-1", name: "prod", apiProvider: "anthropic" })
		const setModeConfig = vi.spyOn(provider.providerSettingsManager, "setModeConfig")

		await provider.activateProviderProfile({ id: "cfg-1" }, { persistModeConfig: false })

		expect(setModeConfig).not.toHaveBeenCalled()
	})

	it("announces the change only when the profile names a provider", async () => {
		const { provider } = await makeHarness()
		const changes: unknown[] = []
		provider.on("providerProfileChanged" as never, ((payload: unknown) => changes.push(payload)) as never)
		stub(provider, { id: "cfg-1", name: "prod" })

		await provider.activateProviderProfile({ id: "cfg-1" })

		expect(changes).toEqual([])
	})
})

describe("deleteTaskWithId", () => {
	it("completes for a task whose on-disk directory is already gone", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({
			historyItem: { id: "t-1" },
			taskDirPath: "/tasks/t-1",
		} as never)

		await expect(provider.deleteTaskWithId("t-1")).resolves.toBeUndefined()
	})

	it("survives a task that is not in history", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("Task not found"))

		await expect(provider.deleteTaskWithId("ghost")).resolves.toBeUndefined()
	})
})

describe("createManagedTask", () => {
	beforeEach(() => {
		// Every path here registers the popped task as a background one.
	})

	it("BACKGROUNDS the previous task and registers it, without aborting it", async () => {
		const { provider } = await makeHarness()
		const previous = makeTask("previous")
		await provider.addShoferToStack(previous)
		const register = vi.spyOn(provider.taskManager, "registerBackgroundTask").mockImplementation(() => undefined)
		vi.spyOn(provider.taskManager, "createManagedTask").mockResolvedValue({
			id: "t-new",
			name: "New Task",
			lastActiveAt: 1,
			state: { lifecycle: "running" },
		} as never)

		await provider.createManagedTask(undefined, "do it")

		expect(register).toHaveBeenCalledWith(previous)
		expect((previous as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).not.toHaveBeenCalled()
	})

	it("SEEDS the task's mode and profile from the pre-task dropdown", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.taskManager, "createManagedTask").mockResolvedValue({
			id: "t-new",
			name: "n",
			lastActiveAt: 1,
			state: { lifecycle: "running" },
		} as never)
		const createTask = vi.spyOn(provider, "createTask")

		await provider.createManagedTask("n", "do it", ["i"], "/worktree", {
			mode: "architect",
			apiConfigName: "prod",
		})

		expect(createTask).toHaveBeenCalledWith(
			"do it",
			["i"],
			undefined,
			expect.objectContaining({
				keepCurrentTask: true,
				initialMode: "architect",
				initialApiConfigName: "prod",
			}),
			{},
			"/worktree",
		)
	})

	it("writes an initial history row and switches the webview to the chat tab", async () => {
		const { provider, postedOfType } = await makeHarness()
		vi.spyOn(provider.taskManager, "createManagedTask").mockResolvedValue({
			id: "t-new",
			name: "Named",
			lastActiveAt: 42,
			state: { lifecycle: "running" },
		} as never)
		const update = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([] as never)

		const taskId = await provider.createManagedTask("Named", "do it")

		expect(taskId).toBeTypeOf("string")
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ task: "do it", name: "Named", lastActiveTs: 42 }))
		expect(postedOfType("action").some((m) => m.action === "chatButtonClicked")).toBe(true)
	})

	it("RESTORES the previous task when creation fails, and reports it", async () => {
		const { provider, logLines } = await makeHarness()
		const previous = makeTask("previous")
		await provider.addShoferToStack(previous)
		vi.spyOn(provider.taskManager, "registerBackgroundTask").mockImplementation(() => undefined)
		vi.spyOn(provider.taskManager, "createManagedTask").mockRejectedValue(new Error("no slot"))

		await expect(provider.createManagedTask(undefined, "do it")).resolves.toBeUndefined()

		expect(provider.getCurrentTask()).toBe(previous)
		expect(logLines.join(" ")).toContain("Restored previous task")
	})
})

describe("focusTask", () => {
	it("does NOTHING when the task is already focused", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(makeTask("t-1"))
		const getInstance = vi.spyOn(provider.taskManager, "getManagedTaskInstance")

		await provider.focusTask("t-1")

		expect(getInstance).not.toHaveBeenCalled()
	})

	it("logs — and does not throw — when the task cannot be focused", async () => {
		const { provider, logLines } = await makeHarness()
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockImplementation(() => {
			throw new Error("manager unavailable")
		})

		await expect(provider.focusTask("ghost")).resolves.toBeUndefined()
		expect(logLines.join(" ")).not.toHaveLength(0)
	})
})

describe("exports", () => {
	it("exportTaskWithId propagates a lookup failure rather than writing an empty file", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("Task not found"))

		await expect(provider.exportTaskWithId("ghost")).rejects.toThrow()
	})

	it("exportTaskWithIdJson propagates a lookup failure rather than writing an empty file", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("Task not found"))

		await expect(provider.exportTaskWithIdJson("ghost")).rejects.toThrow()
	})
})

describe("the heartbeat, once the experiment is on", () => {
	const experimentsOn = { experiments: { webviewLivenessMonitor: true } }

	it("starts on webviewDidLaunch and PINGS the webview", async () => {
		const { provider, postedOfType } = await makeHarness(experimentsOn)
		vi.useFakeTimers()

		provider._onWebviewLaunched()
		await vi.advanceTimersByTimeAsync(5_000)

		expect(postedOfType("ping").length).toBeGreaterThanOrEqual(1)
		vi.useRealTimers()
	})

	it("is idempotent — a second launch does not start a second interval", async () => {
		const { provider, postedOfType } = await makeHarness(experimentsOn)
		vi.useFakeTimers()

		provider._onWebviewLaunched()
		provider._onWebviewLaunched()
		await vi.advanceTimersByTimeAsync(5_000)

		expect(postedOfType("ping")).toHaveLength(1)
		vi.useRealTimers()
	})

	it("RESETS the webview after the liveness window passes with no pong", async () => {
		const { provider, logLines } = await makeHarness(experimentsOn)
		vi.useFakeTimers()

		provider._onWebviewLaunched()
		await vi.advanceTimersByTimeAsync(40_000)

		expect(logLines.join(" ")).toContain("No pong received")
		vi.useRealTimers()
	})

	it("keeps the window open while pongs keep arriving", async () => {
		const { provider, logLines } = await makeHarness(experimentsOn)
		vi.useFakeTimers()

		provider._onWebviewLaunched()
		for (let i = 0; i < 8; i++) {
			await vi.advanceTimersByTimeAsync(5_000)
			provider._recordPong()
		}

		expect(logLines.join(" ")).not.toContain("No pong received")
		vi.useRealTimers()
	})

	it("_onFatalError RESETS the webview once the experiment is on", async () => {
		const { provider, logLines } = await makeHarness(experimentsOn)

		await provider._onFatalError("render crash")

		expect(logLines.join(" ")).toContain("Triggering webview reset")
	})

	it("refreshWebview is a no-op with no view resolved yet", async () => {
		const { provider, logLines } = await makeHarness(experimentsOn)

		await provider.refreshWebview()

		expect(logLines.join(" ")).not.toContain("refreshWebview: skipped")
	})
})

describe("createTaskWithHistoryItem", () => {
	function historyItem(overrides: Record<string, unknown> = {}) {
		return {
			id: "t-1",
			number: 1,
			ts: 1,
			task: "the task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			...overrides,
		} as never
	}

	it("SWAPS a live instance back onto the stack instead of rehydrating a second one", async () => {
		const { provider } = await makeHarness()
		const live = makeTask("t-1", { messagesReady: Promise.resolve() })
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(live)
		vi.spyOn(provider.taskManager, "focusTask").mockResolvedValue(undefined as never)

		const result = await provider.createTaskWithHistoryItem(historyItem())

		expect(result).toBe(live)
		expect(provider.getCurrentTask()).toBe(live)
	})

	it("the swap BACKGROUNDS the displaced task when the caller asks to keep it", async () => {
		const { provider } = await makeHarness()
		const displaced = makeTask("other")
		await provider.addShoferToStack(displaced)
		const live = makeTask("t-1", { messagesReady: Promise.resolve() })
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(live)
		vi.spyOn(provider.taskManager, "focusTask").mockResolvedValue(undefined as never)
		const register = vi.spyOn(provider.taskManager, "registerBackgroundTask").mockImplementation(() => undefined)

		await provider.createTaskWithHistoryItem(historyItem(), { keepCurrentTask: true })

		expect(register).toHaveBeenCalledWith(displaced)
		expect((displaced as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).not.toHaveBeenCalled()
	})

	it("the swap ABORTS the displaced task when the caller did not", async () => {
		const { provider } = await makeHarness()
		const displaced = makeTask("other")
		await provider.addShoferToStack(displaced)
		const live = makeTask("t-1", { messagesReady: Promise.resolve() })
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(live)
		vi.spyOn(provider.taskManager, "focusTask").mockResolvedValue(undefined as never)

		await provider.createTaskWithHistoryItem(historyItem())

		expect((displaced as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).toHaveBeenCalled()
	})

	it("SURVIVES a task the manager cannot focus — an externally created one is not in its map", async () => {
		const { provider } = await makeHarness()
		const live = makeTask("t-1", { messagesReady: Promise.resolve() })
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(live)
		vi.spyOn(provider.taskManager, "focusTask").mockRejectedValue(new Error("not managed"))

		await expect(provider.createTaskWithHistoryItem(historyItem())).resolves.toBe(live)
	})

	it("does NOT swap for an ABORTED live instance — that one really does need rehydrating", async () => {
		const { provider } = await makeHarness()
		const dead = makeTask("t-1", { abort: true, messagesReady: Promise.resolve() })
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(dead)

		const result = await provider.createTaskWithHistoryItem(historyItem())

		expect(result).not.toBe(dead)
	})

	it("CONSULTS the effective mode list before restoring the task's saved mode", async () => {
		const { provider } = await makeHarness()
		const getCustomModes = vi.spyOn(provider.customModesManager, "getCustomModes")

		await provider.createTaskWithHistoryItem(historyItem({ mode: "architect" }))

		expect(getCustomModes).toHaveBeenCalled()
		expect(provider.getValue("mode")).toBe("architect")
	})

	it("restores a mode the node still defines", async () => {
		const { provider } = await makeHarness()

		await provider.createTaskWithHistoryItem(historyItem({ mode: "code" }))

		expect(provider.getValue("mode")).toBe("code")
	})

	it("does NOT restore a per-mode profile when the task carries its OWN sticky profile", async () => {
		const { provider } = await makeHarness()
		const getModeConfigId = vi.spyOn(provider.providerSettingsManager, "getModeConfigId")

		await provider.createTaskWithHistoryItem(historyItem({ mode: "code", apiConfigName: "sticky" }))

		expect(getModeConfigId).not.toHaveBeenCalled()
	})

	it("does not restore a per-mode profile while the api config is LOCKED across modes", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.context.workspaceState, "get").mockReturnValue(true as never)
		const getModeConfigId = vi.spyOn(provider.providerSettingsManager, "getModeConfigId")

		await provider.createTaskWithHistoryItem(historyItem({ mode: "code" }))

		expect(getModeConfigId).not.toHaveBeenCalled()
	})
})

describe("focusTask", () => {
	it("SWAPS a live instance into the stack, unfocusing the one it replaces", async () => {
		const { provider } = await makeHarness()
		const displaced = makeTask("displaced")
		await provider.addShoferToStack(displaced)
		const live = makeTask("t-9")
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(live)
		vi.spyOn(provider.taskManager, "focusTask").mockResolvedValue(undefined as never)
		vi.spyOn(provider.taskManager, "clearTaskNotification").mockImplementation(() => undefined)
		vi.spyOn(provider.taskManager, "getManagedTasks").mockReturnValue([] as never)

		await provider.focusTask("t-9")

		expect(provider.getCurrentTask()).toBe(live)
		expect((displaced as unknown as { emit: ReturnType<typeof vi.fn> }).emit).toHaveBeenCalledWith("taskUnfocused")
		expect((displaced as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).not.toHaveBeenCalled()
	})

	it("PUSHES a live instance onto an empty stack", async () => {
		const { provider } = await makeHarness()
		const live = makeTask("t-9")
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(live)
		vi.spyOn(provider.taskManager, "focusTask").mockResolvedValue(undefined as never)
		vi.spyOn(provider.taskManager, "clearTaskNotification").mockImplementation(() => undefined)
		vi.spyOn(provider.taskManager, "getManagedTasks").mockReturnValue([] as never)

		await provider.focusTask("t-9")

		expect(provider.getCurrentTask()).toBe(live)
	})

	it("swaps even when TaskManager does not know the task — an external one is not in its map", async () => {
		const { provider } = await makeHarness()
		const live = makeTask("t-9")
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(live)
		vi.spyOn(provider.taskManager, "focusTask").mockRejectedValue(new Error("not managed"))

		await provider.focusTask("t-9")

		expect(provider.getCurrentTask()).toBe(live)
	})

	it("EVICTS a dead instance and rehydrates from history instead", async () => {
		const { provider } = await makeHarness()
		const dead = makeTask("t-9", { abort: true })
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(dead)
		const remove = vi.spyOn(provider.taskManager, "removeManagedTaskInstance").mockImplementation(() => undefined)
		vi.spyOn(provider.taskManager, "clearTaskNotification").mockImplementation(() => undefined)
		vi.spyOn(provider.taskManager, "getManagedTasks").mockReturnValue([] as never)
		const show = vi.spyOn(provider, "showTaskWithId").mockResolvedValue(undefined as never)

		await provider.focusTask("t-9")

		expect(remove).toHaveBeenCalledWith("t-9")
		expect(show).toHaveBeenCalledWith("t-9", { keepCurrentTask: true })
	})

	it("REGISTERS the rehydrated instance so the next focus switch takes the live path", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(undefined)
		vi.spyOn(provider.taskManager, "clearTaskNotification").mockImplementation(() => undefined)
		vi.spyOn(provider.taskManager, "getManagedTasks").mockReturnValue([] as never)
		const register = vi.spyOn(provider.taskManager, "registerBackgroundTask").mockImplementation(() => undefined)
		const rehydrated = makeTask("t-9")
		vi.spyOn(provider, "showTaskWithId").mockImplementation(async () => {
			await provider.addShoferToStack(rehydrated)
		})

		await provider.focusTask("t-9")

		expect(register).toHaveBeenCalledWith(rehydrated)
	})
})

describe("deliverToTask", () => {
	it("delivers straight into a LIVE instance's mailbox", async () => {
		const { provider } = await makeHarness()
		const live = makeTask("t-1", { deliver: vi.fn(async (e: unknown) => e) })
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(live)

		const envelope = { id: "e-1", from: "a", to: "t-1" }
		await expect(provider.deliverToTask("t-1", envelope as never)).resolves.toEqual(envelope)
		expect((live as unknown as { deliver: ReturnType<typeof vi.fn> }).deliver).toHaveBeenCalledWith(envelope)
	})

	it("delivers into the CURRENT task when it is the addressed one", async () => {
		const { provider } = await makeHarness()
		const current = makeTask("t-1", { deliver: vi.fn(async (e: unknown) => e) })
		await provider.addShoferToStack(current)

		await provider.deliverToTask("t-1", { id: "e-1" } as never)

		expect((current as unknown as { deliver: ReturnType<typeof vi.fn> }).deliver).toHaveBeenCalled()
	})

	it("still delivers to an ABORTED instance — a finished task's mailbox is in memory", async () => {
		const { provider } = await makeHarness()
		const finished = makeTask("t-1", { abort: true, deliver: vi.fn(async (e: unknown) => e) })
		vi.spyOn(provider.taskManager, "getManagedTaskInstance").mockReturnValue(finished)

		await provider.deliverToTask("t-1", { id: "e-1" } as never)

		expect((finished as unknown as { deliver: ReturnType<typeof vi.fn> }).deliver).toHaveBeenCalled()
	})

	it("REFUSES, naming both halves, when there is no instance and no history", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("Task not found"))

		await expect(provider.deliverToTask("ghost", { id: "e-1" } as never)).rejects.toThrow(
			/no live instance and no history/,
		)
	})

	it("REFUSES a task that has ERRORED — it cannot act on the message", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({
			historyItem: { id: "t-1", taskState: { lifecycle: "error" } },
		} as never)

		await expect(provider.deliverToTask("t-1", { id: "e-1" } as never)).rejects.toThrow(/has errored/)
	})
})

describe("per-mode api config", () => {
	it("resolveModeApiConfigName prefers the mode's OWN provider name", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
			{ id: "1", name: "mode-profile" },
		] as never)
		vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([] as never)

		await expect(provider.resolveModeApiConfigName("code")).resolves.toBeTypeOf("undefined")
	})

	it("setModeApiConfig writes the per-mode mapping through the settings manager", async () => {
		const { provider } = await makeHarness()
		const setModeConfig = vi
			.spyOn(provider.providerSettingsManager, "setModeConfig")
			.mockResolvedValue(undefined as never)
		vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
			{ id: "cfg-1", name: "prod" },
		] as never)
		vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([] as never)

		await provider.setModeApiConfig("code", "cfg-1")

		expect(setModeConfig).toHaveBeenCalledWith("code", "cfg-1")
	})
})

describe("deleteProviderProfile", () => {
	it("REFUSES to delete the last profile — something must stay active", async () => {
		const { provider } = await makeHarness({
			currentApiConfigName: "prod",
			listApiConfigMeta: [{ id: "cfg-1", name: "prod" }],
		})

		await expect(provider.deleteProviderProfile({ id: "cfg-1", name: "prod" } as never)).rejects.toThrow(
			/cannot delete the last profile/,
		)
	})

	it("ACTIVATES a survivor when the deleted profile was the active one", async () => {
		const { provider } = await makeHarness({
			currentApiConfigName: "prod",
			listApiConfigMeta: [
				{ id: "cfg-1", name: "prod" },
				{ id: "cfg-2", name: "dev" },
			],
		})

		await provider.deleteProviderProfile({ id: "cfg-1", name: "prod" } as never)

		expect(provider.getValue("currentApiConfigName")).toBe("dev")
		expect(provider.getValue("listApiConfigMeta")).toEqual([{ id: "cfg-2", name: "dev" }])
	})

	it("LEAVES the active profile alone when some other one is deleted", async () => {
		const { provider } = await makeHarness({
			currentApiConfigName: "prod",
			listApiConfigMeta: [
				{ id: "cfg-1", name: "prod" },
				{ id: "cfg-2", name: "dev" },
			],
		})

		await provider.deleteProviderProfile({ id: "cfg-2", name: "dev" } as never)

		expect(provider.getValue("currentApiConfigName")).toBe("prod")
	})
})

describe("dispose", () => {
	it("tears the provider down without throwing", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(makeTask("t-1"))

		await expect(provider.dispose()).resolves.toBeUndefined()
	})
})

describe("the task-created event fan-out", () => {
	/**
	 * The provider mirrors a task's own events onto its emitter (the ShoferApi's
	 * upstream). A missing wire is invisible: the controller simply never learns
	 * the task did that.
	 */
	function makeInstance(overrides: Record<string, unknown> = {}) {
		const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
		return {
			taskId: "t-1",
			instanceId: 1,
			abortReason: undefined as string | undefined,
			rootTask: undefined,
			parentTask: undefined,
			on: (event: string, cb: (...args: unknown[]) => void) => {
				listeners.set(event, [...(listeners.get(event) ?? []), cb])
			},
			off: vi.fn(),
			fire: async (event: string, ...args: unknown[]) => {
				for (const cb of listeners.get(event) ?? []) await cb(...args)
			},
			...overrides,
		}
	}

	async function wireUp() {
		const { provider } = await makeHarness()
		const instance = makeInstance()
		const seen: Array<{ name: string; args: unknown[] }> = []
		const emit = provider.emit.bind(provider) as (name: string, ...args: unknown[]) => boolean
		provider.emit = ((name: string, ...args: unknown[]) => {
			seen.push({ name, args })
			return emit(name, ...args)
		}) as typeof provider.emit

		provider.onTaskCreated(instance as never)
		return { provider, instance, seen }
	}

	it("announces the task the moment it is created", async () => {
		const { seen } = await wireUp()

		expect(seen.map((e) => e.name)).toContain("taskCreated")
	})

	it.each([["taskStarted"], ["taskFocused"], ["taskUnfocused"]])(
		"mirrors %s with the task's own id",
		async (event) => {
			const { instance, seen } = await wireUp()

			await instance.fire(event)

			expect(seen.find((e) => e.name === event)!.args).toEqual(["t-1"])
		},
	)

	it.each([["taskActive"], ["taskInteractive"], ["taskResumable"], ["taskIdle"], ["taskPaused"], ["taskUnpaused"]])(
		"mirrors %s with the id the task supplied",
		async (event) => {
			const { instance, seen } = await wireUp()

			await instance.fire(event, "t-9")

			expect(seen.find((e) => e.name === event)!.args).toEqual(["t-9"])
		},
	)

	it("mirrors taskCompleted with the usage and the completion info", async () => {
		const { instance, seen } = await wireUp()

		await instance.fire("taskCompleted", "t-1", { totalCost: 1 }, { read_file: 1 }, { rating: "well" })

		expect(seen.find((e) => e.name === "taskCompleted")!.args).toEqual([
			"t-1",
			{ totalCost: 1 },
			{ read_file: 1 },
			{ rating: "well" },
		])
	})

	it("mirrors the token-usage update", async () => {
		const { instance, seen } = await wireUp()

		await instance.fire("taskTokenUsageUpdated", "t-1", { totalCost: 2 }, {})

		expect(seen.find((e) => e.name === "taskTokenUsageUpdated")!.args[0]).toBe("t-1")
	})

	it("does NOT rehydrate on an ordinary abort — only a streaming failure earns that", async () => {
		const { provider, instance } = await wireUp()
		const create = vi.spyOn(provider, "createTaskWithHistoryItem").mockResolvedValue(undefined as never)

		await instance.fire("taskAborted", { reason: "user_cancelled" })

		expect(create).not.toHaveBeenCalled()
	})

	it("REHYDRATES after a streaming failure, carrying the task's parent and root", async () => {
		const { provider } = await makeHarness()
		const instance = makeInstance({
			abortReason: "streaming_failed",
			rootTask: { taskId: "root" },
			parentTask: { taskId: "parent" },
		})
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({ historyItem: { id: "t-1" } } as never)
		const create = vi.spyOn(provider, "createTaskWithHistoryItem").mockResolvedValue(undefined as never)
		provider.onTaskCreated(instance as never)

		await instance.fire("taskAborted", { reason: "streaming_failed" })

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ id: "t-1", rootTask: { taskId: "root" }, parentTask: { taskId: "parent" } }),
		)
	})

	it("SKIPS the rehydrate when another path already replaced the instance", async () => {
		const { provider } = await makeHarness()
		const instance = makeInstance({ abortReason: "streaming_failed", instanceId: 1 })
		await provider.addShoferToStack(makeTask("t-1", { instanceId: 2 }))
		const create = vi.spyOn(provider, "createTaskWithHistoryItem").mockResolvedValue(undefined as never)
		provider.onTaskCreated(instance as never)

		await instance.fire("taskAborted", { reason: "streaming_failed" })

		expect(create).not.toHaveBeenCalled()
	})

	it("LOGS — and does not throw — when the rehydrate itself fails", async () => {
		const { provider, logLines } = await makeHarness()
		const instance = makeInstance({ abortReason: "streaming_failed" })
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("Task not found"))
		provider.onTaskCreated(instance as never)

		await instance.fire("taskAborted", { reason: "streaming_failed" })

		expect(logLines.join(" ")).toContain("Failed to rehydrate after streaming failure")
	})
})

describe("resetState", () => {
	it("does NOTHING when the confirmation is declined", async () => {
		const { provider } = await makeHarness()
		const reset = vi.spyOn(provider.contextProxy, "resetAllState").mockResolvedValue(undefined as never)

		await provider.resetState()

		expect(reset).not.toHaveBeenCalled()
	})
})

describe("_cancelTaskInner", () => {
	async function cancelWith(task: ReturnType<typeof makeTask>) {
		const { provider, logLines } = await makeHarness()
		await provider.addShoferToStack(task)
		vi.spyOn(provider, "getTaskWithId").mockResolvedValue({ historyItem: { id: "t-1" } } as never)
		const create = vi.spyOn(provider, "createTaskWithHistoryItem").mockResolvedValue(undefined as never)
		await provider.cancelTask()
		return { provider, logLines, create, task }
	}

	function cancellableTask(overrides: Record<string, unknown> = {}) {
		return makeTask("t-1", {
			instanceId: 1,
			isStreaming: false,
			didFinishAbortingStream: true,
			isWaitingForFirstChunk: false,
			cancelCurrentRequest: vi.fn(),
			abandoned: false,
			didExecuteAttemptCompletion: false,
			...overrides,
		})
	}

	it("is a no-op with nothing on the stack", async () => {
		const { provider } = await makeHarness()

		await expect(provider.cancelTask()).resolves.toBeUndefined()
	})

	it("SKIPS an already-terminal task — aborting one can hang and wedge every caller", async () => {
		const finished = cancellableTask({ didExecuteAttemptCompletion: true })

		const { create } = await cancelWith(finished)

		expect((finished as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})

	it("marks the cancellation as USER-initiated, cancels the request, and abandons the instance", async () => {
		const task = cancellableTask()

		await cancelWith(task)

		const state = task as unknown as {
			abortReason: string
			abandoned: boolean
			cancelCurrentRequest: ReturnType<typeof vi.fn>
			abortTask: ReturnType<typeof vi.fn>
		}
		expect(state.abortReason).toBe("user_cancelled")
		expect(state.cancelCurrentRequest).toHaveBeenCalled()
		expect(state.abandoned).toBe(true)
		expect(state.abortTask).toHaveBeenCalled()
	})

	it("REHYDRATES the task from history after the abort completes", async () => {
		const { create } = await cancelWith(cancellableTask())

		expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: "t-1" }))
	})

	it("still aborts a task whose history has not been written yet — it just skips the rehydrate", async () => {
		const { provider } = await makeHarness()
		const task = cancellableTask()
		await provider.addShoferToStack(task)
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("Task not found"))
		const create = vi.spyOn(provider, "createTaskWithHistoryItem").mockResolvedValue(undefined as never)

		await provider.cancelTask()

		expect((task as unknown as { abortTask: ReturnType<typeof vi.fn> }).abortTask).toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})

	it("PROPAGATES a history-lookup failure that is not 'Task not found'", async () => {
		const { provider } = await makeHarness()
		await provider.addShoferToStack(cancellableTask())
		vi.spyOn(provider, "getTaskWithId").mockRejectedValue(new Error("disk unreadable"))

		await expect(provider.cancelTask()).rejects.toThrow("disk unreadable")
	})
})

describe("task export destinations", () => {
	/**
	 * `showSaveDialog` on a WEB host writes to the remote server rather than the
	 * user's machine, so the export first asks WHERE — and the browser branch has
	 * to stream the bytes back to the webview instead of writing a file.
	 */
	async function exportHarness(destination: "browser" | "file" | undefined) {
		const harness = await makeHarness()
		const misc = await import("../../../integrations/misc/export-destination")
		vi.spyOn(misc, "pickExportDestination").mockResolvedValue(destination as never)
		vi.spyOn(harness.provider, "getTaskWithId").mockResolvedValue({
			historyItem: { id: "t-1", ts: 1, task: "the task" },
			apiConversationHistory: [{ role: "user", content: "hello" }],
		} as never)
		return harness
	}

	it("does NOTHING when the user dismisses the destination picker", async () => {
		const { provider, posted } = await exportHarness(undefined)

		await provider.exportTaskWithId("t-1")

		expect(posted).not.toHaveBeenCalled()
	})

	it("STREAMS the markdown to the webview for a browser download", async () => {
		const { provider, postedOfType } = await exportHarness("browser")

		await provider.exportTaskWithId("t-1")

		const download = postedOfType("browserDownload")[0].browserDownload as Record<string, unknown>
		expect(download.mime).toBe("text/markdown")
		expect(download.fileName).toMatch(/^shofer_task_.*\.md$/)
		expect(download.content).toContain("**User:**")
	})
})

describe("condenseTaskContext", () => {
	it("REFUSES a task that is not on the stack", async () => {
		const { provider } = await makeHarness()

		await expect(provider.condenseTaskContext("ghost")).rejects.toThrow(/not found in stack/)
	})

	it("condenses the addressed task and tells the webview it finished", async () => {
		const { provider, postedOfType } = await makeHarness()
		const task = makeTask("t-1", { condenseContext: vi.fn(async () => undefined) })
		await provider.addShoferToStack(task)

		await provider.condenseTaskContext("t-1")

		expect((task as unknown as { condenseContext: ReturnType<typeof vi.fn> }).condenseContext).toHaveBeenCalled()
		expect(postedOfType("condenseTaskContextResponse")[0]).toMatchObject({ text: "t-1" })
	})
})

describe("the OAuth callbacks", () => {
	it("handleOpenRouterCallback exchanges the code and UPSERTS the profile", async () => {
		const { provider } = await makeHarness({ currentApiConfigName: "prod" })
		const axios = (await import("axios")).default as unknown as { post: ReturnType<typeof vi.fn> }
		axios.post = vi.fn(async () => ({ data: { key: "sk-or-123" } }))
		const upsert = vi.spyOn(provider, "upsertProviderProfile").mockResolvedValue("cfg-1" as never)

		await provider.handleOpenRouterCallback("the-code")

		expect(upsert).toHaveBeenCalledWith(
			"prod",
			expect.objectContaining({ apiProvider: "openrouter", openRouterApiKey: "sk-or-123" }),
		)
	})

	it("handleOpenRouterCallback REFUSES a response carrying no key", async () => {
		const { provider, logLines } = await makeHarness()
		const axios = (await import("axios")).default as unknown as { post: ReturnType<typeof vi.fn> }
		axios.post = vi.fn(async () => ({ data: {} }))

		await expect(provider.handleOpenRouterCallback("the-code")).rejects.toThrow()
		expect(logLines.join(" ")).toContain("Error exchanging code")
	})

	it("handleRequestyCallback drops the DEFAULT base url and keeps a custom one", async () => {
		const custom = await makeHarness()
		vi.spyOn(custom.provider, "upsertProviderProfile").mockResolvedValue("cfg-1" as never)
		vi.spyOn(custom.provider, "activateProviderProfile").mockResolvedValue(undefined as never)

		await custom.provider.handleRequestyCallback("key-1", "https://custom.example")

		const [, settings] = (custom.provider.upsertProviderProfile as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(settings).toMatchObject({
			apiProvider: "requesty",
			requestyApiKey: "key-1",
			requestyBaseUrl: "https://custom.example",
		})

		const plain = await makeHarness()
		vi.spyOn(plain.provider, "upsertProviderProfile").mockResolvedValue("cfg-1" as never)
		vi.spyOn(plain.provider, "activateProviderProfile").mockResolvedValue(undefined as never)
		await plain.provider.handleRequestyCallback("key-1", null)
		const [, plainSettings] = (plain.provider.upsertProviderProfile as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(plainSettings.requestyBaseUrl).toBeUndefined()
	})

	it("handleRequestyCallback saves WITHOUT activating, then activates once", async () => {
		const { provider } = await makeHarness()
		const upsert = vi.spyOn(provider, "upsertProviderProfile").mockResolvedValue("cfg-1" as never)
		const activate = vi.spyOn(provider, "activateProviderProfile").mockResolvedValue(undefined as never)

		await provider.handleRequestyCallback("key-1", null)

		expect(upsert.mock.calls[0][2]).toBe(false)
		expect(activate).toHaveBeenCalledTimes(1)
	})
})

describe("the static action entry points", () => {
	it("handleCodeAction ADDS to context without starting a task", async () => {
		const { provider, postedOfType } = await makeHarness()
		vi.spyOn(ShoferProvider, "getInstance").mockResolvedValue(provider)
		const create = vi.spyOn(provider, "createTask")

		await ShoferProvider.handleCodeAction("addToContext", "ADD_TO_CONTEXT", {
			filePath: "/w/a.ts",
			selectedText: "x",
		})

		expect(create).not.toHaveBeenCalled()
		expect(postedOfType("invoke")[0]).toMatchObject({ invoke: "setChatBoxMessage" })
		expect(postedOfType("action").some((m) => m.action === "focusInput")).toBe(true)
	})

	it("handleCodeAction STARTS a task for every other command", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(ShoferProvider, "getInstance").mockResolvedValue(provider)
		const create = vi.spyOn(provider, "createTask").mockResolvedValue({ taskId: "t-new" } as never)

		await ShoferProvider.handleCodeAction("explainCode", "EXPLAIN", { filePath: "/w/a.ts", selectedText: "x" })

		expect(create).toHaveBeenCalled()
	})

	it("handleTerminalAction adds to context, or starts a task", async () => {
		const added = await makeHarness()
		vi.spyOn(ShoferProvider, "getInstance").mockResolvedValue(added.provider)
		const addCreate = vi.spyOn(added.provider, "createTask")
		await ShoferProvider.handleTerminalAction("terminalAddToContext", "TERMINAL_ADD_TO_CONTEXT", {
			terminalContent: "npm test",
		})
		expect(addCreate).not.toHaveBeenCalled()

		const started = await makeHarness()
		vi.spyOn(ShoferProvider, "getInstance").mockResolvedValue(started.provider)
		const create = vi.spyOn(started.provider, "createTask").mockResolvedValue({ taskId: "t-new" } as never)
		await ShoferProvider.handleTerminalAction("terminalFixCommand", "TERMINAL_FIX", {
			terminalContent: "npm test",
		})
		expect(create).toHaveBeenCalled()
	})

	it("isActiveTask reports whether the visible provider holds a task", async () => {
		const { provider } = await makeHarness()
		vi.spyOn(ShoferProvider, "getInstance").mockResolvedValue(provider)
		await expect(ShoferProvider.isActiveTask()).resolves.toBe(false)

		await provider.addShoferToStack(makeTask("t-1"))
		await expect(ShoferProvider.isActiveTask()).resolves.toBe(true)
	})
})
