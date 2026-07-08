// pnpm --filter shofer test api/providers/__tests__/shofer.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({}))
vi.mock("openai")
vi.mock("delay", () => ({ default: vi.fn(() => Promise.resolve()) }))
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureException: vi.fn() } },
}))
vi.mock("../fetchers/modelEndpointCache", () => ({
	getModelEndpoints: vi.fn().mockResolvedValue({}),
}))

// The Shofer router catalog carries glm-5.2's real metadata (1M context, 131k
// max output). The openrouter.ai catalog never contains Shofer-router model ids,
// so a handler that (wrongly) fetches from it falls back to the 200k Sonnet default.
vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn(async (options: { provider: string }) => {
		if (options.provider === "shofer") {
			return {
				"zhipu/glm-5.2": {
					maxTokens: 131_072,
					contextWindow: 1_000_000,
					supportsImages: false,
					supportsPromptCache: true,
					inputPrice: 0,
					outputPrice: 0,
					description: "GLM-5.2",
				},
			}
		}
		// openrouter.ai catalog — intentionally has no `zhipu/glm-5.2`.
		return {
			"anthropic/claude-sonnet-4.5": {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				description: "Claude 4.5 Sonnet",
			},
		}
	}),
}))

import { ShoferHandler, normalizeReasoningStream } from "../shofer.js"
import { getModels } from "../fetchers/modelCache.js"
import type { ApiHandlerOptions } from "../_deps.js"

/** Build an async-iterable stream from a fixed list of chunks. */
async function* streamOf(chunks: unknown[]) {
	for (const c of chunks) yield c
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const c of gen) out.push(c)
	return out
}

describe("ShoferHandler model resolution", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const options = {
		apiModelId: "zhipu/glm-5.2",
		shoferBaseUrl: "http://localhost:30081/v1",
		shoferApiKey: "shofer",
	} as ApiHandlerOptions

	it("resolves glm-5.2 from the Shofer router catalog (1M context), not the 200k OpenRouter default", async () => {
		const handler = new ShoferHandler(options)

		const { info } = await handler.fetchModel()

		// Regression: pre-fix this fell back to openRouterDefaultModelInfo
		// (200k context, 8k max output), condensing at ~20% of the real window.
		expect(info.contextWindow).toBe(1_000_000)
		expect(info.maxTokens).toBe(131_072)
	})

	it("fetches its model catalog from the Shofer router, never openrouter.ai", async () => {
		const handler = new ShoferHandler(options)
		await handler.fetchModel()

		const providers = (getModels as unknown as { mock: { calls: [{ provider: string }][] } }).mock.calls.map(
			([opts]) => opts.provider,
		)
		expect(providers).toContain("shofer")
		expect(providers).not.toContain("openrouter")
	})

	it("passes the configured Shofer base URL and key through to the fetcher", async () => {
		const handler = new ShoferHandler(options)
		await handler.fetchModel()

		expect(getModels).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "shofer",
				baseUrl: "http://localhost:30081/v1",
				apiKey: "shofer",
			}),
		)
	})
})

describe("normalizeReasoningStream (Shofer Router)", () => {
	it("mirrors delta.reasoning_content into delta.reasoning (GLM/DeepSeek convention)", async () => {
		const out = await collect(
			normalizeReasoningStream(
				streamOf([
					{ choices: [{ delta: { reasoning_content: "Let me think" } }] },
					{ choices: [{ delta: { content: "the answer" } }] },
				]),
			),
		)

		expect(out[0].choices[0].delta.reasoning).toBe("Let me think")
		// content chunk is untouched
		expect(out[1].choices[0].delta.reasoning).toBeUndefined()
		expect(out[1].choices[0].delta.content).toBe("the answer")
	})

	it("does not overwrite an existing delta.reasoning", async () => {
		const out = await collect(
			normalizeReasoningStream(
				streamOf([{ choices: [{ delta: { reasoning: "primary", reasoning_content: "dup" } }] }]),
			),
		)
		expect(out[0].choices[0].delta.reasoning).toBe("primary")
	})

	it("passes through chunks with no delta / no reasoning fields unchanged", async () => {
		const usage = { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.001 } }
		const out = await collect(normalizeReasoningStream(streamOf([usage, { foo: "bar" }])))
		expect(out[0]).toBe(usage)
		expect(out[1]).toEqual({ foo: "bar" })
	})
})
