import { BUILTIN_MODES } from "../../__fixtures__/builtin-config.js"

vi.mock("../../ignore/ShoferIgnoreController.js", () => ({
	ShoferIgnoreController: class {
		validateAccess() {
			return true
		}
		validateCommand() {
			return undefined
		}
		filterPaths(paths: string[]) {
			return paths
		}
		getInstructions() {
			return undefined
		}
		async initialize() {}
		dispose() {}
	},
}))

vi.mock("../../utils/storage.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getTaskDirectoryPath: vi.fn(async (root: string, taskId: string) => `${root}/tasks/${taskId}`),
	getSettingsDirectoryPath: vi.fn(async (root: string) => `${root}/settings`),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	const stubs = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		appendFile: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
		readdir: vi.fn().mockResolvedValue([]),
	}
	return { ...actual, ...stubs, default: stubs }
})

vi.mock("delay", () => ({ __esModule: true, default: vi.fn().mockResolvedValue(undefined) }))

vi.mock("../../environment/getEnvironmentDetails.js", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue("<environment_details>mock</environment_details>"),
}))

const summarizeConversation = vi.fn()
vi.mock("../../condense/index.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	summarizeConversation: (...args: unknown[]) => summarizeConversation(...args),
}))

import { ShoferEventName } from "@shofer/types"

import {
	BASE_API_CONFIG,
	makeProvider,
	makeScriptedTask,
	resetScriptedEnvironment,
	type FakeProvider,
} from "./helpers/scriptedTask.js"

/**
 * `Task`'s LIFECYCLE surface — the methods a host calls between turns rather
 * than inside one: explicit condensation, the Send-Now soft cancel, the
 * mailbox delivery, teardown.
 *
 * The Dual Cancellation-Path Rule is the invariant this file exists for.
 * `abortTask()` is destructive tear-down; `cancelAndProcessQueuedMessages()` is
 * a SOFT cancel that must leave the task alive and restartable — and the flag
 * that distinguishes them (`_softCancelForQueuedMessage`) is what stops the
 * stream's catch block from disposing a task that is about to resume. A path
 * that aborts the controller without setting it destroys a task that should
 * have restarted.
 */

const STATE = {
	mode: "code",
	customModes: BUILTIN_MODES,
	autoApprovalEnabled: true,
	apiConfiguration: BASE_API_CONFIG,
}

let provider: FakeProvider

beforeEach(() => {
	vi.clearAllMocks()
	resetScriptedEnvironment()
	provider = makeProvider({ state: STATE })
	summarizeConversation.mockResolvedValue({
		messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }],
		summary: "we did things",
		cost: 0.01,
		newContextTokens: 50,
	})
})

function build(opts: Parameters<typeof makeScriptedTask>[0] = {}) {
	return makeScriptedTask({ provider, ...opts })
}

describe("condenseContext", () => {
	it("flushes pending tool results before condensing, so no tool_use is left unanswered", async () => {
		const { task } = build()
		const flush = vi.spyOn(task, "flushPendingToolResultsToHistory").mockResolvedValue(false)

		await task.condenseContext()

		expect(flush).toHaveBeenCalled()
		expect(summarizeConversation).toHaveBeenCalled()
	})

	it("shows the summary and replaces the history with it", async () => {
		const { task } = build()

		await task.condenseContext()

		expect(task.shoferMessages.some((m) => m.say === "condense_context")).toBe(true)
		expect(JSON.stringify(task.apiConversationHistory)).toContain("summary")
	})

	it("reports a condensation that produced nothing as an error row", async () => {
		const { task } = build()
		summarizeConversation.mockResolvedValue({ messages: [], error: "the summarizer refused" })

		await task.condenseContext()

		expect(task.shoferMessages.some((m) => m.say === "condense_context_error")).toBe(true)
	})

	it("hands the condenser the task's OWN mode's tools", async () => {
		const { task } = build()
		await task.condenseContext()

		const passed = summarizeConversation.mock.calls[0]![0] as { metadata: { taskId: string; tools?: unknown[] } }
		expect(passed.metadata.taskId).toBe(task.taskId)
		expect(passed.metadata.tools!.length).toBeGreaterThan(0)
	})
})

