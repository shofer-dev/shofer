import { processMcpToolContent, DEFAULT_MCP_MAX_RESPONSE_BYTES } from "../use-mcp-shared"

describe("processMcpToolContent", () => {
	it("returns empty text and no images for an empty content array", () => {
		expect(processMcpToolContent({ content: [] })).toEqual({ text: "", images: [] })
	})

	it("joins text-type content blocks with blank-line separators", () => {
		const result = processMcpToolContent({
			content: [
				{ type: "text", text: "alpha" },
				{ type: "text", text: "beta" },
			],
		})
		expect(result.text).toBe("alpha\n\nbeta")
		expect(result.images).toEqual([])
	})

	it("collects image content blocks as data URLs", () => {
		const result = processMcpToolContent({
			content: [
				{ type: "image", mimeType: "image/png", data: "AAAA" },
				{ type: "image", mimeType: "image/png", data: "data:image/png;base64,ZZZZ" },
			],
		})
		expect(result.images).toEqual(["data:image/png;base64,AAAA", "data:image/png;base64,ZZZZ"])
	})

	it("does not truncate when output is below the cap", () => {
		const small = "x".repeat(100)
		const result = processMcpToolContent({ content: [{ type: "text", text: small }] }, 1024)
		expect(result.text).toBe(small)
	})

	it("truncates oversized output and appends a banner", () => {
		const big = "y".repeat(10_000)
		const result = processMcpToolContent({ content: [{ type: "text", text: big }] }, 1024)
		// 1024 truncated text + banner suffix
		expect(result.text.length).toBeGreaterThan(1024)
		expect(result.text.length).toBeLessThan(1024 + 256)
		expect(result.text).toMatch(/\[shofer: MCP response truncated from \d+ bytes to \d+ bytes/)
	})

	it("disables truncation when maxBytes is 0", () => {
		const big = "z".repeat(5_000_000)
		const result = processMcpToolContent({ content: [{ type: "text", text: big }] }, 0)
		expect(result.text.length).toBe(big.length)
	})

	it("uses DEFAULT_MCP_MAX_RESPONSE_BYTES when no cap is passed", () => {
		expect(DEFAULT_MCP_MAX_RESPONSE_BYTES).toBe(1024 * 1024)
		// Just under the default cap — no truncation.
		const text = "a".repeat(DEFAULT_MCP_MAX_RESPONSE_BYTES - 100)
		const result = processMcpToolContent({ content: [{ type: "text", text }] })
		expect(result.text).toBe(text)
	})

	it("does not split multi-byte UTF-8 codepoints at the truncation boundary", () => {
		// Each "💧" is 4 bytes; cap at 10 bytes -> 2 full emoji (8 bytes) + banner.
		const emojiBlob = "💧".repeat(5)
		const result = processMcpToolContent({ content: [{ type: "text", text: emojiBlob }] }, 10)
		// The truncated head must be valid UTF-8 — no replacement characters
		// from broken codepoints — and Buffer round-tripping must not surface
		// the U+FFFD sentinel inside the original payload region.
		const headEnd = result.text.indexOf("\n\n[shofer:")
		expect(headEnd).toBeGreaterThan(0)
		const head = result.text.slice(0, headEnd)
		expect(head.includes("\uFFFD")).toBe(false)
	})
})
