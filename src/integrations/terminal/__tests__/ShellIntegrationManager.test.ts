// npx vitest src/integrations/terminal/__tests__/ShellIntegrationManager.test.ts

/**
 * The ZDOTDIR shim. To make zsh emit VS Code's shell-integration escape
 * sequences we point the shell at a throwaway `$ZDOTDIR` holding a generated
 * `.zshrc` that sources VS Code's own script and then re-sources the user's real
 * dotfiles. Two things must hold or a user's shell silently loses its config:
 * the ORIGINAL `$ZDOTDIR` is preserved as `ROO_ZDOTDIR` before it is overwritten,
 * and the generated rc restores it. The cleanup half must never throw — it runs
 * while a terminal is closing.
 */

const hoisted = vi.hoisted(() => ({
	createDirectory: vi.fn(async () => undefined),
	writeFile: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	logs: [] as string[],
}))

vi.mock("vscode", () => ({
	Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
	env: { appRoot: "/vscode" },
	workspace: { fs: { createDirectory: hoisted.createDirectory, writeFile: hoisted.writeFile } },
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	webviewLog: {
		info: (m: string) => hoisted.logs.push(m),
		error: (m: string) => hoisted.logs.push(m),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}))

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { ShellIntegrationManager } from "../ShellIntegrationManager"

/**
 * The cleanup half reaches for `fs` through a CommonJS `require()` inside the
 * function, which vitest's ESM mock registry does not intercept — so these tests
 * use REAL throwaway directories rather than a fake filesystem.
 */
const madeDirs: string[] = []

function realTmpDir(withZshrc: boolean, extraFile?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shofer-zdotdir-test-"))
	madeDirs.push(dir)
	if (withZshrc) fs.writeFileSync(path.join(dir, ".zshrc"), "# rc")
	if (extraFile) fs.writeFileSync(path.join(dir, extraFile), "x")
	return dir
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.logs = []
	hoisted.createDirectory.mockResolvedValue(undefined)
	hoisted.writeFile.mockResolvedValue(undefined)
	ShellIntegrationManager.terminalTmpDirs.clear()
	delete process.env.ZDOTDIR
})

afterEach(() => {
	while (madeDirs.length) fs.rmSync(madeDirs.pop()!, { recursive: true, force: true })
})

describe("zshInitTmpDir", () => {
	it("returns a unique temp directory per call", () => {
		const a = ShellIntegrationManager.zshInitTmpDir({})
		const b = ShellIntegrationManager.zshInitTmpDir({})

		expect(a).toContain("shofer-zdotdir-")
		expect(a).not.toBe(b)
	})

	it("PRESERVES the caller's existing ZDOTDIR as ROO_ZDOTDIR before it is overwritten", () => {
		process.env.ZDOTDIR = "/home/u/.config/zsh"
		const env: Record<string, string> = {}

		ShellIntegrationManager.zshInitTmpDir(env)

		expect(env.ROO_ZDOTDIR).toBe("/home/u/.config/zsh")
	})

	it("sets no ROO_ZDOTDIR when the user had none", () => {
		const env: Record<string, string> = {}

		ShellIntegrationManager.zshInitTmpDir(env)

		expect(env.ROO_ZDOTDIR).toBeUndefined()
	})

	it("writes a .zshrc that sources VS Code's script and RESTORES the user's dotfiles", async () => {
		const tmpDir = ShellIntegrationManager.zshInitTmpDir({})
		await vi.waitFor(() => expect(hoisted.writeFile).toHaveBeenCalled())

		const [uri, bytes] = hoisted.writeFile.mock.calls[0] as [{ fsPath: string }, Buffer]
		expect(uri.fsPath).toBe(`${tmpDir}/.zshrc`)
		const rc = bytes.toString()
		expect(rc).toContain("shellIntegration-rc.zsh")
		expect(rc).toContain("ZDOTDIR=${ROO_ZDOTDIR:-$HOME}")
		expect(rc).toContain("unset ROO_ZDOTDIR")
		expect(rc).toContain('[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"')
	})

	it("logs — and does not throw — when the .zshrc write fails", async () => {
		hoisted.writeFile.mockRejectedValueOnce(new Error("EROFS"))

		ShellIntegrationManager.zshInitTmpDir({})

		await vi.waitFor(() => expect(hoisted.logs.join(" ")).toContain("Error creating .zshrc file"))
	})

	it("logs — and does not throw — when the temp directory cannot be created", async () => {
		hoisted.createDirectory.mockRejectedValueOnce(new Error("EACCES"))

		ShellIntegrationManager.zshInitTmpDir({})

		await vi.waitFor(() => expect(hoisted.logs.join(" ")).toContain("Error creating temporary directory"))
		expect(hoisted.writeFile).not.toHaveBeenCalled()
	})
})

describe("zshCleanupTmpDir", () => {
	it("returns false for a terminal that never had a temp directory", () => {
		expect(ShellIntegrationManager.zshCleanupTmpDir(7)).toBe(false)
	})

	it("removes the .zshrc, then the directory, then FORGETS the terminal", () => {
		const dir = realTmpDir(true)
		ShellIntegrationManager.terminalTmpDirs.set(7, dir)

		expect(ShellIntegrationManager.zshCleanupTmpDir(7)).toBe(true)

		expect(fs.existsSync(dir)).toBe(false)
		expect(ShellIntegrationManager.terminalTmpDirs.has(7)).toBe(false)
	})

	it("skips files that are already gone", () => {
		const dir = realTmpDir(false)
		ShellIntegrationManager.terminalTmpDirs.set(7, dir)

		expect(ShellIntegrationManager.zshCleanupTmpDir(7)).toBe(true)
		expect(fs.existsSync(dir)).toBe(false)
	})

	it("returns FALSE and logs rather than throwing while a terminal is closing", () => {
		// A stray file makes the rmdir fail with ENOTEMPTY — the shape of a real
		// cleanup race, and the one this guard exists for.
		const dir = realTmpDir(true, "leftover")
		ShellIntegrationManager.terminalTmpDirs.set(7, dir)

		expect(ShellIntegrationManager.zshCleanupTmpDir(7)).toBe(false)
		expect(hoisted.logs.join(" ")).toContain("Error cleaning up temporary directory")
		// The entry is KEPT so a later `clear()` can retry it.
		expect(ShellIntegrationManager.terminalTmpDirs.has(7)).toBe(true)
	})
})

describe("clear", () => {
	it("cleans up EVERY tracked terminal and empties the map", () => {
		const a = realTmpDir(true)
		const b = realTmpDir(true)
		ShellIntegrationManager.terminalTmpDirs.set(1, a)
		ShellIntegrationManager.terminalTmpDirs.set(2, b)

		ShellIntegrationManager.clear()

		expect(fs.existsSync(a)).toBe(false)
		expect(fs.existsSync(b)).toBe(false)
		expect(ShellIntegrationManager.terminalTmpDirs.size).toBe(0)
	})
})
