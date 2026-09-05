// pnpm --filter @shofer/cli test src/agent/__tests__/extension-host-api.test.ts

import fs from "fs"
import os from "os"
import path from "path"
import { EventEmitter } from "events"

import type { ShoferExtensionApi, ShoferMessage } from "@shofer/types"
import { ShoferEventName } from "@shofer/types"

import { ExtensionHost, type ExtensionHostOptions } from "../extension-host.js"

/**
 * The parts of ExtensionHost that only exist once a bundle has been LOADED:
 * `activate()`'s require/redirect dance, the ShoferExtensionApi event forwarding,
 * the ACP/serve pass-throughs, and the task-addressed API wrappers.
 *
 * The "bundle" is a real CommonJS file written to a temp directory — no VS Code,
 * no network, no child process. `@shofer/vscode-shim` is mocked because the host
 * only uses it for a context object and a settings sink.
 */

const { ephemeralDir } = vi.hoisted(() => ({
	ephemeralDir: `${process.env.TMPDIR?.replace(/\/$/, "") ?? "/tmp"}/shofer-cli-host-api-ephemeral`,
}))

vi.mock("@/lib/storage/index.js", () => ({
	createEphemeralStorageDir: vi.fn(async () => ephemeralDir),
}))

vi.mock("@shofer/vscode-shim", () => ({
	createVSCodeAPI: vi.fn((extensionPath: string) => ({
		context: {
			extensionPath,
			globalStorageUri: { fsPath: path.join(os.tmpdir(), "shofer-cli-host-api-globalstorage") },
		},
	})),
	setRuntimeConfigValues: vi.fn(),
}))

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
	tempDirs.push(dir)
	return dir
}

/**
 * Write a CommonJS extension bundle. `body` is spliced into `activate()`; the
 * returned API is a bare EventEmitter so `forwardShoferEvents` can subscribe.
 */
function writeBundle(options: {
	throwOnLoad?: boolean
	throwOnActivate?: boolean
	withAcp?: boolean
	withServe?: boolean
	withDeactivate?: boolean
	deactivateThrows?: boolean
	markReady?: boolean
}): string {
	const dir = makeTempDir("shofer-cli-bundle-")
	const lines = [
		'"use strict";',
		'const { EventEmitter } = require("events");',
		options.throwOnLoad ? 'throw new Error("bundle is broken");' : "",
		"module.exports.activate = async function activate(context) {",
		options.throwOnActivate ? '  throw new Error("activation refused");' : "",
		"  const api = new EventEmitter();",
		"  api.getCurrentTaskStack = () => globalThis.__shoferTestTaskStack || [];",
		"  api.createTask = async (args) => { globalThis.__shoferTestCalls.createTask.push(args); return { taskId: 'created' } };",
		"  api.resumeTask = async (id) => { globalThis.__shoferTestCalls.resumeTask.push(id) };",
		"  api.cancelTask = async (id) => { globalThis.__shoferTestCalls.cancelTask.push(id) };",
		"  api.sendMessage = async (...a) => { globalThis.__shoferTestCalls.sendMessage.push(a) };",
		"  api.respondToAsk = async (...a) => { globalThis.__shoferTestCalls.respondToAsk.push(a) };",
		"  globalThis.__shoferTestApi = api;",
		options.markReady === false ? "" : "  setTimeout(() => globalThis.__extensionHost.markWebviewReady(), 0);",
		"  return api;",
		"};",
		options.withDeactivate
			? `module.exports.deactivate = async function () { globalThis.__shoferTestDeactivated = true; ${
					options.deactivateThrows ? 'throw new Error("deactivate failed");' : ""
				} };`
			: "",
		options.withAcp
			? "module.exports.runAcpAgentOverShoferApi = async function (api, streams) { globalThis.__shoferTestAcp = { api, streams }; };"
			: "",
		options.withServe
			? "module.exports.serveHttpOverShoferApi = function (api, opts) { globalThis.__shoferTestServe = { api, opts }; return { close() {} }; };"
			: "",
		"",
	]
	fs.writeFileSync(path.join(dir, "extension.js"), lines.filter(Boolean).join("\n"), "utf-8")
	return dir
}

