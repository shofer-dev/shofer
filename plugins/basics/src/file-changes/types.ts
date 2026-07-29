/**
 * The plugin's own wire types.
 *
 * Deliberately plugin-local rather than imported from `@shofer/types`: the change list
 * is this plugin's data model, shared only between its extension half and its UI half.
 * Core has no opinion about it, which is what lets the plugin be removed without
 * leaving a type behind.
 */

import crypto from "crypto"

export function sha256(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex")
}

/** One file this task changed. */
export interface ChangedFileEntry {
	/** Workspace-relative POSIX path — also the key the UI posts back for actions. */
	path: string
	insertions: number
	deletions: number
	binary: boolean
	state: "modified" | "added" | "deleted"
	/** A baseline was captured, so diff and revert are possible. */
	hasOriginalContent: boolean
	/** A produced state was captured — the right-hand side of this file's diff. */
	hasFinalContent: boolean
}

/** What the panel renders. */
export interface ChangedFilesPayload {
	taskId: string
	entries: ChangedFileEntry[]
}

/** Message pushed to the panel when the list changed under it. */
export interface ChangedFilesUpdate {
	type: "changedFiles"
	payload: ChangedFilesPayload
}
