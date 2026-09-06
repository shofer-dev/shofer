// npx vitest src/integrations/openai-codex/__tests__/oauth.test.ts

/**
 * The OpenAI Codex OAuth manager. Four things here are security-relevant rather
 * than cosmetic, and each is pinned below:
 *
 *  - PKCE + `state`: the callback server REFUSES a state that does not match the
 *    one it minted, which is the CSRF gate;
 *  - the token exchange is form-encoded and MUST NOT carry `state` (OpenAI
 *    rejects the request if it does), while the refresh must ROTATE the refresh
 *    token when one comes back and keep the old one when it does not;
 *  - a refresh failure clears the stored credentials only when the grant is
 *    clearly invalid — a 500 or a network blip must not log the user out; and
 *  - concurrent callers share ONE in-flight refresh, so two tasks noticing the
 *    same expiry do not burn the refresh token twice.
 */

const hoisted = vi.hoisted(() => ({
	createServer: vi.fn(),
}))

vi.mock("http", async (importOriginal) => {
	const actual = await importOriginal<typeof import("http")>()
	return { ...actual, default: { ...actual, createServer: hoisted.createServer }, createServer: hoisted.createServer }
})

import type { ExtensionContext } from "vscode"

import {
	buildAuthorizationUrl,
	exchangeCodeForTokens,
	generateCodeChallenge,
	generateCodeVerifier,
	generateState,
	isTokenExpired,
	OPENAI_CODEX_OAUTH_CONFIG,
	OpenAiCodexOAuthManager,
	refreshAccessToken,
	type OpenAiCodexCredentials,
} from "../oauth"

const CREDENTIALS_KEY = "openai-codex-oauth-credentials"

function creds(overrides: Partial<OpenAiCodexCredentials> = {}): OpenAiCodexCredentials {
	return {
		type: "openai-codex",
		access_token: "at",
		refresh_token: "rt",
		expires: Date.now() + 3_600_000,
		...overrides,
	}
}

/** A JWT whose payload is `claims`; only the payload segment is ever read. */
function jwt(claims: Record<string, unknown>): string {
	return ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
	return {
		ok: init.ok ?? true,
		status: init.status ?? 200,
		statusText: init.statusText ?? "OK",
		json: async () => body,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	}
}

function makeContext() {
	const store = new Map<string, string>()
	return {
		secrets: {
			get: vi.fn(async (key: string) => store.get(key)),
			store: vi.fn(async (key: string, value: string) => void store.set(key, value)),
			delete: vi.fn(async (key: string) => void store.delete(key)),
		},
		_store: store,
	} as unknown as ExtensionContext & {
		_store: Map<string, string>
		secrets: Record<string, ReturnType<typeof vi.fn>>
	}
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
	vi.clearAllMocks()
	fetchMock = vi.fn()
	vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe("PKCE primitives", () => {
	it("mints a verifier in the 43–128 character unreserved range", () => {
		const verifier = generateCodeVerifier()
		expect(verifier.length).toBeGreaterThanOrEqual(43)
		expect(verifier.length).toBeLessThanOrEqual(128)
		expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
	})

	it("mints a DIFFERENT verifier every time", () => {
		expect(generateCodeVerifier()).not.toBe(generateCodeVerifier())
	})

	it("derives the S256 challenge deterministically, base64url-encoded", () => {
		const verifier = "a".repeat(43)
		expect(generateCodeChallenge(verifier)).toBe(generateCodeChallenge(verifier))
		expect(generateCodeChallenge(verifier)).toMatch(/^[A-Za-z0-9\-_]+$/)
	})

	it("mints a 32-hex-character state", () => {
		expect(generateState()).toMatch(/^[0-9a-f]{32}$/)
	})
})

describe("buildAuthorizationUrl", () => {
	it("carries PKCE, the fixed redirect and the Codex-specific parameters", () => {
		const url = new URL(buildAuthorizationUrl("challenge", "state-1"))

		expect(`${url.origin}${url.pathname}`).toBe(OPENAI_CODEX_OAUTH_CONFIG.authorizationEndpoint)
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
			redirect_uri: OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
			scope: OPENAI_CODEX_OAUTH_CONFIG.scopes,
			code_challenge: "challenge",
			code_challenge_method: "S256",
			response_type: "code",
			state: "state-1",
			codex_cli_simplified_flow: "true",
			originator: "shofer-code",
		})
	})
})

