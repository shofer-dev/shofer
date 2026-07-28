/**
 * Worktree Path Guard — prevents tasks running inside an embedded worktree
 * from writing to the master checkout or to another worktree.
 *
 * When a Task's `cwd` points into `<workspace>/.worktrees/<name>/`, it is an
 * "embedded worktree task". All mutating tools that accept file paths must
 * validate that the resolved absolute path stays within the task's assigned
 * worktree directory. Attempts to escape (via `..`, absolute paths, or
 * symlinks that resolve outside) are blocked with a clear error.
 *
 * ## Design
 *
 * The detection is filesystem-level and synchronous — no git dependency:
 *
 * 1. Resolve `task.cwd` and `task.workspacePath` to absolute paths.
 * 2. If `task.cwd` starts with `<workspacePath>/.worktrees/`, the task is
 *    scoped to an embedded worktree.
 * 3. For any target path, resolve against `task.cwd` — following symlinks on the
 *    part of the path that already exists — and verify it stays within `task.cwd`
 *    (or equals it exactly, for directory operations).
 *
 * Normal (non-worktree) tasks always pass validation — the guard is a no-op.
 */

import * as fs from "fs"
import * as path from "path"

import { EMBEDDED_WORKTREES_DIR, LEGACY_EMBEDDED_WORKTREES_DIR } from "@shofer/types"

import { type Task } from "../task/Task.js"

/**
 * Determines whether a task is running inside an embedded worktree directory.
 *
 * An embedded worktree is a directory under `<workspace>/.worktrees/<name>/`
 * that serves as the task's `cwd`. This is the "new model" where worktree-scoped
 * tasks run in the same VS Code window.
 *
 * The previous location, `<workspace>/.shofer/worktrees/`, is recognised as well:
 * this is a **transition shim, to be removed in a later release**. It exists
 * because dropping it does not fail loudly — a worktree a user already has would
 * simply stop being recognised, and both the path confinement below and the Linux
 * shell sandbox would vanish with no error.
 *
 * @param task - The task to check
 * @returns true if the task is scoped to an embedded worktree
 */
export function isEmbeddedWorktreeTask(task: Task): boolean {
	const normalizedCwd = path.resolve(task.cwd)
	const normalizedWorkspace = path.resolve(task.workspacePath)

	// Not a worktree task if cwd equals the workspace root.
	if (normalizedCwd === normalizedWorkspace) {
		return false
	}

	// Verify cwd is inside the worktrees directory (not just any subdirectory).
	return [EMBEDDED_WORKTREES_DIR, LEGACY_EMBEDDED_WORKTREES_DIR].some((dir) =>
		normalizedCwd.startsWith(path.join(normalizedWorkspace, dir) + path.sep),
	)
}

/**
 * Resolves symlinks on the longest existing prefix of `target`, keeping the rest
 * lexical.
 *
 * `fs.realpathSync` throws on a path that does not exist yet, which is the normal
 * case here — the tools calling the guard are usually about to CREATE the file. So
 * walk up to the deepest ancestor that does exist, resolve that, and re-append the
 * remaining segments. A symlink anywhere in the existing part is therefore followed,
 * which is what makes `<worktree>/link -> /etc` fail containment instead of passing
 * it lexically.
 */
function resolveThroughSymlinks(target: string): string {
	let current = path.resolve(target)
	const remainder: string[] = []

	for (;;) {
		try {
			return path.join(fs.realpathSync(current), ...remainder)
		} catch {
			const parent = path.dirname(current)
			// Reached the filesystem root without finding an existing ancestor.
			if (parent === current) return path.resolve(target)
			remainder.unshift(path.basename(current))
			current = parent
		}
	}
}

/**
 * Validates that a target path stays within the task's assigned worktree directory.
 *
 * For non-worktree tasks, this always returns null (no restriction).
 * For worktree tasks, this resolves the path against `task.cwd` — following
 * symlinks, so a link planted inside the worktree cannot be used as a door out —
 * and checks that it does not escape the worktree directory.
 *
 * @param task - The task instance
 * @param relPath - The relative or absolute path to validate
 * @returns An error message if the path escapes the worktree, or null if valid
 */
export function validateWorktreePath(task: Task, relPath: string): string | null {
	if (!isEmbeddedWorktreeTask(task)) {
		return null
	}

	// Both sides go through the same resolution, so a worktree that is itself
	// reached via a symlink (e.g. macOS `/tmp` → `/private/tmp`) still compares equal.
	const normalizedCwd = resolveThroughSymlinks(task.cwd)
	const lexicalTarget = path.resolve(task.cwd, relPath)
	const absTarget = resolveThroughSymlinks(lexicalTarget)

	// Allow exact match on the worktree directory itself (e.g., create_directory on cwd).
	if (absTarget === normalizedCwd) {
		return null
	}

	// The target must be a strict descendant of the worktree directory.
	if (!absTarget.startsWith(normalizedCwd + path.sep)) {
		return (
			`Worktree isolation: cannot write outside the current worktree. ` +
			`Path '${relPath}' resolves to '${lexicalTarget}', which is outside '${normalizedCwd}'. ` +
			`Use a task scoped to the master checkout or the target worktree to make changes there.`
		)
	}

	return null
}

/**
 * Returns whether the current platform is Linux, where kernel-level sandboxing
 * (Landlock / bwrap) is available.
 */
