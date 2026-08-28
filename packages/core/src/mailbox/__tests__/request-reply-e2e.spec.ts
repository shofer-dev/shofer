// npx vitest src/mailbox/__tests__/request-reply-e2e.spec.ts

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
vi.mock("p-wait-for", () => ({ default: vi.fn().mockImplementation(async () => Promise.resolve()) }))

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
import { SendMessageTool } from "../../tools/SendMessageTool.js"
import { ReplyTool } from "../../tools/ReplyTool.js"
import { WaitTool } from "../../tools/WaitTool.js"

/**
 * A request and its reply, end to end, through two LIVE `Task` instances and
 * the three real tool handlers.
 *
 * The unit tests each mock the other side of the seam; this one does not. It is
 * the only place that proves the pieces compose: an envelope minted by
 * `send_message` is one a real `Mailbox` accepts, the id it returns is the id
 * `reply` resolves and `wait(in_reply_to)` unparks on, and answering costs the
 * replier nothing — Task B is still alive at the end, which is the entire
 * reason this design replaced "answer by calling attempt_completion".
 */
describe("request → reply, end to end", () => {
	const ROOT_ID = "root-1"
	let provider: TaskProviderLike
	let tasks: Map<string, Task>

	const apiConfiguration: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	const historyItem = (id: string): HistoryItem =>
		({
			id,
			rootTaskId: ROOT_ID,
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
				globalStorageUri: { fsPath: path.join(os.tmpdir(), `shofer-e2e-${randomUUID()}`) },
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
			// The real routing seam: hand the envelope to the addressed live task.
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

	/** A live, dormant `Task` registered in the fake provider's routing table. */
	const makeTask = async (id: string, knownPeers: string[]) => {
		const task = new Task({
			provider: provider as any,
			apiConfiguration,
			historyItem: { ...historyItem(id), id },
			startTask: false,
			initialState: { lifecycle: "idle" },
		})
		// The constructor mints its own id; route on the real one.
		tasks.set(task.taskId, task)
		task.knownPeers = new Set(knownPeers)
		await task.mailboxReady
		// Keep the loop nominally "running" so a delivery does not try to restart it.
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
			} as any,
		}
	}

	it("carries a question to B and its answer back to A, leaving both alive", async () => {
		const a = await makeTask("a", [])
		const b = await makeTask("b", [])
		a.knownPeers = new Set([b.taskId])
		b.knownPeers = new Set([a.taskId])

		// 1. A asks.
		const send = callbacks()
		await new SendMessageTool().execute(
			{ to: b.taskId, body: "which table does UserService use?", kind: "request", timeout_sec: 60 },
			a,
			send.bag,
		)
		const requestId = /Sent request (\S+) to/.exec(send.results[0]!)![1]!
		expect(b.mailbox.byKind("request").map((e) => e.id)).toEqual([requestId])

		// 2. A parks on the answer. B has not replied yet, so this must not return.
		const waitA = callbacks()
		const parked = new WaitTool().execute({ timeout_sec: 5, in_reply_to: requestId }, a, waitA.bag)
		await vi.waitFor(() => expect(setStateSpy()).toHaveBeenCalledWith(a.taskId, { lifecycle: "waiting" }))
		expect(waitA.results).toHaveLength(0)

		// 3. B reads its box and finds the question.
		const readB = callbacks()
		await new WaitTool().execute({ timeout_sec: 0 }, b, readB.bag)
		expect(readB.results[0]).toContain("which table does UserService use?")
		expect(readB.results[0]).toContain("awaiting your reply")
		// Reading a request does not consume it.
		expect(b.mailbox.byKind("request")).toHaveLength(1)

		// 4. B answers.
		const replyB = callbacks()
		await new ReplyTool().execute({ replies: [{ message_id: requestId, body: "the users table" }] }, b, replyB.bag)
		expect(replyB.results[0]).toContain(`${requestId}: answered ${a.taskId}`)
		// The question is discharged out of B's box…
		expect(b.mailbox.pending()).toHaveLength(0)
		// …and B is still alive. Answering is not terminal.
		expect(b.abort).toBe(false)

		// 5. A's park returns with the answer.
		await parked
		expect(waitA.results[0]).toContain("the users table")
		expect(waitA.results[0]).toContain(`reply to ${requestId}`)
		expect(setStateSpy()).toHaveBeenCalledWith(a.taskId, { lifecycle: "running" })
		// The reply is consumed by being read; A's box is empty again.
		expect(a.mailbox.pending()).toHaveLength(0)

		a.dispose()
		b.dispose()
	})

	it("refuses a send across the ACL, and nothing lands", async () => {
		const a = await makeTask("a", [])
		const b = await makeTask("b", [])
		a.knownPeers = new Set() // no grant

		const send = callbacks()
		await new SendMessageTool().execute({ to: b.taskId, body: "hi" }, a, send.bag)

		expect(send.results[0]).toContain("not in your allowed peer set")
		expect(b.mailbox.pending()).toHaveLength(0)

		a.dispose()
		b.dispose()
	})
})
