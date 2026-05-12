/**
 * WorktreeTool
 *
 * Native tool for managing git worktrees.  Follows the `subcommand` pattern
 * established by the `file` tool.  All worktrees are created under
 * `.roo/worktrees/` by default (Phase 2 convention) unless an explicit
 * absolute path is provided.
 *
 * The tool is assigned to the `mode` group so that Orchestrator tasks —
 * which have no filesystem or command-execution access — can still manage
 * worktree lifecycle (create, list, merge, destroy, status).
 *
 * Safety invariants:
 *   - destroy refuses unmerged branches unless `force=true`
 *   - merge refuses when there are uncommitted changes in the main worktree
 *   - create refuses when path exists or branch name is taken
 */

import * as path from "path"
import { exec } from "child_process"
import { promisify } from "util"
import * as fsPromises from "fs/promises"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { formatResponse } from "../prompts/responses"
import { Task } from "../task/Task"
import { worktreeService, worktreeIncludeService } from "@roo-code/core"

import type { ToolUse } from "../../shared/tools"

// ─── shared exec helper ─────────────────────────────────────────────────────

const execAsync = promisify(exec)

/** Run a git command with PAGER=cat to avoid interactive pagers. */
async function runGit(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
	return execAsync(command, { cwd, env: { ...process.env, PAGER: "cat" } })
}

// ─── parameter types ────────────────────────────────────────────────────────

interface WorktreeParams {
	subcommand: "create" | "list" | "merge" | "destroy" | "status"
	path?: string
	branch?: string
	base_branch?: string
	/**
	 * For `merge`: the branch into which the worktree branch should be merged.
	 * If omitted, defaults to the detected base branch (`main` or `master`).
	 * The tool refuses to merge if the main worktree's HEAD does not match.
	 */
	target_branch?: string
	force?: boolean | string
}

// ─── subcommand result types ────────────────────────────────────────────────

interface WorktreeListEntry {
	path: string
	branch: string
	isCurrent: boolean
	isRooWorktree: boolean
}

interface WorktreeCreateResult {
	success: boolean
	path: string
	branch: string
	message: string
}

interface WorktreeMergeResult {
	merged: boolean
	conflicts?: boolean
	conflictedFiles?: string[]
}

interface WorktreeDestroyResult {
	removed: boolean
	branchDeleted: boolean
	message: string
}

interface WorktreeStatusResult {
	branch: string
	ahead: number
	behind: number
	hasUncommitted: boolean
	mergeReady: boolean
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a worktree path.  Relative paths are resolved against the
 * task's cwd (the workspace root for the orchestrator).
 */
function resolvePath(task: Task, userPath?: string): string {
	if (!userPath) {
		throw new Error("path is required for this subcommand")
	}
	return path.isAbsolute(userPath) ? userPath : path.resolve(task.cwd, userPath)
}

/**
 * Check whether a given worktree path lives under the `.roo/worktrees/`
 * convention prefix (i.e. is an embedded worktree managed by Roo Code).
 */
function isRooWorktree(cwd: string, worktreePath: string): boolean {
	const rooWorktreesDir = path.join(cwd, ".roo", "worktrees")
	const resolved = path.resolve(worktreePath)
	return resolved.startsWith(rooWorktreesDir + path.sep) || resolved === rooWorktreesDir
}

// ─── the tool ───────────────────────────────────────────────────────────────

export class WorktreeTool extends BaseTool<"worktree"> {
	readonly name = "worktree" as const

	async execute(params: WorktreeParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, askApproval, handleError } = callbacks
		const { subcommand, force: rawForce } = params
		const force = rawForce === true || rawForce === "true"

