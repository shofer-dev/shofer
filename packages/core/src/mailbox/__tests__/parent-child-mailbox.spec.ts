// npx vitest src/mailbox/__tests__/parent-child-mailbox.spec.ts

import * as os from "os"
import * as path from "path"
import { randomUUID } from "crypto"

import type { Envelope, HistoryItem, ProviderSettings } from "@shofer/types"
import { setHost, createInMemoryHost, type TaskProviderLike } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

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
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("delay", () => ({ __esModule: true, default: vi.fn().mockResolvedValue(undefined) }))
// `p-wait-for` is deliberately NOT mocked here: `task.ask()` parks on it, and a
// child parked on a question is the whole subject of this file. A mock that
// resolves immediately would make every ask answer itself with empty text.

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		appendFile: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation(() => Promise.resolve("[]")),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}
	return { ...actual, ...mockFunctions, default: mockFunctions }
})

import { Task } from "../../task/Task.js"
import { AttemptCompletionTool } from "../../tools/AttemptCompletionTool.js"
import { AskFollowupQuestionTool } from "../../tools/AskFollowupQuestionTool.js"
import { ReplyTool } from "../../tools/ReplyTool.js"
import { WaitTool } from "../../tools/WaitTool.js"

/**
 * Parent and child on the mailbox, through LIVE `Task` instances.
 *
 * These are the four flows step 3 replaced the blocking machinery with:
 * a child's RESULT arrives as a notification, a child's QUESTION arrives as a
 * request, the parent's `reply` unparks the child, and — the case with no
 * agent on the other end — the question EXPIRES and the child is handed a
 * synthesized answer instead of waiting forever.
 */