function createHost(overrides: Partial<ExtensionHostOptions> = {}): ExtensionHost {
	return new ExtensionHost({
		mode: "code",
		user: null,
		provider: "openrouter",
		model: "test-model",
		workspacePath: makeTempDir("shofer-cli-workspace-"),
		extensionPath: overrides.extensionPath ?? makeTempDir("shofer-cli-empty-"),
		ephemeral: false,
		debug: false,
		exitOnComplete: false,
		integrationTest: true,
		disableOutput: true,
		...overrides,
	})
}

const globals = globalThis as unknown as Record<string, unknown>

beforeEach(() => {
	globals.__shoferTestCalls = {
		createTask: [],
		resumeTask: [],
		cancelTask: [],
		sendMessage: [],
		respondToAsk: [],
	}
	globals.__shoferTestTaskStack = ["task-1"]
	delete globals.__shoferTestApi
	delete globals.__shoferTestAcp
	delete globals.__shoferTestServe
	delete globals.__shoferTestDeactivated
})

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true })
	}
	delete globals.vscode
	delete globals.__extensionHost
})

const calls = () =>
	globals.__shoferTestCalls as {
		createTask: unknown[]
		resumeTask: unknown[]
		cancelTask: unknown[]
		sendMessage: unknown[][]
		respondToAsk: unknown[][]
	}

const testApi = () => globals.__shoferTestApi as EventEmitter

describe("ExtensionHost.activate", () => {
	it("refuses a directory with no bundle", async () => {
		const host = createHost()
		await expect(host.activate()).rejects.toThrow(/Extension bundle not found at/)
		await host.dispose()
	})

	it("reports a bundle that throws while loading", async () => {
		const host = createHost({ extensionPath: writeBundle({ throwOnLoad: true }) })
		await expect(host.activate()).rejects.toThrow(/Failed to load extension bundle: bundle is broken/)
		await host.dispose()
	})

	it("reports a bundle whose activate rejects", async () => {
		const host = createHost({ extensionPath: writeBundle({ throwOnActivate: true }) })
		await expect(host.activate()).rejects.toThrow(/Failed to activate extension: activation refused/)
		await host.dispose()
	})

	it("loads, activates, publishes the globals and becomes ready", async () => {
		const host = createHost({ extensionPath: writeBundle({ withDeactivate: true }) })
		expect(host.isInInitialSetup()).toBe(true)

		await host.activate()

		expect(host.isInInitialSetup()).toBe(false)
		expect(globals.vscode).toBeDefined()
		expect(globals.__extensionHost).toBe(host)
		expect(host.api).toBe(testApi() as unknown as ShoferExtensionApi)
		// The vscode-mock shim is materialized on disk beside the workspace.
		expect(host.approvalPosture.summary).toBeTruthy()

		await host.dispose()
		expect(globals.__shoferTestDeactivated).toBe(true)
		expect(globals.vscode).toBeUndefined()
	})

	it("swallows a deactivate that throws", async () => {
		const host = createHost({ extensionPath: writeBundle({ withDeactivate: true, deactivateThrows: true }) })
		await host.activate()
		await expect(host.dispose()).resolves.toBeUndefined()
	})

	it("uses an ephemeral storage dir and removes it on dispose", async () => {
		const host = createHost({ extensionPath: writeBundle({}), ephemeral: true })
		await host.activate()

		expect(fs.existsSync(path.join(ephemeralDir, "vscode-mock.js"))).toBe(true)
		await host.dispose()
		expect(fs.existsSync(ephemeralDir)).toBe(false)
	})

	it("uses an explicit storage dir for the vscode-mock file", async () => {
		const storageDir = makeTempDir("shofer-cli-storage-")
		const host = createHost({ extensionPath: writeBundle({}), storageDir })
		await host.activate()
		expect(fs.existsSync(path.join(storageDir, "vscode-mock.js"))).toBe(true)
		await host.dispose()
	})

	it("forwards extension webview messages into the client once activated", async () => {
		const host = createHost({ extensionPath: writeBundle({}) })
		await host.activate()

		host.emit("extensionWebviewMessage", {
			type: "stateInit",
			state: { shoferMessages: [{ ts: 1, type: "say", say: "text", text: "hello" }] },
		})

		expect(host.client.getMessages()).toHaveLength(1)
		await host.dispose()
	})
})