describe("exchangeCodeForTokens", () => {
	it("posts FORM-ENCODED and does NOT include state — OpenAI rejects the request if it does", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }))

		await exchangeCodeForTokens("the-code", "the-verifier")

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint)
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded")
		const body = new URLSearchParams(init.body as string)
		expect(Object.fromEntries(body)).toEqual({
			grant_type: "authorization_code",
			client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
			code: "the-code",
			redirect_uri: OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
			code_verifier: "the-verifier",
		})
		expect(body.has("state")).toBe(false)
	})

	it("converts expires_in (seconds) into an absolute millisecond deadline", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000_000)
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 60 }))

		const result = await exchangeCodeForTokens("c", "v")

		expect(result.expires).toBe(1_000_000 + 60_000)
		vi.useRealTimers()
	})

	it("prefers the id_token's account id", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				access_token: jwt({ chatgpt_account_id: "from-access" }),
				refresh_token: "rt",
				expires_in: 60,
				id_token: jwt({ chatgpt_account_id: "from-id" }),
			}),
		)

		await expect(exchangeCodeForTokens("c", "v")).resolves.toMatchObject({ accountId: "from-id" })
	})

	it("falls back to the ACCESS token's claims when the id_token carries none", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "nested" } }),
				refresh_token: "rt",
				expires_in: 60,
				id_token: jwt({ email: "u@example.com" }),
			}),
		)

		await expect(exchangeCodeForTokens("c", "v")).resolves.toMatchObject({ accountId: "nested" })
	})

	it("falls back to the FIRST organization id", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				access_token: jwt({ organizations: [{ id: "org-1" }, { id: "org-2" }] }),
				refresh_token: "rt",
				expires_in: 60,
			}),
		)

		await expect(exchangeCodeForTokens("c", "v")).resolves.toMatchObject({ accountId: "org-1" })
	})

	it("leaves accountId undefined for a token that is not a JWT at all", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "opaque", refresh_token: "rt", expires_in: 60 }))

		await expect(exchangeCodeForTokens("c", "v")).resolves.toMatchObject({ accountId: undefined })
	})

	it("leaves accountId undefined when the payload is not decodable JSON", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "a.!!!.c", refresh_token: "rt", expires_in: 60 }))

		await expect(exchangeCodeForTokens("c", "v")).resolves.toMatchObject({ accountId: undefined })
	})

	it("throws with the server's body when the exchange is refused", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse("bad code", { ok: false, status: 400, statusText: "Bad Request" }))

		await expect(exchangeCodeForTokens("c", "v")).rejects.toThrow(/Token exchange failed: 400 Bad Request/)
	})

	it("REFUSES a response with no refresh_token — an un-renewable session is not a login", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "at", expires_in: 3600 }))

		await expect(exchangeCodeForTokens("c", "v")).rejects.toThrow(/did not return a refresh_token/)
	})
})

describe("refreshAccessToken", () => {
	it("posts the refresh grant form-encoded", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "at2", expires_in: 3600 }))

		await refreshAccessToken(creds({ refresh_token: "rt-old" }))

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
			grant_type: "refresh_token",
			client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
			refresh_token: "rt-old",
		})
	})

	it("KEEPS the old refresh token when the server rotates nothing", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "at2", expires_in: 3600 }))

		const next = await refreshAccessToken(creds({ refresh_token: "rt-old", email: "u@x", accountId: "acc" }))

		expect(next).toMatchObject({ refresh_token: "rt-old", email: "u@x", accountId: "acc" })
	})

	it("ADOPTS a rotated refresh token", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ access_token: "at2", refresh_token: "rt-new", expires_in: 3600 }),
		)

		await expect(refreshAccessToken(creds({ refresh_token: "rt-old" }))).resolves.toMatchObject({
			refresh_token: "rt-new",
		})
	})

	it("carries the OAuth error CODE, which is what decides whether to log the user out", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(JSON.stringify({ error: "invalid_grant", error_description: "expired" }), {
				ok: false,
				status: 400,
				statusText: "Bad Request",
			}),
		)

		await expect(refreshAccessToken(creds())).rejects.toMatchObject({
			name: "OpenAiCodexOAuthTokenError",
			status: 400,
			errorCode: "invalid_grant",
		})
	})

	it("reads a structured error object's `type` and `message`", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(JSON.stringify({ error: { type: "invalid_grant", message: "revoked" } }), {
				ok: false,
				status: 401,
				statusText: "Unauthorized",
			}),
		)

		await expect(refreshAccessToken(creds())).rejects.toMatchObject({ errorCode: "invalid_grant" })
	})

	it("falls back to the raw body when the error is not JSON", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse("gateway down", { ok: false, status: 502, statusText: "Bad Gateway" }),
		)

		await expect(refreshAccessToken(creds())).rejects.toThrow(/502 Bad Gateway - gateway down/)
	})
})

