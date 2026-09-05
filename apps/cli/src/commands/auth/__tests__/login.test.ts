/**
 * Unit tests for `shofer auth login` (`src/commands/auth/login.ts`).
 *
 * `login()` binds a loopback callback server, opens a browser and waits for the
 * IdP to redirect back. All three seams are faked here — `http`, `net` and
 * `child_process.exec` — so the suite is hermetic: no socket is bound, no
 * browser is launched, no credential is written, and no request leaves the
 * process. Driving the captured request handler by hand is what lets every
 * callback outcome (error, missing token, state mismatch, success, unknown
 * path) be asserted deterministically.
 */

import { saveToken } from "@/lib/storage/index.js"

import { login } from "../login.js"

type RequestHandler = (req: { url?: string }, res: FakeResponse) => void

interface FakeResponse {
	writeHead: ReturnType<typeof vi.fn>
	end: ReturnType<typeof vi.fn>
}

const httpState = vi.hoisted(() => ({
	handler: undefined as unknown,
	listen: vi.fn(),
	close: vi.fn(),
	closeListeners: [] as Array<() => void>,
}))

const netState = vi.hoisted(() => ({
	/** Queue of outcomes for successive `listen()` calls. */
	outcomes: [] as Array<{ kind: "listening" } | { kind: "error"; code?: string }>,
	listenedPorts: [] as number[],
}))

const exec = vi.hoisted(() => vi.fn())

vi.mock("http", () => {
	const createServer = (handler: unknown) => {
		httpState.handler = handler
		return {
			listen: httpState.listen,
			close: (...args: unknown[]) => {
				httpState.close(...args)
				for (const listener of httpState.closeListeners) listener()
			},
			on: (event: string, listener: () => void) => {
				if (event === "close") httpState.closeListeners.push(listener)
			},
		}
	}
	return { default: { createServer }, createServer }
})

vi.mock("net", () => {
	const createServer = () => {
		const handlers = new Map<string, (arg?: unknown) => void>()
		return {
			once: (event: string, listener: (arg?: unknown) => void) => {
				handlers.set(event, listener)
			},
			listen: (port: number) => {
				netState.listenedPorts.push(port)
				const outcome = netState.outcomes.shift() ?? { kind: "listening" as const }
				if (outcome.kind === "error") {
					handlers.get("error")?.(Object.assign(new Error("listen failed"), { code: outcome.code }))
					return
				}
				handlers.get("listening")?.()
			},
			close: (cb?: () => void) => cb?.(),
		}
	}
	return { default: { createServer }, createServer }
})

vi.mock("child_process", () => ({ default: { exec }, exec }))

vi.mock("@/lib/storage/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/storage/index.js")>()
	return { ...actual, saveToken: vi.fn() }
})

function makeResponse(): FakeResponse {
	return {
		writeHead: vi.fn(),
		// `res.end(cb)` is how login sequences "reply, then settle"; `res.end("body")`
		// is the 404 path and must not be mistaken for a callback.
		end: vi.fn((arg?: unknown) => {
			if (typeof arg === "function") (arg as () => void)()
		}),
	}
}

/** Wait for the callback server to be installed, then return its handler. */
async function captureHandler(): Promise<RequestHandler> {
	// Microtasks only: one case runs under fake timers, where a real `setTimeout`
	// would never fire. Every seam login touches is mocked and synchronous.
	for (let i = 0; i < 500 && !httpState.handler; i++) {
		await Promise.resolve()
	}
	return httpState.handler as RequestHandler
}

/** The `state` login generated, read back off the URL it opened in the browser. */
function openedAuthUrl(): URL {
	const command = String(exec.mock.calls.at(-1)?.[0] ?? "")
	const match = command.match(/"([^"]+)"\s*$/)
	return new URL(match![1]!)
}