describe("ExtensionHost bundle exports", () => {
	it("refuses ACP and serve when the bundle does not export them", async () => {
		const host = createHost({ extensionPath: writeBundle({}) })
		await host.activate()

		expect(() => host.runAcp({ input: process.stdin, output: process.stdout })).toThrow(
			/does not export runAcpAgentOverShoferApi/,
		)
		expect(() => host.serve({ port: 1 })).toThrow(/does not export serveHttpOverShoferApi/)
		await host.dispose()
	})

	it("passes the activated api through to ACP and serve", async () => {
		const host = createHost({ extensionPath: writeBundle({ withAcp: true, withServe: true }) })
		await host.activate()

		await host.runAcp({ input: process.stdin, output: process.stdout, agentVersion: "1.2.3" })
		expect((globals.__shoferTestAcp as { streams: { agentVersion?: string } }).streams.agentVersion).toBe("1.2.3")

		host.serve({ port: 4321, host: "127.0.0.1", token: "t", version: "v", allowClientConfig: true })
		expect((globals.__shoferTestServe as { opts: { port: number } }).opts.port).toBe(4321)

		await host.dispose()
	})

	it("refuses the api getter before activation", () => {
		const host = createHost()
		expect(() => host.api).toThrow(/accessed before activation/)
	})

	it("wires no forwarding when there is no activated api", () => {
		const host = createHost()
		const forward = (host as unknown as { forwardShoferEvents: () => void }).forwardShoferEvents
		expect(() => forward.call(host)).not.toThrow()
	})
})

