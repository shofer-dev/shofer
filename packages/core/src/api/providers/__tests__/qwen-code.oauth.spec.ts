import * as os from "os"
import * as path from "path"

import type { Anthropic } from "@anthropic-ai/sdk"

const mockCreate = vi.fn()
const clientInstances: Array<{ apiKey: string; baseURL: string }> = []
vi.mock("openai", () => ({
	__esModule: true,
	default: vi.fn().mockImplementation(() => {
		const instance = { apiKey: "", baseURL: "", chat: { completions: { create: mockCreate } } }
		clientInstances.push(instance)
		return instance
	}),
}))

const readFile = vi.fn()
const writeFile = vi.fn()
// The provider reads its credential through `node:fs`'s promises namespace, so
// that is the module that has to be stubbed — `fs/promises` is a different
// specifier and mocking it reaches nothing here.
vi.mock("node:fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	const promises = {
		...(actual.promises as Record<string, unknown>),
		readFile: (...a: unknown[]) => readFile(...a),
		writeFile: (...a: unknown[]) => writeFile(...a),
	}
	return { ...actual, promises, default: { ...(actual.default as object), promises } }
})

import { QwenCodeHandler } from "../qwen-code.js"

/**
 * Qwen Code authenticates with an OAUTH credential file the `qwen` CLI writes,
 * not with an API key — which makes this provider's interesting behaviour token
 * lifecycle rather than streaming.
 *
 * Three properties matter:
 *
 *  - a token is refreshed BEFORE it expires (a 30s buffer), not after a 401,
 *    because a request that starts valid and expires mid-flight cannot be
 *    retried transparently;
 *  - concurrent turns share ONE refresh. Two tasks noticing an expired token at
 *    the same moment must not both spend the refresh token — the second would
 *    invalidate the first's result;
 *  - the endpoint comes from the CREDENTIAL (`resource_url`), because the OAuth
 *    grant is region-scoped; it is normalized to an absolute `/v1` URL since the
 *    file may carry a bare host.
 */

const USER: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hi" }]

const validCreds = (overrides: Record<string, unknown> = {}) => ({
	access_token: "access-1",
	refresh_token: "refresh-1",
	token_type: "Bearer",
	expiry_date: Date.now() + 3_600_000,
	...overrides,
})

function stubStream(chunks: unknown[] = [{ choices: [{ delta: { content: "hi" } }] }]) {
	mockCreate.mockResolvedValue({
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c
		},
	})
}

function stubTokenEndpoint(response: Record<string, unknown>, ok = true) {
	const fetchMock = vi.fn(async () => ({
		ok,
		status: ok ? 200 : 400,
		statusText: ok ? "OK" : "Bad Request",
		text: async () => JSON.stringify(response),
		json: async () => response,
	}))
	vi.stubGlobal("fetch", fetchMock)
	return fetchMock
}

async function drain(stream: AsyncIterable<unknown>) {
	const out: unknown[] = []
	for await (const c of stream) out.push(c)
	return out
}

beforeEach(() => {
	vi.clearAllMocks()
	clientInstances.length = 0
	readFile.mockResolvedValue(JSON.stringify(validCreds()))
	writeFile.mockResolvedValue(undefined)
	stubStream()
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("the credential file", () => {
	it("reads the CLI's default location", async () => {
		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(readFile.mock.calls[0]![0]).toBe(path.join(os.homedir(), ".qwen", "oauth_creds.json"))
	})

	it("expands a ~/ path and resolves a relative one", async () => {
		await drain(
			new QwenCodeHandler({ qwenCodeOauthPath: "~/custom/creds.json" } as never).createMessage("sys", USER),
		)
		expect(readFile.mock.calls[0]![0]).toBe(path.join(os.homedir(), "custom/creds.json"))

		readFile.mockClear()
		await drain(new QwenCodeHandler({ qwenCodeOauthPath: "./rel/creds.json" } as never).createMessage("sys", USER))
		expect(readFile.mock.calls[0]![0]).toBe(path.resolve("./rel/creds.json"))
	})

	it("names the file when it cannot be read or parsed", async () => {
		readFile.mockResolvedValue("{ not json")

		await expect(drain(new QwenCodeHandler({} as never).createMessage("sys", USER))).rejects.toThrow(
			/Failed to load Qwen OAuth credentials/,
		)
	})
})

describe("the endpoint comes from the credential", () => {
	it("uses the grant's resource_url, normalized to an absolute /v1 URL", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ resource_url: "dashscope-intl.aliyuncs.com" })))

		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(clientInstances.at(-1)!.baseURL).toBe("https://dashscope-intl.aliyuncs.com/v1")
	})

	it("leaves a URL that is already absolute and already /v1 alone", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ resource_url: "https://region.example/compatible/v1" })))

		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(clientInstances.at(-1)!.baseURL).toBe("https://region.example/compatible/v1")
	})

	it("falls back to the default endpoint when the credential names none", async () => {
		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(clientInstances.at(-1)!.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1")
	})

	it("puts the access token on the client", async () => {
		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(clientInstances.at(-1)!.apiKey).toBe("access-1")
	})
})

