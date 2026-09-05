/**
 * Unit tests for the CLI's own type-level helpers (`src/types/`).
 *
 * Both modules are mostly declarations; what is testable is the pair of
 * runtime guards (`isSupportedProvider`, `isValidOutputFormat`) and the
 * constant tables they answer from.
 */

import {
	AUTH_BASE_URL,
	DEFAULT_FLAGS,
	OUTPUT_FORMATS,
	OnboardingProviderChoice,
	REASONING_EFFORTS,
	SDK_BASE_URL,
	isSupportedProvider,
	isValidOutputFormat,
	supportedProviders,
} from "../index.js"

describe("isSupportedProvider", () => {
	it("accepts every entry of supportedProviders", () => {
		for (const provider of supportedProviders) {
			expect(isSupportedProvider(provider)).toBe(true)
		}
	})

	it("rejects a provider outside the table", () => {
		expect(isSupportedProvider("deepseek")).toBe(false)
		expect(isSupportedProvider("")).toBe(false)
		expect(isSupportedProvider("OPENROUTER")).toBe(false)
	})

	it("lists the seven providers the CLI can drive", () => {
		expect([...supportedProviders]).toEqual([
			"anthropic",
			"openai-native",
			"gemini",
			"openrouter",
			"shofer",
			"vercel-ai-gateway",
			"mock",
		])
	})
})

describe("isValidOutputFormat", () => {
	it("accepts every published output format", () => {
		for (const format of OUTPUT_FORMATS) {
			expect(isValidOutputFormat(format)).toBe(true)
		}
	})

	it("accepts the three formats the CLI documents", () => {
		expect(isValidOutputFormat("text")).toBe(true)
		expect(isValidOutputFormat("json")).toBe(true)
		expect(isValidOutputFormat("stream-json")).toBe(true)
	})

	it("rejects anything else", () => {
		expect(isValidOutputFormat("ndjson")).toBe(false)
		expect(isValidOutputFormat("")).toBe(false)
		expect(isValidOutputFormat("JSON")).toBe(false)
	})
})

describe("OnboardingProviderChoice", () => {
	it("carries the two provider routes onboarding offers", () => {
		expect(OnboardingProviderChoice.Shofer).toBe("shofer")
		expect(OnboardingProviderChoice.Byok).toBe("byok")
	})
})

describe("constants", () => {
	it("defaults the run flags to code / medium / 10", () => {
		expect(DEFAULT_FLAGS).toEqual({ mode: "code", reasoningEffort: "medium", consecutiveMistakeLimit: 10 })
	})

	it("extends the reasoning efforts with the CLI-only sentinels", () => {
		expect(REASONING_EFFORTS).toContain("unspecified")
		expect(REASONING_EFFORTS).toContain("disabled")
	})

	it("exposes https auth/sdk base urls", () => {
		expect(AUTH_BASE_URL).toMatch(/^https?:\/\//)
		expect(SDK_BASE_URL).toMatch(/^https?:\/\//)
	})
})
