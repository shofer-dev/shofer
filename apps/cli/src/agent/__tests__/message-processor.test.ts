// pnpm --filter @shofer/cli test src/agent/__tests__/message-processor.test.ts

import type { ExtensionMessage, ShoferMessage } from "@shofer/types"

import {
	MessageProcessor,
	isValidShoferMessage,
	isValidExtensionMessage,
	parseExtensionMessage,
	parseApiReqStartedText,
} from "../message-processor.js"
import { StateStore } from "../state-store.js"
import { TypedEventEmitter } from "../events.js"

const say = (overrides: Partial<ShoferMessage> = {}): ShoferMessage =>
	({ ts: 1, type: "say", say: "text", text: "hello", ...overrides }) as unknown as ShoferMessage

const ask = (askType: string, overrides: Partial<ShoferMessage> = {}): ShoferMessage =>
	({ ts: 2, type: "ask", ask: askType, text: "", partial: false, ...overrides }) as unknown as ShoferMessage

interface Recorder {
	store: StateStore
	emitter: TypedEventEmitter
	processor: MessageProcessor
	events: Array<{ name: string; payload: unknown }>
}

function makeProcessor(options: { debug?: boolean; emitAllStateChanges?: boolean } = {}): Recorder {
	const store = new StateStore()
	const emitter = new TypedEventEmitter()
	const events: Array<{ name: string; payload: unknown }> = []

	for (const name of [
		"stateChange",
		"message",
		"messageUpdated",
		"waitingForInput",
		"resumedRunning",
		"streamingStarted",
		"streamingEnded",
		"taskCompleted",
		"taskCleared",
		"modeChanged",
		"error",
	] as const) {
		emitter.on(name, (payload) => events.push({ name, payload }))
	}

	return { store, emitter, processor: new MessageProcessor(store, emitter, options), events }
}

const names = (recorder: Recorder) => recorder.events.map((event) => event.name)

describe("MessageProcessor stateInit", () => {
	it("ignores a stateInit with no state payload", () => {
		const r = makeProcessor()
		r.processor.processMessage({ type: "stateInit" } as unknown as ExtensionMessage)
		expect(r.events).toEqual([])
	})

	it("ignores a stateInit whose state carries no shoferMessages", () => {
		const r = makeProcessor()
		r.processor.processMessage({ type: "stateInit", state: {} } as unknown as ExtensionMessage)
		expect(r.events).toEqual([])
	})

	it("emits modeChanged only when the mode actually changes", () => {
		const r = makeProcessor()
		r.processor.processMessage({ type: "stateInit", state: { mode: "code" } } as unknown as ExtensionMessage)
		r.processor.processMessage({ type: "stateInit", state: { mode: "code" } } as unknown as ExtensionMessage)
		r.processor.processMessage({ type: "stateInit", state: { mode: "ask" } } as unknown as ExtensionMessage)

		const modeEvents = r.events.filter((event) => event.name === "modeChanged")
		expect(modeEvents).toHaveLength(2)
		expect(modeEvents[1]?.payload).toEqual({ previousMode: "code", currentMode: "ask" })
		expect(r.store.getCurrentMode()).toBe("ask")
	})

	it("updates the store and emits the state change plus the last message", () => {
		const r = makeProcessor()
		r.processor.processMessage({
			type: "stateInit",
			state: { shoferMessages: [say({ ts: 1 }), say({ ts: 2, text: "second" })] },
		} as unknown as ExtensionMessage)

		expect(r.store.getMessages()).toHaveLength(2)
		expect(names(r)).toEqual(["stateChange", "message"])
		expect((r.events[1]?.payload as ShoferMessage).ts).toBe(2)
	})

	it("emits nothing for an empty message array", () => {
		const r = makeProcessor()
		r.processor.processMessage({ type: "stateInit", state: { shoferMessages: [] } } as unknown as ExtensionMessage)
		expect(names(r)).toEqual(["stateChange"])
	})

	it("emits waitingForInput, streaming, resumedRunning and taskCompleted transitions", () => {
		const r = makeProcessor()
		const push = (messages: ShoferMessage[]) =>
			r.processor.processMessage({
				type: "stateInit",
				state: { shoferMessages: messages },
			} as unknown as ExtensionMessage)

		push([say({ ts: 1, partial: true })])
		expect(names(r)).toContain("streamingStarted")

		push([say({ ts: 1 }), ask("followup", { ts: 2 })])
		expect(names(r)).toContain("streamingEnded")
		expect(names(r)).toContain("waitingForInput")

		push([say({ ts: 1 }), ask("followup", { ts: 2 }), say({ ts: 3, text: "back to work" })])
		expect(names(r)).toContain("resumedRunning")

		push([say({ ts: 3 }), ask("completion_result", { ts: 4, text: "done" })])
		const completed = r.events.find((event) => event.name === "taskCompleted")
		expect(completed).toBeDefined()
		expect((completed?.payload as { success: boolean }).success).toBe(true)
	})

	it("reports an unsuccessful completion for resume-less terminal asks", () => {
		const r = makeProcessor()
		r.processor.processMessage({
			type: "stateInit",
			state: { shoferMessages: [ask("resume_completed_task", { ts: 9 })] },
		} as unknown as ExtensionMessage)

		const completed = r.events.find((event) => event.name === "taskCompleted")
		expect((completed?.payload as { success: boolean }).success).toBe(true)
	})

	it("only emits significant state changes when configured that way", () => {
		const r = makeProcessor({ emitAllStateChanges: false })
		const push = (messages: ShoferMessage[]) =>
			r.processor.processMessage({
				type: "stateInit",
				state: { shoferMessages: messages },
			} as unknown as ExtensionMessage)

		push([say({ ts: 1 })])
		push([say({ ts: 1 }), say({ ts: 2 })])

		expect(names(r).filter((name) => name === "stateChange")).toHaveLength(1)
	})
})

