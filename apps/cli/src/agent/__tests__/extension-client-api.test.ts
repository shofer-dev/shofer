// pnpm --filter @shofer/cli test src/agent/__tests__/extension-client-api.test.ts

import type { ExtensionMessage, ShoferMessage, WebviewMessage } from "@shofer/types"

import { ExtensionClient, createClient, createMockClient } from "../extension-client.js"
import { AgentLoopState } from "../agent-state.js"

/**
 * The transport-agnostic ExtensionClient facade: everything it forwards to the
 * store, and every WebviewMessage it can produce.
 */

const say = (overrides: Partial<ShoferMessage> = {}): ShoferMessage =>
	({ ts: 1, type: "say", say: "text", text: "hi", ...overrides }) as unknown as ShoferMessage

function makeClient(config: { debug?: boolean; maxHistorySize?: number } = {}) {
	const sent: WebviewMessage[] = []
	const client = new ExtensionClient({ sendMessage: (message) => void sent.push(message), ...config })
	return { client, sent }
}

const stateInit = (messages: ShoferMessage[]): ExtensionMessage =>
	({ type: "stateInit", state: { shoferMessages: messages } }) as unknown as ExtensionMessage

describe("ExtensionClient message intake", () => {
	it("accepts an object message and a JSON string", () => {
		const { client } = makeClient()
		client.handleMessage(stateInit([say({ ts: 1 })]))
		client.handleMessage(JSON.stringify({ type: "stateInit", state: { shoferMessages: [say({ ts: 2 })] } }))
		expect(client.getMessages().map((m) => m.ts)).toEqual([2])
	})

	it("drops an unparsable string, logging it only in debug mode", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			const quiet = makeClient()
			quiet.client.handleMessage("{not json")
			expect(log).not.toHaveBeenCalled()

			const loud = makeClient({ debug: true })
			loud.client.handleMessage("{not json")
			expect(log).toHaveBeenCalled()
			expect(loud.client.isInitialized()).toBe(false)
		} finally {
			log.mockRestore()
		}
	})

	it("accepts a batch of mixed messages", () => {
		const { client } = makeClient()
		client.handleMessages([stateInit([say({ ts: 1 })]), JSON.stringify({ type: "theme" }), "{bad"])
		expect(client.getMessages()).toHaveLength(1)
	})
})

describe("ExtensionClient state queries", () => {
	it("projects every store query", () => {
		const { client } = makeClient()
		expect(client.hasActiveTask()).toBe(false)
		expect(client.getCurrentState()).toBe(AgentLoopState.NO_TASK)
		expect(client.getMessages()).toEqual([])
		expect(client.getLastMessage()).toBeUndefined()
		expect(client.getCurrentAsk()).toBeUndefined()
		expect(client.getCurrentMode()).toBeUndefined()
		expect(client.isInitialized()).toBe(false)

		client.handleMessage({
			type: "stateInit",
			state: { mode: "architect", shoferMessages: [say({ ts: 1 }), { ts: 2, type: "ask", ask: "followup" }] },
		} as unknown as ExtensionMessage)

		expect(client.hasActiveTask()).toBe(true)
		expect(client.isInitialized()).toBe(true)
		expect(client.isWaitingForInput()).toBe(true)
		expect(client.isRunning()).toBe(false)
		expect(client.isStreaming()).toBe(false)
		expect(client.getCurrentAsk()).toBe("followup")
		expect(client.getCurrentMode()).toBe("architect")
		expect(client.getLastMessage()?.ts).toBe(2)
		expect(client.getAgentState().state).toBe(AgentLoopState.WAITING_FOR_INPUT)
	})

	it("exposes the store and the emitter for advanced use", () => {
		const { client } = makeClient({ maxHistorySize: 3 })
		client.handleMessage(stateInit([say({ ts: 1 })]))
		expect(client.getStore().getMessages()).toHaveLength(1)
		expect(client.getStateHistory()).toHaveLength(1)
		expect(client.getEmitter().listenerCount("message")).toBe(0)
	})
})

