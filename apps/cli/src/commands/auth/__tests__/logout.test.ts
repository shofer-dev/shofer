/**
 * Unit tests for `shofer auth logout` (`src/commands/auth/logout.ts`) and the
 * `commands/auth` barrel. The credential store is faked, so no test touches
 * the developer's real `~/.shofer/cli-credentials.json`.
 */

import { clearToken, getCredentialsPath, hasToken } from "@/lib/storage/index.js"

import { logout } from "../logout.js"
import * as authCommands from "../index.js"

vi.mock("@/lib/storage/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/storage/index.js")>()
	return {
		...actual,
		clearToken: vi.fn(),
		hasToken: vi.fn(),
		getCredentialsPath: vi.fn(() => "/tmp/does-not-exist/cli-credentials.json"),
	}
})

describe("logout", () => {
	let logs: string[]

	beforeEach(() => {
		vi.clearAllMocks()
		logs = []
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("reports not-logged-in and clears nothing when there is no token", async () => {
		vi.mocked(hasToken).mockResolvedValue(false)

		await expect(logout()).resolves.toEqual({ success: true, wasLoggedIn: false })

		expect(clearToken).not.toHaveBeenCalled()
		expect(logs).toContain("You are not currently logged in.")
	})

	it("clears the token when one exists", async () => {
		vi.mocked(hasToken).mockResolvedValue(true)

		await expect(logout()).resolves.toEqual({ success: true, wasLoggedIn: true })

		expect(clearToken).toHaveBeenCalledTimes(1)
		expect(logs).toContain("✓ Successfully logged out")
	})

	it("names the credentials file under --verbose", async () => {
		vi.mocked(hasToken).mockResolvedValue(true)

		await logout({ verbose: true })

		expect(getCredentialsPath).toHaveBeenCalled()
		expect(logs.join("\n")).toContain("[Auth] Removing credentials from /tmp/does-not-exist/cli-credentials.json")
	})

	it("stays quiet about the path without --verbose", async () => {
		vi.mocked(hasToken).mockResolvedValue(true)

		await logout()

		expect(logs.join("\n")).not.toContain("[Auth] Removing credentials")
	})
})

describe("commands/auth barrel", () => {
	it("re-exports login, logout and status", () => {
		expect(typeof authCommands.login).toBe("function")
		expect(authCommands.logout).toBe(logout)
		expect(typeof authCommands.status).toBe("function")
	})
})
