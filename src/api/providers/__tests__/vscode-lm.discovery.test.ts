// npx vitest src/api/providers/__tests__/vscode-lm.discovery.test.ts

/**
 * The VS Code Language Model provider's DISCOVERY and side-channel half —
 * everything around the stream, which the sibling spec already drives.
 *
 * Two things here are load-bearing and easy to break silently:
 *
 *  - **Every side-channel lookup is optional.** Capability, pricing and
 *    per-request cost come from the LLM Local Router extension over
 *    `vscode.commands`, which simply does not exist on a machine without it.
 *    Each miss must leave the field UNSET — `undefined` means "not available",
 *    never "the model cannot do this" — and must warn at most once per session
 *    rather than on every model, or a plain Copilot user gets a wall of noise.
 *  - **No matching model is an ERROR, not a stub.** Returning a placeholder
 *    model used to produce a canned reply carrying no tool call, which the agent
 *    loop then rejected forever with "you did not use a tool". The real cause
 *    has to surface.
 */

const hoisted = vi.hoisted(() => ({
	selectChatModels: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
	executeCommand: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
	integrationEnabled: false,
	warnings: [] as string[],
	disposeConfigListener: vi.fn(),
}))

vi.mock("vscode", () => ({
	workspace: {
		onDidChangeConfiguration: vi.fn(() => ({ dispose: hoisted.disposeConfigListener })),
		getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
	},
	lm: { selectChatModels: hoisted.selectChatModels },
	commands: { executeCommand: hoisted.executeCommand },
	CancellationTokenSource: class {
		token = { isCancellationRequested: false, onCancellationRequested: vi.fn() }
		cancel = vi.fn()
		dispose = vi.fn()
	},
	LanguageModelChatMessage: { Assistant: vi.fn(), User: vi.fn() },
	CancellationError: class CancellationError extends Error {},
	LanguageModelTextPart: class {
		constructor(public value: string) {}
	},
	LanguageModelToolCallPart: class {
		constructor(
			public callId: string,
			public name: string,
			public input: unknown,
		) {}
	},
}))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ config: { get: () => hoisted.integrationEnabled } }),
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	apiLog: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: (m: string) => hoisted.warnings.push(m),
		error: vi.fn(),
	},
}))

import { getVsCodeLmModels, VsCodeLmHandler } from "../vscode-lm"

function model(overrides: Record<string, unknown> = {}) {
	return {
		id: "copilot/gpt-4o",
		vendor: "copilot",
		family: "gpt-4o",
		version: "1",
		name: "GPT-4o",
		maxInputTokens: 128_000,
		countTokens: vi.fn(async () => 7),
		sendRequest: vi.fn(),
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.warnings = []
	hoisted.selectChatModels.mockResolvedValue([model()])
	hoisted.executeCommand.mockResolvedValue(undefined)
	hoisted.integrationEnabled = false
	// The opt-in flag is cached on the class after its first read; clear it so
	// each test decides for itself.
	;(VsCodeLmHandler as unknown as { _llmProviderIntegrationEnabled?: boolean })._llmProviderIntegrationEnabled =
		undefined
})

describe("getVsCodeLmModels", () => {
	it("projects the fields the settings picker renders", async () => {
		const [descriptor] = await getVsCodeLmModels()

		expect(descriptor).toMatchObject({
			id: "copilot/gpt-4o",
			vendor: "copilot",
			family: "gpt-4o",
			version: "1",
			name: "GPT-4o",
			maxInputTokens: 128_000,
		})
	})

	it("leaves the router-supplied fields UNSET when the extension is not installed", async () => {
		hoisted.executeCommand.mockRejectedValue(new Error("command not found"))

		const [descriptor] = await getVsCodeLmModels()

		expect(descriptor.shoferCapabilities).toBeUndefined()
		expect(descriptor.shoferPricing).toBeUndefined()
	})

	it("enriches from the router, trying the id and then the slash-free family", async () => {
		hoisted.executeCommand.mockImplementation(async (command: unknown, candidate: unknown) => {
			if (candidate !== "gpt-4o") return undefined
			return command === "llmLocalRouter.getModelCapabilities"
				? { supportsImages: true }
				: { inputPrice: 1, outputPrice: 2 }
		})

		const [descriptor] = await getVsCodeLmModels()

		expect(descriptor.shoferCapabilities).toEqual({ supportsImages: true })
		expect(descriptor.shoferPricing).toEqual({ inputPrice: 1, outputPrice: 2 })
	})

	it("forwards the runtime capability flags when the build exposes them", async () => {
		hoisted.selectChatModels.mockResolvedValue([model({ capabilities: { imageInput: true, toolCalling: false } })])

		const [descriptor] = await getVsCodeLmModels()

		expect(descriptor.capabilities).toEqual({ imageInput: true, toolCalling: false })
	})

	it("omits the capabilities key on a build that exposes none", async () => {
		const [descriptor] = await getVsCodeLmModels()

		expect(descriptor.capabilities).toBeUndefined()
	})

	it("answers an EMPTY list — never throws — when enumeration fails", async () => {
		hoisted.selectChatModels.mockRejectedValue(new Error("lm api unavailable"))

		await expect(getVsCodeLmModels()).resolves.toEqual([])
	})

	it("answers an empty list when the API returns nothing at all", async () => {
		hoisted.selectChatModels.mockResolvedValue(undefined as never)

		await expect(getVsCodeLmModels()).resolves.toEqual([])
	})
})

