/**
 * ForkLlmClient stream handling — the seams that broke the Phase-0 live run.
 *
 * OpenAI-compatible providers stream a tool call as `tool_call_partial`
 * fragments keyed by `index` (id/name on the first fragment only, arguments as
 * append-fragments); `tool_call_delta` carries its fragment in `delta`. Both
 * were previously mis-read, so every detector feedback call arrived with empty
 * arguments and coerced to silent. And the handler must resolve PER CALL: an
 * empty profileRef means the host's *current* default profile.
 */

import { ForkLlmClient, type StreamChunk } from "../src/llm.js"

/** A PluginAi stub whose handler yields the scripted chunks. */
function aiWithChunks(chunks: StreamChunk[], buildSpy?: (ref?: string) => void) {
	return {
		buildHandler: vi.fn(async (ref?: string) => {
			buildSpy?.(ref)
			return {
				async *createMessage() {
					for (const c of chunks) yield c
				},
			}
		}),
	}
}

const chatOpts = { systemPrompt: "s", messages: [], tools: [] }

describe("ForkLlmClient tool-call streaming", () => {
	it("assembles index-keyed tool_call_partial fragments into one call", async () => {
		// The exact shape observed live: id+name ride the first fragment, the
		// arguments arrive in later fragments that carry ONLY index+arguments.
		const client = new ForkLlmClient(
			aiWithChunks([
				{ type: "tool_call_partial", index: 0, id: "call_1", name: "second_brain_detector_feedback", arguments: "" },
				{ type: "tool_call_partial", index: 0, arguments: '{"advice":"check ' },
				{ type: "tool_call_partial", index: 0, arguments: 'the path"' },
				{ type: "tool_call_partial", index: 0, arguments: ",\"confidence\":0.95}" },
				{ type: "usage", inputTokens: 10, outputTokens: 5 },
			]) as never,
		)

		const res = await client.chat(chatOpts)
		expect(res.toolCalls).toHaveLength(1)
		expect(res.toolCalls[0].id).toBe("call_1")
		expect(res.toolCalls[0].name).toBe("second_brain_detector_feedback")
		expect(JSON.parse(res.toolCalls[0].arguments)).toEqual({ advice: "check the path", confidence: 0.95 })
	})

	it("keeps concurrent partial calls separate by index", async () => {
		const client = new ForkLlmClient(
			aiWithChunks([
				{ type: "tool_call_partial", index: 0, id: "a", name: "one", arguments: '{"x":' },
				{ type: "tool_call_partial", index: 1, id: "b", name: "two", arguments: '{"y":' },
				{ type: "tool_call_partial", index: 0, arguments: "1}" },
				{ type: "tool_call_partial", index: 1, arguments: "2}" },
			]) as never,
		)

		const res = await client.chat(chatOpts)
		const byName = Object.fromEntries(res.toolCalls.map((c) => [c.name, c.arguments]))
		expect(byName).toEqual({ one: '{"x":1}', two: '{"y":2}' })
	})

	it("reads tool_call_delta fragments from `delta`", async () => {
		const client = new ForkLlmClient(
			aiWithChunks([
				{ type: "tool_call_start", id: "c1", name: "feedback" },
				{ type: "tool_call_delta", id: "c1", delta: '{"a":' },
				{ type: "tool_call_delta", id: "c1", delta: "true}" },
				{ type: "tool_call_end", id: "c1" },
			]) as never,
		)

		const res = await client.chat(chatOpts)
		expect(res.toolCalls).toHaveLength(1)
		expect(res.toolCalls[0].arguments).toBe('{"a":true}')
	})

	it("resolves the handler on every chat, never pinning the first build", async () => {
		const built: Array<string | undefined> = []
		const client = new ForkLlmClient(aiWithChunks([{ type: "text", text: "ok" }], (ref) => built.push(ref)) as never)

		await client.chat(chatOpts)
		await client.chat(chatOpts)
		expect(built).toHaveLength(2)
	})
})
