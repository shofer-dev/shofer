// npx vitest src/utils/__tests__/validate.providers.spec.ts
//
// `validateApiConfiguration` answers three questions in order: are the keys and
// ids this provider needs present, does the org's allow-list permit the
// provider (and the model), and — for a dynamic provider — does the fetched
// catalog carry the configured model. The per-provider required-field switch is
// the part a new provider is most likely to be added to without, so it is
// walked here.

import type { OrganizationAllowList, ProviderSettings } from "@shofer/types"

vi.mock("i18next", () => ({
	default: {
		t: (key: string, options?: Record<string, string>) =>
			options
				? `${key}(${Object.entries(options)
						.map(([k, v]) => `${k}=${v}`)
						.join(",")})`
				: key,
	},
}))

const { validateApiConfiguration, validateBedrockArn } = await import("../validate")

const allowAll: OrganizationAllowList = { allowAll: true, providers: {} }

describe("required fields, per provider", () => {
	const missing: Array<[string, ProviderSettings, string]> = [
		["openrouter", { apiProvider: "openrouter" }, "settings:validation.apiKey"],
		["requesty", { apiProvider: "requesty" }, "settings:validation.apiKey"],
		["unbound", { apiProvider: "unbound" }, "settings:validation.apiKey"],
		["litellm", { apiProvider: "litellm" }, "settings:validation.apiKey"],
		["anthropic", { apiProvider: "anthropic" }, "settings:validation.apiKey"],
		["gemini", { apiProvider: "gemini" }, "settings:validation.apiKey"],
		["openai-native", { apiProvider: "openai-native" }, "settings:validation.apiKey"],
		["mistral", { apiProvider: "mistral" }, "settings:validation.apiKey"],
		["fireworks", { apiProvider: "fireworks" }, "settings:validation.apiKey"],
		["vercel-ai-gateway", { apiProvider: "vercel-ai-gateway" }, "settings:validation.apiKey"],
		["baseten", { apiProvider: "baseten" }, "settings:validation.apiKey"],
		["bedrock", { apiProvider: "bedrock" }, "settings:validation.awsRegion"],
		["vertex", { apiProvider: "vertex" }, "settings:validation.googleCloud"],
		["ollama", { apiProvider: "ollama" }, "settings:validation.modelId"],
		["lmstudio", { apiProvider: "lmstudio" }, "settings:validation.modelId"],
		["vscode-lm", { apiProvider: "vscode-lm" }, "settings:validation.modelSelector"],
		["qwen-code", { apiProvider: "qwen-code" }, "settings:validation.qwenCodeOauthPath"],
	] as never

	it.each(missing)("%s reports what it is missing", (_name, config, expected) => {
		expect(validateApiConfiguration(config)).toBe(expected)
	})

	const satisfied: Array<[string, ProviderSettings]> = [
		["anthropic", { apiProvider: "anthropic", apiKey: "k" }],
		["gemini", { apiProvider: "gemini", geminiApiKey: "k" }],
		["bedrock", { apiProvider: "bedrock", awsRegion: "us-east-1" }],
		["vertex", { apiProvider: "vertex", vertexProjectId: "p", vertexRegion: "r" }],
		["ollama", { apiProvider: "ollama", ollamaModelId: "m" }],
		["lmstudio", { apiProvider: "lmstudio", lmStudioModelId: "m" }],
		["vscode-lm", { apiProvider: "vscode-lm", vsCodeLmModelSelector: { vendor: "v", family: "f" } }],
		["qwen-code", { apiProvider: "qwen-code", qwenCodeOauthPath: "~/creds.json" }],
		["baseten", { apiProvider: "baseten", basetenApiKey: "k" }],
	] as never

	it.each(satisfied)("%s validates once its required field is present", (_name, config) => {
		expect(validateApiConfiguration(config)).toBeUndefined()
	})

	it("checks the openai-compatible fields in order", () => {
		expect(validateApiConfiguration({ apiProvider: "openai" } as ProviderSettings)).toBe(
			"settings:validation.openAiBaseUrl",
		)
		expect(validateApiConfiguration({ apiProvider: "openai", openAiBaseUrl: "u" } as ProviderSettings)).toBe(
			"settings:validation.apiKey",
		)
		expect(
			validateApiConfiguration({
				apiProvider: "openai",
				openAiBaseUrl: "u",
				openAiApiKey: "k",
			} as ProviderSettings),
		).toBe("settings:validation.openAiModelId")
		expect(
			validateApiConfiguration({
				apiProvider: "openai",
				openAiBaseUrl: "u",
				openAiApiKey: "k",
				openAiModelId: "m",
			} as ProviderSettings),
		).toBeUndefined()
	})

	it("still refuses a DYNAMIC provider whose catalog has not been fetched", () => {
		// Key present, but the model cannot be confirmed against a catalog.
		for (const apiProvider of ["openrouter", "requesty", "unbound"]) {
			const config = {
				apiProvider,
				openRouterApiKey: "k",
				requestyApiKey: "k",
				unboundApiKey: "k",
			} as ProviderSettings
			expect(validateApiConfiguration(config)).toBe("settings:validation.modelId")
		}
	})

	it("asks nothing of a provider with no required fields", () => {
		expect(validateApiConfiguration({ apiProvider: "xai" } as ProviderSettings)).toBeUndefined()
		expect(validateApiConfiguration({} as ProviderSettings)).toBeUndefined()
	})
})