		try {
			switch (subcommand) {
				case "create":
					await this.handleCreate(params, task, pushToolResult, handleError)
					return
				case "list":
					await this.handleList(task, pushToolResult, handleError)
					return
				case "merge":
					await this.handleMerge(params, task, pushToolResult, askApproval, handleError)
					return
				case "destroy":
					await this.handleDestroy(params, task, pushToolResult, force, handleError)
					return
				case "status":
					await this.handleStatus(params, task, pushToolResult, handleError)
					return
				default: {
					pushToolResult(
						formatResponse.toolError(
							`Unknown subcommand: ${subcommand}. Valid subcommands: create, list, merge, destroy, status.`,
						),
					)
					return
				}
			}
		} catch (error) {
			await handleError("worktree operation", error instanceof Error ? error : new Error(String(error)))
		}
	}

	// ─── create ──────────────────────────────────────────────────────────

	private async handleCreate(
		params: WorktreeParams,
		task: Task,
		pushToolResult: ToolCallbacks["pushToolResult"],
		handleError: ToolCallbacks["handleError"],
	): Promise<void> {
		const cwd = task.cwd

		// Default branch name
		const branch = params.branch || `worktree/roo-${Math.random().toString(36).substring(2, 7)}`

		// Default path under .roo/worktrees/
		const defaultPath = path.join(cwd, ".roo", "worktrees", path.basename(branch))
		const resolvedPath = params.path ? resolvePath(task, params.path) : defaultPath

		// Check if the worktree already exists
		try {
			const worktrees = await worktreeService.listWorktrees(cwd)
			const exists = worktrees.some((wt) => path.resolve(wt.path) === path.resolve(resolvedPath))
			if (exists) {
				pushToolResult(formatResponse.toolError(`Worktree path already exists: ${resolvedPath}`))
				return
			}
		} catch {
			// best-effort check; proceed
		}

		// Ensure .roo/worktrees/ is gitignored
		await ensureWorktreeDirGitignored(cwd)

		const result = await worktreeService.createWorktree(cwd, {
			path: resolvedPath,
			branch,
			baseBranch: params.base_branch,
			createNewBranch: true,
		})

		if (!result.success) {
			pushToolResult(formatResponse.toolError(result.message))
			return
		}

		// Copy .worktreeinclude intersection files if present
		let copiedSummary = ""
		try {
			const copiedItems = await worktreeIncludeService.copyWorktreeIncludeFiles(cwd, resolvedPath)
			if (copiedItems.length > 0) {
				copiedSummary = ` (copied ${copiedItems.length} item(s) from .worktreeinclude)`
			}
		} catch {
			// non-fatal
		}

		pushToolResult(
			formatResponse.toolResult(`Worktree created.\nPath: ${resolvedPath}\nBranch: ${branch}${copiedSummary}`),
		)
	}

	// ─── list ────────────────────────────────────────────────────────────

	private async handleList(
		task: Task,
		pushToolResult: ToolCallbacks["pushToolResult"],
		handleError: ToolCallbacks["handleError"],
	): Promise<void> {
		const worktrees = await worktreeService.listWorktrees(task.cwd)

		const entries: WorktreeListEntry[] = worktrees.map((wt) => ({
			path: wt.path,
			branch: wt.branch || "(detached)",
			isCurrent: wt.isCurrent,
			isRooWorktree: isRooWorktree(task.workspacePath, wt.path),
		}))

		pushToolResult(JSON.stringify(entries, null, 2))
	}

	// ─── merge ───────────────────────────────────────────────────────────

