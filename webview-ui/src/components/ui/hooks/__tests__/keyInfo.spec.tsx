// npx vitest src/components/ui/hooks/__tests__/keyInfo.spec.tsx
//
// The two provider key-info queries. Both share a contract worth pinning: no
// key means no request at all, a transport failure or a response that fails its
// schema resolves to `null` rather than throwing, and the query key carries
// every input so switching profile or base URL refetches.

import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import axios from "axios"

import { useOpenRouterKeyInfo } from "../useOpenRouterKeyInfo"
import { useRequestyKeyInfo } from "../useRequestyKeyInfo"

vi.mock("axios", () => ({ default: { get: vi.fn() } }))

const get = vi.mocked(axios.get)

const wrapper = ({ children }: { children: React.ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
)

const openRouterKey = {
	label: "sk-or-…",
	usage: 12.5,
	is_free_tier: false,
	is_provisioning_key: false,
	rate_limit: { requests: 10, interval: "10s" },
	limit: null,
}

const requestyKey = {
	name: "team",
	monthly_limit: "100",
	monthly_spend: "12",
	org_balance: "88",
	config: {},
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe("useOpenRouterKeyInfo", () => {
	it("asks nothing without a key", () => {
		const { result } = renderHook(() => useOpenRouterKeyInfo(undefined), { wrapper })
		expect(result.current.fetchStatus).toBe("idle")
		expect(get).not.toHaveBeenCalled()
	})

	it("reads the key endpoint under a bearer token", async () => {
		get.mockResolvedValue({ data: { data: openRouterKey } })
		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-test"), { wrapper })

		await waitFor(() => expect(result.current.data).toBeTruthy())
		expect(result.current.data).toMatchObject({ label: "sk-or-…", usage: 12.5 })
		expect(get).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", {
			headers: { Authorization: "Bearer sk-test" },
		})
	})

	it("honours a self-hosted base URL", async () => {
		get.mockResolvedValue({ data: { data: openRouterKey } })
		renderHook(() => useOpenRouterKeyInfo("sk-test", "https://gateway.internal/v1"), { wrapper })

		await waitFor(() => expect(get).toHaveBeenCalled())
		expect(get.mock.calls[0][0]).toBe("https://gateway.internal/v1/key")
	})

	it("resolves to null on a response that fails the schema", async () => {
		get.mockResolvedValue({ data: { data: { label: "x" } } })
		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
	})

	it("resolves to null on a transport failure rather than erroring the query", async () => {
		get.mockRejectedValue(new Error("offline"))
		const { result } = renderHook(() => useOpenRouterKeyInfo("sk-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
	})
})

describe("useRequestyKeyInfo", () => {
	it("asks nothing without a key", () => {
		const { result } = renderHook(() => useRequestyKeyInfo("https://router.requesty.ai/v1"), { wrapper })
		expect(result.current.fetchStatus).toBe("idle")
		expect(get).not.toHaveBeenCalled()
	})

	it("reads the api-key endpoint derived from the router URL", async () => {
		get.mockResolvedValue({ data: requestyKey })
		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "rq-test"), { wrapper })

		await waitFor(() => expect(result.current.data).toBeTruthy())
		expect(result.current.data).toMatchObject({ name: "team", org_balance: "88" })
		expect(String(get.mock.calls[0][0])).toContain("x/apikey")
		expect(get.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer rq-test" } })
	})

	it("carries the optional alias map through", async () => {
		get.mockResolvedValue({ data: { ...requestyKey, config: { aliases: { fast: {} } } } })
		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "rq-test"), { wrapper })

		await waitFor(() => expect(result.current.data).toBeTruthy())
		expect(result.current.data?.config.aliases).toHaveProperty("fast")
	})

	it("resolves to null on a response that fails the schema", async () => {
		get.mockResolvedValue({ data: { name: "team" } })
		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "rq-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
	})

	it("resolves to null on a transport failure", async () => {
		get.mockRejectedValue(new Error("offline"))
		const { result } = renderHook(() => useRequestyKeyInfo(undefined, "rq-test"), { wrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
	})
})
