import { describe, test, expect } from "vitest"
import {
	cleanReasoningChunk,
	isAtomicPreambleToken,
	stripReasoningPreamble,
	REASONING_PREAMBLE_RE,
} from "../reasoning-preamble"

describe("REASONING_PREAMBLE_RE", () => {
	test.each([
		// Full preamble variants — should match and strip to empty
		["• response", ""],
		["• response ", ""],
		["•response", ""],
		["•response ", ""],
		["• Response", ""],
		["• RESPONSE", ""],
		// Bare bullet — strip to empty
		["•", ""],
		["• ", ""],
		// Glued to real content — strip prefix only
		["• responseOk, let me think", "Ok, let me think"],
		["•responseThe user wants", "The user wants"],
		["•Okay, the user wants", "Okay, the user wants"],
		// No preamble — pass through
		["Let me think about this", "Let me think about this"],
		["response but not at start", "response but not at start"],
		["", ""],
	])("RE matches %j → %j", (input, expected) => {
		expect(stripReasoningPreamble(input)).toBe(expected)
	})
})

describe("isAtomicPreambleToken", () => {
	test.each([
		["•", true],
		["• ", true],
		["• response", true],
		["•response", true],
		["answer", false],
		["Answer", false],
		["response", true],
		["•Okay", false],
		["Let me think", false],
		["", false],
	])("%j → %s", (input, expected) => {
		expect(isAtomicPreambleToken(input)).toBe(expected)
	})
})

describe("cleanReasoningChunk", () => {
	describe("preamble region (processPreamble = true, default)", () => {
		test("atomic token → dropped", () => {
			expect(cleanReasoningChunk("•")).toBeUndefined()
			expect(cleanReasoningChunk("•response")).toBeUndefined()
			expect(cleanReasoningChunk("• response")).toBeUndefined()
			expect(cleanReasoningChunk("answer")).toBe("answer")
		})

		test("glued preamble → prefix stripped", () => {
			expect(cleanReasoningChunk("•Okay, let's think")).toBe("Okay, let's think")
			expect(cleanReasoningChunk("•response now let me…")).toBe("now let me…")
		})

		test("no preamble → pass through", () => {
			expect(cleanReasoningChunk("Let me think")).toBe("Let me think")
			expect(cleanReasoningChunk("response mid-sentence")).toBe("response mid-sentence")
		})

		test("empty / whitespace → dropped", () => {
			expect(cleanReasoningChunk("")).toBeUndefined()
			expect(cleanReasoningChunk("   ")).toBeUndefined()
		})
	})

	describe("mid-stream (processPreamble = false)", () => {
		test("leading • preserved (legitimate markdown bullet)", () => {
			expect(cleanReasoningChunk("• Consider the edge cases", undefined, false)).toBe("• Consider the edge cases")
		})

		test("leading •response preserved (not a preamble)", () => {
			expect(cleanReasoningChunk("•response time analysis", undefined, false)).toBe("•response time analysis")
		})

		test("whitespace-only delta preserved", () => {
			expect(cleanReasoningChunk(" ", undefined, false)).toBe(" ")
		})

		test("normal text passes through", () => {
			expect(cleanReasoningChunk("The user wants to", undefined, false)).toBe("The user wants to")
		})

		test("empty string dropped (regardless of preamble flag)", () => {
			// empty passes the `text || undefined` gate; technically the caller's
			// `if (cleaned)` check would also skip it, but we also return undefined
			expect(cleanReasoningChunk("", undefined, false)).toBeUndefined()
		})
	})
})
