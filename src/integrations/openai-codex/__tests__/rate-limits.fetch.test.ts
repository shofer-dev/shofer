// npx vitest src/integrations/openai-codex/__tests__/rate-limits.fetch.test.ts

/**
 * The Codex subscription-usage read. Everything it does is defensive translation
 * of an undocumented payload: percentages are CLAMPED (a provider returning 105
 * must not render as an over-full bar), the reset timestamp is converted from
 * SECONDS to milliseconds, and a response carrying no rate-limit window at all is
 * an ERROR rather than an empty-but-successful reading — the webview would show
 * "0% used" for a quota it never actually learned.
 */

import { fetchOpenAiCodexRateLimitInfo, parseOpenAiCodexUsagePayload } from "../rate-limits"

let fetchMock: ReturnType<typeof vi.fn>

function response(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
	return {
		ok: init.ok ?? true,
		status: init.status ?? 200,
		statusText: init.statusText ?? "OK",
		json: async () => body,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	}
}

beforeEach(() => {
	fetchMock = vi.fn()
	vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe("parseOpenAiCodexUsagePayload", () => {
	it("returns only the fetch timestamp for a payload that is not an object", () => {
		expect(parseOpenAiCodexUsagePayload("nonsense", 1_000)).toEqual({ fetchedAt: 1_000 })
		expect(parseOpenAiCodexUsagePayload(null, 1_000)).toEqual({ fetchedAt: 1_000 })
	})

	it("converts the window to MINUTES and the reset to MILLISECONDS", () => {
		const parsed = parseOpenAiCodexUsagePayload(
			{
				rate_limit: {
					primary_window: { used_percent: 42, limit_window_seconds: 300, reset_at: 1_700_000_000 },
				},
			},
			1_000,
		)

		expect(parsed.primary).toEqual({ usedPercent: 42, windowMinutes: 5, resetsAt: 1_700_000_000_000 })
	})

	it("CLAMPS a percentage outside 0–100 rather than rendering an impossible bar", () => {
		const over = parseOpenAiCodexUsagePayload({ rate_limit: { primary_window: { used_percent: 150 } } }, 0)
		const under = parseOpenAiCodexUsagePayload({ rate_limit: { primary_window: { used_percent: -5 } } }, 0)

		expect(over.primary!.usedPercent).toBe(100)
		expect(under.primary!.usedPercent).toBe(0)
	})

	it("treats a NON-FINITE percentage as zero", () => {
		const parsed = parseOpenAiCodexUsagePayload({ rate_limit: { primary_window: { used_percent: NaN } } }, 0)

		expect(parsed.primary!.usedPercent).toBe(0)
	})

	it("OMITS the optional fields the payload did not carry", () => {
		const parsed = parseOpenAiCodexUsagePayload({ rate_limit: { primary_window: { used_percent: 10 } } }, 0)

		expect(parsed.primary).toEqual({ usedPercent: 10 })
	})

	it("ignores a window with no usedPercent — there is nothing to report", () => {
		const parsed = parseOpenAiCodexUsagePayload({ rate_limit: { primary_window: { reset_at: 1 } } }, 0)

		expect(parsed.primary).toBeUndefined()
	})

	it("reads the SECONDARY window independently", () => {
		const parsed = parseOpenAiCodexUsagePayload(
			{ rate_limit: { secondary_window: { used_percent: 7, limit_window_seconds: 86_400 } } },
			0,
		)

		expect(parsed.secondary).toEqual({ usedPercent: 7, windowMinutes: 1440 })
		expect(parsed.primary).toBeUndefined()
	})

	it("carries the plan type only when it is a string", () => {
		expect(parseOpenAiCodexUsagePayload({ plan_type: "pro" }, 0)).toMatchObject({ planType: "pro" })
		expect(parseOpenAiCodexUsagePayload({ plan_type: 5 }, 0).planType).toBeUndefined()
	})

	it("ignores a non-finite reset timestamp", () => {
		const parsed = parseOpenAiCodexUsagePayload(
			{ rate_limit: { primary_window: { used_percent: 1, reset_at: Infinity } } },
			0,
		)

		expect(parsed.primary!.resetsAt).toBeUndefined()
	})
})

describe("fetchOpenAiCodexRateLimitInfo", () => {
	it("sends the bearer token and the account header when there is an organization account", async () => {
		fetchMock.mockResolvedValueOnce(response({ rate_limit: { primary_window: { used_percent: 1 } } }))

		await fetchOpenAiCodexRateLimitInfo("token-1", { accountId: "acct-1" })

		const [, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string> }]
		expect(init.method).toBe("GET")
		expect(init.headers).toMatchObject({ Authorization: "Bearer token-1", "ChatGPT-Account-Id": "acct-1" })
	})

	it("omits the account header for a personal account", async () => {
		fetchMock.mockResolvedValueOnce(response({ rate_limit: { primary_window: { used_percent: 1 } } }))

		await fetchOpenAiCodexRateLimitInfo("token-1")

		const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
		expect(init.headers["ChatGPT-Account-Id"]).toBeUndefined()
	})

	it("stamps the reading with the time it was FETCHED", async () => {
		fetchMock.mockResolvedValueOnce(response({ rate_limit: { primary_window: { used_percent: 1 } } }))

		const info = await fetchOpenAiCodexRateLimitInfo("token-1")

		expect(info.fetchedAt).toBeTypeOf("number")
	})

	it("reports an HTTP failure with the server's own body", async () => {
		fetchMock.mockResolvedValueOnce(
			response("upstream down", { ok: false, status: 503, statusText: "Unavailable" }),
		)

		await expect(fetchOpenAiCodexRateLimitInfo("token-1")).rejects.toThrow(/503 Unavailable - upstream down/)
	})

	it("still reports an HTTP failure when the error body cannot be read", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: "Server Error",
			text: async () => {
				throw new Error("stream closed")
			},
		})

		await expect(fetchOpenAiCodexRateLimitInfo("token-1")).rejects.toThrow(/500 Server Error/)
	})

	it("REFUSES a successful response carrying no rate-limit window — 0% would be a lie", async () => {
		fetchMock.mockResolvedValueOnce(response({ plan_type: "pro" }))

		await expect(fetchOpenAiCodexRateLimitInfo("token-1")).rejects.toThrow(/did not include rate_limit windows/)
	})
})
