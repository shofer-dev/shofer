import * as actualFsPromises from "fs/promises"
import * as path from "path"

// Use the same mock pattern as safeWriteJson.test.ts:
// import actuals, then selectively wrap with vi.fn().
vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	const mockedFs = { ...actual }
	mockedFs.readFile = vi.fn(actual.readFile) as any
	return mockedFs
})

import * as fs from "fs/promises"
import { parseGitmodules, formatSubmoduleBlock, resolveSubmoduleEntries, type SubmoduleEntry } from "../git-submodules"

const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>

describe("parseGitmodules", () => {
	const workspacePath = "/test/workspace"
	const gitmodulesPath = path.join(workspacePath, ".gitmodules")

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("should return empty map when .gitmodules does not exist", async () => {
		readFileMock.mockRejectedValue({ code: "ENOENT" })

		const result = await parseGitmodules(workspacePath)

		expect(result).toBeInstanceOf(Map)
		expect(result.size).toBe(0)
		expect(readFileMock).toHaveBeenCalledWith(gitmodulesPath, "utf-8")
	})

	it("should parse a single submodule with path and url", async () => {
		readFileMock.mockResolvedValue(
			'[submodule "code-server"]\n\tpath = code-server\n\turl = https://github.com/coder/code-server.git\n',
		)

		const result = await parseGitmodules(workspacePath)

		expect(result.size).toBe(1)
		const entry = result.get("code-server")
		expect(entry).toBeDefined()
		expect(entry!.path).toBe("code-server")
		expect(entry!.url).toBe("https://github.com/coder/code-server.git")
		expect(entry!.branch).toBeUndefined()
	})

	it("should parse multiple submodules", async () => {
		readFileMock.mockResolvedValue(
			`[submodule "code-server"]
	path = code-server
	url = https://github.com/coder/code-server.git
[submodule "extensions/shofer"]
	path = extensions/shofer
	url = https://github.com/shofer-dev/shofer.git
	branch = master
[submodule "extensions/shofer-router"]
	path = extensions/shofer-router
	url = https://github.com/shofer-dev/shofer-router.git
	branch = master
`,
		)

		const result = await parseGitmodules(workspacePath)

		expect(result.size).toBe(3)

		const entry1 = result.get("code-server")
		expect(entry1!.path).toBe("code-server")
		expect(entry1!.url).toBe("https://github.com/coder/code-server.git")
		expect(entry1!.branch).toBeUndefined()

		const entry2 = result.get("extensions/shofer")
		expect(entry2!.path).toBe("extensions/shofer")
		expect(entry2!.url).toBe("https://github.com/shofer-dev/shofer.git")
		expect(entry2!.branch).toBe("master")

		const entry3 = result.get("extensions/shofer-router")
		expect(entry3!.path).toBe("extensions/shofer-router")
		expect(entry3!.url).toBe("https://github.com/shofer-dev/shofer-router.git")
		expect(entry3!.branch).toBe("master")
	})

	it("should handle entries without a branch gracefully", async () => {
		readFileMock.mockResolvedValue(
			'[submodule "no-branch"]\n\tpath = no-branch\n\turl = https://example.com/repo.git\n',
		)

		const result = await parseGitmodules(workspacePath)

		expect(result.size).toBe(1)
		const entry = result.get("no-branch")
		expect(entry!.path).toBe("no-branch")
		expect(entry!.url).toBe("https://example.com/repo.git")
		expect(entry!.branch).toBeUndefined()
	})

	it("should skip unknown keys silently", async () => {
		readFileMock.mockResolvedValue(
			'[submodule "with-extra"]\n\tpath = with-extra\n\turl = https://example.com/repo.git\n\tignore = dirty\n\tshallow = true\n',
		)

		const result = await parseGitmodules(workspacePath)

		expect(result.size).toBe(1)
		const entry = result.get("with-extra")
		expect(entry!.path).toBe("with-extra")
		expect(entry!.url).toBe("https://example.com/repo.git")
	})

	it("should handle comments and blank lines", async () => {
		readFileMock.mockResolvedValue(
			`# This is a comment
; This is also a comment
[submodule "lib"]

	# Indented comment
	path = lib
	url = https://example.com/lib.git
`,
		)

		const result = await parseGitmodules(workspacePath)

		expect(result.size).toBe(1)
		const entry = result.get("lib")
		expect(entry!.path).toBe("lib")
		expect(entry!.url).toBe("https://example.com/lib.git")
	})

	it("should handle empty .gitmodules file", async () => {
		readFileMock.mockResolvedValue("\n\n\n")

		const result = await parseGitmodules(workspacePath)

		expect(result.size).toBe(0)
	})

	it("should handle INI section name without submodule prefix", async () => {
		readFileMock.mockResolvedValue(
			`[core]
	bare = false
[submodule "repo"]
	path = repo
	url = https://example.com/repo.git
`,
		)

		const result = await parseGitmodules(workspacePath)

		// Only the [submodule ...] section should be parsed.
		expect(result.size).toBe(1)
		expect(result.get("repo")!.url).toBe("https://example.com/repo.git")
	})

	it("should ignore key-value pairs outside a submodule section", async () => {
		readFileMock.mockResolvedValue(
			`path = orphan
url = https://example.com/orphan.git
[submodule "real"]
	path = real
	url = https://example.com/real.git
`,
		)

		const result = await parseGitmodules(workspacePath)

		expect(result.size).toBe(1)
		expect(result.get("real")!.path).toBe("real")
		expect(result.get("orphan")).toBeUndefined()
	})
})

