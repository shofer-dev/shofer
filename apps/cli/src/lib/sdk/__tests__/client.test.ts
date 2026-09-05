/**
 * Unit tests for `createClient` (`src/lib/sdk/client.ts`).
 *
 * The tRPC transport is faked entirely — nothing here opens a socket. What is
 * worth pinning is the wiring: the `/trpc` suffix on the configured base URL
 * and the fact that the `Authorization` header is present only when a token
 * was supplied (an empty token must not send `Bearer `).
 */

import { createClient } from "../client.js"
import * as sdkIndex from "../index.js"

const createTRPCProxyClient = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ marker: "trpc-client" })))
const httpBatchLink = vi.hoisted(() => vi.fn((options: unknown) => ({ link: options })))

vi.mock("@trpc/client", () => ({ createTRPCProxyClient, httpBatchLink }))

type LinkOptions = { url: string; headers: () => Record<string, string> }

/** The single `httpBatchLink` options object the last `createClient` produced. */
function lastLinkOptions(): LinkOptions {
	return httpBatchLink.mock.calls.at(-1)?.[0] as LinkOptions
}

describe("createClient", () => {
	beforeEach(() => {
		createTRPCProxyClient.mockClear()
		httpBatchLink.mockClear()
	})

	it("suffixes the configured base url with /trpc", () => {
		createClient({ url: "https://cloud-api.example.test", authToken: "t" })
		expect(lastLinkOptions().url).toBe("https://cloud-api.example.test/trpc")
	})

	it("sends a bearer header when a token is configured", () => {
		createClient({ url: "https://cloud-api.example.test", authToken: "abc123" })
		expect(lastLinkOptions().headers()).toEqual({ Authorization: "Bearer abc123" })
	})

	it("sends no header at all when the token is empty", () => {
		createClient({ url: "https://cloud-api.example.test", authToken: "" })
		expect(lastLinkOptions().headers()).toEqual({})
	})

	it("returns whatever the tRPC proxy client factory produced", () => {
		const client = createClient({ url: "https://cloud-api.example.test", authToken: "t" })
		expect(client).toEqual({ marker: "trpc-client" })
		expect(createTRPCProxyClient).toHaveBeenCalledTimes(1)
	})

	it("installs exactly one link", () => {
		createClient({ url: "https://cloud-api.example.test", authToken: "t" })
		const config = createTRPCProxyClient.mock.calls[0]?.[0] as unknown as { links: unknown[] }
		expect(config.links).toHaveLength(1)
	})
})

describe("lib/sdk barrel", () => {
	it("re-exports createClient", () => {
		expect(sdkIndex.createClient).toBe(createClient)
	})
})