describe("isTokenExpired", () => {
	it("is false for a token with plenty of life left", () => {
		expect(isTokenExpired(creds({ expires: Date.now() + 3_600_000 }))).toBe(false)
	})

	it("is TRUE inside the five-minute buffer — refreshing early beats a mid-request 401", () => {
		expect(isTokenExpired(creds({ expires: Date.now() + 60_000 }))).toBe(true)
	})

	it("is true for an already-expired token", () => {
		expect(isTokenExpired(creds({ expires: Date.now() - 1 }))).toBe(true)
	})
})

describe("OpenAiCodexOAuthManager credential storage", () => {
	it("answers null for everything before it is initialized", async () => {
		const manager = new OpenAiCodexOAuthManager()

		await expect(manager.loadCredentials()).resolves.toBeNull()
		await expect(manager.getAccessToken()).resolves.toBeNull()
		await expect(manager.getEmail()).resolves.toBeNull()
		await expect(manager.getAccountId()).resolves.toBeNull()
		await expect(manager.isAuthenticated()).resolves.toBe(false)
		expect(manager.getCredentials()).toBeNull()
	})

	it("REFUSES to save before initialization rather than dropping the credentials", async () => {
		const manager = new OpenAiCodexOAuthManager()
		await expect(manager.saveCredentials(creds())).rejects.toThrow(/not initialized/)
	})

	it("clearCredentials before initialization is a harmless no-op", async () => {
		const manager = new OpenAiCodexOAuthManager()
		await expect(manager.clearCredentials()).resolves.toBeUndefined()
	})

	it("round-trips credentials through the SECRETS store, never globalState", async () => {
		const context = makeContext()
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(context)

		await manager.saveCredentials(creds({ email: "u@x", accountId: "acc" }))

		expect(context.secrets.store).toHaveBeenCalledWith(CREDENTIALS_KEY, expect.any(String))
		await expect(manager.loadCredentials()).resolves.toMatchObject({ email: "u@x", accountId: "acc" })
	})

	it("returns null (and logs) for a stored blob that fails the schema", async () => {
		const context = makeContext()
		context._store.set(CREDENTIALS_KEY, JSON.stringify({ type: "openai-codex", access_token: "" }))
		const logged: string[] = []
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(context, (m) => logged.push(m))

		await expect(manager.loadCredentials()).resolves.toBeNull()
		expect(logged.join(" ")).toContain("Failed to load credentials")
	})

	it("returns null for unparseable JSON in the secret", async () => {
		const context = makeContext()
		context._store.set(CREDENTIALS_KEY, "{not json")
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(context)

		await expect(manager.loadCredentials()).resolves.toBeNull()
	})

	it("returns null when nothing has ever been stored", async () => {
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(makeContext())

		await expect(manager.loadCredentials()).resolves.toBeNull()
	})

	it("clearCredentials deletes the secret and forgets the in-memory copy", async () => {
		const context = makeContext()
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(context)
		await manager.saveCredentials(creds())

		await manager.clearCredentials()

		expect(context.secrets.delete).toHaveBeenCalledWith(CREDENTIALS_KEY)
		expect(manager.getCredentials()).toBeNull()
	})
})

describe("OpenAiCodexOAuthManager.getAccessToken", () => {
	function initialized(stored?: OpenAiCodexCredentials) {
		const context = makeContext()
		if (stored) context._store.set(CREDENTIALS_KEY, JSON.stringify(stored))
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(context, () => {})
		return { manager, context }
	}

	it("returns a live token without touching the network", async () => {
		const { manager } = initialized(creds({ access_token: "live" }))

		await expect(manager.getAccessToken()).resolves.toBe("live")
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("refreshes an expired token and PERSISTS the result", async () => {
		const { manager, context } = initialized(creds({ expires: Date.now() - 1 }))
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "fresh", refresh_token: "rt2", expires_in: 3600 }))

		await expect(manager.getAccessToken()).resolves.toBe("fresh")
		expect(context.secrets.store).toHaveBeenCalled()
	})

	it("de-dupes CONCURRENT refreshes onto one in-flight request", async () => {
		const { manager } = initialized(creds({ expires: Date.now() - 1 }))
		fetchMock.mockResolvedValue(jsonResponse({ access_token: "fresh", refresh_token: "rt2", expires_in: 3600 }))

		const [a, b] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()])

		expect([a, b]).toEqual(["fresh", "fresh"])
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("CLEARS the stored credentials when the refresh token is invalid", async () => {
		const { manager, context } = initialized(creds({ expires: Date.now() - 1 }))
		fetchMock.mockResolvedValueOnce(
			jsonResponse(JSON.stringify({ error: "invalid_grant" }), {
				ok: false,
				status: 400,
				statusText: "Bad Request",
			}),
		)

		await expect(manager.getAccessToken()).resolves.toBeNull()
		expect(context.secrets.delete).toHaveBeenCalledWith(CREDENTIALS_KEY)
	})

	it("KEEPS the credentials when the refresh merely failed transiently", async () => {
		const { manager, context } = initialized(creds({ expires: Date.now() - 1 }))
		fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"))

		await expect(manager.getAccessToken()).resolves.toBeNull()
		expect(context.secrets.delete).not.toHaveBeenCalled()
	})

	it("isAuthenticated reflects whether a token could be produced", async () => {
		const { manager } = initialized(creds())
		await expect(manager.isAuthenticated()).resolves.toBe(true)

		const empty = initialized()
		await expect(empty.manager.isAuthenticated()).resolves.toBe(false)
	})

	it("getEmail and getAccountId lazily load from storage", async () => {
		const { manager } = initialized(creds({ email: "u@x", accountId: "acc" }))

		await expect(manager.getEmail()).resolves.toBe("u@x")
		await expect(manager.getAccountId()).resolves.toBe("acc")
	})

	it("getEmail and getAccountId answer null when the fields are absent", async () => {
		const { manager } = initialized(creds())

		await expect(manager.getEmail()).resolves.toBeNull()
		await expect(manager.getAccountId()).resolves.toBeNull()
	})
})

