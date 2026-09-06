const { mockOutputChannel } = vi.hoisted(() => ({ mockOutputChannel: { appendLine: vi.fn() } }))
vi.mock("../../utils/outputChannel.js", () => ({ getOutputChannel: vi.fn(() => mockOutputChannel) }))

const { mockCaptureTaskCompleted } = vi.hoisted(() => ({ mockCaptureTaskCompleted: vi.fn() }))
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureTaskCompleted: mockCaptureTaskCompleted } },
}))

import { ShoferEventName, createInMemoryHost, setHost, type AttemptCompletionToolUse } from "@shofer/types"

import type { Task } from "../../task/Task.js"
import { pluginRegistry } from "../../plugins/plugin-registry.js"
import { MAX_SUBTASK_RESULT_LENGTH } from "../../task/subtask-limits.js"
import { attemptCompletionTool, type AttemptCompletionCallbacks } from "../AttemptCompletionTool.js"

/**
 * `attempt_completion`'s TERMINAL half — what happens once the guards pass.
 *
 * Three AGENTS.md rules meet here, and each one is a bug that has been shipped:
 *
 *  - the **Self-Declared Terminal State Rule**: the tool renders via
 *    `say("completion_result", …)` and emits `TaskCompleted` synchronously. It
 *    must NOT `task.ask(...)` — an idle ask would let `statusMutationTimeout`
 *    fire `TaskIdle` while the never-arriving response withholds
 *    `emitTaskCompleted`, so the rating overlay never lands;
 *  - the **Terminal-State Queue-Drain Rule**: because it no longer asks, it
 *    loses `Task.ask()`'s free queue drain, so it must check the queue ITSELF
 *    before declaring terminal state. Skipping that silently swallows every
 *    message the user typed while the task was running;
 *  - the **Single-Writer Persistence Rule**: only the completion ARTEFACTS are
 *    written here (`completionResultSummary`, the +/− counts). `taskState` is
 *    TaskManager's alone, written in response to the event emitted below, so
 *    spreading a `historyItem` would race it back to a stale value.
 *
 * The delegation path is the one with a counterparty: a child's result reaches
 * its parent as a mailbox `notification` rather than by unwinding a stack —
 * nothing blocks inside `new_task` — and delivery is BEST-EFFORT, because the
 * result is already durable on the child's own history and a deleted or full
 * parent must not prevent the child from completing.
 */

type Recorded = { history: unknown[]; delivered: unknown[] }

function makeProvider(over: Record<string, unknown> = {}) {
	const recorded: Recorded = { history: [], delivered: [] }
	const provider = {
		updateTaskHistory: vi.fn(async (item: unknown) => {
			recorded.history.push(item)
			return []
		}),
		deliverToTask: vi.fn(async (_id: string, envelope: unknown) => {
			recorded.delivered.push(envelope)
			return envelope
		}),
		getTaskWithId: vi.fn(),
		taskManager: {
			getManagedTaskInstance: vi.fn(),
			getManagedTask: vi.fn(),
			getTaskState: vi.fn(),
		},
		...over,
	}
	return { provider, recorded }
}

function makeTask(over: Partial<Task> = {}, provider: unknown = makeProvider().provider) {
	const emitted: Array<[unknown, ...unknown[]]> = []
	const said: Array<[string, string, unknown]> = []
	const task = {
		taskId: "child_1",
		cwd: "/ws",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		todoList: undefined,
		toolUsage: {},
		abort: false,
		completedTerminalState: false,
		shoferMessages: [] as unknown[],
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Error: missing parameter"),
		say: vi.fn(async (type: string, text: string, images?: unknown) => {
			said.push([type, text, images])
		}),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		emit: vi.fn((...args: [unknown, ...unknown[]]) => emitted.push(args)),
		emitFinalTokenUsageUpdate: vi.fn(),
		getTokenUsage: vi.fn().mockReturnValue({}),
		abortBackgroundChildren: vi.fn().mockResolvedValue(undefined),
		providerRef: { deref: () => provider },
		messageQueueService: { isEmpty: () => true, dequeueMessage: () => null },
		...over,
	} as unknown as Task

	return { task, emitted, said }
}

function callbacks(): AttemptCompletionCallbacks & { results: unknown[]; errors: unknown[] } {
	const results: unknown[] = []
	const errors: unknown[] = []
	return {
		results,
		errors,
		pushToolResult: vi.fn((r: unknown) => results.push(r)),
		handleError: vi.fn(async (_ctx: string, e: unknown) => {
			errors.push(e)
		}),
		askApproval: vi.fn(),
		askFinishSubTaskApproval: vi.fn(),
		toolDescription: vi.fn(() => "attempt_completion"),
		removeClosingTag: vi.fn((_t: string, v?: string) => v ?? ""),
	} as unknown as AttemptCompletionCallbacks & { results: unknown[]; errors: unknown[] }
}

