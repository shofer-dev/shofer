// npx vitest src/task/__tests__/conversational-turn.spec.ts

import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { ProviderSettings } from "@shofer/types"
import { setHost, createInMemoryHost, ShoferEventName, type TaskProviderLike } from "@shofer/types"
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
import { formatResponse } from "../../prompts/responses.js"
import { getEnvironmentDetails } from "../../environment/getEnvironmentDetails.js"

/**
 * A text-only assistant reply means two opposite things depending on
 * `toolCallingEnabled`: a mistake to be nudged (the agentic default) or the
 * turn's whole deliverable (a conversational task). These tests pin both, plus
 * the queue-drain that must happen before any terminal state is declared.
 */
describe("conversational turns (toolCallingEnabled === false)", () => {
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

	/** A task whose only API response is a complete, tool-free text reply. */
	const makeTask = (toolCallingEnabled?: boolean) => {
		const task = new Task({
			provider: mockProvider as any,
			apiConfiguration: {
				...baseApiConfig,
				...(toolCallingEnabled === undefined ? {} : { toolCallingEnabled }),
			},
			task: "say hello",
			startTask: false,
		})

		let calls = 0
		vi.spyOn(task, "attemptApiRequest").mockImplementation(async function* () {
			calls++
			if (calls > 1) {
				// The agentic path loops after nudging; stop it deterministically.
				// The loop's own catch turns this into "end the loop".
				throw new Error("second request not expected")
			}
			yield { type: "text", text: "Hello, how can I help?" } as never
		})

		return task
	}

	it("completes the task instead of nudging when a text-only reply arrives", async () => {
		const task = makeTask(false)
		const completed = vi.fn()
		task.on(ShoferEventName.TaskCompleted, completed)
		const nudge = vi.spyOn(formatResponse, "noToolsUsed")

		const didEndLoop = await task.recursivelyMakeShoferRequests([{ type: "text", text: "hi" }], false)

		expect(didEndLoop).toBe(true)
		expect(completed).toHaveBeenCalledTimes(1)
		// Self-declared terminal state: the loop is over and the streamed text
		// was never re-said as a completion_result.
		expect(task.abort).toBe(true)
		expect(nudge).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.consecutiveNoToolUseCount).toBe(0)
		expect(JSON.stringify(task.userMessageContent)).not.toContain("did not use a tool")
	})

	it("drains a queued message and continues instead of completing", async () => {
		const task = makeTask(false)
		const completed = vi.fn()
		task.on(ShoferEventName.TaskCompleted, completed)
		task.messageQueueService.addMessage("and what about tomorrow?")

		await task.recursivelyMakeShoferRequests([{ type: "text", text: "hi" }], false)

		// Terminal-State Queue-Drain Rule: the conversation goes on.
		expect(completed).not.toHaveBeenCalled()
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("skips environment details entirely", async () => {
		const task = makeTask(false)

		await task.recursivelyMakeShoferRequests([{ type: "text", text: "hi" }], false)

		expect(vi.mocked(getEnvironmentDetails)).not.toHaveBeenCalled()
	})

	it("still nudges a text-only reply on the default (agentic) path", async () => {
		const task = makeTask(undefined)
		const completed = vi.fn()
		task.on(ShoferEventName.TaskCompleted, completed)
		const nudge = vi.spyOn(formatResponse, "noToolsUsed")

		await task.recursivelyMakeShoferRequests([{ type: "text", text: "hi" }], false)

		expect(nudge).toHaveBeenCalled()
		expect(completed).not.toHaveBeenCalled()
		expect(vi.mocked(getEnvironmentDetails)).toHaveBeenCalled()
	})

	/**
	 * The follow-up turn of a conversation REHYDRATES the task, and rehydration
	 * aborts the instance that just finished. That abort is teardown, and a
	 * `TaskAborted` announcing it is read by every consumer as the turn's
	 * terminal event — a controller ends the turn on it, the CLI ends the run,
	 * evals score it a failure. So a completed instance is torn down silently,
	 * whichever way it completed.
	 */
	describe("teardown of a completed instance", () => {
		const abortSilently = async (task: Task) => {
			const aborted = vi.fn()
			task.on(ShoferEventName.TaskAborted, aborted)
			vi.spyOn(task, "dispose").mockImplementation(() => {})
			await task.abortTask(true)
			return aborted
		}

		it("emits no TaskAborted after a conversational completion", async () => {
			const task = makeTask(false)
			await task.recursivelyMakeShoferRequests([{ type: "text", text: "hi" }], false)
			expect(task.completedTerminalState).toBe(true)

			expect(await abortSilently(task)).not.toHaveBeenCalled()
		})

		it("emits no TaskAborted after an attempt_completion completion", async () => {
			const task = makeTask(undefined)
			// What the attempt_completion path leaves on the instance.
			task.didExecuteAttemptCompletion = true

			expect(await abortSilently(task)).not.toHaveBeenCalled()
		})

		it("still announces a genuine abandonment", async () => {
			const task = makeTask(undefined)

			const aborted = await abortSilently(task)

			expect(aborted).toHaveBeenCalledWith({ reason: "abandoned" })
		})
	})
})