describe("the handler's client", () => {
	it("REFUSES loudly when no model matches the selector", async () => {
		// Built while selection succeeds: the constructor kicks `initializeClient`
		// off fire-and-forget, so a failing selection at CONSTRUCTION time surfaces
		// as an unhandled rejection rather than as this error.
		const handler = new VsCodeLmHandler({} as never)
		hoisted.selectChatModels.mockResolvedValue([])

		await expect(handler.createClient({ vendor: "nobody" } as never)).rejects.toThrow(
			/No language model matched selector/,
		)
	})

	it("names the underlying failure when selection itself throws", async () => {
		const handler = new VsCodeLmHandler({} as never)
		hoisted.selectChatModels.mockRejectedValue(new Error("lm api unavailable"))

		await expect(handler.createClient({} as never)).rejects.toThrow(/lm api unavailable/)
	})

	it("takes the FIRST matching model", async () => {
		hoisted.selectChatModels.mockResolvedValue([model({ id: "first" }), model({ id: "second" })])
		const handler = new VsCodeLmHandler({} as never)

		await expect(handler.createClient({} as never)).resolves.toMatchObject({ id: "first" })
	})

	it("initializeClient is idempotent — a second call reuses the client", async () => {
		const handler = new VsCodeLmHandler({} as never)
		await handler.initializeClient()
		const callsAfterFirst = hoisted.selectChatModels.mock.calls.length

		await handler.initializeClient()

		expect(hoisted.selectChatModels.mock.calls.length).toBe(callsAfterFirst)
	})

	it("dispose releases the configuration listener", () => {
		const handler = new VsCodeLmHandler({} as never)

		handler.dispose()

		expect(hoisted.disposeConfigListener).toHaveBeenCalled()
	})
})

describe("countTokens", () => {
	it("delegates to the model's own tokenizer", async () => {
		const handler = new VsCodeLmHandler({} as never)
		await handler.initializeClient()

		await expect(handler.countTokens([{ type: "text", text: "hello" }] as never)).resolves.toBe(7)
	})

	it("substitutes a PLACEHOLDER for an image — the LM API takes none", async () => {
		const chat = model()
		hoisted.selectChatModels.mockResolvedValue([chat])
		const handler = new VsCodeLmHandler({} as never)
		await handler.initializeClient()

		await handler.countTokens([
			{ type: "text", text: "look:" },
			{ type: "image", source: {} },
		] as never)

		expect(chat.countTokens).toHaveBeenCalledWith("look:[IMAGE]", expect.anything())
	})

	it("answers ZERO rather than throwing when there is no client to ask", async () => {
		const handler = new VsCodeLmHandler({} as never)
		;(handler as unknown as { client: unknown }).client = null

		await expect(handler.countTokens([{ type: "text", text: "x" }] as never)).resolves.toBe(0)
	})
})