const block = (params: Record<string, unknown>): AttemptCompletionToolUse =>
	({
		type: "tool_use",
		name: "attempt_completion",
		params,
		// The router hands the handler its typed `nativeArgs`; a block without
		// them is rejected before `execute` is ever reached.
		nativeArgs: params,
		partial: false,
	}) as unknown as AttemptCompletionToolUse

beforeEach(() => {
	setHost(createInMemoryHost())
	vi.restoreAllMocks()
	mockCaptureTaskCompleted.mockReset()
	mockOutputChannel.appendLine.mockClear()
	vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([])
})

describe("declaring the task complete", () => {
	it("renders the result and emits TaskCompleted WITHOUT asking anyone", async () => {
		const { task, emitted } = makeTask()
		const cb = callbacks()

		await attemptCompletionTool.handle(task, block({ result: "all done", rating: "well" }), cb)

		expect(task.say).toHaveBeenCalledWith("completion_result", "all done", undefined, false)
		expect(task.ask).not.toHaveBeenCalled()
		expect(emitted.map(([name]) => name)).toContain(ShoferEventName.TaskCompleted)
		expect(task.abort).toBe(true)
	})

	it("carries the rating and the subtask flag on the event itself", async () => {
		// Self-Contained Events Rule: a consumer must not call back into the
		// task to learn how it ended.
		const { task, emitted } = makeTask()

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "excellent" }), callbacks())

		const completed = emitted.find(([name]) => name === ShoferEventName.TaskCompleted)!
		expect(completed.at(-1)).toEqual({ rating: "excellent", isSubtask: false })
	})

	it("aborts background children before completing, so none outlives the parent", async () => {
		const { task } = makeTask()

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), callbacks())

		expect(task.abortBackgroundChildren).toHaveBeenCalled()
	})

	it("persists ONLY the completion artefacts, never a task state", async () => {
		const { provider, recorded } = makeProvider()
		vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([{ insertions: 12, deletions: 3 }])
		const { task } = makeTask({}, provider)

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), callbacks())

		expect(recorded.history).toEqual([
			{ id: "child_1", completionResultSummary: "done", insertions: 12, deletions: 3 },
		])
	})

	it("does NOT re-persist when TaskManager already recorded the task completed", async () => {
		const { provider, recorded } = makeProvider()
		provider.taskManager.getTaskState = vi.fn(() => ({ lifecycle: "completed" }))
		const { task } = makeTask({}, provider)

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), callbacks())

		expect(recorded.history).toEqual([])
	})

	it("completes anyway when persisting the artefacts fails", async () => {
		const { provider } = makeProvider({
			updateTaskHistory: vi.fn().mockRejectedValue(new Error("history store down")),
		})
		const { task, emitted } = makeTask({}, provider)

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), callbacks())

		expect(emitted.map(([n]) => n)).toContain(ShoferEventName.TaskCompleted)
	})
})

describe("the file-change badge", () => {
	it("sums whatever the plugins answer", async () => {
		vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([
			{ insertions: 5, deletions: 1 },
			{ insertions: 2, deletions: 4 },
			undefined,
			{ insertions: "not a number", deletions: null },
		])
		const { provider, recorded } = makeProvider()
		const { task } = makeTask({}, provider)

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), callbacks())

		expect(recorded.history[0]).toMatchObject({ insertions: 7, deletions: 5 })
	})

	it("reports zero when NOTHING is tracking file changes", async () => {
		// No plugin answering is the correct rendering of "nothing tracks this",
		// not an error — core computes no stats of its own.
		const { provider, recorded } = makeProvider()
		const { task } = makeTask({}, provider)

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), callbacks())

		expect(recorded.history[0]).toMatchObject({ insertions: 0, deletions: 0 })
	})

	it("survives a plugin that throws while answering", async () => {
		vi.spyOn(pluginRegistry, "requestAll").mockRejectedValue(new Error("plugin exploded"))
		const { provider, recorded } = makeProvider()
		const { task } = makeTask({}, provider)

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), callbacks())

		expect(recorded.history[0]).toMatchObject({ insertions: 0, deletions: 0 })
	})
})