function isLinux(): boolean {
	return process.platform === "linux"
}

/**
 * Returns the sandbox wrapper command prefix for worktree-scoped shell commands.
 *
 * On Linux, this returns the absolute path to the shofer-sandbox binary followed
 * by the worktree directory, so the caller can prepend it to the user's command.
 * On non-Linux platforms (macOS, Windows), it returns null — no kernel sandbox
 * is available, so the advisory warning (getWorktreeCommandWarning) is the only
 * guard.
 *
 * @param task - The task instance
 * @returns The sandbox prefix array, or null if sandboxing is unavailable
 */
/**
 * Error thrown when the sandbox binary is unavailable but required for a
 * worktree-scoped task.  The caller (ExecuteCommandTool) catches this and
 * surfaces it as a blocking error so the command never executes unsandboxed.
 */
export class SandboxUnavailableError extends Error {
	constructor(
		reason: string,
		public readonly worktreeDir: string,
	) {
		super(
			`Worktree shell sandbox unavailable at '${worktreeDir}': ${reason}. ` +
				`Shell commands in worktree tasks cannot run without sandboxing. ` +
				`Ensure the shofer-sandbox binary is built for the correct architecture.`,
		)
		this.name = "SandboxUnavailableError"
	}
}

/**
 * Returns the sandbox wrapper command prefix for worktree-scoped shell commands.
 *
 * On Linux, this returns the absolute path to the shofer-sandbox binary followed
 * by the worktree directory.  On non-Linux platforms (macOS, Windows), it returns
 * null — no kernel sandbox is available, so the advisory warning
 * (getWorktreeCommandWarning) is the only guard.
 *
 * If the binary is missing for a worktree task on Linux, throws
 * SandboxUnavailableError rather than silently degrading.
 *
 * @param task - The task instance
 * @returns The sandbox prefix array, or null if sandboxing is unavailable
 * @throws  SandboxUnavailableError if sandboxing is required but impossible
 */
export function getWorktreeSandboxPrefix(task: Task): string[] | null {
	if (!isEmbeddedWorktreeTask(task) || !isLinux()) {
		return null
	}

	const worktreeDir = path.resolve(task.cwd)
	// The sandbox binary is shipped as src/sandbox/shofer-sandbox and
	// copied into dist/sandbox/ by esbuild.  At runtime __dirname is
	// <install>/dist/, so resolve to ./sandbox/shofer-sandbox.
	const sandboxBinary = path.resolve(__dirname, "sandbox", "shofer-sandbox")

	// Fail closed — for worktree tasks on Linux the sandbox must be present.
	if (!fs.existsSync(sandboxBinary)) {
		throw new SandboxUnavailableError("binary not found", worktreeDir)
	}

	// Verify the binary is executable for the current architecture.
	try {
		fs.accessSync(sandboxBinary, fs.constants.X_OK)
	} catch {
		throw new SandboxUnavailableError("binary not executable", worktreeDir)
	}

	// Check that it's an ELF binary matching the current arch (fail on
	// wrong-arch, e.g. x86-64 binary on arm64).
	const archOk = isBinaryCorrectArch(sandboxBinary)
	if (!archOk) {
		throw new SandboxUnavailableError(`binary architecture mismatch (expected ${process.arch})`, worktreeDir)
	}

	return [sandboxBinary, worktreeDir]
}

/**
 * Reads the ELF header of the given file and checks that its machine type
 * matches the current process architecture.  Returns true if the binary
 * is for the correct arch, false otherwise.
 */
/**
 * Reads the ELF header (first 20 bytes) of the given file and checks that its
 * machine type matches the current process architecture.
 *
 * Exported for testing.
 */
export function isBinaryCorrectArch(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, "r")
		const header = Buffer.alloc(20)
		const bytesRead = fs.readSync(fd, header, 0, 20, 0)
		fs.closeSync(fd)
		if (bytesRead < 20) return false

		// ELF magic: 0x7f 'E' 'L' 'F'
		if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
			return false
		}

		// Machine type (offset 18, 2 bytes little-endian): 0x3e = x86-64, 0xb7 = aarch64
		const machine = header.readUInt16LE(18)
		const expectedMachine = process.arch === "arm64" ? 0xb7 : 0x3e
		return machine === expectedMachine
	} catch {
		return false
	}
}

/**
 * Returns a warning message to prepend to command approval when a worktree-scoped
 * task is about to execute a shell command. The warning reminds the user that the
 * command can escape the worktree via `cd`, absolute paths, or shell redirections.
 *
 * For non-worktree tasks, this always returns null.
 *
 * @param task - The task instance
 * @returns A warning string, or null if not in a worktree task
 */
export function getWorktreeCommandWarning(task: Task): string | null {
	if (!isEmbeddedWorktreeTask(task)) {
		return null
	}

	const worktreeName = path.basename(path.resolve(task.cwd))

	return (
		`⚠️  WORKTREE CONTEXT: This task is scoped to worktree '${worktreeName}' at\n` +
		`   ${path.resolve(task.cwd)}\n` +
		`   Shell commands are NOT automatically sandboxed — they can read and write\n` +
		`   files outside this worktree via absolute paths, 'cd', or redirects.\n` +
		`   Verify the command does not modify the master checkout or other worktrees.\n`
	)
}
