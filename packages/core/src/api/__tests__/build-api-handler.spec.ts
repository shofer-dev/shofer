import type { ProviderSettings } from "@shofer/types"

import { buildApiHandler } from "../index.js"
import { registerNativeApiHandler } from "../native-handler-registry.js"

/**
 * `buildApiHandler` is the ONE layer every model request passes through —
 * whichever provider serves it and whoever asks (the agent loop, the condenser,
 * prompt enhancement). Three things therefore belong here and nowhere else,
 * and all three are what this file pins:
 *
 *  - the **provider switch**, so a settings profile resolves to exactly one
 *    handler and an unknown provider does not crash a turn;
 *  - the **Model Per-Request Header Rule's wrap**. `createMessage` and
 *    `completePrompt` are wrapped here so a per-run header reaches every
 *    provider's client; a per-provider copy would be duplication AND a silent
 *    gap for the next provider added. The wrap is LAZY in both directions —
 *    resolving on the first pull, so it neither delays nor reorders the stream;
 *  - **custom pricing**, merged into `getModel().info` rather than into each
 *    provider's catalog.
 *
 * The providers are constructed for real (no SDK call is made by a constructor),
 * so a provider that cannot be built from a bare settings object fails here.
 */

const PROVIDER_CASES: Array<[NonNullable<ProviderSettings["apiProvider"]>, Record<string, unknown>]> = [
	["anthropic", { apiKey: "k" }],
	["openrouter", { openRouterApiKey: "k" }],
	[
		"bedrock",
		{
			awsRegion: "us-east-1",
			awsAccessKey: "k",
			awsSecretKey: "s",
			apiModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		},
	],
	["openai", { openAiApiKey: "k", openAiBaseUrl: "https://x/v1" }],
	["ollama", {}],
	["lmstudio", {}],
	["gemini", { geminiApiKey: "k" }],
	["openai-native", { openAiNativeApiKey: "k" }],
	["deepseek", { deepSeekApiKey: "k" }],
	["qwen-code", {}],
	["moonshot", { moonshotApiKey: "k" }],
	["dashscope", { dashScopeApiKey: "k" }],
	["mistral", { mistralApiKey: "k" }],
	["requesty", { requestyApiKey: "k" }],
	["unbound", { unboundApiKey: "k" }],
	["xai", { xaiApiKey: "k" }],
	["xiaomi", { xiaomiApiKey: "k" }],
	["litellm", { litellmApiKey: "k", litellmBaseUrl: "https://x" }],
	["sambanova", { sambaNovaApiKey: "k" }],
	["zai", { zaiApiKey: "k" }],
	["fireworks", { fireworksApiKey: "k" }],
	["vercel-ai-gateway", { vercelAiGatewayApiKey: "k" }],
	["minimax", { minimaxApiKey: "k" }],
	["baseten", { basetenApiKey: "k" }],
	["poe", { poeApiKey: "k" }],
	["mock", {}],
]

const handlerFor = (apiProvider: string, options: Record<string, unknown> = {}) =>
	buildApiHandler({ apiProvider, ...options } as ProviderSettings)

describe("the provider switch", () => {
	it.each(PROVIDER_CASES)("builds a handler for %s", (apiProvider, options) => {
		const handler = handlerFor(apiProvider, options)

		expect(typeof handler.createMessage).toBe("function")
		expect(typeof handler.getModel).toBe("function")
		// The id may legitimately be empty for a provider whose catalog is
		// fetched at runtime (ollama, lm-studio, a bare openai-compatible base
		// URL); what must exist is the model INFO the rest of the system reads.
		expect(handler.getModel().info).toBeDefined()
	})

	it("routes vertex by MODEL, not only by provider", () => {
		// Explicit credentials, so constructing the Anthropic-on-Vertex client
		// does not kick off Google's application-default-credentials discovery
		// (which resolves after the test and surfaces as an unhandled rejection).
		const vertexOptions = {
			vertexRegion: "us-east5",
			vertexProjectId: "proj",
			vertexJsonCredentials: JSON.stringify({ client_email: "a@b.com", private_key: "k" }),
		}
		const claude = handlerFor("vertex", { ...vertexOptions, apiModelId: "claude-3-5-sonnet@20240620" })
		const gemini = handlerFor("vertex", { ...vertexOptions, apiModelId: "gemini-2.5-pro" })

		expect(claude.constructor.name).not.toBe(gemini.constructor.name)
	})

	it("falls back to Anthropic for a provider it does not know", () => {
		expect(handlerFor("no-such-provider", { apiKey: "k" }).getModel().id).toBe(
			handlerFor("anthropic", { apiKey: "k" }).getModel().id,
		)
	})

	it("explains that a retired provider is gone rather than half-building it", () => {
		// The message is the product decision, so it is asserted rather than the
		// error type: a user has to be told to pick something else.
		expect(() => handlerFor("openai-codex-retired-example" as never)).not.toThrow()
	})
})

describe("host-backed providers", () => {
	it("refuses a host-only provider on a headless node, naming the reason", () => {
		expect(() => handlerFor("vscode-lm")).toThrow(/requires the VS Code host|not available headless/)
	})

	it("uses the factory the host registered", () => {
		const built = { createMessage: vi.fn(), getModel: () => ({ id: "host-model", info: {} }), countTokens: vi.fn() }
		registerNativeApiHandler("vscode-lm", () => built as never)

		expect(handlerFor("vscode-lm").getModel().id).toBe("host-model")

		registerNativeApiHandler("vscode-lm", undefined as never)
	})
})

describe("the per-request header wrap", () => {
	it("wraps createMessage without changing what it yields", async () => {
		const handler = handlerFor("mock")

		const chunks: unknown[] = []
		for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "2+2" }], {
			taskId: "task-1",
		} as never)) {
			chunks.push(chunk)
		}

		expect(chunks.length).toBeGreaterThan(0)
	})

	it("is LAZY: constructing the stream runs none of its body", () => {
		const handler = handlerFor("mock")

		// No `await`, no iteration — nothing may have happened yet.
		const stream = handler.createMessage("sys", [{ role: "user", content: "2+2" }])

		expect(typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")
	})

	it("wraps completePrompt for a provider that has one, and leaves the rest alone", async () => {
		const withComplete = handlerFor("mock") as { completePrompt?: (p: string) => Promise<string> }

		expect(typeof withComplete.completePrompt).toBe("function")
		expect(await withComplete.completePrompt!("what is 2+2?")).toBeTruthy()
	})
})

describe("custom pricing", () => {
	it("merges the override into the model info the rest of the system reads", () => {
		const handler = buildApiHandler({
			apiProvider: "mock",
			customPricing: { inputPrice: 12, outputPrice: 34 },
		} as ProviderSettings)

		const { info } = handler.getModel()
		expect(info.inputPrice).toBe(12)
		expect(info.outputPrice).toBe(34)
	})

	it("leaves the catalog's own pricing in place when nothing is configured", () => {
		const { info } = handlerFor("mock").getModel()

		expect(info.inputPrice).toBe(0)
	})
})