describe("formatSubmoduleBlock", () => {
	it("should return empty string for undefined entries", () => {
		expect(formatSubmoduleBlock(undefined)).toBe("")
	})

	it("should return empty string for empty array", () => {
		expect(formatSubmoduleBlock([])).toBe("")
	})

	it("should format a single submodule entry", () => {
		const entries: SubmoduleEntry[] = [{ path: "code-server", url: "https://github.com/coder/code-server.git" }]

		const result = formatSubmoduleBlock(entries)

		expect(result).toContain("WORKSPACE SUBMODULES")
		expect(result).toContain("`code-server` → https://github.com/coder/code-server.git")
		expect(result).not.toContain("(branch:")
	})

	it("should format entries with branches", () => {
		const entries: SubmoduleEntry[] = [
			{ path: "extensions/shofer", url: "https://github.com/shofer-dev/shofer.git", branch: "master" },
		]

		const result = formatSubmoduleBlock(entries)

		expect(result).toContain("(branch: master)")
	})

	it("should format multiple entries", () => {
		const entries: SubmoduleEntry[] = [
			{ path: "code-server", url: "https://github.com/coder/code-server.git" },
			{ path: "extensions/shofer", url: "https://github.com/shofer-dev/shofer.git", branch: "master" },
		]

		const result = formatSubmoduleBlock(entries)

		expect(result).toContain("`code-server`")
		expect(result).toContain("`extensions/shofer`")
	})

	it("should truncate at 51+ entries with notice", () => {
		const entries: SubmoduleEntry[] = Array.from({ length: 55 }, (_, i) => ({
			path: `sub-${i}`,
			url: `https://example.com/sub-${i}.git`,
		}))

		const result = formatSubmoduleBlock(entries)

		expect(result).toContain("`sub-0`")
		expect(result).toContain("`sub-49`")
		expect(result).not.toContain("`sub-50`")
		expect(result).toContain("5 more submodules (truncated)")
	})

	it("should not truncate at exactly 50 entries", () => {
		const entries: SubmoduleEntry[] = Array.from({ length: 50 }, (_, i) => ({
			path: `sub-${i}`,
			url: `https://example.com/sub-${i}.git`,
		}))

		const result = formatSubmoduleBlock(entries)

		expect(result).toContain("`sub-0`")
		expect(result).toContain("`sub-49`")
		expect(result).not.toContain("truncated")
	})
})

describe("resolveSubmoduleEntries", () => {
	const ws = "/test/workspace"

	// Dispatch readFile by directory so each level's `.gitmodules` is served.
	const mockGitmodulesByDir = (byDir: Record<string, string>) => {
		readFileMock.mockImplementation(async (p: string) => {
			for (const [dir, content] of Object.entries(byDir)) {
				if (p === path.join(dir, ".gitmodules")) {
					return content
				}
			}
			const err = new Error("ENOENT") as NodeJS.ErrnoException
			err.code = "ENOENT"
			throw err
		})
	}

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("resolves metadata for top-level submodules from the root .gitmodules", async () => {
		mockGitmodulesByDir({
			[ws]: `[submodule "code-server"]
	path = code-server
	url = https://github.com/coder/code-server.git
[submodule "shofer"]
	path = extensions/shofer
	url = https://github.com/shofer-dev/shofer.git
	branch = master
`,
		})

		const entries = await resolveSubmoduleEntries(ws, ["code-server", "extensions/shofer"])

		expect(entries).toEqual([
			{ path: "code-server", url: "https://github.com/coder/code-server.git", branch: undefined },
			{ path: "extensions/shofer", url: "https://github.com/shofer-dev/shofer.git", branch: "master" },
		])
	})

	it("resolves a NESTED submodule from its immediate superproject .gitmodules (regression)", async () => {
		// Top-level .gitmodules knows `code-server`; the nested `lib/vscode` lives
		// only in `code-server/.gitmodules`. A flat top-level parse would drop it.
		mockGitmodulesByDir({
			[ws]: `[submodule "code-server"]
	path = code-server
	url = https://github.com/coder/code-server.git
`,
			[path.join(ws, "code-server")]: `[submodule "vscode"]
	path = lib/vscode
	url = https://github.com/microsoft/vscode.git
	branch = main
`,
		})

		const entries = await resolveSubmoduleEntries(ws, ["code-server", "code-server/lib/vscode"])

		expect(entries).toEqual([
			{ path: "code-server", url: "https://github.com/coder/code-server.git", branch: undefined },
			{ path: "code-server/lib/vscode", url: "https://github.com/microsoft/vscode.git", branch: "main" },
		])
	})

	it("returns an empty url (never drops) when metadata cannot be resolved", async () => {
		mockGitmodulesByDir({}) // no .gitmodules anywhere

		const entries = await resolveSubmoduleEntries(ws, ["code-server/lib/vscode"])

		expect(entries).toEqual([{ path: "code-server/lib/vscode", url: "", branch: undefined }])
	})

	it("does not treat a partial-name sibling as a parent (a vs a-b)", async () => {
		mockGitmodulesByDir({
			[ws]: `[submodule "a"]
	path = a
	url = https://example.com/a.git
[submodule "a-b"]
	path = a-b
	url = https://example.com/a-b.git
`,
		})

		const entries = await resolveSubmoduleEntries(ws, ["a", "a-b"])

		// `a-b` must resolve from the ROOT .gitmodules, not be mis-parented under `a`.
		expect(entries).toEqual([
			{ path: "a", url: "https://example.com/a.git", branch: undefined },
			{ path: "a-b", url: "https://example.com/a-b.git", branch: undefined },
		])
	})
})