describe("the SOFT cancel for Send Now", () => {
	it("does nothing at all when the queue is empty", async () => {
		const { task } = build()

		await task.cancelAndProcessQueuedMessages()

		expect(task.abort).toBe(false)
	})

	it("dequeues the message, stops the loop, and leaves the task ALIVE to restart", async () => {
		const { task } = build()
		task.messageQueueService.addMessage("send this now")
		const dispose = vi.spyOn(task, "dispose").mockImplementation(() => {})
		// The restart itself drives a whole turn; stub it so this test is about
		// the cancel half.
		vi.spyOn(task as never as { _runTaskLoop: () => Promise<void> }, "_runTaskLoop").mockResolvedValue(undefined)

		await task.cancelAndProcessQueuedMessages()

		expect(task.messageQueueService.isEmpty()).toBe(true)
		// Destructive tear-down is exactly what must NOT happen.
		expect(dispose).not.toHaveBeenCalled()
	})

	it("aborts the in-flight request and the task-lifetime signal", async () => {
		const { task } = build()
		task.messageQueueService.addMessage("send this now")
		vi.spyOn(task as never as { _runTaskLoop: () => Promise<void> }, "_runTaskLoop").mockResolvedValue(undefined)
		const controller = new AbortController()
		;(task as never as { currentRequestAbortController?: AbortController }).currentRequestAbortController =
			controller
		// The task-lifetime signal is REPLACED as part of the restart, so capture
		// the one the cancel is supposed to fire before calling.
		const signalBeforeCancel = task.abortSignal

		await task.cancelAndProcessQueuedMessages()

		expect(controller.signal.aborted).toBe(true)
		expect(signalBeforeCancel.aborted).toBe(true)
		// …and the task got a FRESH controller, which is what lets it restart.
		expect(task.abortSignal.aborted).toBe(false)
	})

	it("clears the outstanding asks so the queued message can be handled", async () => {
		const { task } = build()
		task.messageQueueService.addMessage("send this now")
		vi.spyOn(task as never as { _runTaskLoop: () => Promise<void> }, "_runTaskLoop").mockResolvedValue(undefined)
		task.idleAsk = { ts: 1, type: "ask", ask: "followup" } as never
		task.interactiveAsk = { ts: 2, type: "ask", ask: "tool" } as never
		const active = vi.fn()
		task.on(ShoferEventName.TaskActive, active)

		await task.cancelAndProcessQueuedMessages()

		expect(task.idleAsk).toBeUndefined()
		expect(task.interactiveAsk).toBeUndefined()
		expect(active).toHaveBeenCalledWith(task.taskId)
	})

	it("repairs orphaned tool calls before the new loop starts", async () => {
		const { task } = build()
		task.messageQueueService.addMessage("send this now")
		vi.spyOn(task as never as { _runTaskLoop: () => Promise<void> }, "_runTaskLoop").mockResolvedValue(undefined)
		task.apiConversationHistory = [
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }] },
		] as never

		await task.cancelAndProcessQueuedMessages()

		// A cancelled mid-stream tool call would otherwise be sent unanswered.
		const results = task.apiConversationHistory.flatMap((m) =>
			Array.isArray(m.content) ? m.content.filter((b) => (b as { type: string }).type === "tool_result") : [],
		)
		expect(results).toHaveLength(1)
	})
})

