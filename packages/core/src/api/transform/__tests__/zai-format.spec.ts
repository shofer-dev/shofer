import type { Anthropic } from "@anthropic-ai/sdk"

import { convertToZAiFormat, type ZAiAssistantMessage } from "../zai-format.js"

/**
 * `convertToZAiFormat` exists because of the Provider Reasoning-Preservation
 * Rule: Z.ai's GLM models set `preserveReasoning`, and the generic AI-SDK
 * converter DROPS `{type: "reasoning"}` content blocks — which forces the model
 * to re-derive its whole chain of thought on every tool round-trip and
 * invalidates the server-side prefix cache. So the assertions below are about
 * `reasoning_content` surviving, and about the ONE structural rule that makes
 * it survive on the wire: Z.ai discards reasoning as soon as it sees a user
 * message, so post-tool-result text is merged INTO the tool message instead.
 */

const msg = (m: Anthropic.Messages.MessageParam) => m

describe("convertToZAiFormat — reasoning preservation", () => {
	it("keeps top-level reasoning_content on an assistant message", () => {
		const out = convertToZAiFormat([
			{ role: "assistant", content: "answer", reasoning_content: "because" } as never,
		])

		expect(out).toEqual([{ role: "assistant", content: "answer", reasoning_content: "because" }])
	})

	it("lifts a `reasoning` CONTENT BLOCK into the native reasoning_content field", () => {
		// This is the shape `Task` persists reasoning in, and the one the generic
		// converter silently drops.
		const out = convertToZAiFormat([
			msg({
				role: "assistant",
				content: [
					{ type: "reasoning", text: "step by step" },
					{ type: "text", text: "the answer" },
				] as never,
			}),
		])

		expect(out[0]).toMatchObject({ role: "assistant", content: "the answer", reasoning_content: "step by step" })
	})

	it("prefers explicit top-level reasoning over a reasoning block", () => {
		const out = convertToZAiFormat([
			{
				role: "assistant",
				reasoning_content: "top level",
				content: [{ type: "reasoning", text: "block" }],
			} as never,
		])

		expect((out[0] as ZAiAssistantMessage).reasoning_content).toBe("top level")
	})

	it("carries reasoning across a merge of two consecutive assistant messages", () => {
		const out = convertToZAiFormat([
			msg({ role: "assistant", content: "first" }),
			{ role: "assistant", content: "second", reasoning_content: "why" } as never,
		])

		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ content: "first\nsecond", reasoning_content: "why" })
	})

	it("emits reasoning alongside tool calls without merging them into the previous turn", () => {
		const out = convertToZAiFormat([
			msg({ role: "assistant", content: "before" }),
			{
				role: "assistant",
				reasoning_content: "thinking",
				content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } }],
			} as never,
		])

		expect(out).toHaveLength(2)
		expect(out[1]).toMatchObject({
			role: "assistant",
			content: null,
			reasoning_content: "thinking",
			tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file" } }],
		})
		expect(
			JSON.parse(
				(out[1] as never as { tool_calls: [{ function: { arguments: string } }] }).tool_calls[0]!.function
					.arguments,
			),
		).toEqual({
			path: "a.ts",
		})
	})
})

describe("convertToZAiFormat — tool results", () => {
	const toolResultThenText = (): Anthropic.Messages.MessageParam => ({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: "call-1", content: "the file" },
			{ type: "text", text: "<environment_details>…</environment_details>" },
		],
	})

	it("merges post-tool-result text INTO the tool message when asked", () => {
		const out = convertToZAiFormat([toolResultThenText()], { mergeToolResultText: true })

		// One message, not two: a user message here would make Z.ai drop the
		// reasoning accumulated so far.
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: "tool", tool_call_id: "call-1" })
		expect(out[0]!.content).toBe("the file\n\n<environment_details>…</environment_details>")
	})

	it("emits a separate user message when merging is not requested", () => {
		const out = convertToZAiFormat([toolResultThenText()])

		expect(out.map((m) => m.role)).toEqual(["tool", "user"])
	})

	it("does not merge when the trailing content includes an image", () => {
		const out = convertToZAiFormat(
			[
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call-1", content: "the file" },
						{ type: "text", text: "look" },
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: "AAA" },
						},
					],
				},
			],
			{ mergeToolResultText: true },
		)

		expect(out.map((m) => m.role)).toEqual(["tool", "user"])
		expect(out[1]!.content).toEqual([
			{ type: "text", text: "look" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
		])
	})

	it("flattens a block-array tool_result, naming images rather than inlining them", () => {
		const out = convertToZAiFormat([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-1",
						content: [
							{ type: "text", text: "line one" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
						],
					},
				],
			},
		])

		expect(out[0]!.content).toBe("line one\n(image)")
	})

	it("renders an empty tool_result content as an empty string", () => {
		const out = convertToZAiFormat([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1" }] } as never,
		])

		expect(out[0]).toEqual({ role: "tool", tool_call_id: "call-1", content: "" })
	})
})

describe("convertToZAiFormat — message merging", () => {
	it("merges consecutive string user messages", () => {
		const out = convertToZAiFormat([msg({ role: "user", content: "one" }), msg({ role: "user", content: "two" })])

		expect(out).toEqual([{ role: "user", content: "one\ntwo" }])
	})

	it("appends a string user message onto a preceding multi-part one", () => {
		const out = convertToZAiFormat([
			msg({
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
				],
			}),
			msg({ role: "user", content: "and this" }),
		])

		expect(out).toHaveLength(1)
		expect(out[0]!.content).toEqual([
			{ type: "text", text: "look" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
			{ type: "text", text: "and this" },
		])
	})

	it("concatenates multi-part user content onto a preceding string user message", () => {
		const out = convertToZAiFormat([
			msg({ role: "user", content: "first" }),
			msg({
				role: "user",
				content: [
					{ type: "text", text: "second" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
				],
			}),
		])

		expect(out).toHaveLength(1)
		expect(out[0]!.content).toEqual([
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
		])
	})

	it("never merges an assistant message that already carries tool_calls", () => {
		const out = convertToZAiFormat([
			msg({
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }],
			}),
			msg({ role: "assistant", content: "after the call" }),
		])

		expect(out).toHaveLength(2)
	})
})
