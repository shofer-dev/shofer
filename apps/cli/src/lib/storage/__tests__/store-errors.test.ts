/**
 * Unit tests for the failure paths of the credential and settings stores
 * (`src/lib/storage/credentials.ts`, `src/lib/storage/settings.ts`).
 *
 * Both read files with a "missing is fine, anything else is fatal" contract, so
 * `fs/promises` is faked to hand back an `EACCES` rather than an `ENOENT`. The
 * happy paths are covered against a real temp directory in `credentials.test.ts`
 * and `settings.test.ts`.
 */

import { clearToken, getCredentialsPath, hasToken, loadCredentials, loadToken } from "../credentials.js"
import { getSettingsPath, loadSettings, resetOnboarding, saveSettings } from "../settings.js"

const fsMock = vi.hoisted(() => ({
	readFile: vi.fn(),
	writeFile: vi.fn(async () => {}),
	unlink: vi.fn(async () => {}),
	mkdir: vi.fn(async () => undefined),
}))

vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }))

/** An `fs` rejection carrying `code`. */
function fsError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: fake`), { code })
}

describe("credential store failures", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		fsMock.writeFile.mockResolvedValue(undefined)
		fsMock.unlink.mockResolvedValue(undefined)
		fsMock.mkdir.mockResolvedValue(undefined)
	})

	it("treats a missing credentials file as 'not logged in'", async () => {
		fsMock.readFile.mockRejectedValue(fsError("ENOENT"))

		await expect(loadToken()).resolves.toBeNull()
		await expect(loadCredentials()).resolves.toBeNull()
		await expect(hasToken()).resolves.toBe(false)
	})

	it("rethrows any other read failure rather than reporting logged-out", async () => {
		fsMock.readFile.mockRejectedValue(fsError("EACCES"))

		await expect(loadToken()).rejects.toThrow("EACCES")
		await expect(loadCredentials()).rejects.toThrow("EACCES")
	})

	it("treats a missing file as an already-cleared token", async () => {
		fsMock.unlink.mockRejectedValue(fsError("ENOENT"))
		await expect(clearToken()).resolves.toBeUndefined()
	})

	it("rethrows any other unlink failure", async () => {
		fsMock.unlink.mockRejectedValue(fsError("EPERM"))
		await expect(clearToken()).rejects.toThrow("EPERM")
	})

	it("reports a token when one is readable", async () => {
		fsMock.readFile.mockResolvedValue(JSON.stringify({ token: "jwt", createdAt: "2026-01-01T00:00:00.000Z" }))

		await expect(loadToken()).resolves.toBe("jwt")
		await expect(hasToken()).resolves.toBe(true)
	})

	it("keeps the credentials file inside the config dir", () => {
		expect(getCredentialsPath()).toMatch(/cli-credentials\.json$/)
	})
})

describe("settings store failures", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		fsMock.writeFile.mockResolvedValue(undefined)
		fsMock.mkdir.mockResolvedValue(undefined)
	})

	it("treats a missing settings file as empty settings", async () => {
		fsMock.readFile.mockRejectedValue(fsError("ENOENT"))
		await expect(loadSettings()).resolves.toEqual({})
	})

	it("rethrows any other read failure rather than silently defaulting", async () => {
		fsMock.readFile.mockRejectedValue(fsError("EACCES"))
		await expect(loadSettings()).rejects.toThrow("EACCES")
	})

	it("merges over the existing settings and writes owner-only", async () => {
		fsMock.readFile.mockResolvedValue(JSON.stringify({ mode: "code", model: "old" }))

		await saveSettings({ model: "new" })

		expect(fsMock.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true })
		const [file, body, options] = fsMock.writeFile.mock.calls[0] as unknown as [string, string, { mode: number }]
		expect(file).toBe(getSettingsPath())
		expect(JSON.parse(body)).toEqual({ mode: "code", model: "new" })
		expect(options).toEqual({ mode: 0o600 })
	})

	it("clears the onboarding choice", async () => {
		fsMock.readFile.mockResolvedValue(JSON.stringify({ onboardingProviderChoice: "shofer" }))

		await resetOnboarding()

		const [, body] = fsMock.writeFile.mock.calls[0] as unknown as [string, string]
		expect(JSON.parse(body).onboardingProviderChoice).toBeUndefined()
	})
})
