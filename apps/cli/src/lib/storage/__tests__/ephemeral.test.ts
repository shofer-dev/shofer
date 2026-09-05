/**
 * Unit tests for `createEphemeralStorageDir` (`src/lib/storage/ephemeral.ts`)
 * and the `getConfigDir` / `ensureConfigDir` pair
 * (`src/lib/storage/config-dir.ts`).
 *
 * The ephemeral directory is created for real under the OS temp dir and
 * removed again; the config directory's error handling is exercised against a
 * faked `fs/promises.mkdir` so no test ever writes to the developer's real
 * `~/.shofer`.
 */

import fs from "fs"
import os from "os"
import path from "path"

import { createEphemeralStorageDir } from "../ephemeral.js"
import { ensureConfigDir, getConfigDir } from "../config-dir.js"

const mkdir = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, default: { ...actual, mkdir }, mkdir }
})

describe("createEphemeralStorageDir", () => {
	const created: string[] = []

	afterEach(() => {
		while (created.length > 0) {
			fs.rmSync(created.pop()!, { recursive: true, force: true })
		}
	})

	it("creates a shofer-cli-prefixed directory under the OS temp dir", async () => {
		const dir = await createEphemeralStorageDir()
		created.push(dir)

		expect(path.dirname(dir)).toBe(os.tmpdir())
		expect(path.basename(dir)).toMatch(/^shofer-cli-\d+-[a-z0-9]+$/)
		expect(fs.existsSync(dir)).toBe(true)
	})

	it("hands out a distinct directory per call", async () => {
		const first = await createEphemeralStorageDir()
		const second = await createEphemeralStorageDir()
		created.push(first, second)

		expect(first).not.toBe(second)
	})
})

describe("getConfigDir", () => {
	it("is ~/.shofer", () => {
		expect(getConfigDir()).toBe(path.join(os.homedir(), ".shofer"))
	})
})

describe("ensureConfigDir", () => {
	beforeEach(() => {
		mkdir.mockReset()
		mkdir.mockResolvedValue(undefined)
	})

	it("creates the config dir recursively", async () => {
		await ensureConfigDir()
		expect(mkdir).toHaveBeenCalledWith(getConfigDir(), { recursive: true })
	})

	it("swallows EEXIST", async () => {
		const error = Object.assign(new Error("exists"), { code: "EEXIST" })
		mkdir.mockRejectedValueOnce(error)
		await expect(ensureConfigDir()).resolves.toBeUndefined()
	})

	it("rethrows any other failure", async () => {
		const error = Object.assign(new Error("denied"), { code: "EACCES" })
		mkdir.mockRejectedValueOnce(error)
		await expect(ensureConfigDir()).rejects.toThrow("denied")
	})
})
