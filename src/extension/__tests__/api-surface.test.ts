// npx vitest src/extension/__tests__/api-surface.test.ts

/**
 * `API` is the ShoferExtensionApi — what a controller (user-console, the CLI, an
 * IPC client) drives this host through. It is deliberately thin, so the tests
 * here are about the few places it makes a decision of its own:
 *
 *  - **Every task operation is task-ADDRESSED.** Starting or resuming a task
 *    BACKGROUNDS the previous one rather than killing it, so the conversation a
 *    caller cancels is routinely not the current one; addressing the wrong task
 *    is a silent no-op that reports success while the agent keeps running.
 *  - **`resumeTask` on a LIVE task does nothing** — rehydrating it would abort
 *    the instance mid-turn.
 *  - **A cancelled background task is marked `user_cancelled`**, because a
 *    controller must tell a user Stop apart from an eviction.
 *  - **Secrets never leave through `getConfiguration`**, which is also what
 *    `exportConfiguration` serializes.
 *  - **A corrupt transcript degrades to "nothing said yet"** rather than failing
 *    the whole attach.
 */

const hoisted = vi.hoisted(() => ({
	executeCommand: vi.fn(async () => undefined),
	getRecentLogs: vi.fn(() => "log line"),
	readTaskMessages: vi.fn(async () => [{ ts: 1, type: "say", say: "text", text: "persisted" }]),
	pluginRequest: vi.fn(async () => ({ ok: true })),
	resolveTaskCwd: vi.fn(async () => "/worktree"),
	ipcOn: vi.fn(),
	ipcListen: vi.fn(),
	ipcSend: vi.fn(),
}))

vi.mock("@shofer/ipc", () => ({
	IpcServer: class {
		listen = hoisted.ipcListen
		send = hoisted.ipcSend
		on = hoisted.ipcOn
	},
}))

vi.mock("../../core/webview/resolveTaskCwd", () => ({ resolveTaskCwd: hoisted.resolveTaskCwd }))

vi.mock("vscode", () => ({
	commands: { executeCommand: hoisted.executeCommand },
	window: {},
	workspace: {},
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	getRecentLogs: hoisted.getRecentLogs,
	readTaskMessages: hoisted.readTaskMessages,
	pluginRegistry: { request: hoisted.pluginRequest },
}))

import { API } from "../api"
import type { ShoferProvider } from "../../core/webview/ShoferProvider"

const outputChannel = { appendLine: vi.fn() } as unknown as import("vscode").OutputChannel

type ProviderOverrides = Partial<Record<string, unknown>>

function makeTask(taskId: string, extra: Record<string, unknown> = {}) {
	return {
		abortReason: undefined as string | undefined,
		taskId,
		abort: false,
		abandoned: false,
		cwd: "/w",
		shoferMessages: [{ ts: 1, type: "say", say: "text", text: "live" }],
		getTokenUsage: () => ({ totalTokensIn: 1, totalTokensOut: 2, totalCost: 0, contextTokens: 10 }),
		cancelCurrentRequest: vi.fn(),
		abortTask: vi.fn(async () => undefined),
		messageQueueService: { removeMessage: vi.fn(), addMessage: vi.fn() },
		rootTaskId: undefined as string | undefined,
		isAwaitingAsk: () => false,
		handleWebviewAskResponse: vi.fn(),
		submitUserMessage: vi.fn(async () => undefined),
		startFromHistory: vi.fn(),
		...extra,
	}
}

function makeProvider(overrides: ProviderOverrides = {}) {
	const managed = (overrides.managedInstances as Record<string, unknown>) ?? {}
	return {
		context: {} as never,
		on: vi.fn(),
		cwd: "/w",
		viewLaunched: true,
		getCurrentTask: vi.fn(() => overrides.currentTask),
		getCurrentTaskStack: vi.fn(() => ["t-1"]),
		removeShoferFromStack: vi.fn(async () => undefined),
		cancelTask: vi.fn(async () => undefined),
		postInitState: vi.fn(async () => undefined),
		postMessageToWebview: vi.fn(async () => undefined),
		getValues: vi.fn(() => (overrides.values as object) ?? {}),
		getProviderProfileEntries: vi.fn(() => (overrides.profiles as unknown[]) ?? []),
		getProviderProfileEntry: vi.fn((name: string) =>
			((overrides.profiles as Array<{ name: string }>) ?? []).find((p) => p.name === name),
		),
		upsertProviderProfile: vi.fn(async () => (overrides.upsertId === null ? undefined : "profile-id")),
		activateProviderProfile: vi.fn(async () => undefined),
		deleteProviderProfile: vi.fn(async () => undefined),
		contextProxy: { setValues: vi.fn(async () => undefined), globalStorageUri: { fsPath: "/global" } },
		providerSettingsManager: { saveConfig: vi.fn(async () => undefined) },
		taskHistoryStore: {
			getAll: vi.fn(() => (overrides.history as unknown[]) ?? []),
			getOrLoad: vi.fn(async (id: string) =>
				((overrides.history as Array<{ id: string }>) ?? []).find((h) => h.id === id),
			),
			initialized: Promise.resolve(),
		},
		taskManager: {
			getManagedTaskInstance: vi.fn((id: string) => managed[id]),
			getManagedTasks: vi.fn(() => Object.keys(managed).map((id) => ({ id }))),
			renameManagedTask: vi.fn(),
		},
		getTaskWithId: vi.fn(async (id: string) => {
			const item = ((overrides.history as Array<{ id: string }>) ?? []).find((h) => h.id === id)
			if (!item) throw new Error(`Task not found: ${id}`)
			return { historyItem: item, apiConversationHistory: (overrides.apiHistory as unknown[]) ?? [] }
		}),
		updateTaskHistory: vi.fn(async () => []),
		renameManagedTask: vi.fn(),
		archiveManagedTask: vi.fn(async () => undefined),
		unarchiveManagedTask: vi.fn(async () => undefined),
		pinManagedTask: vi.fn(async () => undefined),
		unpinManagedTask: vi.fn(async () => undefined),
		deleteTaskWithId: vi.fn(async () => undefined),
		showTaskWithId: vi.fn(async () => undefined),
		createTaskWithHistoryItem: vi.fn(async () => undefined),
		createTask: vi.fn(async () => ({ taskId: "t-new" })),
		backgroundCurrentTask: vi.fn(),
		deliverToTask: vi.fn(async () => undefined),
		handleModeSwitch: vi.fn(async () => undefined),
		getTaskStackInstances: vi.fn(() => (overrides.taskStackInstances as unknown[]) ?? []),
		...overrides,
	} as unknown as ShoferProvider
}

