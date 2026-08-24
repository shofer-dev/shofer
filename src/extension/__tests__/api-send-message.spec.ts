import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ShoferProvider } from "../../core/webview/ShoferProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ShoferProvider")

/**
 * `ShoferExtensionApi.sendMessage` is **task-addressed**: it resolves the named task and
 * hands the message to that task's own channel. It must never route through the
 * webview (`invoke: sendMessage`) — headless hosts report the mock webview as
 * launched and drop invokes, which silently lost every follow-up — and never
 * fall back to "the current task", which raced concurrent tasks on one host.
 */
describe("API - sendMessage (task-addressed)", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ShoferProvider
	let mockPostMessageToWebview: ReturnType<typeof vi.fn>
	let mockLog: ReturnType<typeof vi.fn>
	let getManagedTaskInstance: ReturnType<typeof vi.fn>
	let getCurrentTask: ReturnType<typeof vi.fn>
	let getTaskWithId: ReturnType<typeof vi.fn>
	let createTaskWithHistoryItem: ReturnType<typeof vi.fn>

	const liveTask = (taskId: string, over: Record<string, unknown> = {}) => ({
		taskId,
		abandoned: false,
		abort: false,
		submitUserMessage: vi.fn().mockResolvedValue(undefined),
		...over,
	})

	/** A freshly rehydrated instance, as `createTaskWithHistoryItem` returns one. */
	const rehydrated = (taskId: string, over: Record<string, unknown> = {}) => ({
		taskId,
		abandoned: false,
		abort: false,
		messageQueueService: { addMessage: vi.fn(), dequeueMessage: vi.fn() },
		startFromHistory: vi.fn(),
		submitUserMessage: vi.fn().mockResolvedValue(undefined),
		...over,
	})

	beforeEach(() => {
		mockOutputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		mockPostMessageToWebview = vi.fn().mockResolvedValue(undefined)
		getManagedTaskInstance = vi.fn().mockReturnValue(undefined)
		getCurrentTask = vi.fn().mockReturnValue(undefined)
		getTaskWithId = vi.fn().mockRejectedValue(new Error("Task not found"))
		createTaskWithHistoryItem = vi.fn()

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			postMessageToWebview: mockPostMessageToWebview,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask,
			getTaskWithId,
			createTaskWithHistoryItem,
			taskManager: { getManagedTaskInstance },
			viewLaunched: true,
		} as unknown as ShoferProvider

		mockLog = vi.fn()
		api = new API(mockOutputChannel, mockProvider, undefined, true)
		;(api as any).log = mockLog
	})

	it("delivers to the addressed background task", async () => {
		const task = liveTask("t1")
		getManagedTaskInstance.mockReturnValue(task)

		await api.sendMessage("t1", "hello")

		expect(getManagedTaskInstance).toHaveBeenCalledWith("t1")
		expect(task.submitUserMessage).toHaveBeenCalledWith("hello", undefined, undefined, undefined, undefined)
		// Never the webview — see the contract note above.
		expect(mockPostMessageToWebview).not.toHaveBeenCalled()
	})

	it("forwards images alongside the text", async () => {
		const task = liveTask("t1")
		getManagedTaskInstance.mockReturnValue(task)
		const images = ["data:image/png;base64,image1data", "data:image/png;base64,image2data"]

		await api.sendMessage("t1", "compare these", images)

		expect(task.submitUserMessage).toHaveBeenCalledWith("compare these", images, undefined, undefined, undefined)
	})

	it("falls back to the current task when its id matches the addressed one", async () => {
		// managedTasks holds only BACKGROUNDED instances; the foreground task is on
		// the stack, so the current task answers for its own id.
		const task = liveTask("t-current")
		getCurrentTask.mockReturnValue(task)

		await api.sendMessage("t-current", "hello")

		expect(task.submitUserMessage).toHaveBeenCalledWith("hello", undefined, undefined, undefined, undefined)
	})

	it("does not deliver to the current task when the addressed id differs", async () => {
		const task = liveTask("t-current")
		getCurrentTask.mockReturnValue(task)

		await api.sendMessage("t-other", "hello")

		expect(task.submitUserMessage).not.toHaveBeenCalled()
		expect(getTaskWithId).toHaveBeenCalledWith("t-other")
	})

	it("drops the message when the host knows no such task at all", async () => {
		await api.sendMessage("nope", "hello")

		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("no live instance and no history for nope"))
		expect(mockPostMessageToWebview).not.toHaveBeenCalled()
	})

	/**
	 * A COMPLETED task has `abort === true` — both completion shapes set it — so
	 * "the addressed instance is aborted" is the ordinary next-turn-of-a-
	 * conversation case, not an error. Dropping the message stranded every
	 * follow-up; resuming first and sending after (the transport's old
	 * sequencing) lost the resume ask to whoever watches asks.
	 *
	 * Delivery rehydrates DORMANT (`startTask: false`), queues, and only then
	 * starts the resume — so `resumeTaskFromHistory` finds the message already
	 * there and takes it as the resumption instead of publishing an ask.
	 */
	describe("finished or cold task", () => {
		it.each([
			["completed (abort)", { abort: true } as Record<string, unknown>],
			["abandoned", { abandoned: true } as Record<string, unknown>],
			["gone entirely", undefined],
		])("rehydrates and queues the message when the instance is %s", async (_label, over) => {
			if (over) {
				getManagedTaskInstance.mockReturnValue(liveTask("t1", over))
			}
			getTaskWithId.mockResolvedValue({ historyItem: { id: "t1" } })
			const fresh = rehydrated("t1")
			createTaskWithHistoryItem.mockResolvedValue(fresh)

			await api.sendMessage("t1", "and tomorrow?")

			expect(createTaskWithHistoryItem).toHaveBeenCalledWith(
				{ id: "t1" },
				{ keepCurrentTask: true, startTask: false, trace: undefined },
			)
			expect(fresh.messageQueueService.addMessage).toHaveBeenCalledWith("and tomorrow?", undefined)
			expect(fresh.startFromHistory).toHaveBeenCalled()
		})

		it("queues BEFORE starting the resume, so no resume ask is ever raised", async () => {
			getManagedTaskInstance.mockReturnValue(liveTask("t1", { abort: true }))
			getTaskWithId.mockResolvedValue({ historyItem: { id: "t1" } })
			const fresh = rehydrated("t1")
			createTaskWithHistoryItem.mockResolvedValue(fresh)

			await api.sendMessage("t1", "and tomorrow?", ["img"])

			// The ordering IS the fix: rehydration that starts itself races the
			// message in, and the lost race publishes an ask that a headless ask
			// dispatcher then prints, declines, and charges to the retry budget.
			expect(fresh.messageQueueService.addMessage).toHaveBeenCalledWith("and tomorrow?", ["img"])
			expect(fresh.messageQueueService.addMessage.mock.invocationCallOrder[0]).toBeLessThan(
				fresh.startFromHistory.mock.invocationCallOrder[0]!,
			)
			// Nothing is delivered a second time through the ask channel.
			expect(fresh.submitUserMessage).not.toHaveBeenCalled()
			expect(fresh.messageQueueService.dequeueMessage).not.toHaveBeenCalled()
		})
	})

	/**
	 * The caller's trace context follows the message down BOTH paths. It has to:
	 * `beforeTaskStart` fires when a task is CREATED, so a conversation whose
	 * context is stated only there is attributable to its caller for exactly one
	 * turn — and the cold path below is how every follow-up turn actually arrives.
	 */
	describe("trace context", () => {
		const trace = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "a=1" }

		it("reaches a warm task's own message channel", async () => {
			const task = liveTask("t1")
			getManagedTaskInstance.mockReturnValue(task)

			await api.sendMessage("t1", "hello", undefined, trace)

			expect(task.submitUserMessage).toHaveBeenCalledWith("hello", undefined, undefined, undefined, trace)
		})

		it("reaches a rehydrated task, which is where a conversation's later turns land", async () => {
			getManagedTaskInstance.mockReturnValue(liveTask("t1", { abort: true }))
			getTaskWithId.mockResolvedValue({ historyItem: { id: "t1" } })
			createTaskWithHistoryItem.mockResolvedValue(rehydrated("t1"))

			await api.sendMessage("t1", "and tomorrow?", undefined, trace)

			expect(createTaskWithHistoryItem).toHaveBeenCalledWith(
				{ id: "t1" },
				{ keepCurrentTask: true, startTask: false, trace },
			)
		})
	})
})