describe("the queued-message drain", () => {
	it("continues the turn with the queued message INSTEAD of completing", async () => {
		const dequeueMessage = vi.fn(() => ({ text: "actually, also do X", images: ["img"] }))
		const { task, emitted, said } = makeTask({
			messageQueueService: { isEmpty: () => false, dequeueMessage } as never,
		})
		const cb = callbacks()

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), cb)

		expect(said).toContainEqual(["user_feedback", "actually, also do X", ["img"]])
		// With images the result is a content-block array, so inspect the payload.
		expect(JSON.stringify(cb.results.at(-1))).toContain("actually, also do X")
		// The task is NOT terminal: the loop takes another iteration.
		expect(emitted.map(([n]) => n)).not.toContain(ShoferEventName.TaskCompleted)
		expect(task.abort).toBe(false)
	})

	it("completes normally when the queue reports non-empty but yields nothing", async () => {
		const { task, emitted } = makeTask({
			messageQueueService: { isEmpty: () => false, dequeueMessage: () => null } as never,
		})

		await attemptCompletionTool.handle(task, block({ result: "done", rating: "well" }), callbacks())

		expect(emitted.map(([n]) => n)).toContain(ShoferEventName.TaskCompleted)
	})
})

describe("a CHILD task's result", () => {
	const childProvider = () => {
		const { provider, recorded } = makeProvider()
		provider.taskManager.getManagedTask = vi.fn(() => ({ name: "Fix the parser" }))
		return { provider, recorded }
	}

	it("is delivered to the parent's mailbox as a waking notification", async () => {
		const { provider, recorded } = childProvider()
		const { task } = makeTask({ taskId: "child_1", parentTaskId: "parent_1" } as never, provider)

		await attemptCompletionTool.handle(task, block({ result: "the answer", rating: "well" }), callbacks())

		expect(recorded.delivered).toHaveLength(1)
		expect(recorded.delivered[0]).toMatchObject({
			from: "child_1",
			to: "parent_1",
			kind: "notification",
			subject: "result: Fix the parser",
			body: "the answer",
			// A parent that ended its turn while its children worked is the
			// normal case, and being told the answer is the point of delegating.
			wake: true,
			plane: "local",
		})
	})

	it("falls back to the task id when the child has no name yet", async () => {
		const { provider, recorded } = makeProvider()
		const { task } = makeTask({ taskId: "child_1", parentTaskId: "parent_1" } as never, provider)

		await attemptCompletionTool.handle(task, block({ result: "x", rating: "well" }), callbacks())

		expect(recorded.delivered[0]).toMatchObject({ subject: "result: child_1" })
	})

	it("marks the parent's background handle completed", async () => {
		const handle = { status: "running" }
		const { provider } = childProvider()
		provider.taskManager.getManagedTaskInstance = vi.fn(() => ({
			backgroundChildren: new Map([["child_1", handle]]),
		}))
		const { task } = makeTask({ taskId: "child_1", parentTaskId: "parent_1" } as never, provider)

		await attemptCompletionTool.handle(task, block({ result: "x", rating: "well" }), callbacks())

		expect(handle.status).toBe("completed")
	})

	it("completes even when the parent cannot be delivered to", async () => {
		// Best-effort by design: the result is already durable on the child's
		// own history and `check_task_status` still reads it there.
		const { provider } = childProvider()
		provider.deliverToTask = vi.fn().mockRejectedValue(new Error("mailbox full"))
		const { task, emitted } = makeTask({ taskId: "child_1", parentTaskId: "parent_1" } as never, provider)

		await attemptCompletionTool.handle(task, block({ result: "x", rating: "well" }), callbacks())

		const completed = emitted.find(([n]) => n === ShoferEventName.TaskCompleted)!
		expect(completed.at(-1)).toEqual({ rating: "well", isSubtask: true })
		expect(task.abort).toBe(true)
	})

	it("still delivers when persisting the child's own history fails", async () => {
		const { provider, recorded } = childProvider()
		provider.updateTaskHistory = vi.fn().mockRejectedValue(new Error("store down"))
		const { task } = makeTask({ taskId: "child_1", parentTaskId: "parent_1" } as never, provider)

		await attemptCompletionTool.handle(task, block({ result: "x", rating: "well" }), callbacks())

		expect(recorded.delivered).toHaveLength(1)
	})

	it("takes the ordinary path when the provider has been collected", async () => {
		const { task, emitted } = makeTask({ taskId: "child_1", parentTaskId: "parent_1" } as never, undefined)

		await attemptCompletionTool.handle(task, block({ result: "x", rating: "well" }), callbacks())

		expect(emitted.map(([n]) => n)).toContain(ShoferEventName.TaskCompleted)
	})
})

