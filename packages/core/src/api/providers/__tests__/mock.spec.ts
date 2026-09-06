import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { Anthropic } from "@anthropic-ai/sdk"

/**
 * The `mock` provider is the substrate the functional harness runs on, so its
 * STREAMING CONTRACT is load-bearing: `NativeToolCallParser` consumes
 * `tool_call_partial` (id+name first, argument fragments after) terminated by
 * `tool_call_end`, and the older `tool_call_start`/`tool_call_delta` chunks are
 * read by nothing. A mock that emitted the wrong shape would make every harness
 * scenario fail somewhere far away from here.
 *
 * The module caches its parsed scenario file at module scope, so the tests that
 * exercise `MOCK_RESPONSES_PATH` import it fresh (`vi.resetModules()`).
 */

type Chunk = { type: string; [k: string]: unknown }

async function drain(stream: AsyncIterable<unknown>): Promise<Chunk[]> {
	const out: Chunk[] = []
	for await (const chunk of stream) out.push(chunk as Chunk)
	return out
}

function userMessages(text: string): Anthropic.Messages.MessageParam[] {
	return [{ role: "user", content: text }]
}

/** The tool call reassembled from the partial chunks, as the parser would. */
function reassembleToolCall(chunks: Chunk[]): { name: string; args: string; id: string } | undefined {
	const first = chunks.find((c) => c.type === "tool_call_partial" && c.name)
	if (!first) return undefined
	const args = chunks
		.filter((c) => c.type === "tool_call_partial" && typeof c.arguments === "string")
		.map((c) => c.arguments as string)
		.join("")
	return { name: first.name as string, args, id: first.id as string }
}

const ENV_KEYS = ["MOCK_TOOL_NAME", "MOCK_TOOL_ARGS", "MOCK_RESPONSE", "MOCK_RESPONSES_PATH"] as const

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
	for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k]
		else process.env[k] = savedEnv[k]
	}
	vi.resetModules()
})

async function freshHandler() {
	vi.resetModules()
	const { MockHandler } = await import("../mock.js")
	return new MockHandler({} as never)
}

describe("MockHandler — model metadata", () => {
	it("advertises a zero-priced model so cost accounting stays at zero", async () => {
		const handler = await freshHandler()
		const { id, info } = handler.getModel()

		expect(id).toBe("mock-model")
		expect(info.inputPrice).toBe(0)
		expect(info.outputPrice).toBe(0)
		expect(info.contextWindow).toBe(128_000)
	})

	it("counts no tokens", async () => {
		const handler = await freshHandler()
		expect(await handler.countTokens([])).toBe(0)
	})
})

describe("MockHandler — default scenarios", () => {
	it("wraps a matched built-in response in an attempt_completion tool call", async () => {
		const handler = await freshHandler()
		const chunks = await drain(handler.createMessage("sys", userMessages("what is 2+2?")))

		const call = reassembleToolCall(chunks)
		expect(call!.name).toBe("attempt_completion")
		expect(JSON.parse(call!.args)).toEqual({ result: "4", rating: "well" })
		// The parser needs the terminating end chunk to finalize the call.
		expect(chunks.at(-2)).toMatchObject({ type: "tool_call_end", id: call!.id })
		expect(chunks.at(-1)).toMatchObject({ type: "usage", totalCost: 0 })
	})

	it("prefers the LONGEST matching scenario", async () => {
		const handler = await freshHandler()
		// "42" and "number" both match; "number" is longer, and both answer 42 —
		// so assert on a pair where the answers differ instead.
		const chunks = await drain(handler.createMessage("sys", userMessages("say Hello there")))

		expect(JSON.parse(reassembleToolCall(chunks)!.args).result).toBe("Hello! Mock assistant here.")
	})

	it("falls back to OK when nothing matches", async () => {
		const handler = await freshHandler()
		const chunks = await drain(handler.createMessage("sys", userMessages("zzzz unmatched zzzz")))

		expect(JSON.parse(reassembleToolCall(chunks)!.args).result).toBe("OK")
	})

	it("unwraps the <user_message> envelope Shofer puts around the prompt", async () => {
		const handler = await freshHandler()
		const chunks = await drain(
			handler.createMessage("sys", [
				{ role: "user", content: [{ type: "text", text: "<user_message>\nBANANA\n</user_message>" }] },
			]),
		)

		expect(JSON.parse(reassembleToolCall(chunks)!.args).result).toBe("BANANA")
	})

	it("reads the prompt out of a tool_result when the turn carries no text block", async () => {
		const handler = await freshHandler()
		const chunks = await drain(
			handler.createMessage("sys", [
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-1", content: "SHELL_OK" }],
				},
			]),
		)

		expect(JSON.parse(reassembleToolCall(chunks)!.args).result).toBe("SHELL_OK")
	})

	it("reads a block-array tool_result's text", async () => {
		const handler = await freshHandler()
		const chunks = await drain(
			handler.createMessage("sys", [
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "WRITE_OK" }] },
					],
				},
			]),
		)

		expect(JSON.parse(reassembleToolCall(chunks)!.args).result).toBe("WRITE_OK")
	})

	it("treats a conversation with no user message as an empty prompt", async () => {
		const handler = await freshHandler()
		const chunks = await drain(handler.createMessage("sys", [{ role: "assistant", content: "hi" }]))

		expect(JSON.parse(reassembleToolCall(chunks)!.args).result).toBe("OK")
	})
})

