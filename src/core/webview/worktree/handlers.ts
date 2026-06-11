/**
 * Worktree Handlers
 *
 * VSCode-specific handlers that bridge webview messages to the core worktree services.
 * These handlers handle VSCode-specific logic like opening folders and managing state.
 */

import { exec } from "child_process"
import * as vscode from "vscode"
import * as path from "path"
import { promisify } from "util"

const execAsync = promisify(exec)

import type {
	WorktreeResult,
	BranchInfo,
	WorktreeIncludeStatus,
	WorktreeListResponse,
	WorktreeDefaultsResponse,
	WorktreeStatus,
} from "@shofer/types"
import { worktreeService, worktreeIncludeService, type CopyProgressCallback } from "@shofer/core"

import type { ShoferProvider } from "../ShoferProvider"

/**
 * Generate a random alphanumeric suffix for branch/folder names.
 */
function generateRandomSuffix(length = 5): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	let result = ""

	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length))
	}

	return result
}

async function isWorkspaceSubfolder(cwd: string): Promise<boolean> {
	const gitRoot = await worktreeService.getGitRootPath(cwd)

	if (!gitRoot) {
		return false
	}

	// Normalize paths for comparison.
	const normalizedCwd = path.normalize(cwd)
	const normalizedGitRoot = path.normalize(gitRoot)

	// If cwd is deeper than git root, it's a subfolder.
	return normalizedCwd !== normalizedGitRoot && normalizedCwd.startsWith(normalizedGitRoot)
}

export async function handleListWorktrees(provider: ShoferProvider): Promise<WorktreeListResponse> {
	const workspaceFolders = vscode.workspace.workspaceFolders
	const isMultiRoot = workspaceFolders ? workspaceFolders.length > 1 : false

	if (!workspaceFolders || workspaceFolders.length === 0) {
		return {
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath: "",
			error: "No workspace folder open",
		}
	}

	// Multi-root workspaces not supported for worktrees.
	if (isMultiRoot) {
		return {
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: true,
			isSubfolder: false,
			gitRootPath: "",
			error: "Worktrees are not supported in multi-root workspaces",
		}
	}

	const cwd = provider.cwd
	const isGitRepo = await worktreeService.checkGitRepo(cwd)

	if (!isGitRepo) {
		return {
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath: "",
			error: "Not a git repository",
		}
	}

	const isSubfolder = await isWorkspaceSubfolder(cwd)
	const gitRootPath = (await worktreeService.getGitRootPath(cwd)) || ""

	// Embedded worktree exception: when the workspace IS a subfolder, but
	// that subfolder lives directly under `<gitRoot>/.shofer/worktrees/`
	// (i.e. this is an embedded worktree task created by the new model),
	// allow it.  The embedded model runs all tasks in a single VS Code
	// window so the subfolder restriction is not necessary.
	//
	// Path check is anchored to the resolved git root + path.relative to
	// avoid false matches against unrelated directories whose name happens
	// to contain `.shofer/worktrees/` as a substring.
	let isEmbeddedWorktree = false
	if (isSubfolder && gitRootPath) {
		const rel = path.relative(path.resolve(gitRootPath), path.resolve(cwd))
		const embeddedPrefix = path.join(".shofer", "worktrees") + path.sep
		isEmbeddedWorktree = !rel.startsWith("..") && !path.isAbsolute(rel) && rel.startsWith(embeddedPrefix)
	}

	if (isSubfolder && !isEmbeddedWorktree) {
		return {
			worktrees: [],
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: true,
			gitRootPath,
			error: "Worktrees are not supported when workspace is a subfolder of a git repository",
		}
	}

	try {
		const worktrees = await worktreeService.listWorktrees(cwd)

		return {
			worktrees,
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath,
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)

		return {
			worktrees: [],
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath,
			error: `Failed to list worktrees: ${errorMessage}`,
		}
	}
}

