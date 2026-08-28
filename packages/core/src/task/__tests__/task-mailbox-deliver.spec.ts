// npx vitest src/task/__tests__/task-mailbox-deliver.spec.ts

import * as os from "os"
import * as path from "path"
import { randomUUID } from "crypto"

import type { Envelope, HistoryItem, ProviderSettings } from "@shofer/types"
import { MAILBOX_WAKE_TURN_TEXT, setHost, createInMemoryHost, type TaskProviderLike } from "@shofer/types"
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

import { Task } from "../Task.js"

/**
 * `Task.deliver` — the wake decision.
 *
 * The mailbox itself is covered in `mailbox/__tests__/Mailbox.spec.ts`; what is
 * pinned here is the ONE place the mail plane touches the human's message
 * queue. Getting it wrong is quiet in both directions: waking a running loop
 * preempts a turn mid-flight, and failing to wake a stopped one strands the
 * message until somebody happens to speak to the task.
 */
describe("Task.deliver", () => {
	let mockProvider: TaskProviderLike

	const apiConfiguration: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	const makeHistoryItem = () =>
		({
			id: `t-mailbox-${randomUUID()}`,
			number: 1,
			ts: Date.now(),
			task: "earlier conversation",
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

		mockProvider = {
			context: {
				globalStorageUri: { fsPath: path.join(os.tmpdir(), `shofer-mailbox-task-${randomUUID()}`) },
			},
			getState: vi.fn().mockResolvedValue({}),
			log: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postTaskStateUpdate: vi.fn(),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as TaskProviderLike
	})

	/** A dormant task with its wake path stubbed, so nothing restarts a real loop. */
	const makeTask = async () => {
		const task = new Task({
			provider: mockProvider as any,
			apiConfiguration,
			historyItem: makeHistoryItem(),
			startTask: false,
			initialState: { lifecycle: "idle" },
		})
		await task.mailboxReady
		const wake = vi.spyOn(task, "cancelAndProcessQueuedMessages").mockResolvedValue(undefined)
		return { task, wake }
	}

	const envelope = (task: Task, overrides: Partial<Envelope> = {}): Envelope =>
		({
			id: randomUUID(),
			from: "task-sender",
			to: task.taskId,
			kind: "notification",
			subject: "a subject",
			body: "a body",
			deadline: Date.now() + 600_000,
			wake: false,
			sent_at: Date.now(),
			plane: "local",
			...overrides,
		}) as Envelope

	it("leaves a RUNNING loop alone — the digest carries the message on its next turn", async () => {
		const { task, wake } = await makeTask()
		task.abort = false
		task.abandoned = false

		await task.deliver(envelope(task, { wake: true }))

		expect(task.messageQueueService.messages).toHaveLength(0)
		expect(wake).not.toHaveBeenCalled()
		// It IS in the box, which is the whole delivery contract.
		expect(task.mailbox.size()).toBe(1)
	})

	it("wakes a STOPPED loop with one plain-text synthesized turn", async () => {
		const { task, wake } = await makeTask()
		task.abort = true

		await task.deliver(envelope(task, { wake: true }))

		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(task.messageQueueService.messages[0]!.text).toBe(MAILBOX_WAKE_TURN_TEXT)
		// Plain text, so `Task.ask()`'s queue-drain cannot read it as an approval.
		expect(task.messageQueueService.messages[0]!.images).toBeUndefined()
		expect(wake).toHaveBeenCalledTimes(1)
	})

	it("coalesces: two deliveries queue ONE turn and kick the wake path once", async () => {
		const { task, wake } = await makeTask()
		task.abort = true

		await task.deliver(envelope(task, { wake: true }))
		await task.deliver(envelope(task, { wake: true }))

		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(wake).toHaveBeenCalledTimes(1)
		// Both envelopes are in the box — coalescing the WAKE never coalesces mail.
		expect(task.mailbox.size()).toBe(2)
	})

	it("wakes an abandoned instance's successor path too", async () => {
		const { task, wake } = await makeTask()
		task.abandoned = true

		await task.deliver(envelope(task, { wake: true }))

		expect(wake).toHaveBeenCalledTimes(1)
	})

	it("never wakes for wake:false, however dead the loop is", async () => {
		const { task, wake } = await makeTask()
		task.abort = true
		task.abandoned = true

		await task.deliver(envelope(task, { wake: false }))

		expect(task.messageQueueService.messages).toHaveLength(0)
		expect(wake).not.toHaveBeenCalled()
		expect(task.mailbox.size()).toBe(1)
	})

	it("refuses an envelope addressed to another task", async () => {
		const { task } = await makeTask()
		await expect(task.deliver(envelope(task, { to: "somebody-else" }))).rejects.toMatchObject({
			code: "misaddressed",
		})
	})
})
