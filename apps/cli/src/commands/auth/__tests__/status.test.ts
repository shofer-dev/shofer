/**
 * Unit tests for `shofer auth status` (`src/commands/auth/status.ts`).
 *
 * The credential store is faked; the JWT helpers are the real ones, driven by
 * hand-built unsigned tokens whose `exp` claim places them in each of the four
 * states the command distinguishes (absent / expired / expiring-soon / valid).
 */

import { getCredentialsPath, loadCredentials, loadToken } from "@/lib/storage/index.js"

import { status } from "../status.js"

vi.mock("@/lib/storage/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/storage/index.js")>()
	return {
		...actual,
		loadToken: vi.fn(),
		loadCredentials: vi.fn(),
		getCredentialsPath: vi.fn(() => "/tmp/does-not-exist/cli-credentials.json"),
	}
})

const HOUR = 60 * 60
const DAY = 24 * HOUR

/** An unsigned token whose `exp` is `offsetSeconds` from now. */
function tokenExpiringIn(offsetSeconds: number): string {
	const exp = Math.floor(Date.now() / 1000) + offsetSeconds
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8").toString("base64url")
	return `${encode({ alg: "none" })}.${encode({ exp })}.sig`
}

describe("status", () => {
	let logs: string[]

	beforeEach(() => {
		vi.clearAllMocks()
		logs = []
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "))
		})
		vi.mocked(loadCredentials).mockResolvedValue(null)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("reports unauthenticated when no token is stored", async () => {
		vi.mocked(loadToken).mockResolvedValue(null)

		await expect(status()).resolves.toEqual({ authenticated: false })

		expect(logs.join("\n")).toContain("✗ Not authenticated")
		expect(logs.join("\n")).toContain("Run: shofer auth login")
		expect(loadCredentials).not.toHaveBeenCalled()
	})

	it("reports an expired token and does not claim authentication", async () => {
		const token = tokenExpiringIn(-HOUR)
		vi.mocked(loadToken).mockResolvedValue(token)

		const result = await status()

		expect(result.authenticated).toBe(false)
		expect(result.expired).toBe(true)
		expect(result.expiresAt).toBeInstanceOf(Date)
		expect(logs.join("\n")).toContain("✗ Authentication token expired")
	})

	it("warns when the token expires inside the 24h window", async () => {
		vi.mocked(loadToken).mockResolvedValue(tokenExpiringIn(2 * HOUR))

		const result = await status()

		expect(result).toMatchObject({ authenticated: true, expired: false, expiringSoon: true })
		expect(logs.join("\n")).toContain("⚠ Expires soon; refresh with `shofer auth login`")
		// Under a day remaining, the countdown is rendered in hours.
		expect(logs.join("\n")).toMatch(/Expires: {6}.+\(\d+ hours?\)/)
	})

	it("reports a healthy token and a day-granularity countdown", async () => {
		vi.mocked(loadToken).mockResolvedValue(tokenExpiringIn(3 * DAY + HOUR))

		const result = await status()

		expect(result).toMatchObject({ authenticated: true, expired: false, expiringSoon: false })
		expect(logs.join("\n")).toContain("✓ Authenticated")
		expect(logs.join("\n")).toMatch(/\(3 days\)/)
	})

	it("renders a one-day countdown in the singular", async () => {
		vi.mocked(loadToken).mockResolvedValue(tokenExpiringIn(DAY + HOUR))

		await status()

		expect(logs.join("\n")).toMatch(/\(1 day\)/)
	})

	it("prints the creation date and credentials path only under --verbose", async () => {
		vi.mocked(loadToken).mockResolvedValue(tokenExpiringIn(3 * DAY + HOUR))
		vi.mocked(loadCredentials).mockResolvedValue({ token: "t", createdAt: "2026-01-02T03:04:05.000Z" })

		const quiet = await status()
		expect(quiet.createdAt).toBeInstanceOf(Date)
		expect(logs.join("\n")).not.toContain("Created:")
		expect(logs.join("\n")).not.toContain("Credentials:")

		logs.length = 0
		await status({ verbose: true })

		expect(logs.join("\n")).toContain("Created:")
		expect(logs.join("\n")).toContain("Credentials:  /tmp/does-not-exist/cli-credentials.json")
		expect(getCredentialsPath).toHaveBeenCalled()
	})

	it("omits the creation date when the stored credentials carry none", async () => {
		vi.mocked(loadToken).mockResolvedValue(tokenExpiringIn(3 * DAY + HOUR))
		vi.mocked(loadCredentials).mockResolvedValue({ token: "t", createdAt: "" })

		const result = await status({ verbose: true })

		expect(result.createdAt).toBeUndefined()
		expect(logs.join("\n")).not.toContain("Created:")
	})

	it("omits the expiry line for a token with no exp claim", async () => {
		// No `exp` → `getTokenExpirationDate` is null while `isTokenValid` is
		// false, so this lands on the expired branch with no date to print.
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8").toString("base64url")
		vi.mocked(loadToken).mockResolvedValue(`${encode({ alg: "none" })}.${encode({ sub: "u" })}.sig`)

		const result = await status()

		expect(result).toEqual({ authenticated: false, expired: true, expiresAt: undefined })
	})
})
