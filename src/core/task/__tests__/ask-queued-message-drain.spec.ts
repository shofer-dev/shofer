import { Task } from "../Task"

/**
 * Verifies the queued-message drain behaviour in Task.ask():
 *
 *  - "drainable" ask types (tool, command, use_mcp_server, …) consume a
 *    queued message that arrives while pWaitFor is polling and return
 *    immediately with yesButtonClicked + the queued text.
 *
 *  - "non-drainable" ask types (followup, resume_task, resume_completed_task)
 *    intentionally leave queued messages intact. Followup questions require
 *    explicit user input, not a silently-drained pre-typed message. A
 *    separate handleWebviewAskResponse call is needed to unblock the ask.
 *
 *  Note: command_output is auto-approved (isAutoApprovableAsk = true), so
 *  task.ask("command_output") returns synchronously before pWaitFor; it is
 *  no longer an interesting drain test case.
 */
describe("Task.ask queued message drain", () => {
	/** Build a minimal Task stub that satisfies the stubs called by ask(). */
	async function buildTaskStub() {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).shoferMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined
		;(task as any).isAwaitingAskResponse = false

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToShoferMessages = vi.fn(async () => {})
		;(task as any).saveShoferMessages = vi.fn(async () => {})
		;(task as any).updateShoferMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		// providerRef returns undefined → state = undefined → auto-approval disabled
		;(task as any).providerRef = { deref: () => undefined }

		return task
	}

	it("drains queued message into a tool-approval ask", async () => {
		const task = await buildTaskStub()

		const askPromise = task.ask("tool", "read_file", false)

		// Enqueue the message via setTimeout so it arrives AFTER pWaitFor has
		// started polling (with isAwaitingAskResponse = true). Adding it
		// synchronously before the await would trigger the pre-pWaitFor drain
		// path which calls handleWebviewAskResponse while isAwaitingAskResponse
		// is still false — causing yesButtonClicked to be silently dropped.
		setTimeout(() => {
			;(task as any).messageQueueService.addMessage("picked answer")
		}, 0)

		const result = await askPromise

		// Tool asks fulfill with yesButtonClicked when a queued message is drained.
		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBe("picked answer")
		// Queue should be empty — message was consumed.
		expect((task as any).messageQueueService.isEmpty()).toBe(true)
	})

	it("does not drain queued messages for followup asks — message stays for next ask", async () => {
		const task = await buildTaskStub()

		const askPromise = task.ask("followup", "Can you clarify?", false)

		// Add a queued message synchronously. Because followup is excluded from
		// shouldDrainQueuedMessageForAsk, this message must NOT be consumed as
		// the implicit answer.
		;(task as any).messageQueueService.addMessage("I meant X")

		// Explicitly resolve the followup via the webview response path.
		setTimeout(() => {
			task.handleWebviewAskResponse("messageResponse", "explicit answer")
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("explicit answer")

		// The pre-queued message must remain — it was not silently consumed.
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		expect((task as any).messageQueueService.messages[0]?.text).toBe("I meant X")
	})
})