function makeApi(overrides: ProviderOverrides = {}) {
	const provider = makeProvider(overrides)
	return { api: new API(outputChannel, provider), provider }
}

beforeEach(() => vi.clearAllMocks())

describe("configuration", () => {
	it("STRIPS secret keys — a controller must never receive an api key", () => {
		const { api } = makeApi({
			values: { currentApiConfigName: "default", apiKey: "sk-secret", ttsSpeed: 1 },
		})

		const config = api.getConfiguration()

		expect(config).toEqual({ currentApiConfigName: "default", ttsSpeed: 1 })
	})

	it("exportConfiguration serializes exactly what getConfiguration returns", () => {
		const { api } = makeApi({ values: { ttsSpeed: 1, apiKey: "sk-secret" } })

		expect(JSON.parse(api.exportConfiguration())).toEqual({ ttsSpeed: 1 })
	})

	it("setConfiguration writes the proxy, saves the profile and re-broadcasts", async () => {
		const { api, provider } = makeApi()

		await api.setConfiguration({ currentApiConfigName: "prod", ttsSpeed: 2 } as never)

		expect(provider.contextProxy.setValues).toHaveBeenCalled()
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith(
			"prod",
			expect.objectContaining({ currentApiConfigName: "prod" }),
		)
		expect(provider.postInitState).toHaveBeenCalled()
	})

	it("setConfiguration falls back to the `default` profile name", async () => {
		const { api, provider } = makeApi()

		await api.setConfiguration({ ttsSpeed: 2 } as never)

		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", expect.anything())
	})

	it("importConfiguration REFUSES malformed JSON with an actionable message", async () => {
		const { api } = makeApi()

		await expect(api.importConfiguration("{not json")).rejects.toThrow(/Invalid configuration JSON/)
	})

	it("importConfiguration applies a valid document", async () => {
		const { api, provider } = makeApi()

		await api.importConfiguration(JSON.stringify({ ttsSpeed: 3 }))

		expect(provider.contextProxy.setValues).toHaveBeenCalled()
	})
})

describe("provider profiles", () => {
	const profiles = [{ id: "1", name: "default" }]

	it("lists profile names", () => {
		const { api } = makeApi({ profiles })

		expect(api.getProfiles()).toEqual(["default"])
		expect(api.getProfileEntry("default")).toEqual(profiles[0])
	})

	it("createProfile REFUSES a name that already exists", async () => {
		const { api } = makeApi({ profiles })

		await expect(api.createProfile("default")).rejects.toThrow(/already exists/)
	})

	it("createProfile saves and then ACTIVATES separately", async () => {
		const { api, provider } = makeApi()

		await expect(api.createProfile("new")).resolves.toBe("profile-id")

		expect(provider.upsertProviderProfile).toHaveBeenCalledWith("new", {}, false)
		expect(provider.activateProviderProfile).toHaveBeenCalledWith({ name: "new" })
	})

	it("createProfile skips activation when the caller opts out", async () => {
		const { api, provider } = makeApi()

		await api.createProfile("new", { apiProvider: "anthropic" } as never, false)

		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
	})

	it("createProfile REFUSES when the save produced no id", async () => {
		const { api } = makeApi({ upsertId: null })

		await expect(api.createProfile("new")).rejects.toThrow(/Failed to create profile/)
	})

	it("updateProfile REFUSES a profile that does not exist", async () => {
		const { api } = makeApi()

		await expect(api.updateProfile("ghost", {} as never)).rejects.toThrow(/does not exist/)
	})

	it("updateProfile saves and activates an existing profile", async () => {
		const { api, provider } = makeApi({ profiles })

		await expect(api.updateProfile("default", { apiProvider: "anthropic" } as never)).resolves.toBe("profile-id")
		expect(provider.activateProviderProfile).toHaveBeenCalledWith({ name: "default" })
	})

	it("updateProfile REFUSES when the save produced no id", async () => {
		const { api } = makeApi({ profiles, upsertId: null })

		await expect(api.updateProfile("default", {} as never)).rejects.toThrow(/Failed to update profile/)
	})

	it("upsertProfile does NOT require the profile to exist", async () => {
		const { api, provider } = makeApi()

		await expect(api.upsertProfile("brand-new", {} as never)).resolves.toBe("profile-id")
		expect(provider.activateProviderProfile).toHaveBeenCalled()
	})

	it("upsertProfile REFUSES when the save produced no id, and can skip activation", async () => {
		const skipped = makeApi()
		await skipped.api.upsertProfile("p", {} as never, false)
		expect(skipped.provider.activateProviderProfile).not.toHaveBeenCalled()

		const failed = makeApi({ upsertId: null })
		await expect(failed.api.upsertProfile("p", {} as never)).rejects.toThrow(/Failed to upsert profile/)
	})

	it("deleteProfile REFUSES an unknown name and deletes a known one", async () => {
		const { api } = makeApi()
		await expect(api.deleteProfile("ghost")).rejects.toThrow(/does not exist/)

		const known = makeApi({ profiles })
		await known.api.deleteProfile("default")
		expect(known.provider.deleteProviderProfile).toHaveBeenCalledWith(profiles[0])
	})

	it("getActiveProfile reads the current name off the (secret-stripped) configuration", () => {
		const { api } = makeApi({ values: { currentApiConfigName: "prod", apiKey: "sk" } })

		expect(api.getActiveProfile()).toBe("prod")
	})

	it("setActiveProfile REFUSES an unknown name and returns the new active name", async () => {
		const { api } = makeApi()
		await expect(api.setActiveProfile("ghost")).rejects.toThrow(/does not exist/)

		const known = makeApi({ profiles, values: { currentApiConfigName: "default" } })
		await expect(known.api.setActiveProfile("default")).resolves.toBe("default")
		expect(known.provider.activateProviderProfile).toHaveBeenCalledWith({ name: "default" })
	})
})