describe("ExtensionClient subscriptions", () => {
	it("supports on/once/off and the convenience subscribers", () => {
		const { client } = makeClient()
		const seen: string[] = []

		const off = client.on("message", () => seen.push("on"))
		client.once("message", () => seen.push("once"))
		client.onStateChange(() => seen.push("state"))
		client.onWaitingForInput(() => seen.push("waiting"))
		client.onModeChanged(() => seen.push("mode"))

		client.handleMessage({
			type: "stateInit",
			state: { mode: "code", shoferMessages: [{ ts: 1, type: "ask", ask: "followup" }] },
		} as unknown as ExtensionMessage)

		expect(seen).toEqual(["mode", "state", "waiting", "on", "once"])

		off()
		client.handleMessage(stateInit([say({ ts: 2 })]))
		expect(seen.filter((entry) => entry === "on")).toHaveLength(1)
	})

	it("removes a single listener and then all of them", () => {
		const { client } = makeClient()
		const listener = () => {}
		client.on("message", listener)
		client.on("stateChange", () => {})
		client.off("message", listener)
		expect(client.getEmitter().listenerCount("message")).toBe(0)

		client.removeAllListeners()
		expect(client.getEmitter().listenerCount("stateChange")).toBe(0)
	})
})

describe("ExtensionClient outbound messages", () => {
	it("sends every ask response shape", () => {
		const { client, sent } = makeClient()
		client.approve()
		client.reject()
		client.respond("an answer", ["img"])
		client.resumeTask()
		client.retryApiRequest()

		expect(sent).toEqual([
			{ type: "askResponse", askResponse: "yesButtonClicked", text: undefined, images: undefined },
			{ type: "askResponse", askResponse: "noButtonClicked", text: undefined, images: undefined },
			{ type: "askResponse", askResponse: "messageResponse", text: "an answer", images: ["img"] },
			{ type: "askResponse", askResponse: "yesButtonClicked", text: undefined, images: undefined },
			{ type: "askResponse", askResponse: "yesButtonClicked", text: undefined, images: undefined },
		])
	})

	it("sends the task control messages", () => {
		const { client, sent } = makeClient()
		client.handleMessage(stateInit([say({ ts: 1 })]))
		client.newTask("do it", ["img"])
		client.cancelTask()
		client.clearTask()

		expect(sent).toEqual([
			{ type: "newTask", text: "do it", images: ["img"] },
			{ type: "cancelTask" },
			{ type: "clearTask" },
		])
		expect(client.getMessages()).toEqual([])
	})

	it("sends the terminal operations", () => {
		const { client, sent } = makeClient()
		client.continueTerminal()
		client.abortTerminal()
		expect(sent).toEqual([
			{ type: "terminalOperation", terminalOperation: "continue" },
			{ type: "terminalOperation", terminalOperation: "abort" },
		])
	})
})

describe("ExtensionClient lifecycle", () => {
	it("resets state and listeners", () => {
		const { client } = makeClient()
		client.on("message", () => {})
		client.handleMessage(stateInit([say({ ts: 1 })]))

		client.reset()
		expect(client.isInitialized()).toBe(false)
		expect(client.getMessages()).toEqual([])
		expect(client.getEmitter().listenerCount("message")).toBe(0)
	})

	it("toggles debug on both itself and the processor", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			const { client } = makeClient()
			client.setDebug(true)
			client.handleMessage("{bad")
			expect(log).toHaveBeenCalled()

			client.setDebug(false)
			log.mockClear()
			client.handleMessage("{bad")
			expect(log).not.toHaveBeenCalled()
		} finally {
			log.mockRestore()
		}
	})
})

describe("ExtensionClient factories", () => {
	it("createClient wires the given sender", () => {
		const sent: WebviewMessage[] = []
		const client = createClient((message) => void sent.push(message))
		client.approve()
		expect(sent).toHaveLength(1)
	})

	it("createMockClient captures and clears sent messages", () => {
		const { client, sentMessages, clearMessages } = createMockClient()
		client.approve()
		client.reject()
		expect(sentMessages).toHaveLength(2)

		clearMessages()
		expect(sentMessages).toHaveLength(0)
	})
})
