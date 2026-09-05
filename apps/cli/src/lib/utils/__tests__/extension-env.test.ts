/**
 * Unit tests for the `ROO_EXTENSION_PATH` override and the case-insensitive
 * path comparison — the two branches of `src/lib/utils/extension.ts` and
 * `src/lib/utils/path.ts` that only run under a particular environment.
 *
 * `fs` is faked so no directory has to exist, and `process.platform` is
 * redefined per case so the Windows/macOS comparison rule can be asserted on a
 * Linux runner.
 */

import fs from "fs"
import path from "path"

import { getDefaultExtensionPath } from "../extension.js"
import { arePathsEqual } from "../path.js"

vi.mock("fs")

describe("getDefaultExtensionPath with ROO_EXTENSION_PATH set", () => {
	const originalEnv = process.env

	beforeEach(() => {
		vi.resetAllMocks()
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("uses the env path when it holds a bundle", () => {
		process.env.ROO_EXTENSION_PATH = "/opt/shofer/extension"
		vi.mocked(fs.existsSync).mockImplementation(
			(candidate) => String(candidate) === path.join("/opt/shofer/extension", "extension.js"),
		)

		expect(getDefaultExtensionPath("/anywhere")).toBe("/opt/shofer/extension")
	})

	it("falls through when the env path holds no bundle", () => {
		process.env.ROO_EXTENSION_PATH = "/opt/shofer/empty"
		// Nothing exists anywhere: neither the env bundle, nor a package.json to
		// anchor on, nor the monorepo bundle — so the installed-layout fallback wins.
		vi.mocked(fs.existsSync).mockReturnValue(false)

		expect(getDefaultExtensionPath("/some/where/deep")).toBe(path.resolve("/", "extension"))
	})
})

describe("arePathsEqual across platforms", () => {
	function withPlatform(platform: string, body: () => void): void {
		const original = Object.getOwnPropertyDescriptor(process, "platform")!
		Object.defineProperty(process, "platform", { value: platform, configurable: true })
		try {
			body()
		} finally {
			Object.defineProperty(process, "platform", original)
		}
	}

	it.each(["win32", "darwin"])("compares case-insensitively on %s", (platform) => {
		withPlatform(platform, () => {
			expect(arePathsEqual("/Users/Test/Project", "/users/test/project")).toBe(true)
			expect(arePathsEqual("/Users/Test/Project/", "/users/test/project")).toBe(true)
			expect(arePathsEqual("/Users/Test/Project", "/users/test/other")).toBe(false)
		})
	})

	it("compares case-sensitively on linux", () => {
		withPlatform("linux", () => {
			expect(arePathsEqual("/Users/Test/Project", "/users/test/project")).toBe(false)
			expect(arePathsEqual("/Users/Test/Project/", "/Users/Test/Project")).toBe(true)
		})
	})

	it("treats a missing path as unequal", () => {
		expect(arePathsEqual(undefined, "/a")).toBe(false)
		expect(arePathsEqual("/a", undefined)).toBe(false)
		expect(arePathsEqual(undefined, undefined)).toBe(false)
	})
})
