/**
 * Worktree Types
 *
 * Platform-agnostic type definitions for git worktree operations.
 * These types are decoupled from VSCode and can be used by any consumer.
 */

/**
 * Represents a git worktree
 */
export interface Worktree {
	/** Absolute path to the worktree directory */
	path: string
	/** Branch name - empty string if detached HEAD */
	branch: string
	/** Current commit hash */
	commitHash: string
	/** Whether this is the current worktree (matches cwd) */
	isCurrent: boolean
	/** Whether this is the bare/main repository */
	isBare: boolean
	/** Whether HEAD is detached (not on a branch) */
	isDetached: boolean
	/** Whether the worktree is locked */
	isLocked: boolean
	/** Reason for lock if locked */
	lockReason?: string
}

/**
 * Result of a worktree operation (create, delete, etc.)
 */
export interface WorktreeResult {
	/** Whether the operation succeeded */
	success: boolean
	/** Human-readable message describing the result */
	message: string
	/** The worktree that was affected (if applicable) */
	worktree?: Worktree
}

/**
 * Branch information for worktree creation
 */
export interface BranchInfo {
	/** Local branches available */
	localBranches: string[]
	/** Remote branches available */
	remoteBranches: string[]
	/** Currently checked out branch */
	currentBranch: string
}

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
	/** Path where the worktree will be created */
	path: string
	/** Branch name to checkout or create */
	branch?: string
	/** Base branch to create new branch from */
	baseBranch?: string
	/** If true, create a new branch; if false, checkout existing branch */
	createNewBranch?: boolean
}

/**
 * Status of .worktreeinclude file
 */
export interface WorktreeIncludeStatus {
	/** Whether .worktreeinclude exists in the directory */
	exists: boolean
	/** Whether .gitignore exists in the directory */
	hasGitignore: boolean
	/** Content of .gitignore (for creating .worktreeinclude) */
	gitignoreContent?: string
}

/**
 * Response for listWorktrees handler
 */
export interface WorktreeListResponse {
	worktrees: Worktree[]
	isGitRepo: boolean
	error?: string
	isMultiRoot: boolean
	isSubfolder: boolean
	gitRootPath: string
}

/**
 * Response for worktree defaults
 */
export interface WorktreeDefaultsResponse {
	suggestedBranch: string
	suggestedPath: string
	error?: string
}

/**
 * Detailed status for a worktree branch.
 */
export interface WorktreeStatus {
	/** Current branch name */
	branch: string
	/** Filesystem path of the worktree */
	path: string
	/** Target base branch (main or master) */
	baseBranch: string
	/** Number of commits this branch is ahead of base */
	commitsAhead: number
	/** Number of commits this branch is behind base */
	commitsBehind: number
	/** Number of files changed vs base */
	filesChanged: number
	/** Total insertions vs base */
	insertions: number
	/** Total deletions vs base */
	deletions: number
	/** Whether the working tree has uncommitted changes */
	hasUncommittedChanges: boolean
	/** Count of uncommitted changes (tracked files) */
	uncommittedCount: number
	/** Last commit info, or null if no commits */
	lastCommit: {
		hash: string
		subject: string
		relativeTime: string
		author: string
	} | null
	/** Merge readiness check result */
	mergeReadiness: {
		/** null = not yet checked, true/false = result */
		hasConflicts: boolean | null
		conflictedFiles: string[]
	}
	/** Whether the current branch is the base branch */
	isBaseBranch: boolean
	/** List of other worktrees with their branch names */
	otherWorktrees: Array<{ branch: string; path: string }>
}
