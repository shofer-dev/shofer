import { describe, it, expect, beforeAll } from "vitest"
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from "jose"

import { createNodeAuthenticator, type AuthEvent, type JwtAuthConfig } from "../auth.js"

/**
 * Per-caller authentication for a served node (`auth.ts`).
 *
 * The suite is built around one real key pair and real signatures rather than a
 * stubbed verifier, because almost everything worth asserting here is a
 * property of the verification itself — a wrong audience, a wrong issuer, an
 * expired token, a signature from the wrong key. A test double would assert
 * that the code calls a function, which is the one thing that was never in
 * doubt.
 */

const ISSUER = "https://issuer.test"
const AUDIENCE = "shofer-node"
const KID = "test-key-1"

let jwks: JSONWebKeySet
let sign: (claims: Record<string, unknown>, opts?: { expSec?: number; alg?: string }) => Promise<string>
let signWithOtherKey: (claims: Record<string, unknown>) => Promise<string>

beforeAll(async () => {
	const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
	const pub = await exportJWK(publicKey)
	jwks = { keys: [{ ...pub, alg: "RS256", kid: KID, use: "sig" }] }

	sign = async (claims, { expSec = 300, alg = "RS256" } = {}) => {
		const now = Math.floor(Date.now() / 1000)
		return new SignJWT(claims)
			.setProtectedHeader({ alg, kid: KID })
			.setIssuedAt(now)
			.setExpirationTime(now + expSec)
			.sign(privateKey)
	}

	const other = await generateKeyPair("RS256", { extractable: true })
	signWithOtherKey = async (claims) => {
		const now = Math.floor(Date.now() / 1000)
		return new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", kid: KID })
			.setIssuedAt(now)
			.setExpirationTime(now + 300)
			.sign(other.privateKey)
	}
})

function cfg(over: Partial<JwtAuthConfig> = {}): JwtAuthConfig {
	return { issuer: ISSUER, audience: AUDIENCE, jwks, posture: "require", ...over }
}

const claims = (over: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: AUDIENCE, sub: "user-1", ...over })

describe("createNodeAuthenticator — configuration", () => {
	it("refuses a jwt config with no issuer", () => {
		expect(() => createNodeAuthenticator({ jwt: cfg({ issuer: "" }) })).toThrow(/issuer is required/)
	})

	it("refuses a jwt config with no audience", () => {
		expect(() => createNodeAuthenticator({ jwt: cfg({ audience: "" }) })).toThrow(/audience is required/)
	})

	it("refuses a jwt config with neither a jwks nor a jwksUri", () => {
		expect(() => createNodeAuthenticator({ jwt: { ...cfg(), jwks: undefined } })).toThrow(/exactly one/)
	})

	it("refuses a jwt config with BOTH a jwks and a jwksUri", () => {
		expect(() => createNodeAuthenticator({ jwt: cfg({ jwksUri: "https://issuer.test/jwks.json" }) })).toThrow(
			/exactly one/,
		)
	})

	it("refuses an unknown posture", () => {
		expect(() => createNodeAuthenticator({ jwt: cfg({ posture: "off" as never }) })).toThrow(/posture must be/)
	})

	/**
	 * `observe` means "a JWT is preferred and the old credential still works".
	 * With no old credential to fall back to it is `require` under a name that
	 * says otherwise — and the name is what an operator reads when deciding
	 * whether the next rung is safe.
	 */
	it("refuses posture observe with no node token to fall back to", () => {
		expect(() => createNodeAuthenticator({ jwt: cfg({ posture: "observe" }) })).toThrow(/needs a node token/)
	})

	it("is disabled when neither credential is configured", async () => {
		const auth = createNodeAuthenticator({})
		expect(auth.enabled).toBe(false)
		await expect(auth.authenticate(undefined)).resolves.toMatchObject({ ok: true })
	})
})

describe("createNodeAuthenticator — jwt verification", () => {
	const auth = (over: Partial<JwtAuthConfig> = {}, token?: string) =>
		createNodeAuthenticator({ token, jwt: cfg(over) })

	it("accepts a well-formed token and names its subject", async () => {
		const out = await auth().authenticate(`Bearer ${await sign(claims())}`)
		expect(out).toEqual({ ok: true, caller: { credential: "jwt", subject: "user-1", taskId: undefined } })
	})

	it("refuses a token for a different audience", async () => {
		const out = await auth().authenticate(`Bearer ${await sign(claims({ aud: "some-other-service" }))}`)
		expect(out).toMatchObject({ ok: false, status: 401 })
	})

	it("refuses a token from a different issuer", async () => {
		const out = await auth().authenticate(`Bearer ${await sign(claims({ iss: "https://elsewhere.test" }))}`)
		expect(out).toMatchObject({ ok: false, status: 401 })
	})

	it("refuses a token signed by a key the issuer does not publish", async () => {
		const out = await auth().authenticate(`Bearer ${await signWithOtherKey(claims())}`)
		expect(out).toMatchObject({ ok: false, status: 401 })
	})

	it("refuses an expired token", async () => {
		// Past the default 30 s skew tolerance, so this is expiry rather than clock drift.
		const out = await auth().authenticate(`Bearer ${await sign(claims(), { expSec: -120 })}`)
		expect(out).toMatchObject({ ok: false, status: 401 })
	})

	/**
	 * A subject is the whole reason to prefer a JWT over the shared bearer, so
	 * a token without one is a credential that names nobody and buys nothing.
	 */
	it("refuses a token with no subject", async () => {
		const { sub: _drop, ...noSub } = claims()
		const out = await auth().authenticate(`Bearer ${await sign(noSub)}`)
		expect(out).toMatchObject({ ok: false, status: 401 })
	})

	it("refuses a non-bearer authorization header", async () => {
		const out = await auth().authenticate("Basic dXNlcjpwYXNz")
		expect(out).toMatchObject({ ok: false, status: 401 })
	})

	it("refuses a missing authorization header", async () => {
		const out = await auth().authenticate(undefined)
		expect(out).toMatchObject({ ok: false, status: 401 })
	})
})

