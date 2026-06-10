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
		["answer", true],
		["Answer", true],
		["response", true],
		["•Okay", false],
		["Let me think", false],
		["", false],
	])("%j → %s", (input, expected) => {
		expect(isAtomicPreambleToken(input)).toBe(expected)
	})
})

describe("cleanReasoningChunk", () => {
	test("atomic token → dropped", () => {
		expect(cleanReasoningChunk("•")).toBeUndefined()
		expect(cleanReasoningChunk("•response")).toBeUndefined()
		expect(cleanReasoningChunk("• response")).toBeUndefined()
		expect(cleanReasoningChunk("answer")).toBeUndefined()
	})

	test("glued preamble → prefix stripped", () => {
		expect(cleanReasoningChunk("•Okay, let's think")).toBe("Okay, let's think")
		expect(cleanReasoningChunk("•response now let me…")).toBe(" now let me…")
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