describe("MockHandler — env-var control", () => {
	it("MOCK_TOOL_NAME forces one specific tool call on every turn", async () => {
		process.env.MOCK_TOOL_NAME = "read_file"
		process.env.MOCK_TOOL_ARGS = '{"path":"x.json"}'
		const handler = await freshHandler()

		const first = reassembleToolCall(await drain(handler.createMessage("sys", userMessages("anything"))))
		const second = reassembleToolCall(await drain(handler.createMessage("sys", userMessages("2+2"))))

		expect(first!.name).toBe("read_file")
		expect(JSON.parse(first!.args)).toEqual({ path: "x.json" })
		// "every turn" is the point: even a prompt that matches a scenario.
		expect(second!.name).toBe("read_file")
	})

	it("defaults forced tool arguments to an empty object", async () => {
		process.env.MOCK_TOOL_NAME = "read_project_structure"
		const handler = await freshHandler()

		expect(reassembleToolCall(await drain(handler.createMessage("sys", userMessages("x"))))!.args).toBe("{}")
	})

	it("MOCK_RESPONSE overrides the matched scenario", async () => {
		process.env.MOCK_RESPONSE = "from the env"
		const handler = await freshHandler()
		const chunks = await drain(handler.createMessage("sys", userMessages("2+2")))

		expect(JSON.parse(reassembleToolCall(chunks)!.args).result).toBe("from the env")
	})

	it("completePrompt answers from the env, then from the scenarios, then OK", async () => {
		const handler = await freshHandler()
		expect(await handler.completePrompt("what is 2+2?")).toBe("4")
		expect(await handler.completePrompt("nothing matches")).toBe("OK")

		process.env.MOCK_RESPONSE = "env wins"
		expect(await handler.completePrompt("what is 2+2?")).toBe("env wins")
	})
})

describe("MockHandler — scenario files", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-mock-scenarios-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	async function writeScenarios(contents: unknown | string): Promise<string> {
		const file = path.join(dir, "scenarios.json")
		await fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8")
		return file
	}

	it("replays one turn per createMessage call, pinning the scenario on the first", async () => {
		process.env.MOCK_RESPONSES_PATH = await writeScenarios({
			scenarios: [
				{
					match: "MULTI",
					turns: [
						{
							reasoning: "thinking",
							text: "let me look",
							tool: { name: "read_file", arguments: { path: "a" } },
						},
						{ response: "done" },
					],
				},
			],
		})
		const handler = await freshHandler()

		const first = await drain(handler.createMessage("sys", userMessages("MULTI please")))
		expect(first[0]).toEqual({ type: "reasoning", text: "thinking" })
		expect(first[1]).toEqual({ type: "text", text: "let me look" })
		expect(reassembleToolCall(first)!.name).toBe("read_file")

		// The second prompt carries a tool result rather than the match string;
		// the pinned scenario is what keeps the replay coherent.
		const second = await drain(handler.createMessage("sys", userMessages("a file's contents")))
		expect(JSON.parse(reassembleToolCall(second)!.args).result).toBe("done")

		// Past the end of the turn list it falls through to the response path.
		const third = await drain(handler.createMessage("sys", userMessages("anything")))
		expect(JSON.parse(reassembleToolCall(third)!.args).result).toBe("OK")
	})

	it("emits usage for a text-only turn so the stream still terminates", async () => {
		process.env.MOCK_RESPONSES_PATH = await writeScenarios({
			scenarios: [{ match: "TEXTONLY", turns: [{ text: "just talking" }] }],
		})
		const handler = await freshHandler()

		const chunks = await drain(handler.createMessage("sys", userMessages("TEXTONLY")))

		expect(chunks).toEqual([
			{ type: "text", text: "just talking" },
			{ type: "usage", inputTokens: 100, outputTokens: 10, totalCost: 0 },
		])
	})

	it("accepts pre-serialized tool arguments verbatim", async () => {
		process.env.MOCK_RESPONSES_PATH = await writeScenarios({
			scenarios: [{ match: "RAWARGS", turns: [{ tool: { name: "sed", arguments: '{"path":"a"}' } }] }],
		})
		const handler = await freshHandler()

		const call = reassembleToolCall(await drain(handler.createMessage("sys", userMessages("RAWARGS"))))
		expect(call!.args).toBe('{"path":"a"}')
	})

	it("falls back to the built-in scenarios when the file is malformed JSON", async () => {
		process.env.MOCK_RESPONSES_PATH = await writeScenarios("{ not json")
		const handler = await freshHandler()

		expect(
			JSON.parse(reassembleToolCall(await drain(handler.createMessage("sys", userMessages("2+2"))))!.args).result,
		).toBe("4")
	})

	it("falls back to the built-in scenarios when the file fails the schema", async () => {
		// Fails closed rather than throwing: `scenarios` must be an array of
		// objects each carrying a string `match`.
		process.env.MOCK_RESPONSES_PATH = await writeScenarios({ scenarios: [{ nomatch: 1 }] })
		const handler = await freshHandler()

		expect(
			JSON.parse(reassembleToolCall(await drain(handler.createMessage("sys", userMessages("2+2"))))!.args).result,
		).toBe("4")
	})

	it("falls back to the built-in scenarios when the path does not exist", async () => {
		process.env.MOCK_RESPONSES_PATH = path.join(dir, "absent.json")
		const handler = await freshHandler()

		expect(
			JSON.parse(reassembleToolCall(await drain(handler.createMessage("sys", userMessages("2+2"))))!.args).result,
		).toBe("4")
	})
})
