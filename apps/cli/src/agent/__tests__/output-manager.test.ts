// pnpm --filter @shofer/cli test src/agent/__tests__/output-manager.test.ts

import type { ShoferMessage } from "@shofer/types"

import { OutputManager } from "../output-manager.js"

/**
 * OutputManager owns every byte the CLI writes in non-JSON mode. These tests
 * drive it through fake write streams so the delta/dedup bookkeeping (which is
 * what actually decides whether a streamed message is duplicated on completion)
 * is observable as plain strings.
 */

interface FakeStream {
	chunks: string[]
	stream: NodeJS.WriteStream
}

function makeStream(): FakeStream {
	const chunks: string[] = []
	const stream = {
		write(text: string) {
			chunks.push(text)
			return true
		},
	} as unknown as NodeJS.WriteStream
	return { chunks, stream }
}

function makeManager(disabled = false) {
	const out = makeStream()
	const err = makeStream()
	const manager = new OutputManager({ disabled, stdout: out.stream, stderr: err.stream })
	return { manager, out, err, text: () => out.chunks.join(""), errText: () => err.chunks.join("") }
}

const say = (overrides: Partial<ShoferMessage>): ShoferMessage =>
	({ ts: 1, type: "say", ...overrides }) as unknown as ShoferMessage

const askMsg = (overrides: Partial<ShoferMessage>): ShoferMessage =>
	({ ts: 1, type: "ask", ...overrides }) as unknown as ShoferMessage

describe("OutputManager plain output", () => {
	it("writes a label alone and a label with text", () => {
		const { manager, text } = makeManager()
		manager.output("[label]")
		manager.output("[label]", "body")
		expect(text()).toBe("[label]\n[label] body\n")
	})

	it("writes errors to stderr", () => {
		const { manager, errText, text } = makeManager()
		manager.outputError("[error]")
		manager.outputError("[error]", "boom")
		expect(errText()).toBe("[error]\n[error] boom\n")
		expect(text()).toBe("")
	})

	it("writes nothing at all when disabled", () => {
		const { manager, text, errText } = makeManager(true)
		manager.output("[label]", "body")
		manager.outputError("[error]", "body")
		manager.writeRaw("raw")
		expect(text()).toBe("")
		expect(errText()).toBe("")
	})

	it("defaults to the process streams", () => {
		const manager = new OutputManager()
		expect(manager.isCurrentlyStreaming()).toBe(false)
	})
})

describe("OutputManager display bookkeeping", () => {
	it("tracks displayed messages and clears them", () => {
		const { manager } = makeManager()
		expect(manager.isAlreadyDisplayed(5)).toBe(false)
		manager.markDisplayed(5, "hi", true)
		expect(manager.isAlreadyDisplayed(5)).toBe(false)
		manager.markDisplayed(5, "hi", false)
		expect(manager.isAlreadyDisplayed(5)).toBe(true)
		manager.clear()
		expect(manager.isAlreadyDisplayed(5)).toBe(false)
	})

	it("tracks first-partial logging per ts", () => {
		const { manager } = makeManager()
		expect(manager.hasLoggedFirstPartial(7)).toBe(false)
		manager.setLoggedFirstPartial(7)
		expect(manager.hasLoggedFirstPartial(7)).toBe(true)
		manager.clearLoggedFirstPartial(7)
		expect(manager.hasLoggedFirstPartial(7)).toBe(false)
	})

	it("publishes streaming state through the observable", () => {
		const { manager } = makeManager()
		const seen: Array<{ ts: number | null; isStreaming: boolean }> = []
		manager.streamingState.subscribe((value) => seen.push(value))

		manager.streamContent(11, "abc", "[assistant]")
		manager.finishStream(11)

		expect(seen.map((s) => s.isStreaming)).toEqual([false, true, false])
		expect(manager.getCurrentlyStreamingTs()).toBeNull()
	})
})

describe("OutputManager streaming deltas", () => {
	it("emits a header then only the delta as content grows", () => {
		const { manager, text } = makeManager()
		manager.streamContent(1, "hel", "[assistant]")
		manager.streamContent(1, "hello", "[assistant]")
		expect(text()).toBe("\n[assistant] hello")
		expect(manager.isCurrentlyStreaming()).toBe(true)
		expect(manager.getCurrentlyStreamingTs()).toBe(1)
	})

	it("ignores a shorter or divergent snapshot", () => {
		const { manager, text } = makeManager()
		manager.streamContent(1, "hello", "[assistant]")
		manager.streamContent(1, "he", "[assistant]")
		manager.streamContent(1, "goodbye!!!", "[assistant]")
		expect(text()).toBe("\n[assistant] hello")
	})

	it("finishStream only closes the ts that is actually streaming", () => {
		const { manager, text } = makeManager()
		manager.streamContent(1, "hi", "[assistant]")
		manager.finishStream(2)
		expect(manager.isCurrentlyStreaming()).toBe(true)
		manager.finishStream(1)
		expect(manager.isCurrentlyStreaming()).toBe(false)
		expect(text()).toBe("\n[assistant] hi\n")
	})
})

