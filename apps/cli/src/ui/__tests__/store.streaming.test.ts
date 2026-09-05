// pnpm --filter @shofer/cli test src/ui/__tests__/store.streaming.test.ts

import type { TUIMessage } from "../types.js"
import { useCLIStore } from "../store.js"

/**
 * The store's streaming path: `addMessage` applies a NEW message immediately, a
 * FINAL update immediately, and debounces only the partial updates a streamed
 * turn produces — batching every pending id into a single state change so the Ink
 * tree re-renders once per interval instead of once per chunk. The final message
 * must never be lost behind a queued partial, which is what the `delete` before
 * the immediate apply is for.
 *
 * Also covered here: `updateMessage`, the shallow-equality guards on the four
 * array setters, and `resetForTaskSwitch`'s clear-vs-preserve split.
 */

const message = (id: string, content: string, extra: Partial<TUIMessage> = {}): TUIMessage => ({
	id,
	role: "assistant",
	content,
	...extra,
})

describe("useCLIStore streaming", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		useCLIStore.getState().reset()
	})

	afterEach(() => {
		vi.runOnlyPendingTimers()
		vi.useRealTimers()
	})

	it("appends a new message immediately, partial or not", () => {
		useCLIStore.getState().addMessage(message("m1", "he", { partial: true }))
		expect(useCLIStore.getState().messages).toEqual([message("m1", "he", { partial: true })])
	})

	it("debounces a partial update to an existing message, then flushes it", () => {
		const store = useCLIStore.getState()
		store.addMessage(message("m1", "he", { partial: true }))
		store.addMessage(message("m1", "hello", { partial: true }))

		// Not applied yet — still queued behind the debounce.
		expect(useCLIStore.getState().messages[0]?.content).toBe("he")

		vi.advanceTimersByTime(150)
		expect(useCLIStore.getState().messages[0]).toMatchObject({ content: "hello", partial: true })
	})

	it("coalesces every queued id into ONE flush", () => {
		const store = useCLIStore.getState()
		store.addMessage(message("m1", "a", { partial: true }))
		store.addMessage(message("m2", "b", { partial: true }))
		store.addMessage(message("m1", "aa", { partial: true }))
		store.addMessage(message("m1", "aaa", { partial: true }))
		store.addMessage(message("m2", "bb", { partial: true }))

		vi.advanceTimersByTime(150)

		expect(useCLIStore.getState().messages.map((m) => m.content)).toEqual(["aaa", "bb"])
	})

	it("applies a final update immediately and drops the partial queued for it", () => {
		const store = useCLIStore.getState()
		store.addMessage(message("m1", "he", { partial: true }))
		store.addMessage(message("m1", "hel", { partial: true }))
		store.addMessage(message("m1", "hello", { partial: false }))

		expect(useCLIStore.getState().messages[0]).toMatchObject({ content: "hello", partial: false })

		// The stale partial must not resurrect the truncated text on flush.
		vi.advanceTimersByTime(150)
		expect(useCLIStore.getState().messages[0]?.content).toBe("hello")
	})

	it("drops a queued partial whose message disappeared before the flush", () => {
		const store = useCLIStore.getState()
		store.addMessage(message("m1", "he", { partial: true }))
		store.addMessage(message("m1", "hello", { partial: true }))
		useCLIStore.setState({ messages: [] })

		vi.advanceTimersByTime(150)
		expect(useCLIStore.getState().messages).toEqual([])
	})
})

describe("useCLIStore updateMessage", () => {
	beforeEach(() => {
		useCLIStore.getState().reset()
	})

	it("updates the content of an existing message", () => {
		useCLIStore.getState().addMessage(message("m1", "a"))
		useCLIStore.getState().updateMessage("m1", "b")
		expect(useCLIStore.getState().messages[0]?.content).toBe("b")
	})

	it("keeps the existing partial flag when none is supplied, and overrides it when one is", () => {
		useCLIStore.getState().addMessage(message("m1", "a", { partial: true }))

		useCLIStore.getState().updateMessage("m1", "b")
		expect(useCLIStore.getState().messages[0]?.partial).toBe(true)

		useCLIStore.getState().updateMessage("m1", "c", false)
		expect(useCLIStore.getState().messages[0]?.partial).toBe(false)
	})

	it("is a no-op for an id that is not in the list", () => {
		useCLIStore.getState().addMessage(message("m1", "a"))
		const before = useCLIStore.getState().messages
		useCLIStore.getState().updateMessage("nope", "b")
		expect(useCLIStore.getState().messages).toBe(before)
	})
})

