/**
 * Unit tests for `getEnvVarName` / `getProviderSettings`
 * (`src/lib/utils/provider.ts`).
 *
 * `getProviderSettings` is the seam that decides WHICH field of
 * `ShoferSettings` a `--api-key` / `--model` / `--base-url` flag lands in, and
 * a wrong field silently drops the value (see the `shofer` comment in the
 * source). Every provider branch is asserted field-by-field for that reason.
 */

import { supportedProviders, type SupportedProvider } from "@/types/index.js"

import { getEnvVarName, getProviderSettings } from "../provider.js"

describe("getEnvVarName", () => {
	it.each([
		["anthropic", "ANTHROPIC_API_KEY"],
		["openai-native", "OPENAI_API_KEY"],
		["gemini", "GOOGLE_API_KEY"],
		["openrouter", "OPENROUTER_API_KEY"],
		["shofer", "SHOFER_API_KEY"],
		["vercel-ai-gateway", "VERCEL_AI_GATEWAY_API_KEY"],
		["mock", "MOCK_API_KEY"],
	] as Array<[SupportedProvider, string]>)("maps %s to %s", (provider, envVar) => {
		expect(getEnvVarName(provider)).toBe(envVar)
	})

	it("names an env var for every supported provider", () => {
		for (const provider of supportedProviders) {
			expect(typeof getEnvVarName(provider)).toBe("string")
		}
	})
})

describe("getProviderSettings", () => {
	it("always records the provider", () => {
		for (const provider of supportedProviders) {
			expect(getProviderSettings(provider, undefined, undefined).apiProvider).toBe(provider)
		}
	})

	it("omits key/model fields when neither is supplied", () => {
		expect(getProviderSettings("anthropic", undefined, undefined)).toEqual({ apiProvider: "anthropic" })
		expect(getProviderSettings("openrouter", undefined, undefined)).toEqual({ apiProvider: "openrouter" })
		expect(getProviderSettings("shofer", undefined, undefined)).toEqual({ apiProvider: "shofer" })
	})

	it("puts an anthropic key on apiKey and the model on apiModelId", () => {
		expect(getProviderSettings("anthropic", "k", "m")).toEqual({
			apiProvider: "anthropic",
			apiKey: "k",
			apiModelId: "m",
		})
	})

	it("puts an openai-native key on openAiNativeApiKey and the base url on openAiNativeBaseUrl", () => {
		expect(getProviderSettings("openai-native", "k", "m", "http://localhost:1/v1")).toEqual({
			apiProvider: "openai-native",
			openAiNativeApiKey: "k",
			apiModelId: "m",
			openAiNativeBaseUrl: "http://localhost:1/v1",
		})
	})

	it("puts a shofer key on shoferApiKey — NOT the generic apiKey", () => {
		const settings = getProviderSettings("shofer", "k", "m", "http://localhost:30081/v1")
		expect(settings).toEqual({
			apiProvider: "shofer",
			shoferApiKey: "k",
			apiModelId: "m",
			shoferBaseUrl: "http://localhost:30081/v1",
		})
		expect(settings.apiKey).toBeUndefined()
	})

	it("puts a gemini key on geminiApiKey", () => {
		expect(getProviderSettings("gemini", "k", "m")).toEqual({
			apiProvider: "gemini",
			geminiApiKey: "k",
			apiModelId: "m",
		})
	})

	it("puts an openrouter model on openRouterModelId", () => {
		expect(getProviderSettings("openrouter", "k", "m")).toEqual({
			apiProvider: "openrouter",
			openRouterApiKey: "k",
			openRouterModelId: "m",
		})
	})

	it("puts a vercel-ai-gateway model on vercelAiGatewayModelId", () => {
		expect(getProviderSettings("vercel-ai-gateway", "k", "m")).toEqual({
			apiProvider: "vercel-ai-gateway",
			vercelAiGatewayApiKey: "k",
			vercelAiGatewayModelId: "m",
		})
	})

	it("falls back to apiKey/apiModelId for the mock provider", () => {
		expect(getProviderSettings("mock", "k", "m")).toEqual({
			apiProvider: "mock",
			apiKey: "k",
			apiModelId: "m",
		})
	})

	it("ignores a base url for providers that carry no base-url field", () => {
		expect(getProviderSettings("anthropic", "k", "m", "http://ignored")).toEqual({
			apiProvider: "anthropic",
			apiKey: "k",
			apiModelId: "m",
		})
	})
})
