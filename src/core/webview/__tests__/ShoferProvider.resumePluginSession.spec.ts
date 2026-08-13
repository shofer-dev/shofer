// npx vitest run core/webview/__tests__/ShoferProvider.resumePluginSession.spec.ts

import { ShoferProvider } from "../ShoferProvider"

/**
 * Pins the DETERMINISTIC ordering of the cold-session path in
 * `resumePluginSession`: rehydrate dormant (`startTask: false`), apply the
 * mode's provider profile, queue the prompt, THEN `startFromHistory()`.
 *
 * The ordering is load-bearing, not stylistic: `resumeTaskFromHistory` takes a
 * queued message AS the resumption and raises no resume ask, but only if the
 * queue is populated before the resume runs. The previous shape (default
 * fire-and-forget start, queue after, answer a raced `resumableAsk` as a
 * fallback) was correct only when it happened to win the race — when it lost,
 * the resume ask was published and dispatched (a headless node's ask handler
 * spends the `--retry` budget declining it) before the drain answered it.
 *
 * The tests bypass the ShoferProvider constructor (`Object.create`) because
 * the method under test touches only the collaborators stubbed here; the
 * Task-side half of the contract (queued message ⇒ no ask) is pinned by
 * `packages/core/src/task/__tests__/resume-with-queued-message.spec.ts`.
 */
describe("ShoferProvider.resumePluginSession", () => {
	type AnyProvider = {
		shoferStack: unknown[]
		getTaskWithId: ReturnType<typeof vi.fn>
		createTaskWithHistoryItem: ReturnType<typeof vi.fn>
		applyModeApiConfig: ReturnType<typeof vi.fn>
		resumePluginSession: (sessionId: string, prompt: string, mode?: string) => Promise<unknown>
	}

	function makeProvider(): { provider: AnyProvider; task: Record<string, ReturnType<typeof vi.fn> | object> } {
		const addMessage = vi.fn()
		const startFromHistory = vi.fn()
		const submitUserMessage = vi.fn()
		const task = {
			messageQueueService: { addMessage },
			startFromHistory,
			submitUserMessage,
		}
		const provider = Object.create(ShoferProvider.prototype) as AnyProvider
		provider.shoferStack = []
		provider.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: { id: "session-1" } })
		provider.createTaskWithHistoryItem = vi.fn().mockResolvedValue(task)
		provider.applyModeApiConfig = vi.fn().mockResolvedValue(undefined)
		return { provider, task: { ...task, addMessage, startFromHistory, submitUserMessage } }
	}

	it("cold session: rehydrates dormant, queues, then starts — never a direct submit", async () => {
		const { provider, task } = makeProvider()

		const result = await provider.resumePluginSession("session-1", "fix the answer", "stake")

		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith({ id: "session-1" }, { startTask: false })
		const addMessage = task.addMessage as ReturnType<typeof vi.fn>
		const startFromHistory = task.startFromHistory as ReturnType<typeof vi.fn>
		expect(addMessage).toHaveBeenCalledWith("fix the answer")
		// The whole point: the queue is populated BEFORE the resume runs.
		expect(addMessage.mock.invocationCallOrder[0]).toBeLessThan(startFromHistory.mock.invocationCallOrder[0])
		// The mode profile lands while the task is still dormant, before any
		// request can run on the wrong model.
		const applyOrder = provider.applyModeApiConfig.mock.invocationCallOrder[0]
		expect(applyOrder).toBeLessThan(startFromHistory.mock.invocationCallOrder[0])
		// No second delivery path: with the ordering deterministic there is no
		// raced ask left to answer directly.
		expect(task.submitUserMessage).not.toHaveBeenCalled()
		expect(result).toBeDefined()
	})

	it("warm session: queues onto the live task and never rehydrates", async () => {
		const { provider } = makeProvider()
		const addMessage = vi.fn()
		provider.shoferStack = [
			{ taskId: "session-1", abort: false, abandoned: false, messageQueueService: { addMessage } },
		]

		await provider.resumePluginSession("session-1", "next step")

		expect(addMessage).toHaveBeenCalledWith("next step")
		expect(provider.getTaskWithId).not.toHaveBeenCalled()
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("finished-but-stacked session: abort=true means cold, not warm", async () => {
		const { provider, task } = makeProvider()
		const staleAdd = vi.fn()
		provider.shoferStack = [
			{ taskId: "session-1", abort: true, abandoned: false, messageQueueService: { addMessage: staleAdd } },
		]

		await provider.resumePluginSession("session-1", "re-ask")

		// The finished instance must NOT receive a message nothing will drain.
		expect(staleAdd).not.toHaveBeenCalled()
		expect(provider.createTaskWithHistoryItem).toHaveBeenCalledWith({ id: "session-1" }, { startTask: false })
		expect(task.startFromHistory).toHaveBeenCalled()
	})

	it("unknown session: throws rather than silently starting fresh", async () => {
		const { provider } = makeProvider()
		provider.getTaskWithId = vi.fn().mockRejectedValue(new Error("no task"))

		await expect(provider.resumePluginSession("missing", "hello")).rejects.toThrow()
		expect(provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})
})