export async function handleCreateWorktree(
	provider: ShoferProvider,
	options: {
		path: string
		branch?: string
		baseBranch?: string
		createNewBranch?: boolean
	},
	onCopyProgress?: CopyProgressCallback,
): Promise<WorktreeResult> {
	const cwd = provider.cwd

	const isGitRepo = await worktreeService.checkGitRepo(cwd)

	if (!isGitRepo) {
		return {
			success: false,
			message: "Not a git repository",
		}
	}

	// Enforce embedded worktree convention: all worktrees MUST live under
	// .shofer/worktrees/ inside the workspace. If the caller passes a path
	// outside that prefix, normalize it by prepending the convention path.
	const conventionPrefix = path.join(cwd, ".shofer", "worktrees")
	const normalizedAbs = path.resolve(cwd, options.path)
	if (!normalizedAbs.startsWith(conventionPrefix + path.sep) && normalizedAbs !== conventionPrefix) {
		// Extract the last path component (directory name) and place it
		// under the convention prefix.
		const dirName = path.basename(options.path)
		options = { ...options, path: path.join(conventionPrefix, dirName) }
	}

	const result = await worktreeService.createWorktree(cwd, options)

	// If successful and worktreeinclude exists, copy the files.
	if (result.success && result.worktree) {
		try {
			const copiedItems = await worktreeIncludeService.copyWorktreeIncludeFiles(
				cwd,
				result.worktree.path,
				onCopyProgress,
			)
			if (copiedItems.length > 0) {
				result.message += ` (copied ${copiedItems.length} item(s) from worktreeinclude)`
			}
		} catch (error) {
			// Log but don't fail the worktree creation.
			provider.log(`Warning: Failed to copy worktreeinclude files: ${error}`)
		}

		// Shallow submodule initialization.
		// On failure, tear down the worktree — half-initialized worktrees are
		// useless (submodules appear as empty directories) and confusing.
		const submoduleResult = await worktreeService.initSubmodules(result.worktree.path, 1)
		if (!submoduleResult.success) {
			provider.log(
				`Submodule init failed for ${result.worktree.path}: ${submoduleResult.error} — removing worktree.`,
			)
			// Best-effort cleanup: remove the worktree directory + branch.
			const cleanupResult = await worktreeService.deleteWorktree(cwd, result.worktree.path, true)
			if (!cleanupResult.success) {
				provider.log(`Cleanup after failed submodule init also failed: ${cleanupResult.message}`)
			}
			return {
				success: false,
				message: `Worktree created but discarded: submodule initialization failed. ${submoduleResult.error}`,
			}
		}
	}

	return result
}

export async function handleDeleteWorktree(
	provider: ShoferProvider,
	worktreePath: string,
	force = false,
): Promise<WorktreeResult> {
	const cwd = provider.cwd
	return worktreeService.deleteWorktree(cwd, worktreePath, force)
}

export async function handleGetAvailableBranches(provider: ShoferProvider): Promise<BranchInfo> {
	const cwd = provider.cwd
	// Include branches already in worktrees since we use this for base branch selection
	return worktreeService.getAvailableBranches(cwd, true)
}

export async function handleGetWorktreeDefaults(provider: ShoferProvider): Promise<WorktreeDefaultsResponse> {
	const suffix = generateRandomSuffix()
	const cwd = provider.cwd

	// Unified naming: branch, directory basename, and worktree label all share
	// the same random token `shofer-<suffix>` so there is exactly one name to
	// track across all three surfaces.
	const name = `shofer-${suffix}`

	// Embedded worktree convention: all worktrees MUST live under
	// .shofer/worktrees/ inside the workspace. The path is auto-generated,
	// not user-configurable (folder picker removed from CreateWorktreeModal),
	// and enforced in handleCreateWorktree by normalizing any path outside
	// the convention prefix.
	const suggestedPath = path.join(cwd, ".shofer", "worktrees", name)

	return {
		suggestedBranch: name,
		suggestedPath,
	}
}

export async function handleGetWorktreeIncludeStatus(provider: ShoferProvider): Promise<WorktreeIncludeStatus> {
	const cwd = provider.cwd
	return worktreeIncludeService.getStatus(cwd)
}

export async function handleCheckBranchWorktreeInclude(provider: ShoferProvider, branch: string): Promise<boolean> {
	const cwd = provider.cwd
	return worktreeIncludeService.branchHasWorktreeInclude(cwd, branch)
}