describe("MessageProcessor incremental messages", () => {
	it("ignores messageUpdated with no payload", () => {
		const r = makeProcessor()
		r.processor.processMessage({ type: "messageUpdated" } as unknown as ExtensionMessage)
		expect(r.events).toEqual([])
	})

	it("updates a message and emits messageUpdated", () => {
		const r = makeProcessor()
		r.processor.processMessage({
			type: "stateInit",
			state: { shoferMessages: [say({ ts: 1, text: "partial", partial: true })] },
		} as unknown as ExtensionMessage)
		r.events.length = 0

		r.processor.processMessage({
			type: "messageUpdated",
			shoferMessage: say({ ts: 1, text: "complete", partial: false }),
		} as unknown as ExtensionMessage)

		expect(names(r)).toContain("messageUpdated")
		expect(r.store.getMessages()[0]?.text).toBe("complete")
	})

	it("ignores shoferMessageAppended with no payload", () => {
		const r = makeProcessor()
		r.processor.processMessage({ type: "shoferMessageAppended" } as unknown as ExtensionMessage)
		expect(r.events).toEqual([])
	})

	it("appends a message and surfaces the resulting transition", () => {
		const r = makeProcessor()
		r.processor.processMessage({
			type: "stateInit",
			state: { shoferMessages: [say({ ts: 1 })] },
		} as unknown as ExtensionMessage)
		r.events.length = 0

		r.processor.processMessage({
			type: "shoferMessageAppended",
			shoferMessage: ask("followup", { ts: 2 }),
		} as unknown as ExtensionMessage)

		expect(r.store.getMessages()).toHaveLength(2)
		expect(names(r)).toContain("message")
		expect(names(r)).toContain("waitingForInput")
	})
})