describe("task addressing", () => {
	it("resumeTask does NOTHING for a live instance — rehydrating would abort it mid-turn", async () => {
		const live = makeTask("t-1")
		const { api, provider } = makeApi({ managedInstances: { "t-1": live } })

		await api.resumeTask("t-1")

		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(hoisted.executeCommand).not.toHaveBeenCalled()
	})

	it("resumeTask treats the CURRENT task as live too", async () => {
		const current = makeTask("t-1")
		const { api, provider } = makeApi({ currentTask: current })

		await api.resumeTask("t-1")

		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("resumeTask rehydrates an ABORTED instance, keeping the host's current task alive", async () => {
		const dead = makeTask("t-1", { abort: true })
		const { api, provider } = makeApi({
			managedInstances: { "t-1": dead },
			history: [{ id: "t-1", ts: 1, task: "t" }],
		})

		await api.resumeTask("t-1")

		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith(expect.objectContaining({ id: "t-1" }), {
			keepCurrentTask: true,
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "chatButtonClicked" })
	})

	it("resumeTask continues HEADLESS when no webview launched", async () => {
		const { api, provider } = makeApi({ viewLaunched: false, history: [{ id: "t-1", ts: 1, task: "t" }] })

		await api.resumeTask("t-1")

		expect(provider.createTaskWithHistoryItem).toHaveBeenCalled()
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("isTaskInHistory answers by whether the store can produce the item", async () => {
		const { api } = makeApi({ history: [{ id: "t-1", ts: 1, task: "t" }] })

		await expect(api.isTaskInHistory("t-1")).resolves.toBe(true)
		await expect(api.isTaskInHistory("ghost")).resolves.toBe(false)
	})

	it("cancelTask on the CURRENT task uses the provider's own cancel path", async () => {
		const current = makeTask("t-1")
		const { api, provider } = makeApi({ currentTask: current })

		await api.cancelTask("t-1")

		expect(provider.cancelTask).toHaveBeenCalled()
		expect(current.abortTask).not.toHaveBeenCalled()
	})

	it("cancelTask with NO current task falls through to the provider", async () => {
		const { api, provider } = makeApi()

		await api.cancelTask("t-1")

		expect(provider.cancelTask).toHaveBeenCalled()
	})

	it("cancelTask marks a BACKGROUND task user_cancelled — not an eviction", async () => {
		const background = makeTask("t-2")
		const { api, provider } = makeApi({
			currentTask: makeTask("t-1"),
			managedInstances: { "t-2": background },
		})

		await api.cancelTask("t-2")

		expect(background.abortReason).toBe("user_cancelled")
		expect(background.cancelCurrentRequest).toHaveBeenCalled()
		expect(background.abortTask).toHaveBeenCalled()
		expect(provider.cancelTask).not.toHaveBeenCalled()
	})

	it("cancelTask is a logged no-op for a task with no live instance", async () => {
		const { api, provider } = makeApi({ currentTask: makeTask("t-1") })

		await expect(api.cancelTask("t-9")).resolves.toBeUndefined()
		expect(provider.cancelTask).not.toHaveBeenCalled()
	})

	it("cancelTask is a no-op for an already-aborted background instance", async () => {
		const background = makeTask("t-2", { abort: true })
		const { api } = makeApi({ currentTask: makeTask("t-1"), managedInstances: { "t-2": background } })

		await api.cancelTask("t-2")

		expect(background.abortTask).not.toHaveBeenCalled()
	})

	it("clearCurrentTask pops the stack and re-broadcasts", async () => {
		const { api, provider } = makeApi()

		await api.clearCurrentTask()

		expect(provider.removeShoferFromStack).toHaveBeenCalled()
		expect(provider.postInitState).toHaveBeenCalled()
	})

	it("getCurrentTaskStack and isReady project the provider's own view", () => {
		const { api } = makeApi()

		expect(api.getCurrentTaskStack()).toEqual(["t-1"])
		expect(api.isReady()).toBe(true)
	})

	it("deleteQueuedMessage is a logged no-op without a current task", () => {
		const { api } = makeApi()

		expect(() => api.deleteQueuedMessage("m-1")).not.toThrow()
	})

	it("deleteQueuedMessage reaches the current task's queue", () => {
		const current = makeTask("t-1")
		const { api } = makeApi({ currentTask: current })

		api.deleteQueuedMessage("m-1")

		expect(current.messageQueueService.removeMessage).toHaveBeenCalledWith("m-1")
	})
})

describe("task history operations", () => {
	const history = [{ id: "t-1", ts: 10, task: "do it", name: "Old name" }]

	it("getTaskHistoryItems reads the store", () => {
		const { api } = makeApi({ history })

		expect(api.getTaskHistoryItems()).toBe(history)
	})

	it("renameTask persists the new name AND renames the live instance", async () => {
		const { api, provider } = makeApi({ history })

		await api.renameTask("t-1", "New name")

		expect(provider.updateTaskHistory).toHaveBeenCalledWith(expect.objectContaining({ name: "New name" }))
		expect(provider.renameManagedTask).toHaveBeenCalledWith("t-1", "New name")
	})

	it("renameTask REFUSES a task that is not in history", async () => {
		const { api } = makeApi()

		await expect(api.renameTask("ghost", "n")).rejects.toThrow(/Task not found/)
	})

	it.each([
		["archiveTask", "archiveManagedTask"],
		["unarchiveTask", "unarchiveManagedTask"],
		["pinTask", "pinManagedTask"],
		["unpinTask", "unpinManagedTask"],
	] as const)("%s delegates to %s", async (apiMethod, providerMethod) => {
		const { api, provider } = makeApi()

		await (api[apiMethod] as (id: string) => Promise<void>)("t-1")

		expect(provider[providerMethod]).toHaveBeenCalledWith("t-1")
	})

	it("deleteTask cascades subtasks by DEFAULT", async () => {
		const { api, provider } = makeApi()

		await api.deleteTask("t-1")
		expect(provider.deleteTaskWithId).toHaveBeenCalledWith("t-1", true)

		await api.deleteTask("t-1", false)
		expect(provider.deleteTaskWithId).toHaveBeenLastCalledWith("t-1", false)
	})

	it("showTaskWithId forwards the keepCurrentTask option", async () => {
		const { api, provider } = makeApi()

		await api.showTaskWithId("t-1", { keepCurrentTask: true })

		expect(provider.showTaskWithId).toHaveBeenCalledWith("t-1", { keepCurrentTask: true })
	})
})

describe("conversations and snapshots", () => {
	it("prefers the LIVE instance's messages and its context occupancy", async () => {
		const live = makeTask("t-1")
		const { api } = makeApi({ managedInstances: { "t-1": live } })

		const conversation = await api.getTaskConversation("t-1")

		expect(conversation!.messages).toEqual(live.shoferMessages)
		expect(conversation!.tokenUsage!.contextTokens).toBe(10)
	})

	it("takes the CURRENT task when it is the one addressed", async () => {
		const current = makeTask("t-1")
		const { api } = makeApi({ currentTask: current })

		const conversation = await api.getTaskConversation("t-1")

		expect(conversation!.messages).toEqual(current.shoferMessages)
	})

	it("reads the persisted transcript for a task with no live instance", async () => {
		const { api } = makeApi({ history: [{ id: "t-1", ts: 1, task: "t", tokensIn: 5, tokensOut: 6, totalCost: 1 }] })

		const conversation = await api.getTaskConversation("t-1")

		expect(conversation!.messages).toEqual([{ ts: 1, type: "say", say: "text", text: "persisted" }])
		expect(conversation!.tokenUsage).toMatchObject({ totalTokensIn: 5, totalTokensOut: 6, totalCost: 1 })
	})

	it("reports ZERO context tokens for a rehydrated transcript rather than fabricating one", async () => {
		const { api } = makeApi({ history: [{ id: "t-1", ts: 1, task: "t" }] })

		const conversation = await api.getTaskConversation("t-1")

		expect(conversation!.tokenUsage!.contextTokens).toBe(0)
	})

	it("DEGRADES to 'nothing said yet' when the transcript cannot be read", async () => {
		hoisted.readTaskMessages.mockRejectedValueOnce(new Error("corrupt jsonl"))
		const { api } = makeApi({ history: [{ id: "t-1", ts: 1, task: "t" }] })

		const conversation = await api.getTaskConversation("t-1")

		expect(conversation!.messages).toEqual([])
		expect(conversation!.tokenUsage).toBeDefined()
	})

	it("answers undefined for a task nobody has heard of", async () => {
		const { api } = makeApi()

		await expect(api.getTaskConversation("ghost")).resolves.toBeUndefined()
	})

	it("getTaskSnapshot folds the history row into the conversation", async () => {
		const { api } = makeApi({
			history: [{ id: "t-1", ts: 10, task: "do it", taskState: { lifecycle: "idle" } }],
		})

		const snapshot = await api.getTaskSnapshot("t-1")

		expect(snapshot).toMatchObject({
			taskId: "t-1",
			summary: "do it",
			createdAt: 10,
			state: { lifecycle: "idle" },
		})
	})

	it("getTaskSnapshot is undefined when there is no conversation to describe", async () => {
		const { api } = makeApi()

		await expect(api.getTaskSnapshot("ghost")).resolves.toBeUndefined()
	})
})

describe("exports", () => {
	it("renders the api conversation as role-labelled markdown", async () => {
		const { api } = makeApi({
			history: [{ id: "t-1", ts: 1, task: "t" }],
			apiHistory: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			],
		})

		const markdown = await api.getTaskMarkdownExport("t-1")

		expect(markdown).toContain("**User:**")
		expect(markdown).toContain("**Assistant:**")
		expect(markdown).toContain("---")
	})

	it("builds a JSON trace, tolerating an unreadable ui_messages file", async () => {
		hoisted.readTaskMessages.mockRejectedValueOnce(new Error("gone"))
		const { api } = makeApi({ history: [{ id: "t-1", ts: 1, task: "t" }] })

		const trace = await api.getTaskJsonExport("t-1")

		expect(trace).toMatchObject({ version: 1, taskId: "t-1", task: "t", calls: [], totalCalls: 0 })
	})
})

describe("plugin RPC and logs", () => {
	it("pluginRequest addresses the managed task, falling back to the current one", async () => {
		const { api } = makeApi({ currentTask: makeTask("t-current") })

		await expect(api.pluginRequest("t-9", "basics", "getChangedFiles")).resolves.toEqual({ ok: true })

		expect(hoisted.pluginRequest).toHaveBeenCalledWith("basics", "getChangedFiles", undefined, {
			taskId: "t-current",
			cwd: "/w",
		})
	})

	it("pluginRequest still names the requested task when no instance exists", async () => {
		const { api } = makeApi()

		await api.pluginRequest("t-9", "basics", "m")

		expect(hoisted.pluginRequest).toHaveBeenCalledWith("basics", "m", undefined, { taskId: "t-9", cwd: undefined })
	})

	it("getOutputLogs defaults to a bounded tail", () => {
		const { api } = makeApi()

		expect(api.getOutputLogs()).toBe("log line")
		expect(hoisted.getRecentLogs).toHaveBeenCalledWith(2000)

		api.getOutputLogs(10)
		expect(hoisted.getRecentLogs).toHaveBeenLastCalledWith(10)
	})
})

describe("subscribe", () => {
	it("forwards only the client-facing events, and STOPS on unsubscribe", () => {
		const { api } = makeApi()
		const events: Array<{ type: string }> = []

		const unsubscribe = api.subscribe((event) => events.push(event))
		;(api.emit as unknown as (name: string, ...args: unknown[]) => boolean)("taskStarted", "t-1")
		expect(events.map((e) => e.type)).toContain("taskStarted")

		unsubscribe()
		events.length = 0
		;(api.emit as unknown as (name: string, ...args: unknown[]) => boolean)("taskStarted", "t-1")
		expect(events).toEqual([])
	})
})

describe("createTask", () => {
	it("BACKGROUNDS the current task rather than aborting it, and keeps it that way", async () => {
		const { api, provider } = makeApi()

		await api.createTask({ prompt: "do it" })

		expect(provider.backgroundCurrentTask).toHaveBeenCalled()
		expect(provider.createTask).toHaveBeenCalledWith(
			"do it",
			undefined,
			undefined,
			expect.objectContaining({ keepCurrentTask: true }),
			{},
			"/worktree",
		)
	})

	it("merges the base contract's provider slice UNDER the host's full-settings seed", async () => {
		const { api, provider } = makeApi()

		await api.createTask({
			prompt: "do it",
			apiConfiguration: { apiProvider: "anthropic", apiModelId: "a" } as never,
			configuration: { apiModelId: "b" } as never,
		})

		const [, , , , configuration] = (provider.createTask as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(configuration).toEqual({ apiProvider: "anthropic", apiModelId: "b" })
	})

	it("threads the mode, the id, the LOCKED title and the trace onto the options", async () => {
		const { api, provider } = makeApi()

		await api.createTask({
			prompt: "do it",
			taskId: "t-fixed",
			mode: "architect",
			title: "Fixed title",
			trace: { traceparent: "00-abc-def-01" } as never,
		})

		const [, , , options] = (provider.createTask as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(options).toMatchObject({
			taskId: "t-fixed",
			initialMode: "architect",
			initialTitle: "Fixed title",
			trace: { traceparent: "00-abc-def-01" },
			consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER,
		})
	})

	it("asks the PLACEMENT seam where the task runs — an API-created task gets the same isolation", async () => {
		const { api } = makeApi()

		await api.createTask({ prompt: "do it" })

		expect(hoisted.resolveTaskCwd).toHaveBeenCalled()
	})

	it("resets the chat surface before creating", async () => {
		const { api, provider } = makeApi()

		await api.createTask({ prompt: "do it", images: ["i"] })

		const posted = (provider.postMessageToWebview as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m)
		expect(posted).toContainEqual({ type: "action", action: "chatButtonClicked" })
		expect(posted).toContainEqual({ type: "invoke", invoke: "newChat", text: "do it", images: ["i"] })
	})

	it("REFUSES when policy blocked the creation", async () => {
		const { api, provider } = makeApi()
		;(provider.createTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)

		await expect(api.createTask({ prompt: "do it" })).rejects.toThrow(/policy restrictions/)
	})

	it("returns the new task's id", async () => {
		const { api } = makeApi()

		await expect(api.createTask({ prompt: "do it" })).resolves.toEqual({ taskId: "t-new" })
	})
})

describe("sendMessage", () => {
	it("hands the message straight to a WARM instance — never through the webview", async () => {
		const live = makeTask("t-1", { submitUserMessage: vi.fn(async () => undefined) })
		const { api, provider } = makeApi({ managedInstances: { "t-1": live } })

		await api.sendMessage("t-1", "next turn", ["i"])

		expect(live.submitUserMessage).toHaveBeenCalledWith("next turn", ["i"], undefined, undefined, undefined)
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("falls back to the CURRENT task when its id matches", async () => {
		const current = makeTask("t-1", { submitUserMessage: vi.fn(async () => undefined) })
		const { api } = makeApi({ currentTask: current })

		await api.sendMessage("t-1", "next turn")

		expect(current.submitUserMessage).toHaveBeenCalled()
	})

	it("QUEUES BEFORE STARTING when the task has finished — a completed task's next turn", async () => {
		const rehydrated = makeTask("t-1", { startFromHistory: vi.fn() })
		const { api, provider } = makeApi({
			managedInstances: { "t-1": makeTask("t-1", { abort: true }) },
			history: [{ id: "t-1", ts: 1, task: "t" }],
		})
		;(provider.createTaskWithHistoryItem as ReturnType<typeof vi.fn>).mockResolvedValue(rehydrated)

		await api.sendMessage("t-1", "next turn", ["i"])

		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: "t-1" }),
			expect.objectContaining({ keepCurrentTask: true, startTask: false }),
		)
		expect(rehydrated.messageQueueService.addMessage).toHaveBeenCalledWith("next turn", ["i"])
		expect(rehydrated.startFromHistory).toHaveBeenCalled()
		const queueOrder = (rehydrated.messageQueueService.addMessage as ReturnType<typeof vi.fn>).mock
			.invocationCallOrder[0]
		expect(queueOrder).toBeLessThan(
			(rehydrated.startFromHistory as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
		)
	})

	it("DROPS the message — with a log — for a task with neither an instance nor history", async () => {
		const { api, provider } = makeApi()

		await expect(api.sendMessage("ghost", "hello")).resolves.toBeUndefined()
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("treats an ABANDONED instance as cold", async () => {
		const rehydrated = makeTask("t-1", { startFromHistory: vi.fn() })
		const { api, provider } = makeApi({
			managedInstances: { "t-1": makeTask("t-1", { abandoned: true }) },
			history: [{ id: "t-1", ts: 1, task: "t" }],
		})
		;(provider.createTaskWithHistoryItem as ReturnType<typeof vi.fn>).mockResolvedValue(rehydrated)

		await api.sendMessage("t-1", "next turn")

		expect(rehydrated.startFromHistory).toHaveBeenCalled()
	})
})

describe("deliverToMailbox", () => {
	it("PROPAGATES a failure — a mailbox ack must not be a lie", async () => {
		const { api, provider } = makeApi()
		;(provider as unknown as { deliverToTask: ReturnType<typeof vi.fn> }).deliverToTask = vi.fn(async () => {
			throw new Error("no such task")
		})

		await expect(api.deliverToMailbox("t-1", { from: "a", to: "b" } as never)).rejects.toThrow("no such task")
	})

	it("passes the envelope straight through on success", async () => {
		const deliverToTask = vi.fn(async () => undefined)
		const { api } = makeApi({ deliverToTask })

		await api.deliverToMailbox("t-1", { from: "a", to: "b" } as never)

		expect(deliverToTask).toHaveBeenCalledWith("t-1", { from: "a", to: "b" })
	})
})

describe("respondToAsk", () => {
	it("DROPS an answer for a task this host does not hold", async () => {
		const { api } = makeApi()

		await expect(api.respondToAsk("ghost", { askResponse: "yesButtonClicked" })).resolves.toBeUndefined()
	})

	it("answers on the addressed task when it is the one parked on the ask", async () => {
		const addressed = makeTask("t-1", { isAwaitingAsk: () => true })
		const { api } = makeApi({ managedInstances: { "t-1": addressed } })

		await api.respondToAsk("t-1", { askResponse: "yesButtonClicked", text: "ok", askId: "ask-1" })

		expect(addressed.handleWebviewAskResponse).toHaveBeenCalledWith("yesButtonClicked", "ok", undefined, "ask-1")
	})

	it("ROUTES to the descendant actually parked on the ask — an escalated question", async () => {
		const root = makeTask("root", { rootTaskId: "root", isAwaitingAsk: () => false })
		const child = makeTask("child", { rootTaskId: "root", isAwaitingAsk: (id: string) => id === "ask-1" })
		const { api } = makeApi({
			managedInstances: { root },
			taskStackInstances: [root, child],
		})

		await api.respondToAsk("root", { askResponse: "yesButtonClicked", askId: "ask-1" })

		expect(child.handleWebviewAskResponse).toHaveBeenCalled()
		expect(root.handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("does NOT route to a task from a DIFFERENT conversation", async () => {
		const root = makeTask("root", { rootTaskId: "root", isAwaitingAsk: () => false })
		const stranger = makeTask("other", { rootTaskId: "other", isAwaitingAsk: () => true })
		const { api } = makeApi({ managedInstances: { root }, taskStackInstances: [root, stranger] })

		await api.respondToAsk("root", { askResponse: "yesButtonClicked", askId: "ask-1" })

		expect(root.handleWebviewAskResponse).toHaveBeenCalled()
		expect(stranger.handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("switches the mode a followup suggestion carried BEFORE answering", async () => {
		const task = makeTask("t-1", { isAwaitingAsk: () => true })
		const { api, provider } = makeApi({ managedInstances: { "t-1": task } })

		await api.respondToAsk("t-1", { askResponse: "messageResponse", mode: "architect" })

		expect(provider.handleModeSwitch).toHaveBeenCalledWith("architect", task)
		const switchOrder = (provider.handleModeSwitch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		expect(switchOrder).toBeLessThan(
			(task.handleWebviewAskResponse as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
		)
	})

	it("falls back to the CURRENT task when the manager does not hold the addressed one", async () => {
		const current = makeTask("t-1", { isAwaitingAsk: () => true })
		const { api } = makeApi({ currentTask: current })

		await api.respondToAsk("whatever", { askResponse: "yesButtonClicked" })

		expect(current.handleWebviewAskResponse).toHaveBeenCalled()
	})
})

describe("the event fan-out", () => {
	/**
	 * `registerListeners` subscribes on the provider's `taskCreated`, then wires
	 * every one of a task's events onto the API's own emitter. A missing wire is
	 * invisible: the controller simply never learns the task did that.
	 */
	function wireUp() {
		const provider = makeProvider()
		const api = new API(outputChannel, provider)
		const onTaskCreated = (provider.on as ReturnType<typeof vi.fn>).mock.calls.find(
			([event]) => event === "taskCreated",
		)![1] as (task: unknown) => void

		const listeners = new Map<string, (...args: unknown[]) => void>()
		const task = {
			taskId: "t-1",
			on: (event: string, cb: (...args: unknown[]) => void) => listeners.set(event, cb),
		}
		// Record at the emitter rather than through `subscribe`: the subscribe
		// projection deliberately forwards only the client-facing subset, and the
		// point here is that every wire exists at all.
		const seen: Array<{ type: string; args: unknown[] }> = []
		const emit = api.emit.bind(api) as (name: string, ...args: unknown[]) => boolean
		api.emit = ((name: string, ...args: unknown[]) => {
			seen.push({ type: name, args })
			return emit(name, ...args)
		}) as typeof api.emit

		onTaskCreated(task)
		return { api, listeners, seen }
	}

	it("announces the task itself the moment it is created", () => {
		const { seen } = wireUp()

		expect(seen.map((e) => e.type)).toContain("taskCreated")
	})

	it.each([
		["taskStarted"],
		["taskFocused"],
		["taskUnfocused"],
		["taskActive"],
		["taskInteractive"],
		["taskResumable"],
		["taskIdle"],
		["taskPaused"],
		["taskUnpaused"],
		["taskAskResponded"],
	])("forwards %s with the task id", (event) => {
		const { listeners, seen } = wireUp()

		listeners.get(event)!()

		expect(seen.find((e) => e.type === event)!.args).toEqual(["t-1"])
	})

	it("forwards taskCompleted with the usage and the SELF-CONTAINED completion info", () => {
		const { listeners, seen } = wireUp()

		listeners.get("taskCompleted")!("t-1", { totalCost: 1 }, { read_file: 2 }, { rating: "well", isSubtask: true })

		const completed = seen.find((e) => e.type === "taskCompleted")!
		expect(completed.args).toEqual(["t-1", { totalCost: 1 }, { read_file: 2 }, { rating: "well", isSubtask: true }])
	})

	it("forwards taskAborted with its REASON, so a consumer need not ask why", () => {
		const { listeners, seen } = wireUp()

		listeners.get("taskAborted")!({ reason: "user_cancelled" })

		expect(seen.find((e) => e.type === "taskAborted")!.args).toEqual(["t-1", { reason: "user_cancelled" }])
	})

	it("forwards a spawned child's id alongside the parent's", () => {
		const { listeners, seen } = wireUp()

		listeners.get("taskSpawned")!("child-1")

		expect(seen.find((e) => e.type === "taskSpawned")!.args).toEqual(["t-1", "child-1"])
	})

	it("STAMPS the task id onto every message so a multiplexed stream stays attributable", () => {
		const { listeners, seen } = wireUp()

		listeners.get("message")!({ action: "created", message: { ts: 1, type: "say", text: "hi" } })

		expect(seen.find((e) => e.type === "message")!.args[0]).toMatchObject({
			taskId: "t-1",
			action: "created",
		})
	})

	it("forwards the analytics events with their payloads", () => {
		const { listeners, seen } = wireUp()

		listeners.get("taskToolFailed")!("t-1", "read_file", "ENOENT")
		listeners.get("taskTokenUsageUpdated")!("t-1", { totalCost: 2 }, { read_file: 1 })

		expect(seen.find((e) => e.type === "taskToolFailed")!.args).toEqual(["t-1", "read_file", "ENOENT"])
		expect(seen.find((e) => e.type === "taskTokenUsageUpdated")!.args).toEqual([
			"t-1",
			{ totalCost: 2 },
			{ read_file: 1 },
		])
	})

	it("forwards a title change and a mode switch with the task's own id", () => {
		const { listeners, seen } = wireUp()

		listeners.get("taskTitleChanged")!("t-1", "New title")
		listeners.get("taskModeSwitched")!("t-1", "architect")

		expect(seen.find((e) => e.type === "taskTitleChanged")!.args).toEqual(["t-1", "New title"])
		expect(seen.find((e) => e.type === "taskModeSwitched")!.args).toEqual(["t-1", "architect"])
	})

	it("forwards the queued-message list", () => {
		const { listeners, seen } = wireUp()

		listeners.get("queuedMessagesUpdated")!("t-1", [{ id: "m1" }])

		expect(seen.find((e) => e.type === "queuedMessagesUpdated")!.args).toEqual(["t-1", [{ id: "m1" }]])
	})
})

describe("the IPC command plane", () => {
	/**
	 * The legacy IPC surface a CLI client drives. Its commands carry no task id, so
	 * each one resolves "the current task" here — the API's own methods are
	 * task-addressed by contract and must not be given that job. Every command is
	 * wrapped so a client cannot crash the IPC server with a bad request.
	 */
	function makeIpcApi(overrides: ProviderOverrides = {}) {
		const provider = makeProvider(overrides)
		const api = new API(outputChannel, provider, "/tmp/shofer.sock", true)
		const [, handler] = hoisted.ipcOn.mock.calls.at(-1)!
		return {
			api,
			provider,
			send: (command: Record<string, unknown>) =>
				(handler as (clientId: string, command: unknown) => Promise<void>)("client-1", command),
		}
	}

	it("starts the IPC server on the configured socket", () => {
		makeIpcApi()

		expect(hoisted.ipcListen).toHaveBeenCalled()
	})

	it("StartNewTask creates a task from the command's text", async () => {
		const { send, provider } = makeIpcApi()

		await send({ commandName: "StartNewTask", data: { text: "do it" } })

		expect(provider.createTask).toHaveBeenCalled()
	})

	it("CancelTask addresses the CURRENT task — the command carries no id", async () => {
		const { send, provider } = makeIpcApi()

		await send({ commandName: "CancelTask" })

		expect(provider.cancelTask).toHaveBeenCalled()
	})

	it("SendMessage DROPS the message, with a log, when there is no current task", async () => {
		const { send, provider } = makeIpcApi({ getCurrentTaskStack: vi.fn(() => []) })

		await send({ commandName: "SendMessage", data: { text: "hello" } })

		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("GetCommands answers with the discovered list, and with [] on failure", async () => {
		const { send } = makeIpcApi()

		await send({ commandName: "GetCommands" })

		expect(hoisted.ipcSend).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ data: expect.objectContaining({ eventName: "commandsResponse" }) }),
		)
	})

	it("GetModes answers with the provider's modes", async () => {
		const { send, provider } = makeIpcApi()
		;(provider.getModes as ReturnType<typeof vi.fn>) = vi.fn(async () => [{ slug: "code", name: "Code" }])

		await send({ commandName: "GetModes" })

		expect(hoisted.ipcSend).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ data: expect.objectContaining({ eventName: "modesResponse" }) }),
		)
	})

	it("GetModels answers with an empty catalog", async () => {
		const { send } = makeIpcApi()

		await send({ commandName: "GetModels" })

		expect(hoisted.ipcSend).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ data: expect.objectContaining({ eventName: "modelsResponse" }) }),
		)
	})

	it.each([
		["ShowTaskWithId", { taskId: "t-1", keepCurrentTask: true }],
		["RenameTask", { taskId: "t-1", name: "New" }],
		["ArchiveTask", { taskId: "t-1" }],
		["UnarchiveTask", { taskId: "t-1" }],
		["PinTask", { taskId: "t-1" }],
		["UnpinTask", { taskId: "t-1" }],
		["DeleteTask", { taskId: "t-1" }],
	])("%s never rejects into the IPC server, even when the task is unknown", async (commandName, data) => {
		const { send } = makeIpcApi()

		await expect(send({ commandName, data })).resolves.toBeUndefined()
	})

	it("DeleteQueuedMessage never rejects into the IPC server", async () => {
		const { send } = makeIpcApi()

		await expect(send({ commandName: "DeleteQueuedMessage", data: "m-1" })).resolves.toBeUndefined()
	})

	it("ExportConfiguration answers with the secret-stripped document", async () => {
		const { send } = makeIpcApi({ values: { ttsSpeed: 1, apiKey: "sk-secret" } })

		await send({ commandName: "ExportConfiguration" })

		const payload = JSON.stringify(hoisted.ipcSend.mock.calls.at(-1))
		expect(payload).not.toContain("sk-secret")
	})

	it("ImportConfiguration never rejects on a malformed document", async () => {
		const { send } = makeIpcApi()

		await expect(send({ commandName: "ImportConfiguration", data: "{not json" })).resolves.toBeUndefined()
	})

	it("an UNKNOWN command is ignored rather than crashing the server", async () => {
		const { send } = makeIpcApi()

		await expect(send({ commandName: "SomethingNobodyImplemented", data: {} })).resolves.toBeUndefined()
	})
})

describe("the output-channel logger", () => {
	function logger() {
		const provider = makeProvider()
		const lines: string[] = []
		const channel = { appendLine: (line: string) => lines.push(line) } as unknown as import("vscode").OutputChannel
		const api = new API(channel, provider, "/tmp/shofer.sock", true)
		return { lines, log: (api as unknown as { log: (...a: unknown[]) => void }).log.bind(api) }
	}

	it("renders null and undefined as WORDS rather than dropping the argument", () => {
		const { lines, log } = logger()

		log(null, undefined)

		expect(lines).toContain("null")
		expect(lines).toContain("undefined")
	})

	it("renders an Error with its stack", () => {
		const { lines, log } = logger()

		log(new Error("boom"))

		expect(lines.join("\n")).toContain("Error: boom")
	})

	it("serializes an object, naming functions, symbols and bigints instead of dropping them", () => {
		const { lines, log } = logger()

		log({ n: 1n, fn: function namedFn() {}, sym: Symbol("s") })

		const rendered = lines.join("\n")
		expect(rendered).toContain("BigInt(1)")
		expect(rendered).toContain("Function: namedFn")
	})

	it("labels a value JSON cannot represent rather than throwing", () => {
		const { lines, log } = logger()
		const circular: Record<string, unknown> = {}
		circular.self = circular

		log(circular)

		expect(lines.join("\n")).toContain("[Non-serializable object:")
	})
})

/**
 * The rest of the IPC command table. Every arm is wrapped in its own try/catch
 * for one reason: this handler runs INSIDE the IPC server's message loop, so a
 * rejection does not fail a request — it takes the socket down for every client.
 * The tests below therefore assert the same shape repeatedly (it resolves, it
 * logged) because that IS the contract.
 */
describe("the IPC command plane — the remaining commands", () => {
	const history = [{ id: "t-1", ts: 1700000000000, task: "the task", mode: "code" }]
	const apiHistory = [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: [{ type: "text", text: "hi" }] },
	]

	function makeIpcApi(overrides: ProviderOverrides = {}) {
		const provider = makeProvider({ history, apiHistory, ...overrides })
		const api = new API(outputChannel, provider, "/tmp/shofer.sock", true)
		const [, handler] = hoisted.ipcOn.mock.calls.at(-1)!
		return {
			api,
			provider,
			send: (command: Record<string, unknown>) =>
				(handler as (clientId: string, command: unknown) => Promise<void>)("client-1", command),
		}
	}

	/** The response payloads the handler pushed back to this client. */
	function responses() {
		return hoisted.ipcSend.mock.calls.map(([, message]) => (message as { data: Record<string, unknown> }).data)
	}

	/** Everything the API logged to its output channel. */
	function logged() {
		return vi
			.mocked(outputChannel.appendLine)
			.mock.calls.map(([line]) => String(line))
			.join(" ")
	}

	it("CloseTask saves every editor BEFORE closing the window", async () => {
		const { send } = makeIpcApi()
		const vscode = await import("vscode")
		const executed: string[] = []
		vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: string) => {
			executed.push(command)
			return undefined
		})

		await send({ commandName: "CloseTask" })

		expect(executed.indexOf("workbench.action.files.saveFiles")).toBeLessThan(
			executed.indexOf("workbench.action.closeWindow"),
		)
	})

	it("ResumeTask is a NO-OP for a task that is already live", async () => {
		const live = makeTask("t-1")
		const { send, provider } = makeIpcApi({ currentTask: live })

		await send({ commandName: "ResumeTask", data: "t-1" })

		// Rehydrating a live task rebuilds the instance and aborts whatever turn
		// it had in flight; "resume" only ever means "make it addressable".
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("SendMessage hands the text to the CURRENT task's own channel, not the webview", async () => {
		const live = makeTask("t-1", { submitUserMessage: vi.fn(async () => undefined) })
		const { send, provider } = makeIpcApi({ currentTask: live })

		await send({ commandName: "SendMessage", data: { text: "hello", images: ["img"] } })

		// The CLI host's mock webview reports launched and silently drops an
		// `invoke`, so routing through it loses every follow-up message.
		expect(live.submitUserMessage).toHaveBeenCalledWith("hello", ["img"], undefined, undefined, undefined)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("GetModes answers with an empty list rather than nothing when the provider throws", async () => {
		const { send } = makeIpcApi({
			getModes: vi.fn(async () => {
				throw new Error("modes unavailable")
			}),
		})

		await send({ commandName: "GetModes" })

		expect(responses().at(-1)).toMatchObject({ eventName: "modesResponse", payload: [[]] })
	})

	it("GetTaskMarkdownExport returns the document on a TaskCompleted envelope", async () => {
		const { send } = makeIpcApi()

		await send({ commandName: "GetTaskMarkdownExport", data: "t-1" })

		const last = responses().at(-1) as { eventName: string; payload: unknown[] }
		expect(last.eventName).toBe("taskCompleted")
		expect(last.payload[3]).toMatchObject({ exportContent: expect.stringContaining("**User:**") })
	})

	it("GetTaskMarkdownExport logs and answers NOTHING when the export fails", async () => {
		const { send } = makeIpcApi({ history: [] })
		const before = hoisted.ipcSend.mock.calls.length

		await expect(send({ commandName: "GetTaskMarkdownExport", data: "gone" })).resolves.toBeUndefined()

		expect(hoisted.ipcSend.mock.calls.length).toBe(before)
		expect(logged()).toContain("GetTaskMarkdownExport failed")
	})

	it("GetTaskJsonExport returns a SERIALIZED trace", async () => {
		const { send } = makeIpcApi()

		await send({ commandName: "GetTaskJsonExport", data: "t-1" })

		const last = responses().at(-1) as { eventName: string; payload: unknown[] }
		const info = last.payload[3] as { exportContent: string }
		expect(() => JSON.parse(info.exportContent)).not.toThrow()
	})

	it("GetTaskJsonExport logs and answers nothing when the export fails", async () => {
		const { send } = makeIpcApi({ history: [] })

		await expect(send({ commandName: "GetTaskJsonExport", data: "gone" })).resolves.toBeUndefined()
		expect(logged()).toContain("GetTaskJsonExport failed")
	})

	it("ImportConfiguration applies the document it was handed", async () => {
		const { send, provider } = makeIpcApi()

		await send({ commandName: "ImportConfiguration", data: JSON.stringify({ ttsSpeed: 2 }) })

		expect(provider.contextProxy.setValues).toHaveBeenCalledWith({ ttsSpeed: 2 })
	})

	it("ImportConfiguration logs and swallows a document that is not JSON", async () => {
		const { send } = makeIpcApi()

		await expect(send({ commandName: "ImportConfiguration", data: "{not json" })).resolves.toBeUndefined()
		expect(logged()).toContain("ImportConfiguration failed")
	})

	it("IGNORES a command name it does not know", async () => {
		const { send } = makeIpcApi()

		await expect(send({ commandName: "NoSuchCommand", data: {} })).resolves.toBeUndefined()
	})
})
