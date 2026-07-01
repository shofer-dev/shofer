/**
 * Diff-view host capability (v3 architecture §9).
 *
 * The core's edit tools drive a stateful diff-presentation object: open a diff
 * editor for a file, stream content into it, then either save (surfacing any new
 * diagnostics + user edits) or revert. In the VS Code extension this is backed by
 * `DiffViewProvider` (a Category II adapter, ~53 `vscode.*` calls). This module
 * captures that object's **vscode-free public surface** as {@link DiffView} so the
 * core (Task + edit tools) can depend on the interface and obtain a concrete
 * instance via `getHost().createDiffView(cwd, task)` — never importing the VS Code
 * class.
 */

import type { ShoferSay } from "./message.js"

/** URI scheme for the read-only "original" side of a Shofer diff editor. */
export const DIFF_VIEW_URI_SCHEME = "shofer-diff"
/** Diff-editor tab label for a modification (vs. a new file). */
export const DIFF_VIEW_LABEL_CHANGES = "Original ↔ Shofer's Changes"

/**
 * Result of {@link DiffView.saveChanges} / {@link DiffView.saveDirectly}: the new
 * diagnostics blurb (if any), any edits the user made before approving, and the
 * final on-disk content.
 */
export interface DiffViewSaveResult {
	newProblemsMessage: string | undefined
	userEdits: string | undefined
	finalContent: string | undefined
}

/**
 * Strategy-specific extras forwarded to {@link DiffView.pushToolWriteResult}. Lets a
 * particular diff format (e.g. apply_diff) attach a custom summary / hint / stats
 * without the generic diff view knowing about that format.
 */
export interface DiffViewWriteResultExtra {
	/** Replaces the default "File X was created/modified." leading sentence. */
	summary?: string
	/** Optional follow-up sentence appended after the summary (e.g. remediation hint). */
	hint?: string
	/** Opaque structured stats forwarded to the model as `diff_stats`. */
	stats?: Record<string, number>
}

/**
 * Narrow, vscode-free handle onto the owning `Task` that a {@link DiffView} needs:
 * emit a UI message ({@link say}), snapshot pre-edit content for revert
 * ({@link fileContextTracker}), and read diagnostic-reporting settings
 * ({@link providerRef}). The real `Task` is structurally assignable to this.
 */
export interface DiffViewTaskHandle {
	/** Emit a UI message (maps to `Task.say`); the diff view uses `user_feedback_diff`. */
	say(type: ShoferSay, text?: string): Promise<unknown>
	/** Captures the pre-edit snapshot of a file so a later revert can restore/delete it. */
	fileContextTracker?: {
		captureOriginal(relPath: string, content: string | undefined): Promise<void>
	}
	/** Weak ref to the provider, read for diagnostic-reporting settings. */
	providerRef: {
		deref(): { getState(): Promise<DiffViewTaskState> } | undefined
	}
}

/** The slice of provider state a {@link DiffView} reads (diagnostic reporting). */
export interface DiffViewTaskState {
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
}

/**
 * Host-agnostic diff presentation the core's edit tools drive. Backed by the VS
 * Code `DiffViewProvider` in the extension; a headless host may supply a no-op.
 *
 * A single instance is stateful and single-flight per file edit: `open` →
 * `update`* → (`saveChanges` | `revertChanges`) → `reset`. The public result fields
 * (`userEdits`, `newProblemsMessage`, `editType`, `originalContent`, `isEditing`)
 * are read/written by the tools around that lifecycle.
 */
export interface DiffView {
	/** New-file vs. existing-file mode; set by the tool before {@link open}. */
	editType?: "create" | "modify"
	/** Content of the file before this edit (empty string for new files). */
	originalContent: string | undefined
	/** Whether an edit is currently in progress (set by {@link open}). */
	isEditing: boolean
	/** Edits the user made before approving, captured by {@link saveChanges}. */
	userEdits?: string
	/** New-diagnostics blurb captured by {@link saveChanges}. */
	newProblemsMessage?: string

	/** Open the diff editor for `relPath` (relative to the diff view's cwd). */
	open(relPath: string): Promise<void>
	/** Stream `accumulatedContent` into the diff editor; `isFinal` applies the last chunk. */
	update(accumulatedContent: string, isFinal: boolean): Promise<void>
	/** Persist the edited content, compute new diagnostics + any user edits. */
	saveChanges(diagnosticsEnabled?: boolean, writeDelayMs?: number): Promise<DiffViewSaveResult>
	/** Write `content` to `relPath` directly, bypassing the diff editor. */
	saveDirectly(
		relPath: string,
		content: string,
		openFile?: boolean,
		diagnosticsEnabled?: boolean,
		writeDelayMs?: number,
	): Promise<DiffViewSaveResult>
	/** Build the tool-result message the model sees after a write (JSON string). */
	pushToolWriteResult(
		task: DiffViewTaskHandle,
		cwd: string,
		isNewFile: boolean,
		extra?: DiffViewWriteResultExtra,
	): Promise<string>
	/** Undo the edit: delete a new file, or restore the original content. */
	revertChanges(): Promise<void>
	/** Scroll the diff editor to the first changed region (no focus steal). */
	scrollToFirstDiff(): void
	/** Tear down the diff editor and clear per-edit state. */
	reset(): Promise<void>
}