describe("useCLIStore array setters", () => {
	beforeEach(() => {
		useCLIStore.getState().reset()
	})

	it("keeps the identical array rather than publishing a new state", () => {
		const modes = [{ key: "code", slug: "code", name: "Code" }]
		useCLIStore.getState().setAvailableModes(modes)
		const first = useCLIStore.getState().availableModes

		// Same contents, different array object → shallow-equal, so no update.
		useCLIStore.getState().setAvailableModes([...modes])
		expect(useCLIStore.getState().availableModes).toBe(first)

		useCLIStore.getState().setAvailableModes([])
		expect(useCLIStore.getState().availableModes).toEqual([])
	})

	it("publishes when the length differs and when an element differs", () => {
		const a = { key: "a", name: "a", source: "global" as const }
		const b = { key: "b", name: "b", source: "global" as const }

		useCLIStore.getState().setAllSlashCommands([a])
		useCLIStore.getState().setAllSlashCommands([a, b])
		expect(useCLIStore.getState().allSlashCommands).toHaveLength(2)

		useCLIStore.getState().setAllSlashCommands([b, b])
		expect(useCLIStore.getState().allSlashCommands[0]).toBe(b)
	})

	it("guards file search results and task history the same way", () => {
		const files = [{ key: "a.ts", path: "a.ts", type: "file" as const, label: "a.ts" }]
		useCLIStore.getState().setFileSearchResults(files)
		const held = useCLIStore.getState().fileSearchResults
		useCLIStore.getState().setFileSearchResults([...files])
		expect(useCLIStore.getState().fileSearchResults).toBe(held)

		const history = [{ id: "t1", task: "x", ts: 1 }]
		useCLIStore.getState().setTaskHistory(history)
		const heldHistory = useCLIStore.getState().taskHistory
		useCLIStore.getState().setTaskHistory([...history])
		expect(useCLIStore.getState().taskHistory).toBe(heldHistory)
	})
})

describe("useCLIStore resetForTaskSwitch", () => {
	beforeEach(() => {
		useCLIStore.getState().reset()
	})

	it("clears the task's state and preserves the global state", () => {
		const store = useCLIStore.getState()
		store.addMessage(message("m1", "a"))
		store.setPendingAsk({ id: "a1", type: "followup", content: "?" })
		store.setLoading(true)
		store.setComplete(true)
		store.setHasStartedTask(true)
		store.setError("boom")
		store.setIsResumingTask(true)
		store.setTokenUsage({ totalTokensIn: 1, totalTokensOut: 2, totalCost: 3, contextTokens: 4 })
		store.setTodos([{ id: "t", content: "c", status: "pending" }])
		store.setCurrentTaskId("task-1")
		store.setCurrentMode("code")
		store.setTaskHistory([{ id: "t1", task: "x", ts: 1 }])
		store.setAvailableModes([{ key: "code", slug: "code", name: "Code" }])
		store.setRouterModels({ shofer: { m: { contextWindow: 10 } } })
		store.setApiConfiguration({ apiProvider: "openai" })

		useCLIStore.getState().resetForTaskSwitch()

		const after = useCLIStore.getState()
		expect(after.messages).toEqual([])
		expect(after.pendingAsk).toBeNull()
		expect(after.isLoading).toBe(false)
		expect(after.isComplete).toBe(false)
		expect(after.hasStartedTask).toBe(false)
		expect(after.error).toBeNull()
		expect(after.isResumingTask).toBe(false)
		expect(after.tokenUsage).toBeNull()
		expect(after.currentTodos).toEqual([])
		expect(after.previousTodos).toEqual([])

		expect(after.currentTaskId).toBe("task-1")
		expect(after.taskHistory).toHaveLength(1)
		expect(after.availableModes).toHaveLength(1)
		expect(after.currentMode).toBe("code")
		expect(after.routerModels).toEqual({ shofer: { m: { contextWindow: 10 } } })
		expect(after.apiConfiguration).toEqual({ apiProvider: "openai" })
	})
})

describe("useCLIStore setTodos", () => {
	beforeEach(() => {
		useCLIStore.getState().reset()
	})

	it("rotates the current list into previousTodos so a diff can be rendered", () => {
		const first = [{ id: "1", content: "a", status: "pending" as const }]
		const second = [{ id: "1", content: "a", status: "completed" as const }]

		useCLIStore.getState().setTodos(first)
		expect(useCLIStore.getState().previousTodos).toEqual([])

		useCLIStore.getState().setTodos(second)
		expect(useCLIStore.getState().previousTodos).toEqual(first)
		expect(useCLIStore.getState().currentTodos).toEqual(second)
	})
})