describe("the LLM-Local-Router side channel", () => {
	it("is SKIPPED entirely while the integration setting is off", async () => {
		hoisted.integrationEnabled = false
		const handler = new VsCodeLmHandler({} as never)

		await handler.initializeClient()
		await Promise.resolve()

		expect(
			hoisted.executeCommand.mock.calls.filter(([command]) => String(command).startsWith("llmLocalRouter.")),
		).toEqual([])
	})

	it("looks up pricing and capabilities once the setting is on", async () => {
		hoisted.integrationEnabled = true
		hoisted.executeCommand.mockResolvedValue({ inputPrice: 1, outputPrice: 2 })
		const handler = new VsCodeLmHandler({} as never)

		await handler.initializeClient()
		await vi.waitFor(() =>
			expect(hoisted.executeCommand.mock.calls.some(([c]) => c === "llmLocalRouter.getModelPricing")).toBe(true),
		)
	})

	it("WARNS AT MOST ONCE when the router command is missing", async () => {
		hoisted.integrationEnabled = true
		hoisted.executeCommand.mockRejectedValue(new Error("command not found"))
		;(
			VsCodeLmHandler as unknown as { _warnedMissingPricing?: boolean; _warnedMissingCapabilities?: boolean }
		)._warnedMissingPricing = false

		const first = new VsCodeLmHandler({} as never)
		await first.initializeClient()
		const second = new VsCodeLmHandler({} as never)
		await second.initializeClient()
		await vi.waitFor(() => expect(hoisted.warnings.length).toBeGreaterThan(0))

		const pricingWarnings = hoisted.warnings.filter((w) => w.includes("getModelPricing"))
		expect(pricingWarnings.length).toBeLessThanOrEqual(1)
	})
})

describe("createMessage's chunk translation", () => {
	type Chunk = { type: string; [k: string]: unknown }

	/** The null-byte-delimited markers llm-provider emits inside a thinking part. */
	const NUL = "\u0000"

	/** Drive `createMessage` with a scripted response stream. */
	async function streamWith(
		parts: unknown[],
		metadata: Record<string, unknown> = {},
	): Promise<{ chunks: Chunk[]; sendRequest: ReturnType<typeof vi.fn> }> {
		const sendRequest = vi.fn(async () => ({
			stream: (async function* () {
				for (const part of parts) yield part
			})(),
		}))
		hoisted.selectChatModels.mockResolvedValue([model({ sendRequest })])
		const handler = new VsCodeLmHandler({} as never)
		await handler.initializeClient()

		const chunks: Chunk[] = []
		for await (const chunk of handler.createMessage(
			"SYSTEM",
			[{ role: "user", content: "hello" }] as never,
			metadata as never,
		)) {
			chunks.push(chunk as Chunk)
		}
		return { chunks, sendRequest }
	}

	async function text(value: string) {
		const vscode = (await import("vscode")) as unknown as {
			LanguageModelTextPart: new (v: string) => unknown
		}
		return new vscode.LanguageModelTextPart(value)
	}

	async function toolCall(callId: string, name: string, input: unknown) {
		const vscode = (await import("vscode")) as unknown as {
			LanguageModelToolCallPart: new (c: string, n: string, i: unknown) => unknown
		}
		return new vscode.LanguageModelToolCallPart(callId, name, input)
	}

	it("carries the system prompt and the task ids in modelOptions — the API has no System role", async () => {
		const { sendRequest } = await streamWith([await text("hi")])

		const [, options] = sendRequest.mock.calls[0] as [unknown, { modelOptions: Record<string, unknown> }]
		expect(options.modelOptions).toMatchObject({ systemPrompt: "SYSTEM" })
		expect(options.modelOptions.taskId).toBeTypeOf("string")
	})

	it("streams text parts through", async () => {
		const { chunks } = await streamWith([await text("he"), await text("llo")])

		expect(chunks.filter((c) => c.type === "text").map((c) => c.text)).toEqual(["he", "llo"])
	})

	it("emits a tool_call ONLY when the caller advertised tools", async () => {
		const withTools = await streamWith([await toolCall("c1", "read_file", { path: "a.ts" })], {
			tools: [{ type: "function", function: { name: "read_file" } }],
		})
		expect(withTools.chunks.find((c) => c.type === "tool_call")).toMatchObject({
			id: "c1",
			name: "read_file",
			arguments: '{"path":"a.ts"}',
		})

		const without = await streamWith([await toolCall("c1", "read_file", {})])
		expect(without.chunks.find((c) => c.type === "tool_call")).toBeUndefined()
	})

	it("SKIPS a tool call with no name or no callId rather than emitting a broken one", async () => {
		const { chunks } = await streamWith([await toolCall("", "read_file", {}), await toolCall("c1", "", {})], {
			tools: [{ type: "function", function: { name: "read_file" } }],
		})

		expect(chunks.filter((c) => c.type === "tool_call")).toEqual([])
	})

	it("treats an unrecognised part carrying text as REASONING", async () => {
		const { chunks } = await streamWith([{ value: "thinking out loud" }])

		expect(chunks.find((c) => c.type === "reasoning")).toMatchObject({ text: "thinking out loud" })
	})

	it("decodes the tool_preparing marker into a typed chunk", async () => {
		const { chunks } = await streamWith([{ value: `${NUL}tool_preparing${NUL}read_file${NUL}128${NUL}` }])

		expect(chunks.find((c) => c.type === "tool_preparing")).toMatchObject({
			toolName: "read_file",
			byteCount: 128,
		})
	})

	it("decodes the response_metadata marker, and SILENTLY ignores a malformed one", async () => {
		const payload = JSON.stringify({
			model: "shofer/auto",
			actualModel: "gpt-5",
			ttfbMs: 120,
			promptTokens: 100,
			completionTokens: 20,
		})
		const decoded = await streamWith([{ value: `${NUL}response_metadata${NUL}${payload}${NUL}` }])
		expect(decoded.chunks.find((c) => c.type === "response_metadata")).toMatchObject({
			model: "shofer/auto",
			actualModel: "gpt-5",
			promptTokens: 100,
		})

		const malformed = await streamWith([{ value: `${NUL}response_metadata${NUL}{not json}${NUL}` }])
		expect(malformed.chunks.find((c) => c.type === "response_metadata")).toBeUndefined()
	})

	it("WARNS about a chunk it cannot interpret rather than emitting nothing silently", async () => {
		const { chunks } = await streamWith([{ notAValue: true }])

		expect(chunks.filter((c) => c.type === "text" || c.type === "reasoning")).toEqual([])
		expect(hoisted.warnings.join(" ")).toContain("Unknown chunk type")
	})

	it("ends with a usage chunk carrying the counted tokens", async () => {
		const { chunks } = await streamWith([await text("hello")])

		expect(chunks.at(-1)).toMatchObject({ type: "usage" })
	})
})

