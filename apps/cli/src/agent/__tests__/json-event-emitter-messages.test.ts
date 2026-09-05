// pnpm --filter @shofer/cli test src/agent/__tests__/json-event-emitter-messages.test.ts

import { EventEmitter } from "events"
import { Writable } from "stream"

import type { ShoferAsk, ShoferMessage } from "@shofer/types"

import { JsonEventEmitter } from "../json-event-emitter.js"
import type { ExtensionClient } from "../extension-client.js"
import type { AgentStateChangeEvent, TaskCompletedEvent } from "../events.js"
import { AgentLoopState, type AgentStateInfo } from "../agent-state.js"

/**
 * The message → JSON-event translation, driven through the public seam
 * (`attachToClient` plus the client's own events) rather than the private
 * handlers, so subscription wiring and teardown are covered with the mapping.
 */

function createMockStdout() {
	const chunks: string[] = []
	const stdout = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk.toString())
			callback()
		},
	}) as unknown as NodeJS.WriteStream

	return {
		stdout,
		raw: () => chunks.join(""),
		lines: () =>
			chunks
				.join("")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
	}
}

function createFakeClient() {
	const events = new EventEmitter()
	const client = {
		on: (event: string, listener: (...args: never[]) => void) => {
			events.on(event, listener as (...args: unknown[]) => void)
			return () => void events.off(event, listener as (...args: unknown[]) => void)
		},
	}
	return {
		client: client as unknown as ExtensionClient,
		emit: (event: string, payload: unknown) => void events.emit(event, payload),
		counts: () =>
			["message", "messageUpdated", "stateChange", "taskCompleted", "error"].map((e) => events.listenerCount(e)),
	}
}

const state = (loopState: AgentLoopState): AgentStateInfo => ({
	state: loopState,
	isWaitingForInput: false,
	isRunning: loopState === AgentLoopState.RUNNING,
	isStreaming: false,
	requiredAction: "none",
	description: loopState,
})

const stateChange = (previous: AgentLoopState, current: AgentLoopState): AgentStateChangeEvent => ({
	previousState: state(previous),
	currentState: state(current),
	isSignificantChange: previous !== current,
})

const say = (overrides: Partial<ShoferMessage>): ShoferMessage =>
	({ ts: 1, type: "say", say: "text", text: "", ...overrides }) as unknown as ShoferMessage

const askMsg = (overrides: Partial<ShoferMessage>): ShoferMessage =>
	({ ts: 1, type: "ask", ask: "tool", text: "", ...overrides }) as unknown as ShoferMessage

interface Rig {
	emitter: JsonEventEmitter
	lines: () => Record<string, unknown>[]
	raw: () => string
	message: (msg: ShoferMessage) => void
	updated: (msg: ShoferMessage) => void
	fake: ReturnType<typeof createFakeClient>
}

function attach(options: Partial<ConstructorParameters<typeof JsonEventEmitter>[0]> = {}): Rig {
	const { stdout, lines, raw } = createMockStdout()
	const emitter = new JsonEventEmitter({ mode: "stream-json", stdout, ...options })
	const fake = createFakeClient()
	emitter.attachToClient(fake.client)
	// A fresh task: the next complete say:text is the echoed prompt.
	fake.emit("stateChange", stateChange(AgentLoopState.NO_TASK, AgentLoopState.RUNNING))

	return {
		emitter,
		lines,
		raw,
		fake,
		message: (msg) => fake.emit("message", msg),
		updated: (msg) => fake.emit("messageUpdated", msg),
	}
}

