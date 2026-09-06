import { DASHSCOPE_THINKING_MODELS, dashScopeDefaultModelId } from "@shofer/types"

/**
 * DashScope (Qwen) is a thin configuration layer over
 * `OpenAICompatibleHandler`, and everything it decides is decided in the
 * constructor — so that is what these tests read back off the mocked SDK
 * factory. Two of the decisions are load-bearing:
 *
 *  - the base URL defaults to the INTERNATIONAL host. The project forbids
 *    routing to a China/regional endpoint by default, and a wrong default here
 *    is invisible until a request is made from the wrong region.
 *  - `enable_thinking` is sent only for the models that actually have a
 *    thinking mode; sending it to a coder/instruct model is an API error.
 */

const createOpenAICompatible = vi.fn()
vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: (...a: unknown[]) => createOpenAICompatible(...a),
}))

const streamText = vi.fn()
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: (...a: unknown[]) => streamText(...a),
}))

import { DashScopeHandler } from "../dashscope.js"

/** The first model DashScope declares a thinking mode for. */
const THINKING_MODEL = [...DASHSCOPE_THINKING_MODELS][0]!

beforeEach(() => {
	vi.clearAllMocks()
	createOpenAICompatible.mockReturnValue((id: string) => ({ id }))
	streamText.mockReturnValue({ fullStream: (async function* () {})(), usage: Promise.resolve(undefined) })
})

describe("DashScopeHandler", () => {
	it("defaults to the international compatible-mode endpoint", () => {
		new DashScopeHandler({} as never)

		expect(createOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "dashscope",
				baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			}),
		)
	})

	it("honours an explicitly configured base URL", () => {
		new DashScopeHandler({ dashScopeBaseUrl: "https://elsewhere.example/v1" } as never)

		expect(createOpenAICompatible.mock.calls[0]![0].baseURL).toBe("https://elsewhere.example/v1")
	})

	it("substitutes a placeholder key rather than sending undefined", () => {
		new DashScopeHandler({} as never)

		expect(createOpenAICompatible.mock.calls[0]![0].apiKey).toBe("not-provided")
	})

	it("resolves the default model when none was configured", () => {
		const { id, info } = new DashScopeHandler({} as never).getModel()

		expect(id).toBe(dashScopeDefaultModelId)
		expect(info.contextWindow).toBeGreaterThan(0)
	})

	it("falls back to the default model info for an unknown id", () => {
		const { id, info } = new DashScopeHandler({ apiModelId: "qwen-does-not-exist" } as never).getModel()

		expect(id).toBe("qwen-does-not-exist")
		expect(info.contextWindow).toBeGreaterThan(0)
	})

	it("enables thinking only for a model that declares it", async () => {
		const thinking = new DashScopeHandler({ apiModelId: THINKING_MODEL } as never)
		for await (const _ of thinking.createMessage("sys", [{ role: "user", content: "hi" }])) void _
		expect(streamText.mock.calls[0]![0].providerOptions).toEqual({ dashscope: { enable_thinking: true } })

		streamText.mockClear()
		const plain = new DashScopeHandler({ apiModelId: "qwen-does-not-exist" } as never)
		for await (const _ of plain.createMessage("sys", [{ role: "user", content: "hi" }])) void _
		expect(streamText.mock.calls[0]![0].providerOptions).toBeUndefined()
	})
})
