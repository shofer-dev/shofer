import { CommitResult } from "simple-git"

export type CheckpointResult = Partial<CommitResult> & Pick<CommitResult, "commit">

export type CheckpointDiff = {
	paths: {
		relative: string
		absolute: string
	}
	content: {
		before: string
		after: string
	}
}

/**
 * Per-file line-level change summary between two checkpoints (or between a
 * checkpoint and the current working tree). Mirrors what `git diff --numstat`
 * reports per file, with insertions/deletions counted against the working tree
 * (or `to` ref when provided).
 */
export type CheckpointDiffStat = {
	relative: string
	absolute: string
	insertions: number
	deletions: number
	binary: boolean
}

export interface CheckpointServiceOptions {
	taskId: string
	workspaceDir: string
	shadowDir: string // globalStorageUri.fsPath

	/**
	 * When set, the shadow git's core.worktree is scoped to this
	 * subdirectory instead of workspaceDir.  Used by embedded worktree
	 * tasks so checkpoints only track files within their worktree.
	 */
	scopedWorktreeDir?: string

	log?: (message: string) => void
}

export interface CheckpointEventMap {
	initialize: { type: "initialize"; workspaceDir: string; baseHash: string; created: boolean; duration: number }
	checkpoint: {
		type: "checkpoint"
		fromHash: string
		toHash: string
		duration: number
		suppressMessage?: boolean
	}
	restore: { type: "restore"; commitHash: string; duration: number }
	error: { type: "error"; error: Error }
}