describe("JsonEventEmitter attachment", () => {
	it("announces itself with a system:init carrying the transport contract", () => {
		const rig = attach()
		expect(rig.lines()[0]).toEqual({
			type: "system",
			subtype: "init",
			content: "Task started",
			schemaVersion: 1,
			protocol: "shofer-cli-stream",
			capabilities: ["stdin:start", "stdin:message", "stdin:cancel", "stdin:ping", "stdin:shutdown"],
		})
	})

	it("honours an explicit schema version, protocol and capability list", () => {
		const rig = attach({ schemaVersion: 7, protocol: "custom", capabilities: ["stdin:ask"] })
		expect(rig.lines()[0]).toMatchObject({ schemaVersion: 7, protocol: "custom", capabilities: ["stdin:ask"] })
	})

	it("stamps every event with the ambient request id", () => {
		let requestId: string | undefined = "req-1"
		const rig = attach({ requestIdProvider: () => requestId })
		rig.message(say({ ts: 2, text: "prompt" }))
		requestId = undefined
		rig.message(say({ ts: 3, text: "reply" }))

		const events = rig.lines()
		expect(events[0]).toMatchObject({ requestId: "req-1" })
		expect(events[2]).not.toHaveProperty("requestId")
	})

	it("detaches from every client channel", () => {
		const rig = attach()
		expect(rig.fake.counts()).toEqual([1, 1, 1, 1, 1])
		rig.emitter.detach()
		expect(rig.fake.counts()).toEqual([0, 0, 0, 0, 0])

		rig.message(say({ ts: 9, text: "ignored" }))
		expect(rig.lines()).toHaveLength(1)
	})

	it("relays a client error as an error event", () => {
		const rig = attach()
		rig.fake.emit("error", new Error("stream died"))
		expect(rig.lines()[1]).toMatchObject({ type: "error", content: "stream died" })
	})

	it("defaults to process.stdout when none is given", () => {
		const emitter = new JsonEventEmitter({ mode: "json" })
		expect(emitter.getEvents()).toEqual([])
	})
})

