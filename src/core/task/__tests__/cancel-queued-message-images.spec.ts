// Prevent the transitive import graph from loading extension.ts,
// which pulls in WorkflowTask (which extends Task — circular).
vi.mock("../../../extension", () => ({}))

vi.mock("../../../utils/logging/subsystems", () => ({
	taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	webviewLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import type { Anthropic } from "@anthropic-ai/sdk"

import { Task } from "../Task"

/**
 * Regression test for the "Send Now" (queued/interrupt) image-drop bug.
 *
 * When a user pastes an image and sends it while the model is busy or has just
 * finished, the message is queued and later drained by
 * `cancelAndProcessQueuedMessages()`. That path showed the image in the chat
 * UI (via `say("user_feedback", …, images)`) but previously rebuilt the LLM
 * payload from `queued.text` only — silently dropping the image so a vision
 * model never saw it. It must append the queued images as image blocks, like
 * every other user-content path (startTask, ask-response, submitUserMessage).
 */
describe("Task.cancelAndProcessQueuedMessages — queued images reach the LLM", () => {
	async function buildTaskStub() {
		const task = Object.create(Task.prototype) as Task
		;(task as any).taskId = "test-task"
		;(task as any).instanceId = "test-instance"
		;(task as any).abort = false
		;(task as any).currentRequestAbortController = undefined
		;(task as any)._taskLoopPromise = undefined
		;(task as any)._taskAbortController = new AbortController()
		;(task as any)._softCancelForQueuedMessage = false
		;(task as any).idleAsk = undefined
		;(task as any).resumableAsk = undefined
		;(task as any).interactiveAsk = undefined

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).diagLog = vi.fn()
		;(task as any).emit = vi.fn()
		;(task as any).say = vi.fn(async () => {})
		;(task as any)._cleanupOrphanedToolUses = vi.fn()
		// providerRef returns undefined → the persist step is skipped.
		;(task as any).providerRef = { deref: () => undefined }
		// Capture the content handed to the task loop; return a resolved promise
		// so the trailing `.catch(...)` in the implementation is well-formed.
		;(task as any)._runTaskLoop = vi.fn(() => Promise.resolve())

		return task
	}

	it("appends image blocks from the queued message to the task-loop content", async () => {
		const task = await buildTaskStub()
		const dataUrl = "data:image/png;base64,iVBORimgDATA"
		;(task as any).messageQueueService.addMessage("what do you see in this pic?", [dataUrl])

		await task.cancelAndProcessQueuedMessages()

		const runTaskLoop = (task as any)._runTaskLoop as ReturnType<typeof vi.fn>
		expect(runTaskLoop).toHaveBeenCalledTimes(1)

		const content = runTaskLoop.mock.calls[0][0] as Anthropic.ContentBlockParam[]
		// Text block carries the wrapped user message.
		expect(content.some((b) => b.type === "text" && (b as any).text.includes("what do you see in this pic?"))).toBe(
			true,
		)
		// The image must be present as an image block (not dropped).
		const imageBlock = content.find((b) => b.type === "image") as Anthropic.ImageBlockParam | undefined
		expect(imageBlock).toBeDefined()
		expect((imageBlock!.source as any).media_type).toBe("image/png")
		expect((imageBlock!.source as any).data).toBe("iVBORimgDATA")

		// The UI say() also received the image (so the chat shows it).
		expect((task as any).say).toHaveBeenCalledWith("user_feedback", "what do you see in this pic?", [dataUrl])
	})
})