describe("login", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		httpState.handler = undefined
		httpState.closeListeners = []
		netState.outcomes = []
		netState.listenedPorts = []
		exec.mockImplementation((_command: string, cb: (error: Error | null) => void) => cb(null))
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("stores the token and reports success when the callback matches the state", async () => {
		const pending = login()
		const handler = await captureHandler()
		const state = openedAuthUrl().searchParams.get("state")!

		const res = makeResponse()
		handler({ url: `/callback?state=${state}&token=jwt-abc` }, res)

		await expect(pending).resolves.toEqual({ success: true, token: "jwt-abc" })
		expect(saveToken).toHaveBeenCalledWith("jwt-abc")
		expect(res.writeHead).toHaveBeenCalledWith(302, expect.objectContaining({ Location: expect.any(String) }))
		expect(String(res.writeHead.mock.calls[0]?.[1]?.Location)).toContain("success=true")
	})

	it("binds the loopback callback server on the port it advertised", async () => {
		const pending = login()
		const handler = await captureHandler()
		const callback = new URL(openedAuthUrl().searchParams.get("callback")!)

		expect(callback.hostname).toBe("127.0.0.1")
		expect(httpState.listen).toHaveBeenCalledWith(Number(callback.port), "127.0.0.1")

		handler({ url: `/callback?state=${openedAuthUrl().searchParams.get("state")}&token=t` }, makeResponse())
		await pending
	})

	it("fails with the provider's error when the callback carries one", async () => {
		const pending = login()
		const handler = await captureHandler()

		const res = makeResponse()
		handler({ url: "/callback?error=access_denied" }, res)

		await expect(pending).resolves.toEqual({ success: false, error: "access_denied" })
		expect(saveToken).not.toHaveBeenCalled()
		expect(String(res.writeHead.mock.calls[0]?.[1]?.Location)).toContain("error-in-callback")
	})

	it("fails when the callback carries no token", async () => {
		const pending = login()
		const handler = await captureHandler()

		const res = makeResponse()
		handler({ url: "/callback?state=whatever" }, res)

		await expect(pending).resolves.toEqual({ success: false, error: "Missing token in callback" })
		expect(String(res.writeHead.mock.calls[0]?.[1]?.Location)).toContain("missing-token")
	})

	it("rejects a callback whose state does not match — the CSRF guard", async () => {
		const pending = login()
		const handler = await captureHandler()

		const res = makeResponse()
		handler({ url: "/callback?state=forged&token=stolen" }, res)

		await expect(pending).resolves.toEqual({ success: false, error: "Invalid state parameter" })
		expect(saveToken).not.toHaveBeenCalled()
		expect(String(res.writeHead.mock.calls[0]?.[1]?.Location)).toContain("invalid-state-parameter")
	})

	it("404s any path other than /callback and keeps waiting", async () => {
		const pending = login()
		const handler = await captureHandler()

		const stray = makeResponse()
		handler({ url: "/favicon.ico" }, stray)

		expect(stray.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "text/plain" })
		expect(stray.end).toHaveBeenCalledWith("Not found")

		// The flow is still live: a good callback afterwards still succeeds.
		handler({ url: `/callback?state=${openedAuthUrl().searchParams.get("state")}&token=t` }, makeResponse())
		await expect(pending).resolves.toEqual({ success: true, token: "t" })
	})

	it("gives up once the timeout elapses", async () => {
		vi.useFakeTimers()
		const pending = login({ timeout: 1_000 })
		await captureHandler()

		await vi.advanceTimersByTimeAsync(1_000)

		await expect(pending).resolves.toEqual({ success: false, error: "Authentication timed out" })
		expect(httpState.close).toHaveBeenCalled()
	})

	it("continues when the browser cannot be opened", async () => {
		exec.mockImplementation((_command: string, cb: (error: Error | null) => void) => cb(new Error("no xdg-open")))

		const pending = login({ verbose: true })
		const handler = await captureHandler()

		handler({ url: `/callback?state=${openedAuthUrl().searchParams.get("state")}&token=t` }, makeResponse())

		await expect(pending).resolves.toEqual({ success: true, token: "t" })
		expect(console.warn).toHaveBeenCalledWith("[Auth] Failed to open browser automatically:", expect.any(Error))
	})

	it("logs the chosen port under --verbose", async () => {
		const pending = login({ verbose: true })
		const handler = await captureHandler()

		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(
			/\[Auth\] Starting local callback server on port \d+/,
		)

		handler({ url: `/callback?state=${openedAuthUrl().searchParams.get("state")}&token=t` }, makeResponse())
		await pending
	})

	it("walks past a port already in use", async () => {
		netState.outcomes = [{ kind: "error", code: "EADDRINUSE" }, { kind: "listening" }]

		const pending = login()
		const handler = await captureHandler()

		expect(netState.listenedPorts).toEqual([49152, 49153])
		expect(httpState.listen).toHaveBeenCalledWith(49153, "127.0.0.1")

		handler({ url: `/callback?state=${openedAuthUrl().searchParams.get("state")}&token=t` }, makeResponse())
		await pending
	})

	it("propagates a non-EADDRINUSE bind failure", async () => {
		netState.outcomes = [{ kind: "error", code: "EACCES" }]

		await expect(login()).rejects.toThrow("listen failed")
	})

	it.each([
		["darwin", /^open "/],
		["win32", /^start "" "/],
		["linux", /^xdg-open "/],
	])("opens the browser with the %s command", async (platform, expected) => {
		const original = Object.getOwnPropertyDescriptor(process, "platform")!
		Object.defineProperty(process, "platform", { value: platform, configurable: true })

		try {
			const pending = login()
			const handler = await captureHandler()

			expect(String(exec.mock.calls.at(-1)?.[0])).toMatch(expected)

			handler({ url: `/callback?state=${openedAuthUrl().searchParams.get("state")}&token=t` }, makeResponse())
			await pending
		} finally {
			Object.defineProperty(process, "platform", original)
		}
	})
})