describe("JsonEventEmitter say messages", () => {
	it("labels the first complete say:text as the user prompt echo and the rest as assistant", () => {
		const rig = attach()
		rig.message(say({ ts: 2, text: "the prompt" }))
		rig.message(say({ ts: 3, text: "the reply" }))

		const events = rig.lines()
		expect(events[1]).toMatchObject({ type: "user", id: 2, content: "the prompt", done: true })
		expect(events[2]).toMatchObject({ type: "assistant", id: 3, content: "the reply", done: true })
	})

	it("streams assistant text as deltas and suppresses empty ones", () => {
		const rig = attach()
		rig.message(say({ ts: 2, text: "prompt" }))
		rig.message(say({ ts: 3, text: "he", partial: true }))
		rig.message(say({ ts: 3, text: "hello", partial: true }))
		rig.message(say({ ts: 3, text: "hello", partial: true }))
		rig.message(say({ ts: 3, text: "hello", partial: false }))

		const deltas = rig.lines().filter((event) => event.type === "assistant")
		expect(deltas.map((event) => event.content)).toEqual(["he", "llo", "hello"])
		expect(deltas.at(-1)).toMatchObject({ done: true })
	})

	it("falls back to the whole snapshot when a stream is not append-only", () => {
		const rig = attach()
		rig.message(say({ ts: 2, text: "prompt" }))
		rig.message(say({ ts: 3, text: "abc", partial: true }))
		rig.message(say({ ts: 3, text: "xyz", partial: true }))

		const deltas = rig.lines().filter((event) => event.type === "assistant")
		expect(deltas.map((event) => event.content)).toEqual(["abc", "xyz"])
	})

	it("drops a duplicate complete message", () => {
		const rig = attach()
		rig.message(say({ ts: 2, text: "prompt" }))
		rig.message(say({ ts: 2, text: "prompt" }))
		expect(rig.lines().filter((event) => event.type === "user")).toHaveLength(1)
	})

	it("emits nothing for a partial with no content at all", () => {
		const rig = attach()
		rig.message(say({ ts: 2, text: undefined, partial: true }))
		expect(rig.lines()).toHaveLength(1)
	})

	it("streams reasoning on its own delta track", () => {
		const rig = attach()
		const reason = (text: string, reasoning: string, partial: boolean) =>
			rig.message(say({ ts: 2, say: "reasoning", text, reasoning, partial } as Partial<ShoferMessage>))

		reason("thi", "thi", true)
		reason("thinking", "thinking", true)
		// The outer text delta advances but the reasoning snapshot does not, so the
		// reasoning track emits nothing.
		reason("thinking!", "thinking", true)
		rig.message(say({ ts: 2, say: "reasoning", text: "thinking", partial: false }))

		const thinking = rig.lines().filter((event) => event.type === "thinking")
		expect(thinking.map((event) => event.content)).toEqual(["thi", "nking", "thinking"])
		expect(thinking.at(-1)).toMatchObject({ done: true })
	})

	it("emits say:error as an error event", () => {
		const rig = attach()
		rig.message(say({ ts: 2, say: "error", text: "boom" }))
		expect(rig.lines()[1]).toMatchObject({ type: "error", id: 2, content: "boom" })
	})

	it("emits user feedback as user events and clears the prompt-echo expectation", () => {
		const rig = attach()
		rig.message(say({ ts: 2, say: "user_feedback", text: "more please" }))
		rig.message(say({ ts: 3, say: "user_feedback_diff", text: "diff" }))
		rig.message(say({ ts: 4, text: "assistant now" }))

		const events = rig.lines()
		expect(events[1]).toMatchObject({ type: "user", content: "more please" })
		expect(events[2]).toMatchObject({ type: "user", content: "diff" })
		expect(events[3]).toMatchObject({ type: "assistant", content: "assistant now" })
	})

	it("records api_req_started cost without emitting an event", () => {
		const rig = attach()
		rig.message(
			say({
				ts: 2,
				say: "api_req_started",
				text: JSON.stringify({ cost: 0.25, tokensIn: 10, tokensOut: 5, cacheWrites: 1, cacheReads: 2 }),
			}),
		)
		rig.message(say({ ts: 3, say: "api_req_started", text: "not json" }))
		rig.message(say({ ts: 4, say: "api_req_started", text: JSON.stringify({ tokensIn: 1 }) }))
		rig.message(say({ ts: 5, say: "api_req_started" }))
		expect(rig.lines()).toHaveLength(1)

		rig.fake.emit("taskCompleted", { success: true, stateInfo: state(AgentLoopState.IDLE) } as TaskCompletedEvent)
		expect(rig.lines()[1]).toMatchObject({
			type: "result",
			cost: { totalCost: 0.25, inputTokens: 10, outputTokens: 5, cacheWrites: 1, cacheReads: 2 },
		})
	})

	it("emits an mcp_server_response as a tool result", () => {
		const rig = attach()
		rig.message(say({ ts: 2, say: "mcp_server_response", text: "payload" }))
		expect(rig.lines()[1]).toMatchObject({
			type: "tool_result",
			subtype: "mcp",
			tool_result: { name: "mcp_server", output: "payload" },
		})
	})

	it("skips internal say types and passes unknown ones through as assistant", () => {
		const rig = attach()
		rig.message(say({ ts: 2, say: "api_req_finished", text: "hidden" }))
		rig.message(say({ ts: 3, say: "condense_context", text: "hidden" }))
		rig.message(say({ ts: 4, say: "diff_error" }))
		rig.message(say({ ts: 5, say: "diff_error", text: "visible" }))

		const events = rig.lines()
		expect(events).toHaveLength(2)
		expect(events[1]).toMatchObject({ type: "assistant", subtype: "diff_error", content: "visible" })
	})

	it("routes messageUpdated through the same handler", () => {
		const rig = attach()
		rig.updated(say({ ts: 2, text: "prompt" }))
		expect(rig.lines()[1]).toMatchObject({ type: "user", content: "prompt" })
	})
})

