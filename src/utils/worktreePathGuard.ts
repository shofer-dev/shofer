/**
 * Worktree Path Guard — prevents tasks running inside an embedded worktree
 * from writing to the master checkout or to another worktree.
 *
 * When a Task's `cwd` points into `.shofer/worktrees/<name>/`, it is an
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
 * 2. If `task.cwd` starts with `<workspacePath>/.shofer/worktrees/`, the
 *    task is scoped to an embedded worktree.
 * 3. For any target path, resolve against `task.cwd` and verify it stays
 *    within `task.cwd` (or equals it exactly, for directory operations).
 *
 * Normal (non-worktree) tasks always pass validation — the guard is a no-op.
 */

import * as fs from "fs"
import * as path from "path"
import type { Task } from "../core/task/Task"

/**
 * Determines whether a task is running inside an embedded worktree directory.
 *
 * An embedded worktree is a directory under `<workspace>/.shofer/worktrees/<name>/`
 * that serves as the task's `cwd`. This is the "new model" where worktree-scoped
 * tasks run in the same VS Code window.
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

	// Verify cwd is inside `.shofer/worktrees/` (not just any subdirectory).
	const embeddedPrefix = path.join(normalizedWorkspace, ".shofer", "worktrees") + path.sep
	return normalizedCwd.startsWith(embeddedPrefix)
}

/**
 * Validates that a target path stays within the task's assigned worktree directory.
 *
 * For non-worktree tasks, this always returns null (no restriction).
 * For worktree tasks, this resolves the path against `task.cwd` and checks
 * that it does not escape the worktree directory.
 *
 * @param task - The task instance
 * @param relPath - The relative or absolute path to validate
 * @returns An error message if the path escapes the worktree, or null if valid
 */
export function validateWorktreePath(task: Task, relPath: string): string | null {
	if (!isEmbeddedWorktreeTask(task)) {
		return null
	}

	const normalizedCwd = path.resolve(task.cwd)
	const absTarget = path.resolve(task.cwd, relPath)

	// Allow exact match on the worktree directory itself (e.g., create_directory on cwd).
	if (absTarget === normalizedCwd) {
		return null
	}

	// The target must be a strict descendant of the worktree directory.
	if (!absTarget.startsWith(normalizedCwd + path.sep)) {
		return (
			`Worktree isolation: cannot write outside the current worktree. ` +
			`Path '${relPath}' resolves to '${absTarget}', which is outside '${normalizedCwd}'. ` +
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
export function getWorktreeSandboxPrefix(task: Task): string[] | null {
	if (!isEmbeddedWorktreeTask(task) || !isLinux()) {
		return null
	}

	const worktreeDir = path.resolve(task.cwd)
	// The sandbox binary lives alongside the extension's source; at runtime,
	// __dirname resolves to the compiled output directory. The binary is at
	// <extension-root>/sandbox/shofer-sandbox.
	const sandboxBinary = path.resolve(__dirname, "..", "..", "sandbox", "shofer-sandbox")

	// If the binary is missing or non-executable, sandboxing is unavailable.
	// Log a diagnostic so the misconfiguration is debuggable.
	if (!fs.existsSync(sandboxBinary)) {
		// Lazy dynamic import to avoid a circular require with extension.ts.
		void import("../extension")
			.then(({ getOutputChannel }) => {
				const ch = getOutputChannel()
				if (!ch) return
				ch.appendLine(
					`[worktreePathGuard] shofer-sandbox binary not found at ${sandboxBinary}. ` +
						`Shell commands in worktree tasks will NOT be sandboxed. ` +
						`Build the binary: cd sandbox && GOWORK=off CGO_ENABLED=0 go build -o shofer-sandbox .`,
				)
			})
			.catch(() => {
				// channel not yet wired; drop silently
			})
		return null
	}

	return [sandboxBinary, worktreeDir]
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
