/* eslint-disable @typescript-eslint/no-require-imports -- test constructs binary fixtures via dynamic require(os)/require(fs) */
import * as path from "path"
import { EMBEDDED_WORKTREES_DIR, LEGACY_EMBEDDED_WORKTREES_DIR } from "@shofer/types"

import {
	isEmbeddedWorktreeTask,
	validateWorktreePath,
	getWorktreeCommandWarning,
	getWorktreeSandboxPrefix,
	isBinaryCorrectArch,
} from "../worktreePathGuard.js"

/**
 * Creates a minimal mock Task object sufficient for the guard functions.
 * The guard only accesses `task.cwd` and `task.workspacePath`.
 */
function mockTask(cwd: string, workspacePath: string) {
	return {
		cwd,
		workspacePath,
	} as any
}

const WORKSPACE = "/home/user/project"
const WORKTREE = path.join(WORKSPACE, EMBEDDED_WORKTREES_DIR, "repo-hl911")
const OTHER_WORKTREE = path.join(WORKSPACE, EMBEDDED_WORKTREES_DIR, "repo-abc42")
const LEGACY_WORKTREE = path.join(WORKSPACE, LEGACY_EMBEDDED_WORKTREES_DIR, "repo-old42")
const SUBDIR = path.join(WORKSPACE, "src")

describe("isEmbeddedWorktreeTask", () => {
	it("returns true for a task scoped to an embedded worktree", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		expect(isEmbeddedWorktreeTask(task)).toBe(true)
	})

	// Transition shim: a worktree created before the move still has to be recognised,
	// or it silently loses both path confinement and the Linux shell sandbox.
	it("returns true for a task scoped to a worktree at the legacy path", () => {
		const task = mockTask(LEGACY_WORKTREE, WORKSPACE)
		expect(isEmbeddedWorktreeTask(task)).toBe(true)
	})

	it("confines a task at the legacy path just like one at the current path", () => {
		const task = mockTask(LEGACY_WORKTREE, WORKSPACE)
		expect(validateWorktreePath(task, "src/main.ts")).toBeNull()
		expect(validateWorktreePath(task, path.join(WORKSPACE, "master-file.txt"))).toContain(
			"cannot write outside the current worktree",
		)
	})

	it("returns false for a task at the workspace root", () => {
		const task = mockTask(WORKSPACE, WORKSPACE)
		expect(isEmbeddedWorktreeTask(task)).toBe(false)
	})

	it("returns false for a task in a regular subdirectory (not a worktree)", () => {
		const task = mockTask(SUBDIR, WORKSPACE)
		expect(isEmbeddedWorktreeTask(task)).toBe(false)
	})

	it("returns false when cwd is outside the workspace entirely", () => {
		const task = mockTask("/tmp/external", WORKSPACE)
		expect(isEmbeddedWorktreeTask(task)).toBe(false)
	})

	it("returns false when cwd matches a deep path that coincidentally contains the worktrees dir", () => {
		// The guard uses startsWith on the resolved absolute path — it won't
		// match a path like /foo/.worktrees/bar/baz that isn't under
		// the actual workspacePath.
		const impostor = path.join(WORKSPACE, "lib", EMBEDDED_WORKTREES_DIR, "nested")
		const task = mockTask(impostor, WORKSPACE)
		// lib/.worktrees/nested is NOT under workspacePath/.worktrees/
		expect(isEmbeddedWorktreeTask(task)).toBe(false)
	})

	it("returns false for a task in a directory merely named like the worktrees dir", () => {
		const task = mockTask(path.join(WORKSPACE, `${EMBEDDED_WORKTREES_DIR}-backup`, "x"), WORKSPACE)
		expect(isEmbeddedWorktreeTask(task)).toBe(false)
	})
})

describe("validateWorktreePath", () => {
	it("returns null for a non-worktree task (always allowed)", () => {
		const task = mockTask(WORKSPACE, WORKSPACE)
		expect(validateWorktreePath(task, "any/file.ts")).toBeNull()
	})

	it("returns null for a worktree task writing inside its own tree", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		expect(validateWorktreePath(task, "src/main.ts")).toBeNull()
	})

	it("blocks a worktree task from writing via absolute path to master", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		const err = validateWorktreePath(task, path.join(WORKSPACE, "master-file.txt"))
		expect(err).not.toBeNull()
		expect(err!).toContain("cannot write outside the current worktree")
	})

	it("blocks a worktree task from writing to another worktree", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		const err = validateWorktreePath(task, path.join(OTHER_WORKTREE, "file.ts"))
		expect(err).not.toBeNull()
		expect(err!).toContain("cannot write outside the current worktree")
	})

	it("blocks .. traversal escaping the worktree", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		const err = validateWorktreePath(task, "../../master-file.txt")
		expect(err).not.toBeNull()
		expect(err!).toContain("cannot write outside the current worktree")
	})

	it("blocks .. traversal into another worktree", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		const err = validateWorktreePath(task, "../repo-abc42/secret.ts")
		expect(err).not.toBeNull()
		expect(err!).toContain("cannot write outside the current worktree")
	})

	it("allows writing to a subdirectory within the worktree", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		expect(validateWorktreePath(task, "deeply/nested/path/file.ts")).toBeNull()
	})

	it("allows the worktree root directory itself (exact match)", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		expect(validateWorktreePath(task, ".")).toBeNull()
	})

	it("includes the resolved path in the error message", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		const target = "../../outside.txt"
		const err = validateWorktreePath(task, target)
		expect(err).toContain(target)
		expect(err).toContain(path.resolve(task.cwd, target))
	})
})