describe("ExtensionHost ShoferExtensionApi forwarding", () => {
	async function activated() {
		const host = createHost({ extensionPath: writeBundle({}) })
		await host.activate()
		const seen: Array<{ name: string; payload: unknown }> = []
		const emitter = host.client.getEmitter()
		for (const name of [
			"taskCreated",
			"taskStarted",
			"taskCompleted",
			"taskAborted",
			"taskPaused",
			"taskUnpaused",
			"taskSpawned",
			"message",
			"queuedMessagesUpdated",
			"modeChanged",
			"tokenUsageUpdated",
			"toolFailed",
		] as const) {
			emitter.on(name, (payload) => seen.push({ name, payload }))
		}
		return { host, seen, api: testApi() }
	}

	it("bridges the task lifecycle events", async () => {
		const { host, seen, api } = await activated()

		api.emit(ShoferEventName.TaskCreated, "t1")
		api.emit(ShoferEventName.TaskStarted, "t2")
		api.emit(ShoferEventName.TaskAborted, "t3", { reason: "x" })
		api.emit(ShoferEventName.TaskPaused, "t4")
		api.emit(ShoferEventName.TaskUnpaused, "t5")
		api.emit(ShoferEventName.TaskSpawned, "parent", "child")

		expect(seen.map((event) => `${event.name}:${String(event.payload)}`)).toEqual([
			"taskCreated:t1",
			"taskStarted:t2",
			"taskAborted:t3",
			"taskPaused:t4",
			"taskUnpaused:t5",
			"taskSpawned:child",
		])
		await host.dispose()
	})

	it("bridges a root completion but not a subtask one", async () => {
		const { host, seen, api } = await activated()

		api.emit(ShoferEventName.TaskCompleted, "t", {}, {}, { isSubtask: true })
		expect(seen).toHaveLength(0)

		api.emit(ShoferEventName.TaskCompleted, "t", {}, {}, { rating: "good" })
		api.emit(ShoferEventName.TaskCompleted, "t", {}, {}, undefined)
		expect(seen.map((event) => event.name)).toEqual(["taskCompleted", "taskCompleted"])
		expect((seen[0]?.payload as { success: boolean }).success).toBe(true)
		await host.dispose()
	})

	it("bridges created messages and skips partials", async () => {
		const { host, seen, api } = await activated()
		const message = { ts: 1, type: "say", say: "text", text: "hi" } as unknown as ShoferMessage

		api.emit(ShoferEventName.Message, { taskId: "t", action: "created", message: { ...message, partial: true } })
		api.emit(ShoferEventName.Message, { taskId: "t", action: "updated", message })
		api.emit(ShoferEventName.Message, { taskId: "t", action: "created", message })

		expect(seen.filter((event) => event.name === "message")).toHaveLength(1)
		await host.dispose()
	})

	it("bridges queue, mode, usage and tool-failure events, and ignores the informational ones", async () => {
		const { host, seen, api } = await activated()

		api.emit(ShoferEventName.QueuedMessagesUpdated, "t", [{ id: "q" }])
		api.emit(ShoferEventName.ModeChanged, "architect")
		api.emit(ShoferEventName.TaskTokenUsageUpdated, "t", {}, {})
		api.emit(ShoferEventName.TaskToolFailed, "t", "read_file", "nope")
		api.emit(ShoferEventName.TaskModeSwitched, "t", "code")
		api.emit(ShoferEventName.ProviderProfileChanged, { name: "n", provider: "p" })

		expect(seen.map((event) => event.name)).toEqual([
			"queuedMessagesUpdated",
			"modeChanged",
			"tokenUsageUpdated",
			"toolFailed",
		])
		expect(seen[1]?.payload).toEqual({ previousMode: undefined, currentMode: "architect" })
		expect(seen[3]?.payload).toEqual({ taskId: "t", tool: "read_file", error: "nope" })
		await host.dispose()
	})
})