describe("OpenAiCodexOAuthManager.forceRefreshAccessToken", () => {
	function initialized(stored?: OpenAiCodexCredentials) {
		const context = makeContext()
		if (stored) context._store.set(CREDENTIALS_KEY, JSON.stringify(stored))
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(context, () => {})
		return { manager, context }
	}

	it("returns null when there is nothing stored to refresh", async () => {
		const { manager } = initialized()
		await expect(manager.forceRefreshAccessToken()).resolves.toBeNull()
	})

	it("refreshes even though the token has NOT expired — the server may revoke early", async () => {
		const { manager } = initialized(creds({ expires: Date.now() + 3_600_000 }))
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ access_token: "forced", refresh_token: "rt2", expires_in: 3600 }),
		)

		await expect(manager.forceRefreshAccessToken()).resolves.toBe("forced")
	})

	it("clears the credentials on an invalid grant and keeps them otherwise", async () => {
		const invalid = initialized(creds())
		fetchMock.mockResolvedValueOnce(
			jsonResponse(JSON.stringify({ error: "invalid_grant" }), {
				ok: false,
				status: 403,
				statusText: "Forbidden",
			}),
		)
		await expect(invalid.manager.forceRefreshAccessToken()).resolves.toBeNull()
		expect(invalid.context.secrets.delete).toHaveBeenCalled()

		const transient = initialized(creds())
		fetchMock.mockRejectedValueOnce(new Error("offline"))
		await expect(transient.manager.forceRefreshAccessToken()).resolves.toBeNull()
		expect(transient.context.secrets.delete).not.toHaveBeenCalled()
	})
})