describe("the per-request cost side channel", () => {
	/** Drive one complete request and hand back the usage chunk it ends with. */
	async function usageAfterRequest(metadata: Record<string, unknown> = { taskId: "t-9" }) {
		const vscode = (await import("vscode")) as unknown as { LanguageModelTextPart: new (v: string) => unknown }
		const sendRequest = vi.fn(async () => ({
			stream: (async function* () {
				yield new vscode.LanguageModelTextPart("hello")
			})(),
		}))
		hoisted.selectChatModels.mockResolvedValue([model({ sendRequest })])
		const handler = new VsCodeLmHandler({} as never)
		await handler.initializeClient()

		let usage: Record<string, unknown> | undefined
		for await (const chunk of handler.createMessage(
			"S",
			[{ role: "user", content: "hi" }] as never,
			metadata as never,
		)) {
			if ((chunk as { type: string }).type === "usage") usage = chunk as unknown as Record<string, unknown>
		}
		return usage
	}

	it("stays SILENT when the integration is off — no command is issued at all", async () => {
		hoisted.integrationEnabled = false

		const usage = await usageAfterRequest()

		expect(usage?.totalCost).toBeUndefined()
		expect(hoisted.executeCommand).not.toHaveBeenCalledWith("llmLocalRouter.getRequestCost", expect.anything())
	})

	it("yields the DELTA over the conversation total, not the running total", async () => {
		hoisted.integrationEnabled = true
		// Before the request the conversation had spent $1; afterwards $1.25.
		hoisted.executeCommand.mockImplementation(async (command: unknown) =>
			command === "llmLocalRouter.getRequestCost"
				? hoisted.executeCommand.mock.calls.filter(([c]) => c === "llmLocalRouter.getRequestCost").length === 1
					? 1
					: 1.25
				: undefined,
		)

		const usage = await usageAfterRequest()

		// Shofer sums per-message costs, so reporting the running total would
		// double-count every earlier turn.
		expect(usage?.totalCost).toBeCloseTo(0.25)
	})

	it("WARNS once and carries no cost when the command is not registered", async () => {
		hoisted.integrationEnabled = true
		;(VsCodeLmHandler as unknown as { _warnedMissingRequestCost?: boolean })._warnedMissingRequestCost = false
		hoisted.executeCommand.mockRejectedValue(new Error("command not found"))

		const usage = await usageAfterRequest()

		expect(usage?.totalCost).toBeUndefined()
		expect(hoisted.warnings.join(" ")).toContain("llmLocalRouter.getRequestCost command not found")

		hoisted.warnings = []
		await usageAfterRequest()
		expect(hoisted.warnings.join(" ")).not.toContain("llmLocalRouter.getRequestCost command not found")
	})

	it("IGNORES a nonsensical cost rather than reporting it", async () => {
		hoisted.integrationEnabled = true
		hoisted.executeCommand.mockResolvedValue(Number.NaN)

		const usage = await usageAfterRequest()

		expect(usage?.totalCost).toBeUndefined()
	})

	it("attributes the lookup to a task id even when the caller supplied none", async () => {
		hoisted.integrationEnabled = true

		await usageAfterRequest({})

		// A standalone handler mints its own session id in the constructor, so
		// the cost is still attributable rather than being dropped.
		const [, taskId] = hoisted.executeCommand.mock.calls.find(
			([command]) => command === "llmLocalRouter.getRequestCost",
		) as [string, string]
		expect(taskId).toBeTypeOf("string")
		expect(taskId.length).toBeGreaterThan(0)
	})
})