export async function handleCreateWorktreeInclude(provider: ShoferProvider, content: string): Promise<WorktreeResult> {
	const cwd = provider.cwd

	try {
		await worktreeIncludeService.createWorktreeInclude(cwd, content)

		// Open the file in the editor for easy editing
		try {
			const filePath = path.join(cwd, ".shofer", "worktreeinclude")
			const document = await vscode.workspace.openTextDocument(filePath)
			await vscode.window.showTextDocument(document)
		} catch {
			// Opening the file in editor is a convenience feature - don't fail the operation
		}

		return {
			success: true,
			message: "worktreeinclude file created",
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		return {
			success: false,
			message: `Failed to create worktreeinclude: ${errorMessage}`,
		}
	}
}

export async function handleCheckoutBranch(provider: ShoferProvider, branch: string): Promise<WorktreeResult> {
	const cwd = provider.cwd
	return worktreeService.checkoutBranch(cwd, branch)
}

/**
 * Get detailed status for the current worktree: ahead/behind, files changed,
 * last commit, merge readiness.
 */
/**
 * Get worktree status: ahead/behind, uncommitted changes, file changes,
 * last commit, merge readiness.
 *
 * @param provider Webview provider; used to fall back to the workspace cwd
 *                 when the caller does not specify one.
 * @param cwdOverride Explicit working directory to inspect. Pass the active
 *                    task's cwd here so the status reflects the worktree the
 *                    task is actually running in (in the embedded model the
 *                    workspace cwd is always the main worktree).
 */
export async function handleGetWorktreeStatus(provider: ShoferProvider, cwdOverride?: string): Promise<WorktreeStatus> {
	const cwd = cwdOverride && cwdOverride.length > 0 ? cwdOverride : provider.cwd

	const isGitRepo = await worktreeService.checkGitRepo(cwd)
	if (!isGitRepo) {
		throw new Error("Not a git repository")
	}

	// Run initial queries in parallel
	const [currentBranchResult, baseBranchResult, worktreesResult, lastCommitResult, uncommittedResult] =
		await Promise.all([
			worktreeService.getCurrentBranch(cwd),
			worktreeService.detectBaseBranch(cwd),
			worktreeService.listWorktrees(cwd),
			execAsync('git log -1 --format="%h|%s|%ar|%an"', { cwd }).catch(() => ({ stdout: "" })),
			execAsync("git status --short", { cwd }).catch(() => ({ stdout: "" })),
		])

	const currentBranch = currentBranchResult || ""
	const baseBranch = baseBranchResult

	// Get ahead/behind counts
	const [aheadResult, behindResult] = await Promise.all([
		baseBranch && currentBranch !== baseBranch ? countCommits(cwd, baseBranch, currentBranch) : Promise.resolve(0),
		baseBranch && currentBranch !== baseBranch ? countCommits(cwd, currentBranch, baseBranch) : Promise.resolve(0),
	])

	const commitsAhead = aheadResult
	const commitsBehind = behindResult

	// Parse diff stat
	let filesChanged = 0
	let insertions = 0
	let deletions = 0
	if (baseBranch && currentBranch !== baseBranch) {
		try {
			const { stdout: diffOutput } = await execAsync(`git diff --shortstat ${baseBranch}...${currentBranch}`, {
				cwd,
			})
			const parts = diffOutput.trim().split(",")
			for (const part of parts) {
				const trimmed = part.trim()
				if (trimmed.includes("file")) filesChanged = parseInt(trimmed, 10)
				if (trimmed.includes("insertion")) insertions = parseInt(trimmed, 10)
				if (trimmed.includes("deletion")) deletions = parseInt(trimmed, 10)
			}
		} catch {
			// Ignore diff errors
		}
	}

	// Parse last commit
	let lastCommit: WorktreeStatus["lastCommit"] = null
	const lastCommitOutput = (lastCommitResult as unknown as { stdout: string }).stdout.trim()
	if (lastCommitOutput) {
		const [hash, subject, relativeTime, author] = lastCommitOutput.split("|")
		if (hash) {
			lastCommit = { hash, subject: subject || "", relativeTime: relativeTime || "", author: author || "" }
		}
	}

	// Parse uncommitted changes
	const uncommittedOutput = (uncommittedResult as unknown as { stdout: string }).stdout.trim()
	const uncommittedCount = uncommittedOutput ? uncommittedOutput.split("\n").length : 0
	const hasUncommittedChanges = uncommittedCount > 0

	// Check merge readiness (dry-run merge)
	let hasConflicts: boolean | null = null
	const conflictedFiles: string[] = []
	if (baseBranch && currentBranch !== baseBranch) {
		try {
			await execAsync(`git merge --no-commit --no-ff ${currentBranch}`, { cwd })
			hasConflicts = false
			await execAsync("git merge --abort", { cwd }).catch(() => {})
		} catch {
			hasConflicts = true
			try {
				const { stdout: conflictOutput } = await execAsync("git diff --name-only --diff-filter=U", { cwd })
				conflictedFiles.push(...conflictOutput.trim().split("\n").filter(Boolean))
			} catch {
				// Ignore
			}
			await execAsync("git merge --abort", { cwd }).catch(() => {})
		}
	}

	// Find current worktree path and other worktrees
	const currentWorktree = worktreesResult.find((wt) => wt.isCurrent)
	const worktreePath = currentWorktree?.path || cwd
	const otherWorktrees = worktreesResult
		.filter((wt) => !wt.isCurrent)
		.map((wt) => ({ branch: wt.branch, path: wt.path }))

	return {
		branch: currentBranch,
		path: worktreePath,
		baseBranch,
		commitsAhead,
		commitsBehind,
		filesChanged,
		insertions,
		deletions,
		hasUncommittedChanges,
		uncommittedCount,
		lastCommit,
		mergeReadiness: { hasConflicts, conflictedFiles },
		isBaseBranch: currentBranch === baseBranch,
		otherWorktrees,
	}
}

async function countCommits(cwd: string, baseBranch: string, targetBranch: string): Promise<number> {
	if (!baseBranch || !targetBranch) return 0
	try {
		const { stdout } = await execAsync(`git rev-list --count ${baseBranch}..${targetBranch}`, { cwd })
		return parseInt(stdout.trim(), 10) || 0
	} catch {
		return 0
	}
}
