import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ShoferProvider } from "../../core/webview/ShoferProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ShoferProvider")

/**
 * `ShoferAPI.sendMessage` is **task-addressed**: it resolves the named task and
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

	const liveTask = (taskId: string, over: Record<string, unknown> = {}) => ({
		taskId,
		abandoned: false,
		abort: false,
		submitUserMessage: vi.fn().mockResolvedValue(undefined),
		...over,
	})

	beforeEach(() => {
		mockOutputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		mockPostMessageToWebview = vi.fn().mockResolvedValue(undefined)
		getManagedTaskInstance = vi.fn().mockReturnValue(undefined)
		getCurrentTask = vi.fn().mockReturnValue(undefined)

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			postMessageToWebview: mockPostMessageToWebview,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask,
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
		expect(task.submitUserMessage).toHaveBeenCalledWith("hello", undefined)
		// Never the webview — see the contract note above.
		expect(mockPostMessageToWebview).not.toHaveBeenCalled()
	})

	it("forwards images alongside the text", async () => {
		const task = liveTask("t1")
		getManagedTaskInstance.mockReturnValue(task)
		const images = ["data:image/png;base64,image1data", "data:image/png;base64,image2data"]

		await api.sendMessage("t1", "compare these", images)

		expect(task.submitUserMessage).toHaveBeenCalledWith("compare these", images)
	})

	it("falls back to the current task when its id matches the addressed one", async () => {
		// managedTasks holds only BACKGROUNDED instances; the foreground task is on
		// the stack, so the current task answers for its own id.
		const task = liveTask("t-current")
		getCurrentTask.mockReturnValue(task)

		await api.sendMessage("t-current", "hello")

		expect(task.submitUserMessage).toHaveBeenCalledWith("hello", undefined)
	})

	it("does not deliver to the current task when the addressed id differs", async () => {
		const task = liveTask("t-current")
		getCurrentTask.mockReturnValue(task)

		await api.sendMessage("t-other", "hello")

		expect(task.submitUserMessage).not.toHaveBeenCalled()
		expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("no live task instance for t-other"))
	})

	it("drops the message when the host knows no such task", async () => {
		await api.sendMessage("nope", "hello")

		expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("no live task instance for nope"))
		expect(mockPostMessageToWebview).not.toHaveBeenCalled()
	})

	it.each([
		["abandoned", { abandoned: true }],
		["aborted", { abort: true }],
	])("drops the message when the addressed task is %s", async (_label, over) => {
		const task = liveTask("t1", over)
		getManagedTaskInstance.mockReturnValue(task)

		await api.sendMessage("t1", "hello")

		expect(task.submitUserMessage).not.toHaveBeenCalled()
		expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("no live task instance for t1"))
	})
})