describe("the Xiaomi diagnostic path", () => {
	/**
	 * Xiaomi/MiMo models get an extra logging pass over every stage of the
	 * request. It is diagnostics only, so what matters is that turning it on
	 * changes NOTHING about the chunks — a logging branch that swallows a chunk
	 * would be invisible on any other model.
	 */
	it("streams exactly what a non-Xiaomi model streams", async () => {
		const vscode = (await import("vscode")) as unknown as {
			LanguageModelTextPart: new (v: string) => unknown
			LanguageModelToolCallPart: new (c: string, n: string, i: unknown) => unknown
		}
		const parts = [
			new vscode.LanguageModelTextPart("hi"),
			new vscode.LanguageModelToolCallPart("c1", "read_file", { path: "a.ts" }),
		]
		const run = async (name: string) => {
			const sendRequest = vi.fn(async () => ({
				stream: (async function* () {
					for (const part of parts) yield part
				})(),
			}))
			hoisted.selectChatModels.mockResolvedValue([model({ name, sendRequest })])
			const handler = new VsCodeLmHandler({} as never)
			await handler.initializeClient()
			const chunks: Array<{ type: string }> = []
			for await (const chunk of handler.createMessage(
				"S",
				[{ role: "user", content: "hi" }] as never,
				{ taskId: "t-1", tools: [{ type: "function", function: { name: "read_file" } }] } as never,
			)) {
				chunks.push(chunk as { type: string })
			}
			return chunks.map((c) => c.type)
		}

		expect(await run("MiMo-7B")).toEqual(await run("GPT-4o"))
	})
})

describe("stream failures", () => {
	async function streamThatThrows(thrown: unknown) {
		// An async iterable whose FIRST pull rejects — a generator that only
		// throws is the same thing with a lint rule against it.
		const sendRequest = vi.fn(async () => ({
			stream: {
				[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(thrown) }),
			},
		}))
		hoisted.selectChatModels.mockResolvedValue([model({ sendRequest })])
		const handler = new VsCodeLmHandler({} as never)
		await handler.initializeClient()
		return async () => {
			for await (const _chunk of handler.createMessage(
				"S",
				[{ role: "user", content: "hi" }] as never,
				{
					taskId: "t-1",
				} as never,
			)) {
				void _chunk
			}
		}
	}

	it("re-throws an Error unchanged — its message is the one the user must see", async () => {
		const consume = await streamThatThrows(new Error("model is overloaded"))

		await expect(consume()).rejects.toThrow("model is overloaded")
	})

	it("WRAPS a thrown object so the loop gets an Error with the detail in it", async () => {
		const consume = await streamThatThrows({ code: 429, detail: "slow down" })

		await expect(consume()).rejects.toThrow(/slow down/)
	})

	it("wraps a thrown primitive too", async () => {
		const consume = await streamThatThrows("just a string")

		await expect(consume()).rejects.toThrow(/just a string/)
	})
})

describe("getModel", () => {
	it("derives the id from vendor/family/version when the client carries no id", async () => {
		hoisted.selectChatModels.mockResolvedValue([
			model({ id: "", vendor: "copilot", family: "gpt-4o", version: "1" }),
		])
		const handler = new VsCodeLmHandler({} as never)
		await handler.initializeClient()

		expect(handler.getModel().id).toBe("copilot/gpt-4o/1")
	})

	it("leaves the context window at ZERO when the host did not report one", async () => {
		hoisted.selectChatModels.mockResolvedValue([model({ maxInputTokens: undefined })])
		const handler = new VsCodeLmHandler({} as never)
		await handler.initializeClient()

		// A 128K guess would silently corrupt condensation math on a model that
		// actually supports far more; consumers must see the misconfiguration.
		expect(handler.getModel().info.contextWindow).toBe(0)
		expect(hoisted.warnings.join(" ")).toContain("missing maxInputTokens")
	})

	it("falls back to the SELECTOR's spelling when no client was ever created", () => {
		const handler = new VsCodeLmHandler({
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4o" },
		} as never)

		expect(handler.getModel().id).toContain("copilot")
	})
})