// Symlink escapes need a real filesystem: the check follows links on the part of the
// path that exists, which a purely in-memory path cannot exercise.
describe("validateWorktreePath — symlink escapes", () => {
	const fs = require("fs")
	const os = require("os")

	let root: string
	let workspace: string
	let worktree: string

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktree-guard-")))
		workspace = path.join(root, "project")
		worktree = path.join(workspace, EMBEDDED_WORKTREES_DIR, "repo-hl911")
		fs.mkdirSync(worktree, { recursive: true })
		fs.writeFileSync(path.join(workspace, "master-file.txt"), "master")
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("blocks writing through a symlinked directory that points outside the worktree", () => {
		fs.symlinkSync(workspace, path.join(worktree, "escape"), "dir")
		const task = mockTask(worktree, workspace)
		expect(validateWorktreePath(task, "escape/master-file.txt")).toContain(
			"cannot write outside the current worktree",
		)
	})

	it("blocks a symlinked file inside the worktree whose target is outside it", () => {
		fs.symlinkSync(path.join(workspace, "master-file.txt"), path.join(worktree, "linked.txt"), "file")
		const task = mockTask(worktree, workspace)
		expect(validateWorktreePath(task, "linked.txt")).toContain("cannot write outside the current worktree")
	})

	it("still allows a real path inside the worktree", () => {
		fs.mkdirSync(path.join(worktree, "src"))
		const task = mockTask(worktree, workspace)
		expect(validateWorktreePath(task, "src/new-file.ts")).toBeNull()
	})
})

describe("getWorktreeCommandWarning", () => {
	it("returns null for non-worktree tasks", () => {
		const task = mockTask(WORKSPACE, WORKSPACE)
		expect(getWorktreeCommandWarning(task)).toBeNull()
	})

	it("returns a warning string for worktree tasks", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		const warning = getWorktreeCommandWarning(task)
		expect(warning).not.toBeNull()
		expect(warning!).toContain("WORKTREE CONTEXT")
		expect(warning!).toContain("repo-hl911")
	})

	it("warning mentions the worktree name", () => {
		const task = mockTask(WORKTREE, WORKSPACE)
		const warning = getWorktreeCommandWarning(task)
		expect(warning).toContain("repo-hl911")
	})
})

describe("getWorktreeSandboxPrefix", () => {
	const origPlatform = process.platform

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: origPlatform })
	})

	it("returns null for non-worktree tasks", () => {
		const task = mockTask(WORKSPACE, WORKSPACE)
		expect(getWorktreeSandboxPrefix(task)).toBeNull()
	})

	it("returns null on non-Linux platforms", () => {
		Object.defineProperty(process, "platform", { value: "darwin" })
		const task = mockTask(WORKTREE, WORKSPACE)
		expect(getWorktreeSandboxPrefix(task)).toBeNull()
	})

	it("returns null on Windows", () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		const task = mockTask(WORKTREE, WORKSPACE)
		expect(getWorktreeSandboxPrefix(task)).toBeNull()
	})

	it("throws SandboxUnavailableError when binary is missing on Linux", () => {
		Object.defineProperty(process, "platform", { value: "linux" })
		const task = mockTask(WORKTREE, WORKSPACE)
		// The binary doesn't exist at the resolved path in tests,
		// so getWorktreeSandboxPrefix should throw.
		expect(() => getWorktreeSandboxPrefix(task)).toThrow("Worktree shell sandbox unavailable")
	})

	it("detects valid x86-64 ELF binary", () => {
		const tmp = require("os").tmpdir()
		const elf = path.join(tmp, "test-x86.sandbox")
		// Minimal ELF header: magic (4) + class=2 (64-bit) + padding + machine=0x3e (x86-64)
		const buf = Buffer.alloc(20)
		buf[0] = 0x7f
		buf[1] = 0x45
		buf[2] = 0x4c
		buf[3] = 0x46
		buf[4] = 2 // ELFCLASS64
		buf.writeUInt16LE(0x3e, 18) // EM_X86_64
		require("fs").writeFileSync(elf, buf)
		require("fs").chmodSync(elf, 0o755)

		expect(isBinaryCorrectArch(elf)).toBe(true)
		require("fs").unlinkSync(elf)
	})

	it("detects wrong-arch ELF (arm64 on x86-64 host)", () => {
		const tmp = require("os").tmpdir()
		const elf = path.join(tmp, "test-arm64.sandbox")
		const buf = Buffer.alloc(20)
		buf[0] = 0x7f
		buf[1] = 0x45
		buf[2] = 0x4c
		buf[3] = 0x46
		buf[4] = 2
		buf.writeUInt16LE(0xb7, 18) // EM_AARCH64
		require("fs").writeFileSync(elf, buf)
		require("fs").chmodSync(elf, 0o755)

		expect(isBinaryCorrectArch(elf)).toBe(false)
		require("fs").unlinkSync(elf)
	})

	it("detects non-ELF file", () => {
		const tmp = require("os").tmpdir()
		const nonElf = path.join(tmp, "test-not-elf.sandbox")
		require("fs").writeFileSync(nonElf, "#!/bin/sh\necho hello")
		require("fs").chmodSync(nonElf, 0o755)

		expect(isBinaryCorrectArch(nonElf)).toBe(false)
		require("fs").unlinkSync(nonElf)
	})
})
