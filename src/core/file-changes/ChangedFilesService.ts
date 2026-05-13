/**
 * ChangedFilesService — single source of truth for "files Shofer edited in the
 * current Task and their net state".
 *
 * Uses a per-task working-directory approach:
 *   - base/<relPath>  : verbatim copy of each file at the moment Shofer first
 *                       edited it in this task (idempotent).
 *   - final/<relPath>  : last Shofer-produced state, overwritten after every
 *                       shofer_edited (used for Redo).
 *
 * Snapshots are stored under `<taskDir>/originals/` and `<taskDir>/finals/`
 * as lightweight JSON metadata (hash only, no inline content). The actual
 * file content lives in `<taskDir>/base/<relPath>` and
 * `<taskDir>/final/<relPath>`, accessed via FileContextTracker methods.
 *
 * This backend has NO git dependency — no shadow git, no checkpoints, no
 * binary-on-PATH requirement. It works identically in every workspace type.
 */

import * as path from "path"
import * as crypto from "crypto"
import fs from "fs/promises"
import { createTwoFilesPatch, parsePatch } from "diff"

import type { ChangedFileEntry, ChangedFilesPayload } from "@shofer/types"

import { Task } from "../task/Task"
import type { FileSnapshot } from "../context-tracking/FileContextTracker"

/** Normalize to POSIX-style workspace-relative path for stable webview keys. */
function toPosix(p: string): string {
	return p.split(path.sep).join("/")
}

function sha256(s: string): string {
	return crypto.createHash("sha256").update(s).digest("hex")
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

/**
 * Exact insertions/deletions count via unified-diff parsing.
 * This replaces the old `countLineDelta` heuristic.
 */
function computeUnifiedDiffStats(
	oldContent: string,
	newContent: string,
	filePath: string,
): { inserted: number; deleted: number } {
	const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
		context: 0,
	})
	const parsed = parsePatch(patch)
	let inserted = 0
	let deleted = 0
	for (const p of parsed) {
		for (const h of (p as any).hunks ?? []) {
			for (const line of h.lines ?? []) {
				const ch = (line as string)[0]
				if (ch === "+") inserted++
				else if (ch === "-") deleted++
			}
		}
	}
	return { inserted, deleted }
}

// ---------------------------------------------------------------------------
// Disk helpers (workspace reads only; base/final reads go through tracker)
// ---------------------------------------------------------------------------

async function readDiskExists(cwd: string, relPath: string): Promise<boolean> {
	try {
		await fs.access(path.resolve(cwd, relPath))
		return true
	} catch {
		return false
	}
}

