import { describe, it, expect, beforeEach, vi } from "vitest"

import { NodeConnection, type NodeConnectionOptions } from "../node-connection.js"

/**
 * Controller-side connection status layer (Shofer Nodes L1). Drives every state
 * transition with an injected fake `fetch` + injected timers, so nothing waits
 * real time and each branch (connected / version-mismatch / unauthorized /
 * error / reconnecting / give-up / disconnect) is deterministic.
 */

const flush = () => new Promise((r) => setTimeout(r, 0))

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status })
}

/** A fetch mock routing by path, plus a manual timer harness. */
function makeEnv(controllerVersion = "1.0.0") {
	const timeouts: Array<() => void> = []
	const intervals: Array<() => void> = []
	let nowValue = 0

	const routes = {
		whoami: vi.fn(async (): Promise<Response> => json(200, { version: controllerVersion })),
		health: vi.fn(async (): Promise<Response> => new Response("", { status: 200 })),
	}

	const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
		const url = String(input)
		if (url.endsWith("/whoami")) return routes.whoami()
		if (url.endsWith("/health")) return routes.health()
		throw new Error(`unexpected url ${url}`)
	})

	const opts: NodeConnectionOptions = {
		baseUrl: "http://node:30099",
		controllerVersion,
		fetch: fetchMock as unknown as typeof fetch,
		pingIntervalMs: 100,
		reconnectBaseMs: 10,
		maxReconnectAttempts: 3,
		now: () => (nowValue += 5),
		setTimeout: (cb) => timeouts.push(cb),
		clearTimeout: () => {},
		setInterval: (cb) => intervals.push(cb),
		clearInterval: () => {},
	}

	return {
		opts,
		routes,
		fetchMock,
		runInterval: async () => {
			intervals[intervals.length - 1]?.()
			await flush()
		},
		runTimeout: async () => {
			timeouts.pop()?.()
			await flush()
		},
	}
}

describe("NodeConnection (Shofer Nodes L1 status layer)", () => {
	let env: ReturnType<typeof makeEnv>
	let conn: NodeConnection
	let states: string[]

	beforeEach(() => {
		env = makeEnv()
		conn = new NodeConnection(env.opts)
		states = []
		conn.onStatusChange((s) => states.push(s))
	})

	it("connects when /whoami returns a matching version", async () => {
		await conn.connect()
		expect(conn.status).toBe("connected")
		expect(conn.agentVersion).toBe("1.0.0")
		expect(conn.error).toBeUndefined()
		expect(conn.api).toBeDefined()
		expect(states).toEqual(["connecting", "connected"])
	})

	it("goes version-mismatch when the node reports a different version (api withheld)", async () => {
		env.routes.whoami.mockResolvedValueOnce(json(200, { version: "2.0.0" }))
		await conn.connect()
		expect(conn.status).toBe("version-mismatch")
		expect(conn.agentVersion).toBe("2.0.0")
		expect(conn.api).toBeUndefined()
		expect(conn.error).toContain("2.0.0")
	})

	it("goes unauthorized on 401 (api withheld)", async () => {
		env.routes.whoami.mockResolvedValueOnce(json(401, { error: "unauthorized" }))
		await conn.connect()
		expect(conn.status).toBe("unauthorized")
		expect(conn.api).toBeUndefined()
	})

	it("goes error on a network failure", async () => {
		env.routes.whoami.mockRejectedValueOnce(new Error("ECONNREFUSED"))
		await conn.connect()
		expect(conn.status).toBe("error")
		expect(conn.error).toContain("ECONNREFUSED")
		expect(conn.api).toBeUndefined()
	})

	it("goes error on a non-2xx whoami", async () => {
		env.routes.whoami.mockResolvedValueOnce(json(500, { error: "boom" }))
		await conn.connect()
		expect(conn.status).toBe("error")
		expect(conn.error).toContain("500")
	})

	it("sends the bearer token on the whoami handshake", async () => {
		const withToken = makeEnv()
		withToken.opts.token = "s3cret"
		const c = new NodeConnection(withToken.opts)
		await c.connect()
		expect(withToken.fetchMock).toHaveBeenCalledWith(
			"http://node:30099/api/v1/whoami",
			expect.objectContaining({ headers: { authorization: "Bearer s3cret" } }),
		)
	})

	it("updates latencyMs on a successful health ping", async () => {
		await conn.connect()
		states.length = 0
		await env.runInterval()
		expect(conn.status).toBe("connected")
		expect(conn.latencyMs).toBeGreaterThanOrEqual(0)
		expect(states).toEqual(["connected"]) // re-fired to surface latency
	})

	it("reconnects after a ping failure and recovers", async () => {
		await conn.connect()
		states.length = 0

		env.routes.health.mockRejectedValueOnce(new Error("timeout"))
		await env.runInterval() // ping fails → reconnecting + schedule retry
		expect(conn.status).toBe("reconnecting")
		expect(conn.api).toBeUndefined()

		await env.runTimeout() // backoff fires → whoami succeeds again
		expect(conn.status).toBe("connected")
		expect(conn.api).toBeDefined()
		expect(states).toContain("reconnecting")
		expect(states[states.length - 1]).toBe("connected")
	})

	it("gives up to error after exhausting reconnect attempts", async () => {
		await conn.connect()
		// From now on both whoami and health always fail.
		env.routes.whoami.mockRejectedValue(new Error("down"))
		env.routes.health.mockRejectedValue(new Error("down"))

		await env.runInterval() // ping fails → reconnecting (attempt 1)
		expect(conn.status).toBe("reconnecting")

		// maxReconnectAttempts = 3 → drive retries until it gives up.
		await env.runTimeout() // attempt 1 retry fails → schedule attempt 2
		await env.runTimeout() // attempt 2 retry fails → schedule attempt 3
		await env.runTimeout() // attempt 3 retry fails → give up
		expect(conn.status).toBe("error")
		expect(conn.error).toContain("giving up")
		expect(conn.api).toBeUndefined()
	})

	it("disconnect() tears down and stops pinging", async () => {
		await conn.connect()
		conn.disconnect()
		expect(conn.status).toBe("disconnected")
		expect(conn.api).toBeUndefined()
		expect(conn.latencyMs).toBeUndefined()

		// A stray interval fire after disconnect must not resurrect it.
		const calls = env.fetchMock.mock.calls.length
		await env.runInterval()
		expect(env.fetchMock.mock.calls.length).toBe(calls)
		expect(conn.status).toBe("disconnected")
	})
})
