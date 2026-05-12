import { Task } from "../Task"

// Regression test: when handleWebviewAskResponse is invoked while no ask() is
// currently awaiting a response, a "messageResponse" carrying user text/images
// must be routed into the message queue so it is not silently dropped by the
// next ask() invocation (which clears askResponse* slots at the top).
//
// This is the bug behind "prompts that should be going to the queue actually
// disappear" — caused by the ChatView webview falling into the bare
// `messageResponse` branch during a brief window where no ask is pending.

describe("Task.handleWebviewAskResponse stray response handling", () => {
	const buildTaskShell = async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).abandoned = false
		;(task as any).shoferMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined
		;(task as any).isAwaitingAskResponse = false
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).updateShoferMessage = vi.fn(async () => {})
		;(task as any).saveShoferMessages = vi.fn(async () => {})
		;(task as any).diagLog = vi.fn(() => {})

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()

		return task
	}

	it("enqueues stray messageResponse text when no ask is awaiting", async () => {
		const task = await buildTaskShell()

		task.handleWebviewAskResponse("messageResponse", "hello queue", ["img.png"])

		// askResponse* must remain unset so a later ask() doesn't see a stale value.
		expect((task as any).askResponse).toBeUndefined()
		expect((task as any).askResponseText).toBeUndefined()
		expect((task as any).askResponseImages).toBeUndefined()

		// Message must land in the queue so the next ask() (or drain) consumes it.
		const queued = (task as any).messageQueueService.messages
		expect(queued).toHaveLength(1)
		expect(queued[0].text).toBe("hello queue")
		expect(queued[0].images).toEqual(["img.png"])
	})

	it("ignores empty stray messageResponse without text or images", async () => {
		const task = await buildTaskShell()

		task.handleWebviewAskResponse("messageResponse", "", [])

		expect((task as any).askResponse).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(true)
	})

	it("ignores stray non-messageResponse askResponses", async () => {
		const task = await buildTaskShell()

		task.handleWebviewAskResponse("yesButtonClicked")
		task.handleWebviewAskResponse("noButtonClicked")
		task.handleWebviewAskResponse("objectResponse", '{"x":1}')

		expect((task as any).askResponse).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(true)
	})

	it("still sets askResponse* slots when an ask is awaiting", async () => {
		const task = await buildTaskShell()
		;(task as any).isAwaitingAskResponse = true

		task.handleWebviewAskResponse("messageResponse", "answer", ["img.png"])

		expect((task as any).askResponse).toBe("messageResponse")
		expect((task as any).askResponseText).toBe("answer")
		expect((task as any).askResponseImages).toEqual(["img.png"])
		expect((task as any).messageQueueService.isEmpty()).toBe(true)
	})
})
