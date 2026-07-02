import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { createInMemoryHost, setHost } from "@shofer/types"

import { getStorageBasePath, setCustomStoragePathResolver } from "../storage.js"

// Mock only fs/promises (mkdir/access); `fs` constants stay real so the
// R_OK|W_OK|X_OK bitmask equals 7.
vi.mock("fs/promises", () => {
	const mkdir = vi.fn(async () => undefined)
	const access = vi.fn(async () => undefined)
	return { __esModule: true, default: { mkdir, access }, mkdir, access }
})

const fsp = (await import("fs/promises")) as unknown as {
	mkdir: ReturnType<typeof vi.fn>
	access: ReturnType<typeof vi.fn>
}

const errorSpy = vi.fn()

describe("getStorageBasePath - customStoragePath", () => {
	const defaultPath = "/test/global-storage"

	beforeEach(() => {
		vi.clearAllMocks()
		const host = createInMemoryHost()
		setHost({ ...host, notifier: { ...host.notifier, error: errorSpy } })
	})

	afterEach(() => {
		// Reset the resolver so it doesn't leak between tests.
		setCustomStoragePathResolver(async () => "")
	})

	it("returns the configured custom path when it is writable", async () => {
		const customPath = "/test/storage/path"
		setCustomStoragePathResolver(async () => customPath)

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(customPath)
		expect(fsp.mkdir).toHaveBeenCalledWith(customPath, { recursive: true })
		expect(fsp.access).toHaveBeenCalledWith(customPath, 7) // 7 = R_OK(4) | W_OK(2) | X_OK(1)
	})

	it("falls back to default and shows an error when custom path is not writable", async () => {
		const customPath = "/test/storage/unwritable"
		setCustomStoragePathResolver(async () => customPath)

		fsp.access.mockImplementationOnce(async (p: string) => {
			if (p === customPath) {
				const err = new Error("EACCES: permission denied") as Error & { code?: string }
				err.code = "EACCES"
				throw err
			}
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(errorSpy).toHaveBeenCalledTimes(1)
		expect(typeof errorSpy.mock.calls[0]![0]).toBe("string")
	})

	it("returns the default path when customStoragePath is empty and does not touch fs", async () => {
		setCustomStoragePathResolver(async () => "")

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(fsp.mkdir).not.toHaveBeenCalled()
		expect(fsp.access).not.toHaveBeenCalled()
	})

	it("falls back to default when mkdir fails and does not attempt access", async () => {
		const customPath = "/test/storage/failmkdir"
		setCustomStoragePathResolver(async () => customPath)

		fsp.mkdir.mockImplementationOnce(async (p: string) => {
			if (p === customPath) {
				const err = new Error("EACCES: permission denied") as Error & { code?: string }
				err.code = "EACCES"
				throw err
			}
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(fsp.access).not.toHaveBeenCalled()
		expect(errorSpy).toHaveBeenCalledTimes(1)
	})

	it("passes the correct permission flags (R_OK | W_OK | X_OK) to fs.access", async () => {
		const customPath = "/test/storage/path"
		setCustomStoragePathResolver(async () => customPath)

		await getStorageBasePath(defaultPath)

		expect(fsp.access).toHaveBeenCalledWith(customPath, 7)
	})

	it("falls back when directory is readable but not writable (partial permissions)", async () => {
		const customPath = "/test/storage/readonly"
		setCustomStoragePathResolver(async () => customPath)

		fsp.access.mockImplementationOnce(async (p: string, mode?: number) => {
			if (p === customPath && mode && mode & (2 | 1)) {
				const err = new Error("EACCES: permission denied") as Error & { code?: string }
				err.code = "EACCES"
				throw err
			}
		})

		const result = await getStorageBasePath(defaultPath)

		expect(result).toBe(defaultPath)
		expect(errorSpy).toHaveBeenCalledTimes(1)
	})
})
