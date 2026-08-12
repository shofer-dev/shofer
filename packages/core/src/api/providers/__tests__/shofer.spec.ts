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

import type { Anthropic } from "@anthropic-ai/sdk"

import { ShoferHandler, normalizeReasoningStream } from "../shofer.js"
import { OpenRouterHandler } from "../openrouter.js"
import { getModels } from "../fetchers/modelCache.js"
import type { ApiHandlerOptions } from "../_deps.js"
import { convertToOpenAiMessages } from "../../transform/openai-format.js"
import { humanMessageBlock } from "../../../utils/user-message.js"

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

describe("ShoferHandler request stamping", () => {
	const options = {
		apiModelId: "zhipu/glm-5.2",
		shoferBaseUrl: "http://localhost:30081/v1",
		shoferApiKey: "shofer",
	} as ApiHandlerOptions

	const envDetails: Anthropic.Messages.TextBlockParam = {
		type: "text",
		text: "<environment_details>\n# Current Time\n2026-08-07\n</environment_details>",
	}

	/**
	 * Drives ONLY the client patch under test. The inherited OpenRouter
	 * `createMessage` is replaced by a stub that performs the one call the
	 * ShoferHandler intercepts — with the REAL Anthropic→OpenAI conversion, so
	 * the captured `messages` are the ones a live request would carry.
	 */
	async function capture(messages: Anthropic.Messages.MessageParam[]): Promise<Record<string, unknown>> {
		const captured: Record<string, unknown>[] = []
		const stub = async function* (
			this: { client: { chat: { completions: { create: (body: Record<string, unknown>) => Promise<void> } } } },
			systemPrompt: string,
			msgs: Anthropic.Messages.MessageParam[],
		) {
			await this.client.chat.completions.create({
				model: "zhipu/glm-5.2",
				messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(msgs)],
			})
			yield* []
		}
		const spy = vi.spyOn(OpenRouterHandler.prototype, "createMessage").mockImplementation(stub as never)
		try {
			const handler = new ShoferHandler(options)
			Object.assign(handler, {
				client: {
					chat: {
						completions: {
							create: async (body: Record<string, unknown>) => {
								captured.push(body)
							},
						},
					},
				},
			})
			for await (const chunk of handler.createMessage("SYSTEM", messages, { taskId: "task-1" })) {
				void chunk
			}
		} finally {
			spy.mockRestore()
		}
		return captured[0]!
	}

	it("sends the human's words as a sibling field, leaving the prompt byte-identical", async () => {
		const body = await capture([{ role: "user", content: [humanMessageBlock("List my VMs."), envDetails] }])

		expect(body.task_id).toBe("task-1")
		expect(body.human_text).toBe("List my VMs.")

		// THE assertion that must fail if the model's prompt ever changes: the
		// wrapper and the environment-details block are still there, still their
		// own parts, still spelled exactly as before. `human_text` is metadata
		// ABOUT this prompt, never a substitute for it.
		expect(body.messages).toEqual([
			{ role: "system", content: "SYSTEM" },
			{
				role: "user",
				content: [
					{ type: "text", text: "<user_message>\nList my VMs.\n</user_message>" },
					{ type: "text", text: "<environment_details>\n# Current Time\n2026-08-07\n</environment_details>" },
				],
			},
		])
	})

	it("omits human_text on a turn the human did not speak in", async () => {
		const body = await capture([
			{ role: "user", content: [humanMessageBlock("List my VMs.")] },
			{ role: "assistant", content: [{ type: "text", text: "listing" }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "2 VMs" },
					envDetails,
				] as Anthropic.Messages.ContentBlockParam[],
			},
		])

		expect(body.task_id).toBe("task-1")
		expect("human_text" in body).toBe(false)
	})
})

describe("ShoferHandler reasoning directive", () => {
	const baseOptions = {
		apiModelId: "zhipu/glm-5.2",
		shoferBaseUrl: "http://localhost:30081/v1",
		shoferApiKey: "shofer",
	}

	/**
	 * Capture the body that reaches llm-router for a given settings shape.
	 * `parentParams` stands in for whatever the inherited OpenRouter handler put
	 * into the completion params — including its own OpenRouter-shaped `reasoning`.
	 */
	async function captureWith(
		settings: Partial<ApiHandlerOptions>,
		parentParams: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		const captured: Record<string, unknown>[] = []
		const stub = async function* (this: {
			client: { chat: { completions: { create: (body: Record<string, unknown>) => Promise<void> } } }
		}) {
			await this.client.chat.completions.create({ model: "zhipu/glm-5.2", messages: [], ...parentParams })
			yield* []
		}
		const spy = vi.spyOn(OpenRouterHandler.prototype, "createMessage").mockImplementation(stub as never)
		try {
			const handler = new ShoferHandler({ ...baseOptions, ...settings } as ApiHandlerOptions)
			Object.assign(handler, {
				client: {
					chat: {
						completions: {
							create: async (body: Record<string, unknown>) => {
								captured.push(body)
							},
						},
					},
				},
			})
			for await (const chunk of handler.createMessage("SYSTEM", [], { taskId: "task-1" })) void chunk
		} finally {
			spy.mockRestore()
		}
		return captured[0]!
	}

	it("sends an explicit off switch when reasoning is disabled", async () => {
		// The router defaults thinking ON for several upstreams, so silence is not
		// "off" — the directive has to be on the wire.
		expect(await captureWith({ enableReasoningEffort: false })).toMatchObject({
			reasoning: { enabled: false },
		})
	})

	it("sends the off switch even when the catalog never advertised reasoning", async () => {
		// No model info is consulted at all: turning thinking off must not depend on
		// the router's catalog knowing this model thinks.
		const body = await captureWith({ enableReasoningEffort: false, apiModelId: "arkware/unknown-model" })
		expect(body.reasoning).toEqual({ enabled: false })
	})

	it("sends the selected effort", async () => {
		expect((await captureWith({ reasoningEffort: "low" })).reasoning).toEqual({ effort: "low" })
	})

	it("maps the settings-only 'disable' sentinel onto the router's 'none'", async () => {
		expect((await captureWith({ reasoningEffort: "disable" })).reasoning).toEqual({ effort: "none" })
	})

	it("carries a thinking budget alongside a selected effort", async () => {
		expect((await captureWith({ reasoningEffort: "high", modelMaxThinkingTokens: 4096 })).reasoning).toEqual({
			effort: "high",
			max_tokens: 4096,
		})
	})

	it("sends a budget-only directive when only the thinking budget is set", async () => {
		expect((await captureWith({ modelMaxThinkingTokens: 2048 })).reasoning).toEqual({ max_tokens: 2048 })
	})

	it("omits the field entirely when nothing is configured", async () => {
		expect("reasoning" in (await captureWith({}))).toBe(false)
	})

	it("wins over a reasoning object computed by the inherited OpenRouter path", async () => {
		const body = await captureWith(
			{ enableReasoningEffort: false },
			{ reasoning: { effort: "high" }, include_reasoning: true },
		)

		expect(body.reasoning).toEqual({ enabled: false })
		// Sibling params the parent set are untouched — only `reasoning` is ours.
		expect(body.include_reasoning).toBe(true)
	})

	it("drops the parent's OpenRouter-vocabulary reasoning when we derive none", async () => {
		// `{ exclude: true }` is a shape llm-router does not accept; omitting the
		// field is what "provider default" means on this wire.
		const body = await captureWith({}, { reasoning: { exclude: true } })
		expect("reasoning" in body).toBe(false)
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
