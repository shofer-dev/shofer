// npx vitest src/task/__tests__/api-req-finished-emission.spec.ts

import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { ProviderSettings } from "@shofer/types"
import { setHost, createInMemoryHost, type TaskProviderLike } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

// Same intra-core stubs as the other Task specs: the barrel mock cannot
// intercept Task's own relative imports, so the concrete modules are stubbed.
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

vi.mock("../../environment/getEnvironmentDetails.js", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue("<environment_details>mock</environment_details>"),
}))

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
 * The `api_req_finished` span is the ONLY account of a request's end and of the
 * built-in tools it ran, so "was it written" is not a detail — it is whether the
 * request exists in the record at all.
 *
 * The case these tests exist for is the one that was silently losing it: the
 * TERMINAL request of every turn. `attempt_completion` declares the agent's own
 * terminal state by setting `task.abort = true` as its last act (the
 * Self-Declared Terminal State Rule), and `Task.say()` refuses to append to an
 * aborted task — so the emit point, which is deliberately downstream of tool
 * execution, threw and the span was never written. Every conversation's last
 * request read as "started, never finished", with its built-in tool calls gone.
 */
describe("api_req_finished emission", () => {
	let mockProvider: TaskProviderLike

	const baseApiConfig: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	beforeEach(() => {
		vi.clearAllMocks()
		setHost(createInMemoryHost())
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }

		mockProvider = {
			context: { globalStorageUri: storageUri },
			getState: vi.fn().mockResolvedValue({ autoApprovalEnabled: true }),
			log: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postTaskStateUpdate: vi.fn(),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as TaskProviderLike
	})

	/** A task with one in-flight request that has already run a tool. */
	const makeTaskWithPendingRequest = () => {
		const task = new Task({
			provider: mockProvider as any,
			apiConfiguration: baseApiConfig,
			task: "do the thing",
			startTask: false,
		})

		task._pendingApiReqNeedsEmit = true
		task._pendingRequestStartOffset = 100
		task._pendingTtfbMs = 40
		task._pendingGenStartMs = 300
		task._pendingToolSpans = [
			{
				toolName: "read_file",
				startedAtOffsetMs: 500,
				finishedAtOffsetMs: 640,
				isError: false,
			} as never,
		]

		return task
	}

	/** Every `api_req_finished` message on the transcript, decoded. */
	const finishedSpans = (task: Task) =>
		task.shoferMessages
			.filter((m) => m.type === "say" && m.say === "api_req_finished")
			.map((m) => JSON.parse(m.text || "{}"))

	const emit = (task: Task, ...args: unknown[]) =>
		(task as unknown as { emitApiReqFinished: (...a: unknown[]) => Promise<void> }).emitApiReqFinished(...args)

	it("writes the span for a request that ended normally", async () => {
		const task = makeTaskWithPendingRequest()

		await emit(task, "completed")

		const spans = finishedSpans(task)
		expect(spans).toHaveLength(1)
		expect(spans[0].status).toBe("completed")
		expect(spans[0].toolSpans).toHaveLength(1)
		expect(task._pendingApiReqNeedsEmit).toBe(false)
	})

	it("writes the span even after attempt_completion declared the terminal state", async () => {
		// The regression this whole file exists for. `attempt_completion` sets
		// `abort` and only THEN does the loop reach the emit point, so a span
		// written through the ordinary say path is lost — silently, and for the
		// last request of every single conversation.
		const task = makeTaskWithPendingRequest()
		task.abort = true

		await emit(task, "completed")

		const spans = finishedSpans(task)
		expect(spans).toHaveLength(1)
		expect(spans[0].status).toBe("completed")
		// And the tools it ran ride with it — partial spans are precisely what
		// the timeline is missing when the span is lost.
		expect(spans[0].toolSpans.map((s: { toolName: string }) => s.toolName)).toEqual(["read_file"])
	})

	it("carries the partial tool spans when a cancelled request is flushed on abort", async () => {
		const task = makeTaskWithPendingRequest()
		task.abort = true

		await emit(task, "cancelled", "user_cancelled")

		const spans = finishedSpans(task)
		expect(spans).toHaveLength(1)
		expect(spans[0].status).toBe("cancelled")
		expect(spans[0].cancelReason).toBe("user_cancelled")
		expect(spans[0].toolSpans).toHaveLength(1)
	})

	it("emits exactly once however many stream-end paths fire", async () => {
		// response_metadata, then the background usage drain, then abortTask's
		// flush: three arrivals, one span.
		const task = makeTaskWithPendingRequest()

		await emit(task, "completed")
		await emit(task, "cancelled", "user_cancelled")
		task.abort = true
		await emit(task, "completed")

		const spans = finishedSpans(task)
		expect(spans).toHaveLength(1)
		expect(spans[0].status).toBe("completed")
	})

	it("keeps the origin invariant: ts - finishedAtOffsetMs is the task's timeline origin", async () => {
		// The console derives the task's timeline origin from every finished
		// message this way, so a span written on the abort path must satisfy it
		// exactly as one written on the normal path does.
		const task = makeTaskWithPendingRequest()
		task.abort = true

		await emit(task, "completed")

		const message = task.shoferMessages.find((m) => m.type === "say" && m.say === "api_req_finished")!
		const payload = JSON.parse(message.text || "{}")
		expect(typeof payload.finishedAtOffsetMs).toBe("number")
		expect(payload.finishedAtOffsetMs).toBeGreaterThanOrEqual(0)
		expect(payload.startedAtOffsetMs).toBe(100)
	})

	it("still refuses ordinary agent output on an aborted task", async () => {
		// The opt-out is for the RECORD of finished work, not a way to keep a
		// terminated task talking.
		const task = makeTaskWithPendingRequest()
		task.abort = true

		await expect(task.say("text", "more output after the end")).rejects.toThrow(/aborted/)
	})

	it("releases its claim when the write fails, so a later path can still try", async () => {
		const task = makeTaskWithPendingRequest()
		const saySpy = vi.spyOn(task, "say").mockRejectedValueOnce(new Error("store unavailable"))

		await expect(emit(task, "completed")).rejects.toThrow("store unavailable")
		expect(task._pendingApiReqNeedsEmit).toBe(true)

		saySpy.mockRestore()
		await emit(task, "completed")
		expect(finishedSpans(task)).toHaveLength(1)
	})
})
