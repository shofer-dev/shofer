/**
 * The status of one worktree: how far its branch has diverged from the base, what is
 * uncommitted, and whether it would merge cleanly.
 *
 * Ported verbatim from the built-in `handleGetWorktreeStatus`. The queries run in
 * parallel because the popover opens on hover and six sequential `git` invocations are
 * visibly slow; the merge check is a `--no-commit --no-ff` dry run that is always
 * aborted, so nothing is left half-merged.
 */

import { exec } from "child_process"
import { promisify } from "util"

import { worktreeService } from "./worktree-service.js"
import type { WorktreeStatus } from "./types.js"

const execAsync = promisify(exec)

export async function getWorktreeStatus(cwd: string): Promise<WorktreeStatus> {
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