async function readDiskText(cwd: string, relPath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path.resolve(cwd, relPath), "utf8")
	} catch {
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the unified set of files Shofer edited in the current Task, with net
 * state computed against the per-task working-directory base copies.
 */
export async function getChangedFiles(task: Task): Promise<ChangedFilesPayload> {
	const candidates = (await task.fileContextTracker.getFilesEditedByRoo()).map(toPosix)

	if (candidates.length === 0) {
		return { taskId: task.taskId, entries: [], backend: "none" }
	}

	const entries: ChangedFileEntry[] = []
	for (const relPath of candidates) {
		const original = await task.fileContextTracker.getOriginalSnapshot(relPath)
		const final = await task.fileContextTracker.getFinalSnapshot(relPath)
		const currentExists = await readDiskExists(task.cwd, relPath)
		const currentContent = currentExists ? await readDiskText(task.cwd, relPath) : undefined

		// If disk matches the captured original, keep the entry as "reverted"
		// only when a final snapshot exists (for Redo); otherwise drop it.
		let matchesBase = false
		if (original) {
			if (original.kind === "absent" && !currentExists) matchesBase = true
			else if (
				original.kind === "text" &&
				currentContent !== undefined &&
				original.hash === sha256(currentContent)
			) {
				matchesBase = true
			}
		}
		if (matchesBase) {
			// Drop entries where the file matches the original base — regardless
			// of whether a final snapshot exists. A file with zero net change
			// (e.g. a tool added a line then removed it) has no effective diff
			// and should not appear in the change list.
			continue
		}

		// Compute exact diff stats: unified diff of base content vs. current disk.
		let insertions = 0
		let deletions = 0
		const baseText = await task.fileContextTracker.getBaseContent(relPath)
		if (baseText !== undefined && currentContent !== undefined) {
			const stats = computeUnifiedDiffStats(baseText, currentContent, relPath)
			insertions = stats.inserted
			deletions = stats.deleted
		} else if (baseText === undefined && currentContent !== undefined) {
			// Only treat as new file when the snapshot confirms it was absent.
			// If the snapshot says the file existed but the base copy is missing
			// (e.g. captureOriginal skipped writing base/), report 0/0 rather
			// than falsely counting every line as an insertion.
			const wasAbsent = !original || original.kind === "absent"
			if (wasAbsent) {
				const lines = currentContent.split("\n").length - 1
				insertions = Math.max(0, lines)
			} else {
				console.warn(
					`[ChangedFilesService] base copy missing for ${relPath} (snapshot says text), diff stats unavailable`,
				)
			}
		} else if (baseText !== undefined && currentContent === undefined) {
			const wasNew = original?.kind === "absent"
			if (!wasNew) {
				// File existed at base but is now gone — genuine deletion.
				const lines = baseText.split("\n").length - 1
				deletions = Math.max(0, lines)
			}
			// If wasNew: file was created then deleted → net zero, already 0/0.
		}

		entries.push({
			path: relPath,
			insertions,
			deletions,
			binary: false,
			state: deriveState(original, currentExists),
			source: "working",
			hasOriginalContent: original !== undefined,
			hasFinalContent: final !== undefined,
		})
	}

	// Drop entries with no effective change (0 insertions and 0 deletions).
	// This covers files where Shofer's net effect was zero — e.g. a tool added a
	// line then removed it, or a file was created then deleted within the same
	// task. Such files have no meaningful diff to show.
	const effective = entries.filter((e) => e.insertions > 0 || e.deletions > 0)
	return { taskId: task.taskId, entries: effective, backend: "working" }
}

function deriveState(original: FileSnapshot | undefined, currentExists: boolean): "modified" | "added" | "deleted" {
	const originallyAbsent = original?.kind === "absent"
	if (originallyAbsent && currentExists) return "added"
	if (!originallyAbsent && !currentExists) return "deleted"
	return "modified"
}

/**
 * Returns the original content for a file in the current task.
 * Reads from the per-task base/<relPath> copy via FileContextTracker.
 * Returns "" for absent files (so the diff editor can show all additions),
 * null when no base content is available at all.
 */
export async function getOriginalContent(task: Task, relPath: string): Promise<string | null> {
	const posix = toPosix(relPath)
	const snap = await task.fileContextTracker.getOriginalSnapshot(posix)
	if (snap) {
		if (snap.kind === "absent") return ""
		if (snap.kind === "text") {
			const baseText = await task.fileContextTracker.getBaseContent(posix)
			if (baseText !== undefined) return baseText
		}
	}
	// Fallback: snapshot missing but base copy may exist (e.g. captureOriginal
	// wrote the file copy before the snapshot write failed).
	const baseText = await task.fileContextTracker.getBaseContent(posix)
	if (baseText !== undefined) return baseText
	return null
}

/** Like {@link getOriginalContent}, but for the last captured final state. */
export async function getFinalContent(task: Task, relPath: string): Promise<string | null> {
	const posix = toPosix(relPath)
	const snap = await task.fileContextTracker.getFinalSnapshot(posix)
	if (!snap) return null
	if (snap.kind === "absent") return ""
	if (snap.kind === "text") {
		return (await task.fileContextTracker.getFinalContent(posix)) ?? null
	}
	return null
}

/**
 * Reverts a single file back to its original state as captured at the
 * start of the task. Copies base/<relPath> to the workspace (or deletes
 * the file if the base snapshot indicates it was absent).
 */
export async function restoreFile(task: Task, relPath: string): Promise<void> {
	const posix = toPosix(relPath)
	const abs = path.resolve(task.cwd, posix)
	const snap = await task.fileContextTracker.getOriginalSnapshot(posix)
	if (!snap) {
		throw new Error(`No original snapshot available for ${relPath}; cannot revert.`)
	}
	if (snap.kind === "absent") {
		try {
			await fs.unlink(abs)
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err
		}
	} else {
		const baseText = await task.fileContextTracker.getBaseContent(posix)
		if (baseText === undefined) {
			throw new Error(`No base file copy for ${relPath}; the snapshot exists but the working copy is missing.`)
		}
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, baseText, "utf8")
	}
	// NOTE: deliberately do NOT recapture the final snapshot here. The final
	// snapshot represents the last "Shofer-produced" state and is what Redo will
	// re-apply. Overwriting it with the just-reverted state would make Redo
	// a no-op.
}

/**
 * Reverts every file Shofer edited in the current Task. Iterates restoreFile
 * over the tracker candidate set.
 */
export async function restoreAll(task: Task): Promise<void> {
	const candidates = await task.fileContextTracker.getFilesEditedByRoo()
	for (const p of candidates) {
		try {
			await restoreFile(task, p)
		} catch (err) {
			console.error(`[ChangedFilesService] restoreFile(${p}) failed:`, err)
		}
	}
}

/**
 * Promotes the current final state of a file to the new baseline.
 * Overwrites base/<relPath> and the originals snapshot with the final
 * content (or marks absent). After accept, the file disappears from
 * the change panel since it matches the updated baseline.
 *
 * No-op when the file has no final snapshot (nothing to accept).
 */
export async function acceptFile(task: Task, relPath: string): Promise<void> {
	const posix = toPosix(relPath)
	const snap = await task.fileContextTracker.getFinalSnapshot(posix)
	if (!snap) {
		throw new Error(
			`Cannot accept "${posix}" — no final snapshot exists. The file may not have been written by Shofer in this task, or the final snapshot capture failed silently.`,
		)
	}

	const content = snap.kind === "text" ? await task.fileContextTracker.getFinalContent(posix) : undefined

	await task.fileContextTracker.overwriteOriginalBase(posix, content)
	// Clear the final snapshot so the file disappears from the panel
	// (it now matches the updated baseline and there's nothing to redo).
	await task.fileContextTracker.removeFinalSnapshot(posix)
	console.log(`[ChangedFilesService] acceptFile(${posix}): promoted final → base, kind=${snap.kind}`)
}

/** Accepts all files Shofer edited in the current Task. */
export async function acceptAll(task: Task): Promise<void> {
	const candidates = await task.fileContextTracker.getFilesEditedByRoo()
	console.log(`[ChangedFilesService] acceptAll: ${candidates.length} candidate(s)`)
	for (const p of candidates) {
		try {
			await acceptFile(task, p)
		} catch (err) {
			console.error(`[ChangedFilesService] acceptFile(${p}) failed:`, err)
		}
	}
}
