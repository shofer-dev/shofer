// npx vitest src/task/__tests__/resume-with-queued-message.spec.ts

import * as os from "os"
import * as path from "path"

import { randomUUID } from "crypto"

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { HistoryItem, ProviderSettings } from "@shofer/types"
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

import { Task } from "../Task.js"

/**
 * Resuming a task to DELIVER A MESSAGE must raise no resume ask.
 *
 * `Task.ask()` drains the queue to answer a resume ask, but only after
 * publishing it — so on a headless node the ask is dispatched (printed,
 * `--retry` budget spent, declined) before the drain runs, and the drain's
 * later answer makes that harmless rather than free. It costs a persist, a
 * state broadcast, a `getState()` and a `pWaitFor` on the first hop of every
 * follow-up turn of a live conversation. When the message is already queued at
 * rehydration time it IS the resumption, so nothing is asked.
 */
describe("resumeTaskFromHistory with a queued message", () => {
	let mockProvider: TaskProviderLike

	const apiConfiguration: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	// A fresh id and storage root per test: the message store is SQLite, and a
	// fixed task id collides with the other specs vitest runs in parallel
	// ("database is locked").
	const makeHistoryItem = () =>
		({
			id: `t-resume-${randomUUID()}`,
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
				globalStorageUri: { fsPath: path.join(os.tmpdir(), `shofer-resume-${randomUUID()}`) },
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

	/** A task rehydrated from history, with its agent loop stubbed out. */
	const makeTask = async (lifecycle: "completed" | "idle" = "completed") => {
		const task = new Task({
			provider: mockProvider as any,
			apiConfiguration,
			historyItem: makeHistoryItem(),
			startTask: false,
			initialState: { lifecycle },
		})

		await task.preloadShoferMessages()

		// A non-empty saved history is what carries the resume into the loop.
		vi.spyOn(task as any, "getSavedApiConversationHistory").mockResolvedValue([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		])

		const loop = vi.spyOn(task, "recursivelyMakeShoferRequests").mockResolvedValue(true)
		const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })

		return { task, loop, ask }
	}

	/** The resume asks, as they appear on the message stream a dispatcher reads. */
	const resumeAsksOnStream = (task: Task) =>
		task.shoferMessages.filter((m) => m.ask === "resume_task" || m.ask === "resume_completed_task")

	it("raises no resume ask, and makes the queued message the turn", async () => {
		const { task, loop, ask } = await makeTask()
		task.messageQueueService.addMessage("and what about tomorrow?")

		task.startFromHistory()
		await vi.waitFor(() => expect(loop).toHaveBeenCalled())

		// Nothing was asked — so nothing was published for an ask dispatcher to
		// print, decline, or spend a retry budget on.
		expect(ask).not.toHaveBeenCalled()
		expect(resumeAsksOnStream(task)).toHaveLength(0)

		// The message became the resumed conversation's next user turn.
		expect(JSON.stringify(loop.mock.calls[0]![0])).toContain("and what about tomorrow?")
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("carries the queued message's images through", async () => {
		const { task, loop } = await makeTask()
		task.messageQueueService.addMessage("look at this", ["data:image/png;base64,AAA"])

		task.startFromHistory()
		await vi.waitFor(() => expect(loop).toHaveBeenCalled())

		const blocks = loop.mock.calls[0]![0] as Array<{ type: string }>
		expect(blocks.some((b) => b.type === "image")).toBe(true)
	})

	it.each([
		["completed", "resume_completed_task"],
		["idle", "resume_task"],
	] as const)(
		"still asks (%s) when nothing is queued — the interactive resume is unchanged",
		async (lifecycle, expected) => {
			const { task, ask } = await makeTask(lifecycle)

			task.startFromHistory()
			await vi.waitFor(() => expect(ask).toHaveBeenCalled())

			expect(ask).toHaveBeenCalledWith(expected)
		},
	)
})
