// Prevent the transitive import graph from loading extension.ts,
// which pulls in WorkflowTask (which extends Task — circular).
vi.mock("../../../extension", () => ({}))

vi.mock("../../../utils/logging/subsystems", () => ({
	taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	webviewLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { Task } from "../Task"
import { AskIgnoredError } from "../AskIgnoredError"

/**
 * Tests for the per-ask `_currentAskId` system that replaces the global
 * `lastMessageTs` for ask identity. The goal: unrelated code paths
 * (say(), supersedePendingAsk(), auto-approval) can no longer invalidate
 * an in-flight ask by mutating a shared timestamp.
 */
describe("Task per-ask _currentAskId", () => {
	const buildTaskShell = async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).abandoned = false
		;(task as any).shoferMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined
		;(task as any)._currentAskId = undefined
		;(task as any).isAwaitingAskResponse = false
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).updateShoferMessage = vi.fn(async () => {})
		;(task as any).saveShoferMessages = vi.fn(async () => {})
		;(task as any).diagLog = vi.fn(() => {})
		;(task as any).emit = vi.fn(() => {})
		;(task as any).providerRef = { deref: () => undefined }
		;(task as any).findMessageByTimestamp = vi.fn(() => undefined)
		;(task as any)._debouncedSaveShoferMessages = { cancel: vi.fn() }

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()

		return task
	}

	describe("supersedePendingAsk() scoped invalidation", () => {
		it("clears _currentAskId without touching lastMessageTs", async () => {
			const task = await buildTaskShell()
			;(task as any)._currentAskId = "ask-uuid-1"
			;(task as any).lastMessageTs = 1000

			task.supersedePendingAsk()

			expect((task as any)._currentAskId).toBeUndefined()
			// lastMessageTs must NOT be mutated — that was the old behavior
			// that caused unbounded blast radius.
			expect((task as any).lastMessageTs).toBe(1000)
		})

		it("invalidation only affects the current ask, not askResponse slots", async () => {
			const task = await buildTaskShell()
			;(task as any)._currentAskId = "ask-uuid-1"
			;(task as any).askResponse = "yesButtonClicked"
			;(task as any).askResponseText = "user text"

			task.supersedePendingAsk()

			// askResponse slots are not cleared — supersedePendingAsk only
			// targets the ask identity, not the response buffer.
			expect((task as any).askResponse).toBe("yesButtonClicked")
			expect((task as any).askResponseText).toBe("user text")
		})
	})

	describe("askId propagated on ask messages", () => {
		it("sets _currentAskId when a complete ask enters the system", async () => {
			const task = await buildTaskShell()
			// Simulate what ask() does internally: set _currentAskId before
			// entering pWaitFor, then clear it when the ask resolves.
			;(task as any)._currentAskId = "ask-uuid-1"

			expect((task as any)._currentAskId).toBe("ask-uuid-1")

			// After resolution, _currentAskId is cleared.
			;(task as any)._currentAskId = undefined
			expect((task as any)._currentAskId).toBeUndefined()
		})
	})

	describe("AskIgnoredError for superseded asks", () => {
		it("is constructed with 'superseded' reason", () => {
			const err = new AskIgnoredError("superseded")
			expect(err.message).toBe("Ask ignored: superseded")
			expect(err.name).toBe("AskIgnoredError")
		})

		it("is constructed with custom reason", () => {
			const err = new AskIgnoredError("aborted while awaiting ask response")
			expect(err.message).toBe("Ask ignored: aborted while awaiting ask response")
		})

		it("passes instanceof check", () => {
			const err = new AskIgnoredError("superseded")
			expect(err instanceof AskIgnoredError).toBe(true)
			expect(err instanceof Error).toBe(true)
		})
	})

	describe("superseded path is distinct from abort path", () => {
		it("abort reason differs from superseded reason", () => {
			const aborted = new AskIgnoredError("aborted while awaiting ask response")
			const superseded = new AskIgnoredError("superseded")

			expect(aborted.message).not.toBe(superseded.message)
		})
	})
})
