/**
 * Unit tests for the CLI's JWT helpers (`src/lib/auth/token.ts`).
 *
 * The helpers never verify a signature — they only read `exp` out of the
 * payload — so every fixture here is a hand-built, unsigned three-segment
 * token. Nothing in this file talks to an auth server.
 */

import { getTokenExpirationDate, isTokenExpired, isTokenValid } from "../token.js"
import * as authIndex from "../index.js"

/** Build an unsigned `header.payload.signature` token carrying `payload`. */
function makeToken(payload: Record<string, unknown>, opts: { segments?: number } = {}): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8").toString("base64url")
	const parts = [encode({ alg: "none", typ: "JWT" }), encode(payload), "sig"]
	const segments = opts.segments ?? 3
	return parts.slice(0, segments).join(".")
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

describe("isTokenExpired", () => {
	it("treats a token expiring beyond the buffer as not expired", () => {
		const token = makeToken({ exp: nowSeconds() + 60 * 60 * 24 * 30 })
		expect(isTokenExpired(token)).toBe(false)
	})

	it("treats a token inside the default 24h buffer as expired", () => {
		const token = makeToken({ exp: nowSeconds() + 60 })
		expect(isTokenExpired(token)).toBe(true)
	})

	it("honours an explicit buffer of zero", () => {
		const token = makeToken({ exp: nowSeconds() + 60 })
		expect(isTokenExpired(token, 0)).toBe(false)
	})

	it("reports expired for a token with no exp claim", () => {
		expect(isTokenExpired(makeToken({ sub: "u_1" }))).toBe(true)
	})

	it("reports expired for a token whose segment count is wrong", () => {
		expect(isTokenExpired(makeToken({ exp: nowSeconds() + 1000 }, { segments: 2 }))).toBe(true)
		expect(isTokenExpired("not-a-token")).toBe(true)
	})

	it("reports expired when the payload segment is empty", () => {
		expect(isTokenExpired("header..sig")).toBe(true)
	})

	it("reports expired when the payload is not JSON", () => {
		const garbage = Buffer.from("definitely-not-json", "utf-8").toString("base64url")
		expect(isTokenExpired(`header.${garbage}.sig`)).toBe(true)
	})

	it("pads a payload whose base64url length is not a multiple of four", () => {
		// `{"exp":N}` encodes to a length that needs padding restored.
		const exp = nowSeconds() + 60 * 60 * 24 * 30
		const payload = Buffer.from(JSON.stringify({ exp }), "utf-8").toString("base64url").replace(/=+$/, "")
		expect(isTokenExpired(`h.${payload}.s`)).toBe(false)
	})
})

describe("isTokenValid", () => {
	it("is true while the expiry is in the future", () => {
		expect(isTokenValid(makeToken({ exp: nowSeconds() + 60 }))).toBe(true)
	})

	it("is false once the expiry has passed", () => {
		expect(isTokenValid(makeToken({ exp: nowSeconds() - 60 }))).toBe(false)
	})

	it("is false for an undecodable token", () => {
		expect(isTokenValid("garbage")).toBe(false)
	})
})

describe("getTokenExpirationDate", () => {
	it("returns the expiry as a Date", () => {
		const exp = nowSeconds() + 1234
		expect(getTokenExpirationDate(makeToken({ exp }))?.getTime()).toBe(exp * 1000)
	})

	it("returns null when there is no exp claim", () => {
		expect(getTokenExpirationDate(makeToken({ sub: "u_1" }))).toBeNull()
	})

	it("returns null for an undecodable token", () => {
		expect(getTokenExpirationDate("nope")).toBeNull()
	})
})

describe("lib/auth barrel", () => {
	it("re-exports the token helpers", () => {
		expect(authIndex.isTokenExpired).toBe(isTokenExpired)
		expect(authIndex.isTokenValid).toBe(isTokenValid)
		expect(authIndex.getTokenExpirationDate).toBe(getTokenExpirationDate)
	})
})