	private async handleMerge(
		params: WorktreeParams,
		task: Task,
		pushToolResult: ToolCallbacks["pushToolResult"],
		askApproval: ToolCallbacks["askApproval"],
		handleError: ToolCallbacks["handleError"],
	): Promise<void> {
		const resolvedPath = resolvePath(task, params.path)

		// Find the worktree to get its branch
		const worktrees = await worktreeService.listWorktrees(task.cwd)
		const wt = worktrees.find((w) => path.resolve(w.path) === path.resolve(resolvedPath))

		if (!wt || !wt.branch) {
			pushToolResult(formatResponse.toolError(`No worktree with a branch found at: ${resolvedPath}`))
			return
		}

		if (wt.isCurrent) {
			pushToolResult(formatResponse.toolError("Cannot merge the current worktree into itself."))
			return
		}

		// Determine the target branch (where the merge will land).  Defaults to
		// the detected base branch when not explicitly provided.
		const targetBranch = params.target_branch || (await this.detectBaseBranch(task.cwd))

		// Refuse to merge if the main worktree's HEAD is not on the target branch.
		// This prevents accidentally merging into the orchestrator's working branch
		// when the user expected the merge to land on `main`/`master`.
		let currentBranch = ""
		try {
			const { stdout } = await runGit("git rev-parse --abbrev-ref HEAD", task.cwd)
			currentBranch = stdout.trim()
		} catch (err) {
			pushToolResult(
				formatResponse.toolError(
					`Failed to determine current branch: ${err instanceof Error ? err.message : String(err)}`,
				),
			)
			return
		}
		if (currentBranch !== targetBranch) {
			pushToolResult(
				formatResponse.toolError(
					`Cannot merge: main worktree HEAD is on '${currentBranch}', not target '${targetBranch}'. ` +
						`Check out '${targetBranch}' first or pass target_branch='${currentBranch}' explicitly.`,
				),
			)
			return
		}

		// Check for uncommitted changes in the main worktree
		try {
			const { stdout: statusOut } = await runGit("git status --porcelain", task.cwd)
			if (statusOut.trim()) {
				pushToolResult(
					formatResponse.toolError(
						"Cannot merge: there are uncommitted changes in the current worktree. " +
							"Please commit or stash them first.",
					),
				)
				return
			}
		} catch (err) {
			pushToolResult(
				formatResponse.toolError(
					`Failed to check worktree status: ${err instanceof Error ? err.message : String(err)}`,
				),
			)
			return
		}

		// Attempt the merge
		try {
			await runGit(`git merge --no-ff ${wt.branch}`, task.cwd)
			pushToolResult(
				formatResponse.toolResult(`Merged branch '${wt.branch}' into '${targetBranch}' successfully.`),
			)
		} catch (mergeErr: unknown) {
			const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr)
			const hasConflicts = errMsg.includes("CONFLICT") || errMsg.includes("Automatic merge failed")

			if (hasConflicts) {
				try {
					const { stdout: conflictFiles } = await runGit("git diff --name-only --diff-filter=U", task.cwd)
					const files = conflictFiles.trim().split("\n").filter(Boolean)
					await runGit("git merge --abort", task.cwd).catch(() => {})
					pushToolResult(
						formatResponse.toolError(
							`Merge conflict detected.  Merge has been aborted.\n` +
								`Conflicted files: ${files.join(", ")}\n` +
								`Please resolve conflicts manually or spawn a subtask to fix them.`,
						),
					)
				} catch {
					await runGit("git merge --abort", task.cwd).catch(() => {})
					pushToolResult(formatResponse.toolError(`Merge failed: ${errMsg}`))
				}
			} else {
				await runGit("git merge --abort", task.cwd).catch(() => {})
				pushToolResult(formatResponse.toolError(`Merge failed: ${errMsg}`))
			}
		}
	}

	// ─── destroy ─────────────────────────────────────────────────────────

	private async handleDestroy(
		params: WorktreeParams,
		task: Task,
		pushToolResult: ToolCallbacks["pushToolResult"],
		force: boolean,
		handleError: ToolCallbacks["handleError"],
	): Promise<void> {
		const resolvedPath = resolvePath(task, params.path)

		// Find the worktree
		const worktrees = await worktreeService.listWorktrees(task.cwd)
		const wt = worktrees.find((w) => path.resolve(w.path) === path.resolve(resolvedPath))

		if (!wt) {
			pushToolResult(formatResponse.toolError(`No worktree found at: ${resolvedPath}`))
			return
		}

		if (wt.isCurrent) {
			pushToolResult(formatResponse.toolError("Cannot destroy the current worktree."))
			return
		}

		if (!force && wt.branch) {
			// Safety: check if the branch has been merged
			try {
				await runGit(`git merge-base --is-ancestor ${wt.branch} HEAD`, task.cwd)
				// If we get here, the branch is an ancestor → merged ✓
			} catch {
				pushToolResult(
					formatResponse.toolError(
						`Cannot destroy: branch '${wt.branch}' has not been merged. ` + `Use force=true to override.`,
					),
				)
				return
			}
		}

		const result = await worktreeService.deleteWorktree(task.cwd, resolvedPath, force)
		if (result.success) {
			pushToolResult(formatResponse.toolResult(result.message))
		} else {
			pushToolResult(formatResponse.toolError(result.message))
		}
	}

	// ─── status ──────────────────────────────────────────────────────────

	private async handleStatus(
		params: WorktreeParams,
		task: Task,
		pushToolResult: ToolCallbacks["pushToolResult"],
		handleError: ToolCallbacks["handleError"],
	): Promise<void> {
		const resolvedPath = resolvePath(task, params.path)

		const worktrees = await worktreeService.listWorktrees(task.cwd)
		const wt = worktrees.find((w) => path.resolve(w.path) === path.resolve(resolvedPath))

		if (!wt) {
			pushToolResult(formatResponse.toolError(`No worktree found at: ${resolvedPath}`))
			return
		}

		let ahead = 0
		let behind = 0
		let hasUncommitted = false

		try {
			// Uncommitted changes in the worktree
			const { stdout: statusOut } = await runGit("git status --porcelain", resolvedPath)
			hasUncommitted = statusOut.trim().length > 0
		} catch {
			// best-effort
		}

		if (wt.branch) {
			try {
				// Ahead/behind relative to main/master
				const baseBranch = await this.detectBaseBranch(task.cwd)
				const { stdout: aheadOut } = await runGit(`git rev-list --count ${baseBranch}..${wt.branch}`, task.cwd)
				ahead = parseInt(aheadOut.trim(), 10) || 0

				const { stdout: behindOut } = await runGit(`git rev-list --count ${wt.branch}..${baseBranch}`, task.cwd)
				behind = parseInt(behindOut.trim(), 10) || 0
			} catch {
				// best-effort
			}
		}

		const status: WorktreeStatusResult = {
			branch: wt.branch || "(detached)",
			ahead,
			behind,
			hasUncommitted,
			mergeReady: !hasUncommitted && behind === 0,
		}

		pushToolResult(JSON.stringify(status, null, 2))
	}

	private async detectBaseBranch(cwd: string): Promise<string> {
		try {
			await runGit("git rev-parse --verify main", cwd)
			return "main"
		} catch {
			return "master"
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"worktree">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "worktree",
			subcommand: block.params.subcommand ?? "",
			path: block.params.path ?? "",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const worktreeToolInstance = new WorktreeTool()

/**
 * Ensure `.roo/worktrees/` is covered by the repository's `.gitignore`.
 * If not, append it so the main branch doesn't track worktree content.
 */
async function ensureWorktreeDirGitignored(cwd: string): Promise<void> {
	const gitignorePath = path.join(cwd, ".gitignore")
	const pattern = ".roo/worktrees/"

	try {
		const content = await fsPromises.readFile(gitignorePath, "utf-8")
		const lines = content.split("\n").map((l) => l.trim())
		// Check if .roo/ or .roo/worktrees/ is already covered
		const isCovered = lines.some((line) => line === ".roo/" || line === ".roo/worktrees/" || line === pattern)
		if (!isCovered) {
			await fsPromises.appendFile(gitignorePath, `\n${pattern}\n`, "utf-8")
		}
	} catch {
		// Gitignore doesn't exist; create it with the pattern
		try {
			await fsPromises.writeFile(gitignorePath, `${pattern}\n`, "utf-8")
		} catch {
			// non-fatal
		}
	}
}