describe("the callback server", () => {
	type Handler = (req: { url?: string }, res: FakeResponse) => Promise<void> | void

	class FakeResponse {
		status?: number
		headers?: Record<string, string>
		body?: string
		writeHead(status: number, headers?: Record<string, string>) {
			this.status = status
			this.headers = headers
		}
		end(body?: string) {
			this.body = body
		}
	}

	/** A stand-in for `http.Server` that lets a test drive the request handler. */
	function fakeServer() {
		const listeners = new Map<string, (arg: unknown) => void>()
		let handler: Handler | undefined
		const server = {
			listen: vi.fn((_port: number, cb: () => void) => cb()),
			close: vi.fn(() => listeners.get("close")?.(undefined)),
			on: vi.fn((event: string, cb: (arg: unknown) => void) => void listeners.set(event, cb)),
			emit: (event: string, arg?: unknown) => listeners.get(event)?.(arg),
			request: async (url: string) => {
				const res = new FakeResponse()
				await handler!({ url }, res)
				return res
			},
		}
		hoisted.createServer.mockImplementationOnce((h: Handler) => {
			handler = h
			return server
		})
		return server
	}

	function initialized() {
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(makeContext(), () => {})
		return manager
	}

	it("refuses to wait when no flow was started", async () => {
		await expect(initialized().waitForCallback()).rejects.toThrow(/No pending authorization flow/)
	})

	it("404s any path that is not the callback, without settling the flow", async () => {
		const manager = initialized()
		manager.startAuthorizationFlow()
		const server = fakeServer()
		const pending = manager.waitForCallback()

		const res = await server.request("/favicon.ico")

		expect(res.status).toBe(404)
		manager.cancelAuthorizationFlow()
		server.emit("error", Object.assign(new Error("stop"), { code: "OTHER" }))
		await expect(pending).rejects.toThrow()
	})

	it("REJECTS a state mismatch — the CSRF gate", async () => {
		const manager = initialized()
		manager.startAuthorizationFlow()
		const server = fakeServer()
		const pending = manager.waitForCallback()

		const res = await server.request("/auth/callback?code=c&state=attacker")

		expect(res.status).toBe(400)
		expect(res.body).toContain("CSRF")
		await expect(pending).rejects.toThrow(/State mismatch/)
	})

	it("rejects a callback carrying an OAuth error", async () => {
		const manager = initialized()
		manager.startAuthorizationFlow()
		const server = fakeServer()
		const pending = manager.waitForCallback()

		const res = await server.request("/auth/callback?error=access_denied")

		expect(res.status).toBe(400)
		await expect(pending).rejects.toThrow(/OAuth error: access_denied/)
	})

	it("rejects a callback missing the code or the state", async () => {
		const manager = initialized()
		manager.startAuthorizationFlow()
		const server = fakeServer()
		const pending = manager.waitForCallback()

		await server.request("/auth/callback?state=only")

		await expect(pending).rejects.toThrow(/Missing code or state/)
	})

	it("exchanges a matching callback and SAVES the credentials before resolving", async () => {
		const manager = initialized()
		const url = new URL(manager.startAuthorizationFlow())
		const state = url.searchParams.get("state")!
		const server = fakeServer()
		const pending = manager.waitForCallback()
		fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }))

		const res = await server.request(`/auth/callback?code=the-code&state=${state}`)

		expect(res.status).toBe(200)
		await expect(pending).resolves.toMatchObject({ access_token: "at" })
		expect(manager.getCredentials()).toMatchObject({ access_token: "at" })
	})

	it("reports a failed exchange as a 500 and rejects the flow", async () => {
		const manager = initialized()
		const state = new URL(manager.startAuthorizationFlow()).searchParams.get("state")!
		const server = fakeServer()
		const pending = manager.waitForCallback()
		fetchMock.mockResolvedValueOnce(jsonResponse("nope", { ok: false, status: 400, statusText: "Bad Request" }))

		const res = await server.request(`/auth/callback?code=c&state=${state}`)

		expect(res.status).toBe(500)
		await expect(pending).rejects.toThrow(/Token exchange failed/)
	})

	it("turns EADDRINUSE into an actionable message rather than the raw errno", async () => {
		const manager = initialized()
		manager.startAuthorizationFlow()
		const server = fakeServer()
		const pending = manager.waitForCallback()

		server.emit("error", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }))

		await expect(pending).rejects.toThrow(
			new RegExp(`Port ${OPENAI_CODEX_OAUTH_CONFIG.callbackPort} is already in use`),
		)
	})

	it("propagates any other listen error unchanged", async () => {
		const manager = initialized()
		manager.startAuthorizationFlow()
		const server = fakeServer()
		const pending = manager.waitForCallback()

		server.emit("error", Object.assign(new Error("EACCES"), { code: "EACCES" }))

		await expect(pending).rejects.toThrow("EACCES")
	})

	it("times out a callback nobody ever makes", async () => {
		vi.useFakeTimers()
		const manager = initialized()
		manager.startAuthorizationFlow()
		fakeServer()
		const pending = manager.waitForCallback()

		vi.advanceTimersByTime(5 * 60 * 1000)

		await expect(pending).rejects.toThrow(/Authentication timed out/)
		vi.useRealTimers()
	})

	it("starting a SECOND flow cancels the first one's server", async () => {
		const manager = initialized()
		manager.startAuthorizationFlow()
		const server = fakeServer()
		const pending = manager.waitForCallback()

		manager.startAuthorizationFlow()

		expect(server.close).toHaveBeenCalled()
		manager.cancelAuthorizationFlow()
		server.emit("error", new Error("stop"))
		await expect(pending).rejects.toThrow()
	})

	it("cancelAuthorizationFlow with nothing pending is a no-op", () => {
		expect(() => initialized().cancelAuthorizationFlow()).not.toThrow()
	})

	it("mints a NEW verifier and state per flow", () => {
		const manager = initialized()
		const first = new URL(manager.startAuthorizationFlow())
		const second = new URL(manager.startAuthorizationFlow())

		expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"))
		expect(first.searchParams.get("code_challenge")).not.toBe(second.searchParams.get("code_challenge"))
	})
})
