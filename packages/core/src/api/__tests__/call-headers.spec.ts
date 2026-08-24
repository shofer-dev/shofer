/**
 * The per-request model-call header seam (`api/call-headers.ts`).
 *
 * Three halves, and only the first is about the broadcast. The second and third
 * exist because every part of this seam that could quietly not work lives below
 * the surface a stub would reproduce: the provider's SDK client is built once and
 * shared, its only per-request hook is the custom `fetch`, and the value gets
 * there through an `AsyncLocalStorage` that has to survive an async generator
 * being resumed by whoever pulls it. So the wire tests drive a REAL `OpenAI` SDK
 * client, wired the way `buildApiHandler` wires it, against a REAL `node:http`
 * server.
 */

import { createServer, type IncomingMessage, type Server } from "node:http"
import { AddressInfo } from "node:net"

import type { ModelCallHeadersQuestion, ShoferPlugin } from "@shofer/types"

import { pluginRegistry } from "../../plugins/plugin-registry.js"
import { buildApiHandler } from "../index.js"
import {
	RESOLVE_MODEL_CALL_HEADERS,
	currentModelCallHeaders,
	fetchWithModelCallHeaders,
	modelCallHeadersStream,
	resolveModelCallHeaders,
	withModelCallHeaders,
} from "../call-headers.js"

/** Register a plugin answering the header broadcast, and remove it after the test. */
function usePlugin(name: string, answer: (params: unknown) => unknown): void {
	const plugin: ShoferPlugin = {
		name,
		async handleRequest(method: string, params: unknown) {
			if (method !== RESOLVE_MODEL_CALL_HEADERS) throw new Error(`unknown method ${method}`)
			return answer(params)
		},
	}
	beforeEach(async () => {
		await pluginRegistry.register(plugin)
	})
	afterEach(() => {
		pluginRegistry.unregister(name)
	})
}

const question: ModelCallHeadersQuestion = {
	operation: "chat",
	provider: "openai",
	model: "test-model",
	taskId: "task-1",
	rootTaskId: "task-1",
}

describe("resolveModelCallHeaders", () => {
	it("resolves to nothing when no plugin answers — the pre-plugin path", async () => {
		expect(await resolveModelCallHeaders(question)).toEqual({})
	})

	describe("with a plugin answering", () => {
		const seen: unknown[] = []
		usePlugin("model-headers-1", (params) => {
			seen.push(params)
			return { headers: { traceparent: "00-aaaa-bbbb-01" } }
		})

		it("hands the plugin the profile and the run it is answering for", async () => {
			seen.length = 0
			expect(await resolveModelCallHeaders(question)).toEqual({ traceparent: "00-aaaa-bbbb-01" })
			expect(seen[0]).toEqual(question)
		})
	})

	describe("with a plugin that answers badly", () => {
		usePlugin("model-headers-bad", () => ({
			headers: {
				Authorization: "Bearer stolen",
				"x-api-key": "stolen",
				"Content-Type": "text/plain",
				Host: "elsewhere.invalid",
				"": "x",
				"X-Fine": "yes",
			},
		}))

		it("refuses every credential and transport header and keeps the rest", async () => {
			expect(await resolveModelCallHeaders(question)).toEqual({ "X-Fine": "yes" })
		})
	})

	describe("with two plugins claiming the same header", () => {
		usePlugin("model-headers-first", () => ({ headers: { traceparent: "first" } }))
		usePlugin("model-headers-second", () => ({ headers: { TRACEPARENT: "second", "X-Other": "b" } }))

		it("keeps the first answer, case-insensitively, and still takes the rest", async () => {
			expect(await resolveModelCallHeaders(question)).toEqual({ traceparent: "first", "X-Other": "b" })
		})
	})

	describe("with a plugin that throws", () => {
		usePlugin("model-headers-throws", () => {
			throw new Error("no context for you")
		})

		it("degrades to no headers rather than failing the request", async () => {
			expect(await resolveModelCallHeaders(question)).toEqual({})
		})
	})
})

