import { describe, it, expect } from "vitest"

import { normalizeReasoningStream } from "../shofer.js"

/** Build an async-iterable stream from a fixed list of chunks. */
async function* streamOf(chunks: unknown[]) {
	for (const c of chunks) yield c
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const c of gen) out.push(c)
	return out
}

describe("normalizeReasoningStream (Shofer Router)", () => {
	it("mirrors delta.reasoning_content into delta.reasoning (GLM/DeepSeek convention)", async () => {
		const out = await collect(
			normalizeReasoningStream(
				streamOf([
					{ choices: [{ delta: { reasoning_content: "Let me think" } }] },
					{ choices: [{ delta: { content: "the answer" } }] },
				]),
			),
		)

		expect(out[0].choices[0].delta.reasoning).toBe("Let me think")
		// content chunk is untouched
		expect(out[1].choices[0].delta.reasoning).toBeUndefined()
		expect(out[1].choices[0].delta.content).toBe("the answer")
	})

	it("does not overwrite an existing delta.reasoning", async () => {
		const out = await collect(
			normalizeReasoningStream(
				streamOf([{ choices: [{ delta: { reasoning: "primary", reasoning_content: "dup" } }] }]),
			),
		)
		expect(out[0].choices[0].delta.reasoning).toBe("primary")
	})

	it("passes through chunks with no delta / no reasoning fields unchanged", async () => {
		const usage = { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.001 } }
		const out = await collect(normalizeReasoningStream(streamOf([usage, { foo: "bar" }])))
		expect(out[0]).toBe(usage)
		expect(out[1]).toEqual({ foo: "bar" })
	})
})