describe("teardown", () => {
	it("sets abort BEFORE the signal fires, so a synchronous observer sees the flag", async () => {
		const { task } = build()
		vi.spyOn(task, "dispose").mockImplementation(() => {})
		let flagWhenSignalled: boolean | undefined
		task.abortSignal.addEventListener("abort", () => {
			flagWhenSignalled = task.abort
		})

		await task.abortTask()

		// The Abort-Ordering Invariant: reversing these leaves a window where the
		// stream's catch block skips `abortTask()` and a zombie task survives.
		expect(flagWhenSignalled).toBe(true)
	})

	it("announces an abandonment, and stays silent about a completed instance's teardown", async () => {
		const abandoned = build()
		vi.spyOn(abandoned.task, "dispose").mockImplementation(() => {})
		const abortedEvent = vi.fn()
		abandoned.task.on(ShoferEventName.TaskAborted, abortedEvent)
		await abandoned.task.abortTask(true)
		expect(abortedEvent).toHaveBeenCalled()

		const completed = build()
		vi.spyOn(completed.task, "dispose").mockImplementation(() => {})
		completed.task.didExecuteAttemptCompletion = true
		const silent = vi.fn()
		completed.task.on(ShoferEventName.TaskAborted, silent)
		await completed.task.abortTask(true)
		expect(silent).not.toHaveBeenCalled()
	})

	it("is idempotent", () => {
		const { task } = build()

		task.dispose()

		expect(() => task.dispose()).not.toThrow()
	})
})

describe("background children", () => {
	it("asks the TASK MANAGER whether a child is alive, not its own handle map", () => {
		// A handle can outlive the instance; only the manager knows what is
		// actually running.
		const { task } = build()
		task.backgroundChildren.set("child-1", { taskId: "child-1" } as never)
		expect(task.isBackgroundChildAlive("child-1")).toBe(false)

		provider.getManagedTaskInstance = vi.fn((id: string) => (id === "child-1" ? { taskId: id } : undefined))
		expect(task.isBackgroundChildAlive("child-1")).toBe(true)
		expect(task.isBackgroundChildAlive("child-2")).toBe(false)
	})

	it("aborts every registered child and forgets them", async () => {
		const { task } = build()
		const child = { abortTask: vi.fn().mockResolvedValue(undefined), taskId: "child-1" }
		task.backgroundChildren.set("child-1", child as never)
		provider.taskManager = { getManagedTaskInstance: vi.fn(() => child) }

		await task.abortBackgroundChildren()

		expect(task.backgroundChildren.size).toBe(0)
	})

	it("keeps the handles when asked to abort without clearing", async () => {
		const { task } = build()
		task.backgroundChildren.set("child-1", { taskId: "child-1" } as never)
		provider.taskManager = { getManagedTaskInstance: vi.fn(() => undefined) }

		await task.abortBackgroundChildren(false)

		expect(task.backgroundChildren.size).toBe(1)
	})
})

describe("api configuration", () => {
	it("rebuilds the handler when the profile changes", () => {
		const { task } = build()
		const before = task.api

		task.updateApiConfiguration({ ...BASE_API_CONFIG, apiModelId: "claude-3-opus-20240229" } as never)

		expect(task.api).not.toBe(before)
	})

	it("reports tool calling as disabled only when the configuration says so", () => {
		expect(build().task.toolCallingDisabled).toBe(false)
		expect(
			build({ apiConfiguration: { ...BASE_API_CONFIG, toolCallingEnabled: false } }).task.toolCallingDisabled,
		).toBe(true)
	})
})

describe("token and tool accounting", () => {
	it("caches the token-usage snapshot until a new message arrives", async () => {
		const { task } = build()
		await task.say("api_req_started", JSON.stringify({ tokensIn: 10, tokensOut: 5 }))

		const first = task.tokenUsage
		expect(task.tokenUsage).toBe(first)
	})

	it("emits a final token-usage update on demand", () => {
		const { task } = build()
		const usage = vi.fn()
		task.on(ShoferEventName.TaskTokenUsageUpdated, usage)

		task.emitFinalTokenUsageUpdate()

		expect(usage).toHaveBeenCalled()
	})
})