describe("the organization allow-list", () => {
	it("permits everything when it says so", () => {
		expect(
			validateApiConfiguration(
				{ apiProvider: "anthropic", apiKey: "k" } as ProviderSettings,
				undefined,
				allowAll,
			),
		).toBeUndefined()
	})

	it("refuses a provider it does not list", () => {
		expect(
			validateApiConfiguration({ apiProvider: "anthropic", apiKey: "k" } as ProviderSettings, undefined, {
				allowAll: false,
				providers: {},
			}),
		).toBe("settings:validation.providerNotAllowed(provider=anthropic)")
	})

	it("permits any model of a provider listed with allowAll", () => {
		expect(
			validateApiConfiguration({ apiProvider: "anthropic", apiKey: "k" } as ProviderSettings, undefined, {
				allowAll: false,
				providers: { anthropic: { allowAll: true } },
			}),
		).toBeUndefined()
	})

	it("refuses a model outside the listed set, and admits one inside it", () => {
		const list: OrganizationAllowList = {
			allowAll: false,
			providers: { anthropic: { allowAll: false, models: ["claude-sonnet-4-5"] } },
		}

		expect(
			validateApiConfiguration(
				{ apiProvider: "anthropic", apiKey: "k", apiModelId: "claude-opus-4-6" } as ProviderSettings,
				undefined,
				list,
			),
		).toBe("settings:validation.modelNotAllowed(model=claude-opus-4-6,provider=anthropic)")

		expect(
			validateApiConfiguration(
				{ apiProvider: "anthropic", apiKey: "k", apiModelId: "claude-sonnet-4-5" } as ProviderSettings,
				undefined,
				list,
			),
		).toBeUndefined()
	})

	it("says nothing about a configuration that names no provider", () => {
		expect(validateApiConfiguration({} as ProviderSettings, undefined, { allowAll: false, providers: {} })).toBe(
			undefined,
		)
	})

	it("reads the vscode-lm model id off the selector", () => {
		expect(
			validateApiConfiguration(
				{
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "v", family: "f", id: "not-listed" },
				} as ProviderSettings,
				undefined,
				{ allowAll: false, providers: { "vscode-lm": { allowAll: false, models: ["listed"] } } },
			),
		).toContain("modelNotAllowed")
	})
})

describe("validateBedrockArn", () => {
	it("accepts an ARN whose region matches", () => {
		const result = validateBedrockArn("arn:aws:bedrock:us-west-2:123456789012:provisioned-model/mine", "us-west-2")
		expect(result.isValid).toBe(true)
		expect(result.arnRegion).toBe("us-west-2")
		expect(result.errorMessage).toBeUndefined()
	})

	it("warns — but still accepts — when the region differs", () => {
		const result = validateBedrockArn("arn:aws:bedrock:eu-west-1:123456789012:provisioned-model/mine", "us-west-2")
		expect(result.arnRegion).toBe("eu-west-1")
		expect(result.errorMessage).toBeTruthy()
	})

	it("accepts an ARN when no region is supplied to compare against", () => {
		const result = validateBedrockArn("arn:aws:bedrock:eu-west-1:1:provisioned-model/mine")
		expect(result.isValid).toBe(true)
		expect(result.errorMessage).toBeUndefined()
	})

	it("trusts an ARN it cannot parse a region out of", () => {
		const result = validateBedrockArn("something-else-entirely", "us-west-2")
		expect(result.isValid).toBe(true)
		expect(result.arnRegion).toBeUndefined()
	})
})