describe("parent/child over the mailbox", () => {
	const ROOT_ID = "root-1"
	let provider: TaskProviderLike
	let tasks: Map<string, Task>

	const apiConfiguration: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	const historyItem = (id: string, parentTaskId?: string): HistoryItem =>
		({
			id,
			rootTaskId: ROOT_ID,
			parentTaskId,
			number: 1,
			ts: Date.now(),
			task: "work",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}) as HistoryItem

	beforeEach(() => {
		vi.clearAllMocks()
		setHost(createInMemoryHost())
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		tasks = new Map()

		provider = {
			context: {
				globalStorageUri: { fsPath: path.join(os.tmpdir(), `shofer-pc-${randomUUID()}`) },
			},
			getState: vi.fn().mockResolvedValue({}),
			log: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postTaskStateUpdate: vi.fn(),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			getTaskWithId: vi.fn(async (id: string) => {
				if (!tasks.has(id)) throw new Error(`no task ${id}`)
				return { historyItem: historyItem(id) }
			}),
			deliverToTask: vi.fn(async (taskId: string, envelope: Envelope) => {
				const target = tasks.get(taskId)
				if (!target) throw new Error(`Task ${taskId} is not reachable`)
				return target.deliver(envelope)
			}),
			taskManager: {
				getManagedTaskInstance: vi.fn((id: string) => tasks.get(id)),
				getManagedTask: vi.fn(() => undefined),
				getFocusedTaskId: vi.fn(() => undefined),
				setState: vi.fn(),
			},
		} as unknown as TaskProviderLike
	})

	/**
	 * A live, dormant `Task` registered in the fake provider's routing table.
	 * Passing `parentTaskId` makes it a CHILD — every child is concurrent now, so
	 * `isBackground` rides along with it rather than being a separate mode.
	 */
	const makeTask = async (id: string, parentTaskId?: string) => {
		const task = new Task({
			provider: provider as any,
			apiConfiguration,
			historyItem: { ...historyItem(id, parentTaskId), id },
			isBackground: parentTaskId !== undefined,
			startTask: false,
			initialState: { lifecycle: "idle" },
		})
		tasks.set(task.taskId, task)
		await task.mailboxReady
		task.abort = false
		task.abandoned = false
		return task
	}

	/** The fake provider's `setState` spy — `TaskProviderLike` does not surface `taskManager`. */
	const setStateSpy = () =>
		(provider as unknown as { taskManager: { setState: ReturnType<typeof vi.fn> } }).taskManager.setState

	const callbacks = () => {
		const results: string[] = []
		return {
			results,
			bag: {
				askApproval: vi.fn(async () => true),
				handleError: vi.fn(async (_a: string, e: Error) => {
					throw e
				}),
				pushToolResult: vi.fn((r: string) => results.push(r)),
				askFinishSubTaskApproval: vi.fn(async () => true),
				toolDescription: () => "[attempt_completion]",
			} as any,
		}
	}

	it("delivers a completed child's result to its parent, which reads it with wait(from)", async () => {
		const parent = await makeTask("parent")
		const child = await makeTask("child", parent.taskId)

		// The parent parks on its child specifically.
		const waitP = callbacks()
		const parked = new WaitTool().execute({ timeout_sec: 5, from: [child.taskId] }, parent, waitP.bag)
		await vi.waitFor(() => expect(setStateSpy()).toHaveBeenCalledWith(parent.taskId, { lifecycle: "waiting" }))

		// The child completes.
		const done = callbacks()
		await new AttemptCompletionTool().execute(
			{ result: "the auth tables are users and sessions", rating: "well" },
			child,
			done.bag,
		)

		// The result arrived as a notification and unparked the parent.
		await parked
		expect(waitP.results[0]).toContain("the auth tables are users and sessions")
		expect(waitP.results[0]).toContain("notification")
		expect(waitP.results[0]).toContain(`from ${child.taskId}`)
		// attempt_completion is still terminal for the CHILD.
		expect(child.abort).toBe(true)

		parent.dispose()
		child.dispose()
	})

	it("carries a child's question to the parent as a request, and the parent's reply unparks the child", async () => {
		const parent = await makeTask("parent")
		const child = await makeTask("child", parent.taskId)
		parent.backgroundChildren.set(child.taskId, {
			taskId: child.taskId,
			status: "running",
			createdAt: Date.now(),
			parentTaskId: parent.taskId,
		})

		// The child asks. This parks it on its own `followup` ask.
		const ask = callbacks()
		const asking = new AskFollowupQuestionTool().execute(
			{ question: "Which database?", follow_up: [{ text: "staging" }, { text: "prod" }] },
			child,
			ask.bag,
		)

		// The question is in the parent's box as a request…
		await vi.waitFor(() => expect(parent.mailbox.byKind("request")).toHaveLength(1))
		const request = parent.mailbox.byKind("request")[0]!
		expect(request).toMatchObject({ from: child.taskId, kind: "request", wake: true })
		expect(request.subject).toBe("question: Which database?")
		expect(request.body).toContain("- staging")
		// …and the child is parked on it.
		expect(child.forwardedQuestion?.envelopeId).toBe(request.id)

		// The parent answers with `reply`.
		const rep = callbacks()
		await new ReplyTool().execute({ replies: [{ message_id: request.id, body: "use staging" }] }, parent, rep.bag)

		// The child's ask was unparked with the parent's answer…
		await asking
		expect(ask.results[0]).toContain("use staging")
		// …and the request is discharged out of the parent's box.
		expect(parent.mailbox.byKind("request")).toHaveLength(0)
		expect(child.forwardedQuestion).toBeUndefined()

		parent.dispose()
		child.dispose()
	})

	it("withdraws the request from the parent's box when a HUMAN answers in the child's chat", async () => {
		const parent = await makeTask("parent")
		const child = await makeTask("child", parent.taskId)

		const ask = callbacks()
		const asking = new AskFollowupQuestionTool().execute(
			{ question: "Which database?", follow_up: [{ text: "staging" }] },
			child,
			ask.bag,
		)

		await vi.waitFor(() => expect(parent.mailbox.byKind("request")).toHaveLength(1))

		// The human answers in the child's own chat — the same path the webview takes.
		// Wait until the child is actually parked on its ask before answering it —
		// `handleWebviewAskResponse` is a no-op when nothing is awaiting.
		await vi.waitFor(() =>
			expect((child as unknown as { isAwaitingAskResponse: boolean }).isAwaitingAskResponse).toBe(true),
		)
		child.handleWebviewAskResponse("messageResponse", "prod, actually")
		await asking

		expect(ask.results[0]).toContain("prod, actually")
		// The parent must stop being shown a question nobody is waiting on.
		expect(parent.mailbox.byKind("request")).toHaveLength(0)

		parent.dispose()
		child.dispose()
	})

	it("hands the child a synthesized answer when the question expires unanswered", async () => {
		vi.useFakeTimers()
		try {
			const parent = await makeTask("parent")
			const child = await makeTask("child", parent.taskId)

			const ask = callbacks()
			const asking = new AskFollowupQuestionTool().execute(
				{ question: "Which database?", follow_up: [] },
				child,
				ask.bag,
			)

			// Let the delivery + park settle, then run out the child-question deadline.
			await vi.waitFor(() => expect(child.forwardedQuestion).toBeDefined(), { timeout: 2000, interval: 1 })
			await vi.advanceTimersByTimeAsync(600_000 + 1_000)
			await asking

			// The child is LIVE again with a decision it can act on — not stuck, and
			// not failed.
			expect(ask.results[0]).toContain("expired unanswered after 600s")
			expect(ask.results[0]).toContain("Decide yourself, or ask again")

			parent.dispose()
			child.dispose()
		} finally {
			vi.useRealTimers()
		}
	})
})
