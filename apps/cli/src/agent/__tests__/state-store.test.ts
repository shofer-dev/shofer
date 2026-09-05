// pnpm --filter @shofer/cli test src/agent/__tests__/state-store.test.ts

import type { ExtensionState, ShoferMessage } from "@shofer/types"

import { StateStore, getDefaultStore, resetDefaultStore } from "../state-store.js"
import { AgentLoopState } from "../agent-state.js"

const message = (overrides: Partial<ShoferMessage>): ShoferMessage =>
	({ ts: 1, type: "say", say: "text", text: "hi", ...overrides }) as unknown as ShoferMessage

describe("StateStore queries", () => {
	it("starts empty and uninitialized", () => {
		const store = new StateStore()
		expect(store.isInitialized()).toBe(false)
		expect(store.getMessages()).toEqual([])
		expect(store.getLastMessage()).toBeUndefined()
		expect(store.getCurrentState()).toBe(AgentLoopState.NO_TASK)
		expect(store.getCurrentMode()).toBeUndefined()
		expect(store.isWaitingForInput()).toBe(false)
		expect(store.isRunning()).toBe(false)
		expect(store.isStreaming()).toBe(false)
		expect(store.getState().messages).toEqual([])
	})

	it("computes agent state from the messages it is given", () => {
		const store = new StateStore()
		const previous = store.setMessages([message({ ts: 1 })])

		expect(previous.state).toBe(AgentLoopState.NO_TASK)
		expect(store.isInitialized()).toBe(true)
		expect(store.getCurrentState()).toBe(AgentLoopState.RUNNING)
		expect(store.isRunning()).toBe(true)
		expect(store.getLastMessage()?.ts).toBe(1)

		store.setMessages([message({ ts: 2, partial: true })])
		expect(store.isStreaming()).toBe(true)

		store.setMessages([message({ ts: 3, type: "ask", ask: "followup", say: undefined, partial: false })])
		expect(store.isWaitingForInput()).toBe(true)
		expect(store.getAgentState().currentAsk).toBe("followup")
	})
})

describe("StateStore updates", () => {
	it("appends a message", () => {
		const store = new StateStore()
		store.setMessages([message({ ts: 1 })])
		store.addMessage(message({ ts: 2, text: "second" }))
		expect(store.getMessages().map((m) => m.ts)).toEqual([1, 2])
	})

	it("replaces a message in place by ts", () => {
		const store = new StateStore()
		store.setMessages([message({ ts: 1, text: "a" }), message({ ts: 2, text: "b" })])
		store.updateMessage(message({ ts: 1, text: "a-updated" }))
		expect(store.getMessages().map((m) => m.text)).toEqual(["a-updated", "b"])
	})

	it("appends when the updated message is unknown", () => {
		const store = new StateStore()
		store.setMessages([message({ ts: 1 })])
		store.updateMessage(message({ ts: 99, text: "new" }))
		expect(store.getMessages().map((m) => m.ts)).toEqual([1, 99])
	})

	it("clears messages but stays initialized and keeps the mode", () => {
		const store = new StateStore()
		store.setCurrentMode("architect")
		store.setMessages([message({ ts: 1 })])
		store.clear()

		expect(store.getMessages()).toEqual([])
		expect(store.isInitialized()).toBe(true)
		expect(store.getCurrentMode()).toBe("architect")
		expect(store.getCurrentState()).toBe(AgentLoopState.NO_TASK)
	})

	it("only writes a mode that actually changed", () => {
		const store = new StateStore()
		const seen: Array<string | undefined> = []
		store.subscribe((state) => seen.push(state.currentMode))

		store.setCurrentMode("code")
		store.setCurrentMode("code")
		store.setCurrentMode(undefined)

		expect(seen).toEqual([undefined, "code", undefined])
	})

	it("resets to a pristine store", () => {
		const store = new StateStore({ maxHistorySize: 4 })
		store.setMessages([message({ ts: 1 })])
		store.setCurrentMode("code")
		store.reset()

		expect(store.isInitialized()).toBe(false)
		expect(store.getMessages()).toEqual([])
		expect(store.getCurrentMode()).toBeUndefined()
		expect(store.getHistory()).toEqual([])
	})

	it("caches extension state, extracting shoferMessages", () => {
		const store = new StateStore()
		store.setExtensionState({
			shoferMessages: [message({ ts: 5 })],
			mode: "ask",
		} as unknown as Partial<ExtensionState>)

		expect(store.getMessages().map((m) => m.ts)).toEqual([5])
		expect(store.getState().extensionState?.mode).toBe("ask")

		store.setExtensionState({ mode: "code" } as unknown as Partial<ExtensionState>)
		expect(store.getState().extensionState?.mode).toBe("code")
		expect(store.getMessages().map((m) => m.ts)).toEqual([5])
	})
})

describe("StateStore subscriptions and history", () => {
	it("notifies both observables and unsubscribes cleanly", () => {
		const store = new StateStore()
		const states: number[] = []
		const agentStates: AgentLoopState[] = []

		const offState = store.subscribe((state) => states.push(state.messages.length))
		const offAgent = store.subscribeToAgentState((state) => agentStates.push(state.state))

		store.setMessages([message({ ts: 1 })])
		offState()
		offAgent()
		store.setMessages([message({ ts: 1 }), message({ ts: 2 })])

		expect(states).toEqual([0, 1])
		expect(agentStates).toEqual([AgentLoopState.NO_TASK, AgentLoopState.RUNNING])
	})

	it("records bounded history when enabled", () => {
		const store = new StateStore({ maxHistorySize: 2 })
		store.setMessages([message({ ts: 1 })])
		store.setMessages([message({ ts: 2 })])
		store.setMessages([message({ ts: 3 })])

		const history = store.getHistory()
		expect(history).toHaveLength(2)
		expect(history[0]?.messages.map((m) => m.ts)).toEqual([1])

		store.clearHistory()
		expect(store.getHistory()).toEqual([])
	})

	it("records no history by default", () => {
		const store = new StateStore()
		store.setMessages([message({ ts: 1 })])
		expect(store.getHistory()).toEqual([])
	})
})

describe("default store singleton", () => {
	afterEach(() => resetDefaultStore())

	it("returns the same instance until reset", () => {
		const first = getDefaultStore()
		expect(getDefaultStore()).toBe(first)

		first.setMessages([message({ ts: 1 })])
		resetDefaultStore()

		const second = getDefaultStore()
		expect(second).not.toBe(first)
		expect(second.getMessages()).toEqual([])
	})

	it("tolerates a reset with no live instance", () => {
		resetDefaultStore()
		expect(() => resetDefaultStore()).not.toThrow()
	})
})
