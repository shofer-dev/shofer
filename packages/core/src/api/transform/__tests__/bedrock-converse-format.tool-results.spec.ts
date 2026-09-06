import type { Anthropic } from "@anthropic-ai/sdk"

import { convertToBedrockConverseMessages } from "../bedrock-converse-format.js"

/**
 * Bedrock's Converse shape for TOOL traffic — the half of the converter that
 * the round-trip depends on and that the happy-path tests do not reach.
 *
 * A tool result is the one block whose payload has no single canonical spelling:
 * it arrives as a string, as an array of content blocks (the native tool
 * format), or on the legacy `output` field in either shape, depending on which
 * layer produced it. All four must land as a `toolResult` carrying the SAME id
 * the `toolUse` was sent with — Bedrock rejects a conversation whose ids do not
 * pair up, and the failure surfaces as a 400 on the NEXT request rather than on
 * the message that was wrong.
 *
 * Ids are sanitized on both sides for the same reason and with the same
 * function, which is what keeps them equal.
 */

const message = (role: "user" | "assistant", content: unknown): Anthropic.Messages.MessageParam =>
	({ role, content }) as Anthropic.Messages.MessageParam

const firstBlock = (content: unknown) =>
	convertToBedrockConverseMessages([message("user", content)])[0]!.content![0] as unknown as Record<string, never>

describe("a tool result's payload, however it is spelled", () => {
	it("wraps a string `content`", () => {
		expect(firstBlock([{ type: "tool_result", tool_use_id: "call_1", content: "the file body" }])).toEqual({
			toolResult: { toolUseId: "call_1", content: [{ text: "the file body" }], status: "success" },
		})
	})

	it("maps an ARRAY `content` block by block", () => {
		const block = firstBlock([
			{
				type: "tool_result",
				tool_use_id: "call_1",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		])

		expect(block).toMatchObject({
			toolResult: { content: [{ text: "first" }, { text: "second" }] },
		})
	})

	it("stringifies an array entry that is not a content block", () => {
		const block = firstBlock([{ type: "tool_result", tool_use_id: "call_1", content: ["bare string"] }])

		expect(block).toMatchObject({ toolResult: { content: [{ text: "bare string" }] } })
	})

	it("falls back to a string `output`", () => {
		expect(firstBlock([{ type: "tool_result", tool_use_id: "call_1", output: "legacy payload" }])).toMatchObject({
			toolResult: { content: [{ text: "legacy payload" }] },
		})
	})

	it("falls back to an ARRAY `output`, replacing an image with a pointer", () => {
		// Bedrock carries images as their own blocks, so an image inside a tool
		// result would be dropped silently; the pointer keeps the reference.
		const block = firstBlock([
			{
				type: "tool_result",
				tool_use_id: "call_1",
				output: [{ type: "text", text: "described" }, { type: "image" }, 42],
			},
		])

		expect(block).toMatchObject({
			toolResult: {
				content: [{ text: "described" }, { text: "(see following message for image)" }, { text: "42" }],
			},
		})
	})

	it("produces an EMPTY result rather than nothing when there is no payload at all", () => {
		// A missing block would leave the toolUse unpaired, which Bedrock 400s.
		expect(firstBlock([{ type: "tool_result", tool_use_id: "call_1" }])).toEqual({
			toolResult: { toolUseId: "call_1", content: [{ text: "" }], status: "success" },
		})
	})

	it("tolerates a result with no id, so the conversion cannot throw mid-history", () => {
		expect(firstBlock([{ type: "tool_result" }])).toMatchObject({ toolResult: { toolUseId: "" } })
	})
})

describe("pairing a call with its result", () => {
	it("sanitizes the id identically on both sides", () => {
		const converted = convertToBedrockConverseMessages([
			message("assistant", [{ type: "tool_use", id: "call:weird/id", name: "read_file", input: { path: "a" } }]),
			message("user", [{ type: "tool_result", tool_use_id: "call:weird/id", content: "ok" }]),
		])

		const use = (converted[0]!.content![0] as unknown as Record<string, { toolUseId: string }>).toolUse!
		const result = (converted[1]!.content![0] as unknown as Record<string, { toolUseId: string }>).toolResult!
		expect(result.toolUseId).toBe(use.toolUseId)
	})

	it("keeps a tool_use's input as an OBJECT, not a JSON string", () => {
		// Bedrock's toolUse takes structured input; stringifying it makes the
		// model read its own arguments as prose.
		const block = convertToBedrockConverseMessages([
			message("assistant", [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "src/a.ts" } }]),
		])[0]!.content![0] as unknown as Record<string, never>

		expect(block).toMatchObject({ toolUse: { name: "read_file", input: { path: "src/a.ts" } } })
	})

	it("defaults a tool_use with no name or input rather than emitting an invalid block", () => {
		const block = convertToBedrockConverseMessages([message("assistant", [{ type: "tool_use", id: "c1" }])])[0]!
			.content![0] as unknown as Record<string, never>

		expect(block).toMatchObject({ toolUse: { name: "", input: {} } })
	})
})

describe("the other block types", () => {
	it("passes a plain string message through as one text block", () => {
		expect(convertToBedrockConverseMessages([message("user", "hello")])[0]).toEqual({
			role: "user",
			content: [{ text: "hello" }],
		})
	})

	it("maps the assistant role and defaults anything else to user", () => {
		const converted = convertToBedrockConverseMessages([message("assistant", "hi"), message("user", "yo")])

		expect(converted.map((m) => m.role)).toEqual(["assistant", "user"])
	})

	it("renders a text block with no text as empty rather than undefined", () => {
		expect(firstBlock([{ type: "text" }])).toEqual({ text: "" })
	})

	it("carries a video by its S3 location", () => {
		const block = firstBlock([{ type: "video", s3Location: { uri: "s3://bucket/clip.mp4", bucketOwner: "1234" } }])

		expect(block).toEqual({
			video: { format: "mp4", source: { s3Location: { uri: "s3://bucket/clip.mp4", bucketOwner: "1234" } } },
		})
	})

	it("carries a video delivered inline", () => {
		const source = { type: "base64", data: "AAA", media_type: "video/mp4" }

		expect(firstBlock([{ type: "video", source }])).toEqual({ video: { format: "mp4", source } })
	})

	it("labels a block type it does not know instead of dropping it", () => {
		// A dropped block would desynchronise the conversation silently.
		expect(firstBlock([{ type: "something_new" }])).toEqual({ text: "[Unknown Block Type]" })
	})
})

describe("images", () => {
	it("decodes a base64 image into the bytes Bedrock expects", () => {
		const data = Buffer.from("PNGDATA").toString("base64")

		const block = firstBlock([{ type: "image", source: { type: "base64", data, media_type: "image/png" } }])

		expect(block).toMatchObject({ image: { format: "png" } })
		const bytes = (block as unknown as { image: { source: { bytes: Uint8Array } } }).image.source.bytes
		expect(Buffer.from(bytes).toString()).toBe("PNGDATA")
	})

	it("passes bytes straight through when they are already decoded", () => {
		const bytes = new Uint8Array([1, 2, 3])

		const block = firstBlock([{ type: "image", source: { type: "base64", data: bytes, media_type: "image/jpeg" } }])

		expect(block).toMatchObject({ image: { format: "jpeg", source: { bytes } } })
	})

	it("refuses a format Bedrock cannot accept, rather than sending it and being 400'd", () => {
		expect(() =>
			firstBlock([{ type: "image", source: { type: "base64", data: "AAA", media_type: "image/tiff" } }]),
		).toThrow("Unsupported image format: tiff")
	})
})