describe("createNodeAuthenticator — task confinement", () => {
	const confined = () => createNodeAuthenticator({ jwt: cfg({ taskClaim: "task_id" }) })

	it("carries the claimed task onto the caller", async () => {
		const out = await confined().authenticate(`Bearer ${await sign(claims({ task_id: "t-1" }))}`)
		expect(out).toMatchObject({ ok: true, caller: { subject: "user-1", taskId: "t-1" } })
	})

	/**
	 * A confinement that degrades to "no confinement" the day the mint stops
	 * populating the claim is not a confinement. So the claim is REQUIRED once
	 * it is named, and its absence is a refusal rather than a wildcard.
	 */
	it("refuses a token missing the configured task claim", async () => {
		const out = await confined().authenticate(`Bearer ${await sign(claims())}`)
		expect(out).toMatchObject({ ok: false, status: 401 })
	})

	it("refuses a task claim that is not a string", async () => {
		const out = await confined().authenticate(`Bearer ${await sign(claims({ task_id: 42 }))}`)
		expect(out).toMatchObject({ ok: false, status: 401 })
	})

	it("lets a confined credential address its own task and refuses any other", () => {
		const auth = confined()
		const caller = { credential: "jwt" as const, subject: "user-1", taskId: "t-1" }
		expect(auth.checkTaskScope(caller, "t-1")).toBeUndefined()
		expect(auth.checkTaskScope(caller, "t-2")).toMatchObject({ status: 403 })
	})

	/**
	 * The node-wide stream carries every task's content for every user on the
	 * pod. Refusing it to a confined credential is what makes confinement mean
	 * anything at all — otherwise a token scoped to one task reads every other
	 * task by asking a different route for the same data.
	 */
	it("refuses a confined credential the node-wide surface", () => {
		const auth = confined()
		expect(auth.checkNodeScope({ credential: "jwt", subject: "u", taskId: "t-1" })).toMatchObject({ status: 403 })
	})

	it("lets an unconfined credential reach every task and the node-wide surface", () => {
		const auth = createNodeAuthenticator({ jwt: cfg() })
		const caller = { credential: "jwt" as const, subject: "user-1" }
		expect(auth.checkTaskScope(caller, "anything")).toBeUndefined()
		expect(auth.checkNodeScope(caller)).toBeUndefined()
	})
})

describe("createNodeAuthenticator — the posture ratchet", () => {
	const events: AuthEvent[] = []
	const observing = () => {
		events.length = 0
		return createNodeAuthenticator({
			token: "node-secret",
			jwt: cfg({ posture: "observe" }),
			onAuthEvent: (e) => events.push(e),
		})
	}

	it("observe: prefers a JWT and reports it as such", async () => {
		const auth = observing()
		const out = await auth.authenticate(`Bearer ${await sign(claims())}`)
		expect(out).toMatchObject({ ok: true, caller: { credential: "jwt" } })
		expect(events).toEqual([{ outcome: "jwt", posture: "observe", subject: "user-1" }])
	})

	/**
	 * The fallback is what keeps a not-yet-migrated caller working, and the
	 * REPORT is what makes the next rung a decision rather than a hope: a caller
	 * presenting a JWT that is being rejected looks exactly like one that never
	 * learned to mint one, and the reason is the only thing that tells them
	 * apart.
	 */
	it("observe: falls back to the node token and reports the jwt failure with it", async () => {
		const auth = observing()
		const out = await auth.authenticate("Bearer node-secret")
		expect(out).toMatchObject({ ok: true, caller: { credential: "node-token" } })
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ outcome: "node-token", posture: "observe" })
		expect(events[0]!.reason).toBeTruthy()
	})

	it("observe: refuses a credential that is neither", async () => {
		const auth = observing()
		const out = await auth.authenticate("Bearer neither-of-them")
		expect(out).toMatchObject({ ok: false, status: 401 })
		expect(events[0]).toMatchObject({ outcome: "rejected", posture: "observe" })
	})

	it("require: refuses the node token even though one is configured", async () => {
		const auth = createNodeAuthenticator({ token: "node-secret", jwt: cfg({ posture: "require" }) })
		await expect(auth.authenticate("Bearer node-secret")).resolves.toMatchObject({ ok: false, status: 401 })
		await expect(auth.authenticate(`Bearer ${await sign(claims())}`)).resolves.toMatchObject({ ok: true })
	})

	it("node token only: unchanged behaviour when no jwt is configured", async () => {
		const auth = createNodeAuthenticator({ token: "node-secret" })
		await expect(auth.authenticate("Bearer node-secret")).resolves.toMatchObject({
			ok: true,
			caller: { credential: "node-token" },
		})
		await expect(auth.authenticate("Bearer wrong")).resolves.toMatchObject({ ok: false, status: 401 })
	})
})
