import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { ShoferProvider } from "../../core/webview/ShoferProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ShoferProvider")

/**
 * Starting or resuming a task through the API must never destroy another one.
 *
 * One `shofer serve` node hosts MANY independent conversations — a controller
 * creates each of them through this same entry point, against the same
 * provider. The provider's task stack is a UI notion ("the chat you are looking
 * at"), so clearing it to make room used to abort what it popped: the previous
 * conversation died mid-turn, its controller saw `taskAborted(abandoned)` and
 * then nothing at all, and the reply it was streaming was lost with the agent
 * that was composing it.
 *
 * The invariant these tests pin is therefore about the VERB, not the stack:
 * make room by BACKGROUNDING (pop, keep running, keep addressable), never by
 * aborting. `keepCurrentTask` carries the same instruction down into
 * `createTask`, whose own single-open-task enforcement would otherwise re-abort
 * whatever is left.
 */
describe("ShoferExtensionApi — a new or resumed task never abandons another", () => {
	let api: API
	let provider: ShoferProvider
	let createTask: ReturnType<typeof vi.fn>
	let removeShoferFromStack: ReturnType<typeof vi.fn>
	let backgroundCurrentTask: ReturnType<typeof vi.fn>
	let createTaskWithHistoryItem: ReturnType<typeof vi.fn>

	beforeEach(() => {
		createTask = vi.fn().mockResolvedValue({ taskId: "task-new" })
		removeShoferFromStack = vi.fn().mockResolvedValue(undefined)
		backgroundCurrentTask = vi.fn().mockReturnValue(undefined)
		createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)

		provider = {
			context: {} as vscode.ExtensionContext,
			on: vi.fn(),
			cwd: "/test/workspace",
			viewLaunched: false,
			removeShoferFromStack,
			backgroundCurrentTask,
			createTaskWithHistoryItem,
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "task-other" } }),
			taskManager: { getManagedTaskInstance: vi.fn().mockReturnValue(undefined) },
			postInitState: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			createTask,
		} as unknown as ShoferProvider

		api = new API({ appendLine: vi.fn() } as unknown as vscode.OutputChannel, provider)
	})

	it("backgrounds the host's current task instead of aborting it", async () => {
		await api.createTask({ prompt: "hello" })

		expect(backgroundCurrentTask).toHaveBeenCalledTimes(1)
		expect(removeShoferFromStack).not.toHaveBeenCalled()
	})

	it("tells createTask to keep what is left of the stack", async () => {
		await api.createTask({ prompt: "hello" })

		expect(createTask.mock.calls[0]![3]).toMatchObject({ keepCurrentTask: true })
	})

	it("resumes a task without abandoning the current one", async () => {
		await api.resumeTask("task-other")

		expect(createTaskWithHistoryItem).toHaveBeenCalledWith({ id: "task-other" }, { keepCurrentTask: true })
	})
})