describe("OutputManager say:text", () => {
	it("swallows the first user prompt echo", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 1, say: "text", text: "the prompt" }))
		expect(text()).toBe("")
		expect(manager.isAlreadyDisplayed(1)).toBe(true)
	})

	it("streams a partial then appends the remaining delta on completion", () => {
		const { manager, text } = makeManager()
		manager.markDisplayed(0, "prompt", false) // consume the skip-first slot
		manager.outputMessage(say({ ts: 2, say: "text", text: "hel", partial: true }))
		manager.outputMessage(say({ ts: 2, say: "text", text: "hello", partial: false }))
		expect(text()).toBe("\n[assistant] hello\n")
	})

	it("prints a never-streamed complete message whole", () => {
		const { manager, text } = makeManager()
		manager.markDisplayed(0, "prompt", false)
		manager.outputMessage(say({ ts: 3, say: "text", text: "done" }))
		expect(text()).toBe("\n[assistant] done\n")
	})

	it("does not re-print a message already displayed complete", () => {
		const { manager, text } = makeManager()
		manager.markDisplayed(0, "prompt", false)
		manager.outputMessage(say({ ts: 4, say: "text", text: "once" }))
		manager.outputMessage(say({ ts: 4, say: "text", text: "once" }))
		expect(text()).toBe("\n[assistant] once\n")
	})

	it("honours skipFirstUserMessage=false", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 5, say: "text", text: "echoed" }), false)
		expect(text()).toBe("\n[assistant] echoed\n")
	})
})

describe("OutputManager say:reasoning", () => {
	it("streams partial reasoning and finishes it", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 6, say: "reasoning", text: "thin", partial: true }))
		manager.outputMessage(say({ ts: 6, say: "reasoning", text: "thinking", partial: false }))
		expect(text()).toBe("\n[reasoning] thinking\n")
	})

	it("prints complete reasoning that was never streamed", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 7, say: "reasoning", text: "pondered" }))
		expect(text()).toBe("\n[reasoning] pondered\n")
	})

	it("skips reasoning already displayed complete", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 8, say: "reasoning", text: "x" }))
		manager.outputMessage(say({ ts: 8, say: "reasoning", text: "x" }))
		expect(text()).toBe("\n[reasoning] x\n")
	})
})

describe("OutputManager command output", () => {
	it("prints a complete command output block", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 9, say: "command_output", text: "ok" }))
		expect(text()).toBe("\n[command output] ok\n")
	})

	it("streams partial command output and finishes it", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 10, say: "command_output", text: "li", partial: true }))
		manager.outputMessage(say({ ts: 10, say: "command_output", text: "line", partial: false }))
		expect(text()).toBe("\n[command output] line\n")
	})

	it("routes an ask:command_output through the same path", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(askMsg({ ts: 11, ask: "command_output", text: "from ask" }))
		expect(text()).toBe("\n[command output] from ask\n")
	})

	it("ignores every other ask type", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(askMsg({ ts: 12, ask: "followup", text: "question?" }))
		expect(text()).toBe("")
	})
})

describe("OutputManager completion + error", () => {
	it("streams say:completion_result then reports the boundary without repeating text", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 13, say: "completion_result", text: "all", partial: true }))
		manager.outputMessage(say({ ts: 13, say: "completion_result", text: "all done", partial: false }))
		manager.outputCompletionResult(14, "all done")
		expect(text()).toBe("\n[assistant] all done\n\n[task complete]\n")
	})

	it("prints a never-streamed completion result whole", () => {
		const { manager, text } = makeManager()
		manager.outputMessage(say({ ts: 15, say: "completion_result", text: "finished" }))
		expect(text()).toBe("\n[assistant] finished\n")
	})

	it("prints the completion text when nothing was streamed", () => {
		const { manager, text } = makeManager()
		manager.outputCompletionResult(16, "result text")
		expect(text()).toBe("\n[task complete] result text\n")
	})

	it("does not repeat a completion already displayed complete", () => {
		const { manager, text } = makeManager()
		manager.markDisplayed(17, "x", false)
		manager.outputCompletionResult(17, "x")
		expect(text()).toBe("")
	})

	it("writes say:error to stderr exactly once", () => {
		const { manager, errText } = makeManager()
		manager.outputMessage(say({ ts: 18, say: "error", text: "kaboom" }))
		manager.outputMessage(say({ ts: 18, say: "error", text: "kaboom" }))
		expect(errText()).toBe("\n[error] kaboom\n")
	})

	it("falls back to a generic error string", () => {
		const { manager, errText } = makeManager()
		manager.outputMessage(say({ ts: 19, say: "error" }))
		expect(errText()).toBe("\n[error] Unknown error\n")
	})

	it("stays silent for api_req_started and unknown say types", () => {
		const { manager, text, errText } = makeManager()
		manager.outputMessage(say({ ts: 20, say: "api_req_started", text: "{}" }))
		manager.outputMessage(say({ ts: 21, say: "diff_error", text: "nope" }))
		manager.outputMessage(say({ ts: 22, type: "say" }))
		expect(text()).toBe("")
		expect(errText()).toBe("")
	})
})