describe("token refresh", () => {
	it("refreshes a token inside the expiry BUFFER, before it is actually expired", async () => {
		// Still valid for 10 seconds — inside the 30s buffer, so it is refreshed
		// rather than used and lost mid-request.
		readFile.mockResolvedValue(JSON.stringify(validCreds({ expiry_date: Date.now() + 10_000 })))
		const fetchMock = stubTokenEndpoint({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 })

		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(clientInstances.at(-1)!.apiKey).toBe("access-2")
	})

	it("treats a credential with no expiry as unusable and refreshes it", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ expiry_date: undefined })))
		const fetchMock = stubTokenEndpoint({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 })

		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(fetchMock).toHaveBeenCalled()
	})

	it("persists the refreshed credential, keeping the old refresh token when none is returned", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ expiry_date: 0 })))
		stubTokenEndpoint({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 })

		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		const written = JSON.parse(String(writeFile.mock.calls[0]![1]))
		expect(written.access_token).toBe("access-2")
		expect(written.refresh_token).toBe("refresh-1")
	})

	it("keeps going when the refreshed credential cannot be written to disk", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ expiry_date: 0 })))
		stubTokenEndpoint({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 })
		writeFile.mockRejectedValue(new Error("read-only home"))

		await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		// The in-memory token still works; only the cache write was lost.
		expect(clientInstances.at(-1)!.apiKey).toBe("access-2")
	})

	it("refuses when the credential carries no refresh token", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ expiry_date: 0, refresh_token: undefined })))

		await expect(drain(new QwenCodeHandler({} as never).createMessage("sys", USER))).rejects.toThrow(
			/No refresh token available/,
		)
	})

	it("reports an HTTP failure from the token endpoint with its status", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ expiry_date: 0 })))
		stubTokenEndpoint({ error: "invalid_grant" }, false)

		await expect(drain(new QwenCodeHandler({} as never).createMessage("sys", USER))).rejects.toThrow(
			/Token refresh failed: 400/,
		)
	})

	it("reports an error the token endpoint returned with HTTP 200", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ expiry_date: 0 })))
		stubTokenEndpoint({ error: "invalid_grant", error_description: "expired" })

		await expect(drain(new QwenCodeHandler({} as never).createMessage("sys", USER))).rejects.toThrow(
			/invalid_grant - expired/,
		)
	})

	it("shares ONE refresh between concurrent turns", async () => {
		readFile.mockResolvedValue(JSON.stringify(validCreds({ expiry_date: 0 })))
		const fetchMock = stubTokenEndpoint({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 })
		const handler = new QwenCodeHandler({} as never)

		await Promise.all([drain(handler.createMessage("sys", USER)), drain(handler.createMessage("sys", USER))])

		// Two refreshes would spend the refresh token twice; the second would
		// invalidate the first.
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("refreshes and RETRIES once when the API answers 401", async () => {
		const fetchMock = stubTokenEndpoint({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 })
		let attempt = 0
		mockCreate.mockImplementation(async () => {
			if (attempt++ === 0) throw Object.assign(new Error("Unauthorized"), { status: 401 })
			return {
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ delta: { content: "after refresh" } }] }
				},
			}
		})

		const chunks = await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(chunks).toContainEqual({ type: "text", text: "after refresh" })
	})

	it("re-throws a non-401 failure without refreshing", async () => {
		const fetchMock = stubTokenEndpoint({ access_token: "x", token_type: "Bearer", expires_in: 3600 })
		mockCreate.mockRejectedValue(Object.assign(new Error("server error"), { status: 500 }))

		await expect(drain(new QwenCodeHandler({} as never).createMessage("sys", USER))).rejects.toThrow("server error")
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe("streaming", () => {
	it("splits inline <think> blocks into reasoning and text", async () => {
		stubStream([{ choices: [{ delta: { content: "before<think>pondering</think>after" } }] }])

		const chunks = await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(chunks).toEqual(
			expect.arrayContaining([
				{ type: "text", text: "before" },
				{ type: "reasoning", text: "pondering" },
				{ type: "text", text: "after" },
			]),
		)
	})

	it("streams a native reasoning_content field as reasoning", async () => {
		stubStream([{ choices: [{ delta: { reasoning_content: "native thinking" } }] }])

		const chunks = await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(chunks).toContainEqual({ type: "reasoning", text: "native thinking" })
	})

	it("de-duplicates a provider that re-sends the whole message each delta", async () => {
		// Qwen sometimes sends cumulative content; only the new tail is streamed.
		stubStream([
			{ choices: [{ delta: { content: "Hello" } }] },
			{ choices: [{ delta: { content: "Hello world" } }] },
		])

		const chunks = await drain(new QwenCodeHandler({} as never).createMessage("sys", USER))

		expect(chunks).toEqual(
			expect.arrayContaining([
				{ type: "text", text: "Hello" },
				{ type: "text", text: " world" },
			]),
		)
	})
})