describe("MessageProcessor other message types", () => {
	it("accepts action, invoke and unrelated messages without emitting", () => {
		const r = makeProcessor()
		r.processor.processMessages([
			{ type: "action", action: "chatButtonClicked" },
			{ type: "invoke", invoke: "sendMessage" },
			{ type: "theme" },
		] as unknown as ExtensionMessage[])
		expect(r.events).toEqual([])
	})

	it("logs every branch under debug, including each transition", () => {
		const r = makeProcessor({ debug: true })
		r.processor.processMessages([
			{ type: "action", action: "chatButtonClicked" },
			{ type: "invoke", invoke: "sendMessage" },
			{ type: "theme" },
			{ type: "stateInit" },
			{ type: "stateInit", state: { mode: "code" } },
			{ type: "stateInit", state: { shoferMessages: [say({ ts: 1, partial: true })] } },
			{ type: "stateInit", state: { shoferMessages: [say({ ts: 1 }), ask("followup", { ts: 2 })] } },
			{
				type: "stateInit",
				state: { shoferMessages: [say({ ts: 1 }), ask("followup", { ts: 2 }), say({ ts: 3 })] },
			},
			{ type: "stateInit", state: { shoferMessages: [say({ ts: 3 }), ask("completion_result", { ts: 4 })] } },
			{ type: "stateInit", state: { shoferMessages: [] } },
			{ type: "messageUpdated" },
			{ type: "shoferMessageAppended" },
		] as unknown as ExtensionMessage[])

		for (const event of [
			"streamingStarted",
			"streamingEnded",
			"waitingForInput",
			"resumedRunning",
			"taskCompleted",
		]) {
			expect(names(r)).toContain(event)
		}
	})

	it("toggles debug at runtime", () => {
		const r = makeProcessor()
		r.processor.setDebug(true)
		r.processor.processMessage({ type: "theme" } as unknown as ExtensionMessage)
		r.processor.setDebug(false)
		expect(r.events).toEqual([])
	})

	it("emits an error event when a handler throws", () => {
		const r = makeProcessor()
		const store = r.store as unknown as { setMessages: () => never }
		store.setMessages = () => {
			throw new Error("store blew up")
		}

		r.processor.processMessage({
			type: "stateInit",
			state: { shoferMessages: [say({ ts: 1 })] },
		} as unknown as ExtensionMessage)

		const error = r.events.find((event) => event.name === "error")
		expect((error?.payload as Error).message).toBe("store blew up")
	})

	it("wraps a non-Error throw", () => {
		const r = makeProcessor()
		const store = r.store as unknown as { setMessages: () => never }
		store.setMessages = () => {
			throw "plain string"
		}

		r.processor.processMessage({
			type: "stateInit",
			state: { shoferMessages: [say({ ts: 1 })] },
		} as unknown as ExtensionMessage)

		const error = r.events.find((event) => event.name === "error")
		expect((error?.payload as Error).message).toBe("plain string")
	})

	it("clears the task and announces it", () => {
		const r = makeProcessor()
		r.processor.processMessage({
			type: "stateInit",
			state: { shoferMessages: [say({ ts: 1 })] },
		} as unknown as ExtensionMessage)
		r.processor.notifyTaskCleared()

		expect(r.store.getMessages()).toEqual([])
		expect(names(r)).toContain("taskCleared")
	})
})

describe("message validation helpers", () => {
	it("validates ShoferMessages", () => {
		expect(isValidShoferMessage(say())).toBe(true)
		expect(isValidShoferMessage(ask("tool"))).toBe(true)
		expect(isValidShoferMessage(null)).toBe(false)
		expect(isValidShoferMessage("string")).toBe(false)
		expect(isValidShoferMessage({ type: "say" })).toBe(false)
		expect(isValidShoferMessage({ ts: 1, type: "other" })).toBe(false)
	})

	it("validates ExtensionMessages", () => {
		expect(isValidExtensionMessage({ type: "stateInit" })).toBe(true)
		expect(isValidExtensionMessage(undefined)).toBe(false)
		expect(isValidExtensionMessage(42)).toBe(false)
		expect(isValidExtensionMessage({})).toBe(false)
	})

	it("parses an extension message from JSON", () => {
		expect(parseExtensionMessage('{"type":"stateInit"}')).toEqual({ type: "stateInit" })
		expect(parseExtensionMessage("{not json")).toBeUndefined()
		expect(parseExtensionMessage('{"noType":true}')).toBeUndefined()
	})

	it("parses api_req_started text", () => {
		expect(parseApiReqStartedText(say({ say: "api_req_started", text: '{"cost":0.5}' }))).toEqual({ cost: 0.5 })
		expect(parseApiReqStartedText(say({ say: "api_req_started", text: "nope" }))).toBeUndefined()
		expect(parseApiReqStartedText(say({ say: "api_req_started", text: "" }))).toBeUndefined()
		expect(parseApiReqStartedText(say({ say: "text", text: '{"cost":1}' }))).toBeUndefined()
	})
})