describe("the result value", () => {
	it("serializes a structured result produced under an output contract", async () => {
		const { task, said } = makeTask()

		await attemptCompletionTool.handle(task, block({ result: { ok: true, count: 2 }, rating: "well" }), callbacks())

		expect(said[0]).toEqual(["completion_result", '{"ok":true,"count":2}', undefined])
	})

	it("refuses an EMPTY object as a missing result", async () => {
		const { task } = makeTask()
		const cb = callbacks()

		await attemptCompletionTool.handle(task, block({ result: {}, rating: "well" }), cb)

		expect(task.recordToolError).toHaveBeenCalledWith("attempt_completion")
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(cb.results).toEqual(["Error: missing parameter"])
	})

	it("caps a runaway result so a subtask cannot blow up its parent's context", async () => {
		const { task, said } = makeTask()

		await attemptCompletionTool.handle(
			task,
			block({ result: "x".repeat(MAX_SUBTASK_RESULT_LENGTH + 500), rating: "well" }),
			callbacks(),
		)

		const rendered = said[0]![1]
		expect(rendered.length).toBeLessThan(MAX_SUBTASK_RESULT_LENGTH + 200)
		expect(rendered).toContain("hard safety cap")
	})
})

describe("the rating", () => {
	it.each(["poor", "well", "excellent"])("passes %s through", async (rating) => {
		const { task, emitted } = makeTask()

		await attemptCompletionTool.handle(task, block({ result: "done", rating }), callbacks())

		expect(emitted.find(([n]) => n === ShoferEventName.TaskCompleted)!.at(-1)).toMatchObject({ rating })
	})

	it.each([undefined, "", "amazing"])("defaults %s to poor rather than blocking completion", async (rating) => {
		// The schema declares it required, but providers like vscode-lm do not
		// enforce strict schemas — refusing here would strand a finished task.
		const { task, emitted } = makeTask()

		await attemptCompletionTool.handle(task, block({ result: "done", rating }), callbacks())

		expect(emitted.find(([n]) => n === ShoferEventName.TaskCompleted)!.at(-1)).toMatchObject({ rating: "poor" })
	})
})

describe("the optional feedback", () => {
	it("goes to the output channel, not to the model", async () => {
		const { task } = makeTask()
		const cb = callbacks()

		await attemptCompletionTool.handle(
			task,
			block({ result: "done", rating: "well", feedback: "  the diff tool was slow  " }),
			cb,
		)

		const written = mockOutputChannel.appendLine.mock.calls.map(([line]) => line)
		expect(written.some((l: string) => l.includes("FEEDBACK via attempt_completion"))).toBe(true)
		expect(written).toContain("the diff tool was slow")
	})

	it("is ignored when it is only whitespace", async () => {
		const { task } = makeTask()

		await attemptCompletionTool.handle(
			task,
			block({ result: "done", rating: "well", feedback: "   " }),
			callbacks(),
		)

		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
	})
})

describe("streaming the partial call", () => {
	it("streams the result into the completion row", async () => {
		const { task } = makeTask()

		await attemptCompletionTool.handlePartial(task, {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "half a res" },
			partial: true,
		} as never)

		expect(task.say).toHaveBeenCalledWith("completion_result", "half a res", undefined, true)
	})

	it("serializes a structured partial result too", async () => {
		const { task } = makeTask()

		await attemptCompletionTool.handlePartial(task, {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: { ok: true } },
			partial: true,
		} as never)

		expect(task.say).toHaveBeenCalledWith("completion_result", '{"ok":true}', undefined, true)
	})

	it("renders the result first, then the command row, when a command rides along", async () => {
		const { task } = makeTask()

		await attemptCompletionTool.handlePartial(task, {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done", command: "npm start" },
			partial: true,
		} as never)

		expect(task.say).toHaveBeenCalledWith("completion_result", "done", undefined, false)
		expect(task.ask).toHaveBeenCalledWith("command", "npm start", true)
	})

	it("updates the command row in place once it exists", async () => {
		const { task } = makeTask({ shoferMessages: [{ ask: "command" }] as never })

		await attemptCompletionTool.handlePartial(task, {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done", command: "npm start" },
			partial: true,
		} as never)

		// The result row is not re-rendered; only the command ask updates.
		expect(task.say).not.toHaveBeenCalled()
		expect(task.ask).toHaveBeenCalledWith("command", "npm start", true)
	})

	it("swallows a rejected command ask, which is how a cancelled stream ends", async () => {
		const { task } = makeTask({ ask: vi.fn().mockRejectedValue(new Error("aborted")) } as never)

		await expect(
			attemptCompletionTool.handlePartial(task, {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "done", command: "npm start" },
				partial: true,
			} as never),
		).resolves.toBeUndefined()
	})
})