describe("JsonEventEmitter ask messages", () => {
	it("emits a complete tool ask as a tool_use", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, text: JSON.stringify({ tool: "readFile", path: "a.ts" }) }))
		expect(rig.lines()[1]).toMatchObject({
			type: "tool_use",
			id: 2,
			subtype: "tool",
			tool_use: { name: "readFile" },
			done: true,
		})
	})

	it("falls back to unknown_tool for an unparsable payload", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, text: "not json" }))
		expect(rig.lines()[1]).toMatchObject({ tool_use: { name: "unknown_tool", input: { raw: "not json" } } })

		rig.message(askMsg({ ts: 3, text: JSON.stringify({ noTool: true }) }))
		expect(rig.lines()[2]).toMatchObject({ tool_use: { name: "unknown_tool" } })
	})

	it("streams a tool ask as structured deltas, including a mid-string insertion", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, text: '{"tool":"x","p":"ac"}', partial: true }))
		rig.message(askMsg({ ts: 2, text: '{"tool":"x","p":"abc"}', partial: true }))
		rig.message(askMsg({ ts: 2, text: '{"tool":"x","p":"abc"}', partial: true }))
		rig.message(askMsg({ ts: 2, text: '{"different":1}', partial: true }))

		const uses = rig.lines().filter((event) => event.type === "tool_use")
		expect(uses.map((event) => event.content)).toEqual(['{"tool":"x","p":"ac"}', "b", '{"different":1}'])
	})

	it("emits nothing for a streaming tool ask with no payload yet", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, text: "", partial: true }))
		rig.message(askMsg({ ts: 3, ask: "command", text: "", partial: true }))
		rig.message(askMsg({ ts: 4, ask: "use_mcp_server", text: "", partial: true }))
		expect(rig.lines()).toHaveLength(1)
	})

	it("emits a command ask and streams its deltas", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, ask: "command", text: "ls", partial: true }))
		rig.message(askMsg({ ts: 2, ask: "command", text: "ls", partial: true }))
		rig.message(askMsg({ ts: 2, ask: "command", text: "ls -la", partial: false }))

		const uses = rig.lines().filter((event) => event.type === "tool_use")
		expect(uses[0]).toMatchObject({
			subtype: "command",
			tool_use: { name: "execute_command", input: { command: "ls" } },
		})
		expect(uses[1]).toMatchObject({ done: true, tool_use: { input: { command: "ls -la" } } })
	})

	it("emits an mcp ask and streams its deltas", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, ask: "use_mcp_server", text: "{", partial: true }))
		rig.message(askMsg({ ts: 2, ask: "use_mcp_server", text: "{", partial: true }))
		rig.message(askMsg({ ts: 2, ask: "use_mcp_server", text: "{}", partial: false }))

		const uses = rig.lines().filter((event) => event.type === "tool_use")
		expect(uses[0]).toMatchObject({ subtype: "mcp", content: "{", tool_use: { name: "mcp_server" } })
		expect(uses[1]).toMatchObject({ subtype: "mcp", done: true, tool_use: { input: { raw: "{}" } } })
	})

	it("emits a followup ask as assistant text with a subtype", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, ask: "followup", text: "wh", partial: true }))
		rig.message(askMsg({ ts: 2, ask: "followup", text: "wh", partial: true }))
		rig.message(askMsg({ ts: 2, ask: "followup", text: "who?", partial: false }))

		const followups = rig.lines().filter((event) => event.subtype === "followup")
		expect(followups.map((event) => event.content)).toEqual(["wh", "who?"])
	})

	it("ignores ask:command_output and records ask:completion_result silently", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, ask: "command_output", text: "out" }))
		rig.message(askMsg({ ts: 3, ask: "completion_result", text: "the answer" }))
		expect(rig.lines()).toHaveLength(1)

		rig.fake.emit("taskCompleted", { success: true, stateInfo: state(AgentLoopState.IDLE) } as TaskCompletedEvent)
		expect(rig.lines()[1]).toMatchObject({ type: "result", content: "the answer" })
	})

	it("passes an unmapped ask through as assistant text", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 2, ask: "browser_action_launch" as ShoferAsk }))
		expect(rig.lines()).toHaveLength(1)

		rig.message(askMsg({ ts: 3, ask: "browser_action_launch" as ShoferAsk, text: "http://x", partial: true }))
		rig.message(askMsg({ ts: 3, ask: "browser_action_launch" as ShoferAsk, text: "http://x", partial: true }))
		rig.message(askMsg({ ts: 3, ask: "browser_action_launch" as ShoferAsk, text: "http://x", partial: false }))

		const events = rig.lines().filter((event) => event.subtype === "browser_action_launch")
		expect(events.map((event) => event.content)).toEqual(["http://x", "http://x"])
	})
})