describe("withModelCallHeaders", () => {
	it("is invisible outside its own async context", async () => {
		expect(currentModelCallHeaders()).toBeUndefined()
		await withModelCallHeaders({ A: "1" }, async () => {
			expect(currentModelCallHeaders()).toEqual({ A: "1" })
		})
		expect(currentModelCallHeaders()).toBeUndefined()
	})

	it("enters no context at all for an empty set", () => {
		withModelCallHeaders({}, () => expect(currentModelCallHeaders()).toBeUndefined())
		withModelCallHeaders(undefined, () => expect(currentModelCallHeaders()).toBeUndefined())
	})

	it("keeps concurrent requests apart — the reason this is not a shared field", async () => {
		const [a, b] = await Promise.all([
			withModelCallHeaders({ traceparent: "a" }, async () => {
				await new Promise((r) => setTimeout(r, 10))
				return currentModelCallHeaders()?.traceparent
			}),
			withModelCallHeaders({ traceparent: "b" }, async () => currentModelCallHeaders()?.traceparent),
		])
		expect([a, b]).toEqual(["a", "b"])
	})
})

/**
 * The real seam: an OpenAI-compatible endpoint on an actual socket, reached by
 * the actual SDK through an actual `buildApiHandler` handler.
 */
describe("the header on the wire (real OpenAI SDK, real HTTP)", () => {
	/** Every request the server received, with the two headers this seam is about. */
	let received: Array<{ authorization: string | undefined; traceparent: string | undefined }>
	let server: Server
	let baseUrl: string

	const readBody = (req: IncomingMessage): Promise<string> =>
		new Promise((resolve) => {
			let body = ""
			req.on("data", (c) => (body += c))
			req.on("end", () => resolve(body))
		})

	beforeEach(async () => {
		received = []
		server = createServer(async (req, res) => {
			await readBody(req)
			received.push({
				authorization: req.headers.authorization,
				traceparent: req.headers.traceparent as string | undefined,
			})
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					id: "c-1",
					object: "chat.completion",
					created: 0,
					model: "test-model",
					choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				}),
			)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
	})

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	})

	const handler = () =>
		buildApiHandler(
			{
				apiProvider: "openai",
				openAiBaseUrl: baseUrl,
				openAiApiKey: "the-real-key",
				openAiModelId: "test-model",
			},
			{ taskId: "task-1" },
		) as ReturnType<typeof buildApiHandler> & { completePrompt(p: string): Promise<string> }

	it("leaves a request exactly as it was when no plugin answers", async () => {
		expect(await handler().completePrompt("hi")).toBe("ok")
		expect(received).toHaveLength(1)
		expect(received[0]).toEqual({ authorization: "Bearer the-real-key", traceparent: undefined })
	})

	describe("with a plugin answering", () => {
		usePlugin("model-headers-wire", () => ({
			headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
		}))

		it("puts the answered header on the request", async () => {
			expect(await handler().completePrompt("hi")).toBe("ok")
			expect(received[0]?.traceparent).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
		})

		it("never displaces the provider's own credential", async () => {
			await handler().completePrompt("hi")
			expect(received[0]?.authorization).toBe("Bearer the-real-key")
		})
	})

	describe("with a plugin trying to take the credential", () => {
		usePlugin("model-headers-thief", () => ({
			headers: { Authorization: "Bearer stolen", traceparent: "00-a-b-01" },
		}))

		it("keeps the provider's credential and takes only the rest", async () => {
			await handler().completePrompt("hi")
			expect(received[0]).toEqual({ authorization: "Bearer the-real-key", traceparent: "00-a-b-01" })
		})
	})

	/**
	 * The risky assumption this seam rests on: an async generator's body resumes
	 * in the context of whoever called `next()`, so the store has to be
	 * established around **every pull**, not around the generator's creation. A
	 * request the provider issues after its first `yield` is the case that would
	 * silently lose the header.
	 */
	it("keeps the context across a generator's yields, not just its first segment", async () => {
		const seen: Array<string | undefined> = []
		const probe = async () => {
			await fetchWithModelCallHeaders(`${baseUrl}/chat/completions`, { method: "POST", body: "{}" })
			seen.push(received.at(-1)?.traceparent)
		}
		async function* provider(): AsyncGenerator<number> {
			await probe()
			yield 1
			await probe()
			yield 2
		}

		await pluginRegistry.register({
			name: "model-headers-generator",
			async handleRequest(method: string) {
				if (method !== RESOLVE_MODEL_CALL_HEADERS) throw new Error(`unknown method ${method}`)
				return { headers: { traceparent: "00-gen-1-01" } }
			},
		})
		const pulled: number[] = []
		try {
			const stream = modelCallHeadersStream(
				() => ({ operation: "chat", provider: "openai", taskId: "task-1" }),
				() => provider(),
			)
			for await (const value of stream) {
				pulled.push(value)
			}
		} finally {
			pluginRegistry.unregister("model-headers-generator")
		}

		expect(pulled).toEqual([1, 2])
		expect(seen).toEqual(["00-gen-1-01", "00-gen-1-01"])
	})
})
