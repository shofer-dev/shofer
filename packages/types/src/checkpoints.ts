/**
 * Host-agnostic checkpoint plain types (v3 architecture §11).
 *
 * These describe the checkpoint diff/restore surface WITHOUT depending on
 * `@shofer/core`, VS Code, or `simple-git`, so the transport-agnostic agent
 * control plane ({@link import("./agent-api.js").AgentApi}) can name them and a
 * remote executor can ship a computed diff back over the control plane. The
 * concrete checkpoint service in `@shofer/core` re-exports these so its callers
 * keep one source of truth (any drift is a compile error on both sides).
 */

/**
 * One file's before/after content in a checkpoint diff. Mirrors the shape the
 * checkpoint service's `getDiff` returns and that {@link
 * import("./host.js").HostEditor.showMultiFileDiff} consumes, so a diff computed
 * on a remote executor passes straight through to the controller's diff viewer.
 */
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
 * The wire type for a single checkpoint-diff entry shipped over the control
 * plane (remote shadow tasks). Identical to {@link CheckpointDiff} — an alias so
 * the typed transport methods read as "a list of diff entries".
 */
export type CheckpointDiffEntry = CheckpointDiff

/** Options selecting which two checkpoints (or checkpoint↔worktree) to diff. */
export type CheckpointDiffOptions = {
	ts?: number
	previousCommitHash?: string
	commitHash: string
	/**
	 * from-init: Compare from the first checkpoint to the selected checkpoint.
	 * checkpoint: Compare the selected checkpoint to the next checkpoint.
	 * to-current: Compare the selected checkpoint to the current workspace.
	 * full: Compare from the first checkpoint to the current workspace.
	 */
	mode: "from-init" | "checkpoint" | "to-current" | "full"
}

/** Options selecting which checkpoint to restore/preview and how. */
export type CheckpointRestoreOptions = {
	ts: number
	commitHash: string
	mode: "preview" | "restore"
	operation?: "delete" | "edit" // Optional to maintain backward compatibility
}