describe("JsonEventEmitter command output", () => {
	it("correlates say:command_output with the active command tool use", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 10, ask: "command", text: "ls" }))
		rig.message(say({ ts: 11, say: "command_output", text: "one", partial: true }))
		rig.message(say({ ts: 11, say: "command_output", text: "one", partial: true }))
		rig.message(say({ ts: 11, say: "command_output", text: "one two", partial: false }))

		const results = rig.lines().filter((event) => event.type === "tool_result")
		expect(results.map((event) => (event.tool_result as { output?: string }).output)).toEqual(["one", " two"])
		expect(results.at(-1)).toMatchObject({ id: 10, done: true })
	})

	it("ignores further output for a command id that already closed", () => {
		const rig = attach()
		// No command tool use is active, so the output correlates to its own ts.
		rig.message(say({ ts: 11, say: "command_output", text: "done", partial: false }))
		const before = rig.lines().length
		rig.message(say({ ts: 11, say: "command_output", text: "late", partial: true }))
		expect(rig.lines()).toHaveLength(before)
	})

	it("relays status-driven chunks and closes on the terminal say", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 10, ask: "command", text: "ls" }))
		rig.emitter.emitCommandOutputChunk("partial")
		// Once the status stream owns the output, the say variant is ignored...
		rig.message(say({ ts: 11, say: "command_output", text: "partial", partial: true }))
		rig.emitter.markCommandOutputExited(0)
		// ...until the terminal say arrives, which closes the pending completion.
		rig.message(say({ ts: 11, say: "command_output", text: "partial more", partial: true }))
		rig.message(say({ ts: 11, say: "command_output", text: "partial more", partial: false }))

		const results = rig.lines().filter((event) => event.type === "tool_result")
		expect(results[0]).toMatchObject({ tool_result: { output: "partial" } })
		expect(results.at(-1)).toMatchObject({ done: true, tool_result: { exitCode: 0, output: " more" } })
	})

	it("closes the command explicitly", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 10, ask: "command", text: "ls" }))
		rig.emitter.emitCommandOutputChunk("x")
		rig.emitter.emitCommandOutputDone(2)

		const results = rig.lines().filter((event) => event.type === "tool_result")
		expect(results.at(-1)).toMatchObject({ done: true, tool_result: { exitCode: 2 } })
	})

	it("ignores status relays with no active command", () => {
		const rig = attach()
		rig.emitter.emitCommandOutputChunk("x")
		rig.emitter.markCommandOutputExited(0)
		rig.emitter.emitCommandOutputDone(0)
		expect(rig.lines()).toHaveLength(1)
	})

	it("closes a superseded command when a new one starts", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 10, ask: "command", text: "first" }))
		rig.emitter.markCommandOutputExited(1)
		rig.message(askMsg({ ts: 20, ask: "command", text: "second" }))

		const results = rig.lines().filter((event) => event.type === "tool_result")
		expect(results).toHaveLength(1)
		expect(results[0]).toMatchObject({ id: 10, done: true, tool_result: { exitCode: 1 } })
	})

	it("falls back to closing the command when the terminal say never arrives", async () => {
		vi.useFakeTimers()
		try {
			const rig = attach()
			rig.message(askMsg({ ts: 10, ask: "command", text: "ls" }))
			rig.emitter.markCommandOutputExited(3)
			expect(rig.lines().filter((event) => event.type === "tool_result")).toHaveLength(0)

			vi.advanceTimersByTime(300)
			const results = rig.lines().filter((event) => event.type === "tool_result")
			expect(results).toHaveLength(1)
			expect(results[0]).toMatchObject({ id: 10, done: true, tool_result: { exitCode: 3 } })

			// The fallback is idempotent: a second expiry finds nothing pending.
			vi.advanceTimersByTime(300)
			expect(rig.lines().filter((event) => event.type === "tool_result")).toHaveLength(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("suppresses a status chunk that repeats the previous snapshot", () => {
		const rig = attach()
		rig.message(askMsg({ ts: 10, ask: "command", text: "ls" }))
		rig.emitter.emitCommandOutputChunk("same")
		rig.emitter.emitCommandOutputChunk("same")

		expect(rig.lines().filter((event) => event.type === "tool_result")).toHaveLength(1)
	})

	it("clears the pending exit timer when the command is closed explicitly", () => {
		vi.useFakeTimers()
		try {
			const rig = attach()
			rig.message(askMsg({ ts: 10, ask: "command", text: "ls" }))
			rig.emitter.markCommandOutputExited(0)
			rig.emitter.emitCommandOutputDone(1)
			vi.advanceTimersByTime(1_000)

			const results = rig.lines().filter((event) => event.type === "tool_result")
			expect(results).toHaveLength(1)
			expect(results[0]).toMatchObject({ done: true, tool_result: { exitCode: 1 } })
		} finally {
			vi.useRealTimers()
		}
	})

	it("uses the message's own ts when no command tool use is active", () => {
		const rig = attach()
		rig.message(say({ ts: 11, say: "command_output", text: "orphan", partial: false }))
		expect(rig.lines()[1]).toMatchObject({ type: "tool_result", id: 11, done: true })
	})
})

describe("JsonEventEmitter results", () => {
	it("prefers the completion payload, then the tracked completion, then the last assistant text", () => {
		const rig = attach()
		const complete = (event: Partial<TaskCompletedEvent>) =>
			rig.fake.emit("taskCompleted", { success: true, stateInfo: state(AgentLoopState.IDLE), ...event })

		rig.message(say({ ts: 2, text: "prompt" }))
		rig.message(say({ ts: 3, text: "assistant said this" }))
		complete({})
		expect(rig.lines().at(-1)).toMatchObject({ type: "result", content: "assistant said this", success: true })

		// The fallbacks are cleared after each result, so a bare completion carries none.
		complete({})
		expect(rig.lines().at(-1)).toMatchObject({ type: "result" })
		expect(rig.lines().at(-1)).not.toHaveProperty("content")

		rig.message(say({ ts: 4, say: "completion_result", text: "tracked" }))
		complete({})
		expect(rig.lines().at(-1)).toMatchObject({ content: "tracked" })

		complete({ message: say({ ts: 5, text: "explicit" }) })
		expect(rig.lines().at(-1)).toMatchObject({ id: 5, content: "explicit" })
	})

	it("does not track a partial completion_result", () => {
		const rig = attach()
		rig.message(say({ ts: 2, say: "completion_result", text: "half", partial: true }))
		rig.fake.emit("taskCompleted", { success: false, stateInfo: state(AgentLoopState.IDLE) } as TaskCompletedEvent)
		expect(rig.lines().at(-1)).toMatchObject({ success: false })
		expect(rig.lines().at(-1)).not.toHaveProperty("content")
	})
})

describe("JsonEventEmitter json mode", () => {
	it("accumulates complete messages and writes one final object", () => {
		const { stdout, raw } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "json", stdout })
		const fake = createFakeClient()
		emitter.attachToClient(fake.client)

		fake.emit("message", say({ ts: 2, text: "half", partial: true }))
		fake.emit("message", say({ ts: 2, text: "prompt" }))
		fake.emit("message", say({ ts: 3, text: "reply" }))
		fake.emit("message", say({ ts: 4, say: "command_output", text: "out" }))
		expect(raw()).toBe("")

		fake.emit("taskCompleted", { success: true, stateInfo: state(AgentLoopState.IDLE) })

		const output = JSON.parse(raw()) as { type: string; success: boolean; content?: string; events: unknown[] }
		expect(output.type).toBe("result")
		expect(output.success).toBe(true)
		expect(output.content).toBe("reply")
		expect(output.events.every((event) => (event as { type: string }).type !== "result")).toBe(true)
	})

	it("emits a full command output snapshot rather than a delta", () => {
		const { stdout } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "json", stdout })
		const fake = createFakeClient()
		emitter.attachToClient(fake.client)

		fake.emit("message", askMsg({ ts: 10, ask: "command", text: "ls" }))
		fake.emit("message", say({ ts: 11, say: "command_output", text: "all of it" }))

		const results = emitter.getEvents().filter((event) => event.type === "tool_result")
		expect(results[0]).toMatchObject({
			id: 10,
			done: true,
			tool_result: { name: "execute_command", output: "all of it" },
		})
	})
})

