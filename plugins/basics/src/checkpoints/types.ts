/**
 * Plugin-local checkpoint types.
 *
 * Kept inside the plugin (rather than imported from `@shofer/types`) so the package
 * is self-contained: checkpoints are a plugin-owned feature, and the host must not
 * grow types for it. The one shape that has to agree with the host is the per-file
 * diff — it is handed to `ctx.host.editor.showMultiFileDiff`, whose `PluginFileDiff`
 * this structurally matches.
 */

import type { CommitResult } from "simple-git"

/** One file's before/after content in a checkpoint diff. */
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

/** Per-file line-level change summary (what `git diff --numstat` reports). */
export type CheckpointDiffStat = {
	relative: string
	absolute: string
	insertions: number
	deletions: number
	binary: boolean
}

/** What a successful save returns — simple-git's commit result. */
export type CheckpointResult = Partial<CommitResult> & Pick<CommitResult, "commit">

/** Events a {@link import("./shadow-git.js").ShadowGitRepo} emits. */
export interface CheckpointEventMap {
	initialize: { type: "initialize"; workspaceDir: string; baseHash?: string; created: boolean; duration: number }
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

/** Which two points a diff request compares. */
export type CheckpointDiffMode = "from-init" | "checkpoint" | "to-current" | "full"

/** Params of the `diff` request a checkpoint row's UI issues. */
export interface CheckpointDiffRequest {
	commitHash: string
	mode: CheckpointDiffMode
}

/** Params of the `restore` request a checkpoint row's UI issues. */
export interface CheckpointRestoreRequest {
	/** Timestamp of the marker row being restored to. */
	ts: number
	commitHash: string
	/** `preview` restores files only; `restore` also rewinds the conversation. */
	mode: "preview" | "restore"
}

/**
 * What a `diff` request resolves to: either the computed changes, or a reason there
 * is nothing to show. The notice is a *code*, not a sentence — the host renders the
 * wording, so the plugin never ships user-facing copy in the wrong language.
 */
export type CheckpointDiffResult =
	| { title: string; changes: CheckpointDiff[]; notice?: undefined }
	| { title?: undefined; changes?: undefined; notice: "no-first" | "no-previous" | "no-changes" }