describe("ExtensionHost task-addressed API", () => {
	async function activated(overrides: Partial<ExtensionHostOptions> = {}) {
		const host = createHost({ extensionPath: writeBundle({}), ...overrides })
		await host.activate()
		return host
	}

	it("runs a task and resolves on the completion event", async () => {
		const host = await activated()
		const pending = host.runTask("do it", "task-9", { mode: "code" }, ["img"])
		setTimeout(() => testApi().emit(ShoferEventName.TaskCompleted, "task-9", {}, {}, undefined), 5)

		await expect(pending).resolves.toBeUndefined()
		expect(calls().createTask).toEqual([
			{ configuration: { mode: "code" }, prompt: "do it", images: ["img"], taskId: "task-9" },
		])
		await host.dispose()
	})

	it("rejects a run when the client raises an error", async () => {
		const host = await activated()
		const pending = host.runTask("do it")
		setTimeout(() => host.client.getEmitter().emit("error", new Error("stream died")), 5)
		await expect(pending).rejects.toThrow("stream died")
		await host.dispose()
	})

	it("rejects a run when the resume budget is declined", async () => {
		const host = await activated({ nonInteractive: true })
		// `disableOutput` also parks the AskDispatcher (TUI mode owns asks); re-enable
		// it so the resume ask is actually decided, while output stays suppressed.
		host.setAskDispatcherEnabled(true)
		const pending = host.runTask("do it")
		setTimeout(() => {
			host.client.getEmitter().emit("waitingForInput", {
				ask: "resume_task",
				stateInfo: host.getAgentState(),
				message: { ts: 1, type: "ask", ask: "resume_task", text: "" } as unknown as ShoferMessage,
			})
		}, 5)

		await expect(pending).rejects.toThrow("Task interrupted; not auto-resuming")
		await host.dispose()
	})

	it("rejects a run on a retry-delay message when exitOnError is set", async () => {
		const host = await activated({ exitOnError: true })
		const pending = host.runTask("do it")
		setTimeout(() => {
			host.client.getEmitter().emit("message", {
				ts: 1,
				type: "say",
				say: "api_req_started",
			} as unknown as ShoferMessage)
			host.client.getEmitter().emit("message", {
				ts: 2,
				type: "say",
				say: "api_req_retry_delayed",
				text: "rate limited\nretrying in 5s",
			} as unknown as ShoferMessage)
		}, 5)

		await expect(pending).rejects.toThrow("rate limited")
		await host.dispose()
	})

	it("falls back to a generic message for an empty retry-delay text", async () => {
		const host = await activated({ exitOnError: true })
		const pending = host.runTask("do it")
		setTimeout(() => {
			host.client
				.getEmitter()
				.emit("message", { ts: 2, type: "say", say: "api_req_retry_delayed" } as unknown as ShoferMessage)
		}, 5)
		await expect(pending).rejects.toThrow("API request failed")
		await host.dispose()
	})

	it("resumes a task, granting the explicit resume", async () => {
		const host = await activated()
		const pending = host.resumeTask("task-7")
		setTimeout(() => testApi().emit(ShoferEventName.TaskCompleted, "task-7", {}, {}, undefined), 5)

		await expect(pending).resolves.toBeUndefined()
		expect(calls().resumeTask).toEqual(["task-7"])
		await host.dispose()
	})

	it("addresses cancel, sendMessage and respondToAsk at the current task by default", async () => {
		const host = await activated()

		await host.cancelTask()
		await host.cancelTask("explicit")
		await host.sendMessage("text", ["img"])
		await host.sendMessage(undefined, undefined, "explicit")
		await host.respondToAsk({ askResponse: "messageResponse", text: "t" })
		await host.approveAction()
		await host.rejectAction()

		expect(calls().cancelTask).toEqual(["task-1", "explicit"])
		expect(calls().sendMessage).toEqual([
			["task-1", "text", ["img"]],
			["explicit", "", undefined],
		])
		expect(calls().respondToAsk).toEqual([
			["task-1", { askResponse: "messageResponse", text: "t" }],
			["task-1", { askResponse: "yesButtonClicked" }],
			["task-1", { askResponse: "noButtonClicked" }],
		])
		await host.dispose()
	})

	it("drops every task-addressed call when there is no current task", async () => {
		const host = await activated()
		globals.__shoferTestTaskStack = []

		await host.cancelTask()
		await host.sendMessage("text")
		await host.respondToAsk({ askResponse: "yesButtonClicked" })
		await host.approveAction()

		expect(calls().cancelTask).toEqual([])
		expect(calls().sendMessage).toEqual([])
		expect(calls().respondToAsk).toEqual([])
		await host.dispose()
	})
})

describe("ExtensionHost manager wiring", () => {
	it("routes messages through the output manager and logs first partials once", async () => {
		const host = createHost({ extensionPath: writeBundle({}), debug: true })
		await host.activate()
		const emitter = host.client.getEmitter()

		const partial = { ts: 1, type: "say", say: "text", text: "he", partial: true } as unknown as ShoferMessage
		emitter.emit("message", partial)
		emitter.emit("message", partial)
		emitter.emit("messageUpdated", { ...partial, text: "hello", partial: false })

		// A completion ask reaches the output manager's completion path.
		emitter.emit("taskCompleted", {
			success: true,
			stateInfo: host.getAgentState(),
			message: { ts: 2, type: "ask", ask: "completion_result", text: "done" } as unknown as ShoferMessage,
		})
		emitter.emit("taskCompleted", { success: true, stateInfo: host.getAgentState() })

		await host.dispose()
	})

	it("exposes the resume grant and the ask-dispatcher toggle", async () => {
		const host = createHost({ extensionPath: writeBundle({}) })
		await host.activate()

		expect(() => host.grantResume()).not.toThrow()
		expect(() => host.setAskDispatcherEnabled(false)).not.toThrow()
		expect(() => host.setAskDispatcherEnabled(true)).not.toThrow()

		await host.dispose()
	})
})