describe("JsonEventEmitter queue events", () => {
	it("emits a queue snapshot with its depth and rows", () => {
		const rig = attach()
		rig.emitter.emitQueue({
			subtype: "snapshot",
			taskId: "task-1",
			content: "queue snapshot (1 item)",
			queueDepth: 1,
			queue: [{ id: "q1", text: "queued", imageCount: 0, timestamp: 5 }],
		})

		expect(rig.lines()[1]).toEqual({
			type: "queue",
			subtype: "snapshot",
			taskId: "task-1",
			content: "queue snapshot (1 item)",
			queueDepth: 1,
			queue: [{ id: "q1", text: "queued", imageCount: 0, timestamp: 5 }],
		})
	})

	it("emits a drained queue with no task id", () => {
		const rig = attach()
		rig.emitter.emitQueue({ subtype: "drained", queueDepth: 0, queue: [] })
		expect(rig.lines()[1]).toMatchObject({ type: "queue", subtype: "drained", queueDepth: 0, queue: [] })
	})
})

describe("JsonEventEmitter bookkeeping", () => {
	it("flushes pending writes", async () => {
		const rig = attach()
		rig.message(say({ ts: 2, text: "prompt" }))
		await expect(rig.emitter.flush()).resolves.toBeUndefined()
	})

	it("returns a copy of its events", () => {
		const rig = attach()
		const events = rig.emitter.getEvents()
		events.length = 0
		expect(rig.emitter.getEvents()).toHaveLength(1)
	})

	it("clear() resets every tracker, including a pending command timer", () => {
		const rig = attach()
		rig.message(say({ ts: 2, text: "prompt" }))
		rig.message(askMsg({ ts: 10, ask: "command", text: "ls" }))
		rig.emitter.markCommandOutputExited(0)

		rig.emitter.clear()
		expect(rig.emitter.getEvents()).toEqual([])

		// The prompt-echo expectation is restored, and the command id is forgotten.
		rig.message(say({ ts: 3, text: "next prompt" }))
		expect(rig.emitter.getEvents()[0]).toMatchObject({ type: "user" })
		rig.emitter.emitCommandOutputChunk("ignored")
		expect(rig.emitter.getEvents()).toHaveLength(1)
	})

	it("only resets the prompt-echo expectation when a task actually starts", () => {
		const rig = attach()
		rig.message(say({ ts: 2, text: "prompt" }))
		rig.fake.emit("stateChange", stateChange(AgentLoopState.RUNNING, AgentLoopState.IDLE))
		rig.message(say({ ts: 3, text: "still assistant" }))
		expect(rig.lines().at(-1)).toMatchObject({ type: "assistant" })

		rig.fake.emit("stateChange", stateChange(AgentLoopState.NO_TASK, AgentLoopState.RUNNING))
		rig.message(say({ ts: 4, text: "new prompt" }))
		expect(rig.lines().at(-1)).toMatchObject({ type: "user" })
	})
})
