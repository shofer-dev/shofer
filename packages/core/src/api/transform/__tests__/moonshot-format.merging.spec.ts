import type { Anthropic } from "@anthropic-ai/sdk"

import { convertToMoonshotFormat, type MoonshotAssistantMessage } from "../moonshot-format.js"

/**
 * `convertToMoonshotFormat`'s MERGING, and the reasoning it exists to carry.
 *
 * The **Provider Reasoning-Preservation Rule** is why this converter exists at
 * all: the generic AI-SDK converter drops `{type: "reasoning"}` content blocks,
 * which for a `preserveReasoning` model means it re-derives every prior thought
 * on each tool-call round-trip — burning quota and invalidating the server-side
 * prefix cache. Here the reasoning is lifted into the native
 * `reasoning_content` field, from EITHER of the two places it can be: a content
 * block (how `Task` stores it) or the top level (how it comes back from a
 * router round-trip). The top level wins, because it is the provider's own
 * echo.
 *
 * The merging is the other half, and it is not cosmetic. Moonshot rejects two
 * consecutive messages with the same role, so the converter folds adjacent
 * same-role turns together — EXCEPT across a tool call, where merging would
 * attach text to a message whose `tool_calls` the API pairs with tool results.
 */

const msg = (role: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}) =>
	({ role, content, ...extra }) as Anthropic.Messages.MessageParam

const convert = (messages: unknown[]) => convertToMoonshotFormat(messages as Anthropic.Messages.MessageParam[])

describe("carrying reasoning to the provider's own field", () => {
	it("lifts a reasoning content block into reasoning_content", () => {
		const [assistant] = convert([
			msg("assistant", [
				{ type: "reasoning", text: "the user wants X" },
				{ type: "text", text: "here you go" },
			]),
		]) as MoonshotAssistantMessage[]

		expect(assistant!).toMatchObject({ content: "here you go", reasoning_content: "the user wants X" })
	})

	it("prefers the TOP-LEVEL field, which is the provider's own echo", () => {
		const [assistant] = convert([
			msg("assistant", [{ type: "reasoning", text: "stale" }], { reasoning_content: "authoritative" }),
		]) as MoonshotAssistantMessage[]

		expect(assistant!.reasoning_content).toBe("authoritative")
	})

	it("carries reasoning onto a plain string assistant turn", () => {
		const [assistant] = convert([
			msg("assistant", "just text", { reasoning_content: "thought" }),
		]) as MoonshotAssistantMessage[]

		expect(assistant!).toMatchObject({ content: "just text", reasoning_content: "thought" })
	})

	it("emits no reasoning_content key at all when there is none", () => {
		const [assistant] = convert([msg("assistant", "plain")]) as MoonshotAssistantMessage[]

		expect(assistant!).not.toHaveProperty("reasoning_content")
	})

	it("carries the newer turn's reasoning onto a merged assistant message", () => {
		const merged = convert([
			msg("assistant", "first"),
			msg("assistant", "second", { reasoning_content: "why second" }),
		]) as MoonshotAssistantMessage[]

		expect(merged).toHaveLength(1)
		expect(merged[0]).toMatchObject({ content: "first\nsecond", reasoning_content: "why second" })
	})
})

describe("folding adjacent same-role turns", () => {
	it("joins two string user turns", () => {
		expect(convert([msg("user", "one"), msg("user", "two")])).toEqual([{ role: "user", content: "one\ntwo" }])
	})

	it("joins two string assistant turns", () => {
		const merged = convert([msg("assistant", "one"), msg("assistant", "two")])

		expect(merged).toHaveLength(1)
		expect(merged[0]!.content).toBe("one\ntwo")
	})

	it("appends a string turn onto a user message that already carries parts", () => {
		const merged = convert([
			msg("user", [
				{ type: "text", text: "look" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
			]),
			msg("user", "and this"),
		])

		expect(merged).toHaveLength(1)
		expect(merged[0]!.content).toEqual([
			{ type: "text", text: "look" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
			{ type: "text", text: "and this" },
		])
	})

	it("concatenates two multi-part user turns rather than nesting them", () => {
		const merged = convert([
			msg("user", [
				{ type: "text", text: "a" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
			]),
			msg("user", [
				{ type: "text", text: "b" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "BBB" } },
			]),
		])

		expect(merged).toHaveLength(1)
		expect(
			(merged[0]!.content as unknown[]).filter((p) => (p as { type: string }).type === "image_url"),
		).toHaveLength(2)
	})

	it("does NOT merge an assistant turn into one that carries tool calls", () => {
		// The API pairs `tool_calls` with the tool results that follow; folding
		// text into that message breaks the pairing.
		const converted = convert([
			msg("assistant", [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } }]),
			msg("assistant", "and here is what I found"),
		])

		expect(converted).toHaveLength(2)
	})

	it("does not merge an assistant turn that itself carries tool calls", () => {
		const converted = convert([
			msg("assistant", "thinking"),
			msg("assistant", [{ type: "tool_use", id: "c1", name: "read_file", input: {} }]),
		])

		expect(converted).toHaveLength(2)
	})

	it("keeps alternating roles apart", () => {
		expect(convert([msg("user", "q"), msg("assistant", "a"), msg("user", "q2")]).map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
		])
	})
})

describe("tool traffic", () => {
	it("turns a tool_use block into a function call with stringified arguments", () => {
		const [assistant] = convert([
			msg("assistant", [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "src/a.ts" } }]),
		]) as MoonshotAssistantMessage[]

		expect(assistant!.tool_calls).toEqual([
			{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } },
		])
		// A tool-only turn has no prose, and null is what the API expects there.
		expect(assistant!.content).toBeNull()
	})

	it("emits a tool message per tool_result", () => {
		const converted = convert([msg("user", [{ type: "tool_result", tool_use_id: "c1", content: "the file body" }])])

		expect(converted[0]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "the file body" })
	})

	it("flattens an ARRAY tool_result, naming images rather than dropping them", () => {
		const converted = convert([
			msg("user", [
				{
					type: "tool_result",
					tool_use_id: "c1",
					content: [{ type: "text", text: "line one" }, { type: "image", source: {} }, { type: "audio" }],
				},
			]),
		])

		expect(converted[0]!.content).toBe("line one\n(image)\n")
	})

	it("renders a tool_result with no content as empty rather than undefined", () => {
		const converted = convert([msg("user", [{ type: "tool_result", tool_use_id: "c1" }])])

		expect(converted[0]).toMatchObject({ role: "tool", content: "" })
	})

	it("merges text that follows a tool result INTO the tool message by default", () => {
		// Moonshot's thinking models reject a user turn between a tool result and
		// the next assistant turn.
		const converted = convert([
			msg("user", [
				{ type: "tool_result", tool_use_id: "c1", content: "result" },
				{ type: "text", text: "now do the next bit" },
			]),
		])

		expect(converted).toHaveLength(1)
		expect(String(converted[0]!.content)).toContain("now do the next bit")
	})

	it("keeps them apart when the caller asks for it", () => {
		const converted = convertToMoonshotFormat(
			[
				msg("user", [
					{ type: "tool_result", tool_use_id: "c1", content: "result" },
					{ type: "text", text: "now do the next bit" },
				]),
			] as Anthropic.Messages.MessageParam[],
			{ mergeToolResultText: false },
		)

		expect(converted.map((m) => m.role)).toEqual(["tool", "user"])
	})
})
