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
import { fsLog } from "../../utils/logging/subsystems"

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
		const baseText = await task.fileContextTracker.getBaseContent(relPath)

		// The changelist reflects what THIS task produced: a diff of the task-owned
		// base/<relPath> copy (the file when this task first touched it) against the
		// task-owned final/<relPath> copy (what this task last wrote). Both are
		// captured per-task and are NOT updated by other tasks' edits — captureFinal
		// only runs on this task's own `shofer_edited` writes — so concurrent
		// tasks/sessions editing the same file in the same worktree do not leak into
		// this task's changelist. The live workspace file is consulted ONLY to detect
		// a user-initiated revert (disk back to base); the diff never depends on disk.
		let finalText: string | undefined
		let finalExists: boolean
		if (final) {
			finalText = final.kind === "absent" ? undefined : await task.fileContextTracker.getFinalContent(relPath)
			finalExists = final.kind !== "absent"
		} else {
			// No final snapshot yet (captureFinal is best-effort/async, or a binary
			// tool that skips it) — fall back to the live disk so the entry isn't
			// lost. This is the only path where an external edit could still leak,
			// and it is transient (the next shofer_edited write captures `final`).
			const diskExists = await readDiskExists(task.cwd, relPath)
			finalText = diskExists ? await readDiskText(task.cwd, relPath) : undefined
			finalExists = diskExists
		}

		const baseAbsent = !original || original.kind === "absent"

		// Net-zero (task's own base -> final delta is empty): e.g. a tool added a
		// line then removed it, or created then deleted a file within this task.
		if (baseAbsent && !finalExists) continue
		if (!baseAbsent && finalExists && baseText !== undefined && finalText !== undefined && baseText === finalText) {
			continue
		}

		// User-revert detection (the ONLY disk read used for visibility): if the
		// live file currently matches the base copy, the user reverted this file via
		// the panel — drop it, mirroring the prior behavior. A concurrent task can
		// only trigger this by coincidentally restoring the exact base content.
		const diskExists = await readDiskExists(task.cwd, relPath)
		const diskText = diskExists ? await readDiskText(task.cwd, relPath) : undefined
		let diskMatchesBase = false
		if (baseAbsent && !diskExists) {
			diskMatchesBase = true
		} else if (original?.kind === "text" && diskText !== undefined && original.hash === sha256(diskText)) {
			diskMatchesBase = true
		}
		if (diskMatchesBase) continue

		// Compute exact diff stats: unified diff of base vs. final (task-owned).
		let insertions = 0
		let deletions = 0
		if (baseText !== undefined && finalText !== undefined) {
			const stats = computeUnifiedDiffStats(baseText, finalText, relPath)
			insertions = stats.inserted
			deletions = stats.deleted
		} else if (baseText === undefined && finalText !== undefined) {
			// New file (base absent). If the snapshot says the file existed but the
			// base copy is missing (captureOriginal skipped base/), report 0/0.
			if (baseAbsent) {
				const lines = finalText.split("\n").length - 1
				insertions = Math.max(0, lines)
			} else {
				fsLog.warn(
					`[ChangedFilesService] base copy missing for ${relPath} (snapshot says text), diff stats unavailable`,
				)
			}
		} else if (baseText !== undefined && finalText === undefined) {
			if (!baseAbsent) {
				// File existed at base but the task deleted it — genuine deletion.
				const lines = baseText.split("\n").length - 1
				deletions = Math.max(0, lines)
			}
			// If baseAbsent: created then deleted → net zero (already handled above).
		}

		entries.push({
			path: relPath,
			insertions,
			deletions,
			binary: false,
			state: deriveState(original, finalExists),
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

function deriveState(original: FileSnapshot | undefined, finalExists: boolean): "modified" | "added" | "deleted" {
	const originallyAbsent = original?.kind === "absent"
	if (originallyAbsent && finalExists) return "added"
	if (!originallyAbsent && !finalExists) return "deleted"
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
			fsLog.error(`[ChangedFilesService] restoreFile(${p}) failed:`, err)
		}
	}
}

/**
 * Accepts the current on-disk state of a file as the new baseline.
 * Promotes the current disk content to `base/<relPath>` and updates the
 * originals hash so the file disappears from the change panel.
 *
 * Always reads the current on-disk content — NOT the final snapshot —
 * because the final snapshot represents Shofer's last produced state, which
 * may have been subsequently modified by user edits, language-server
 * formatting, or auto-save. Using the final snapshot when disk has diverged
 * causes a hash mismatch in `getChangedFiles`, keeping the file in the
 * panel and requiring a second Accept click (which then falls back to disk
 * because the final snapshot was cleared by the first attempt).
 *
 * The final snapshot (if any) is always cleared after promotion so Redo
 * cannot re-apply stale state.
 */
export async function acceptFile(task: Task, relPath: string): Promise<void> {
	const posix = toPosix(relPath)

	// Always read current on-disk content as the new baseline.  The final
	// snapshot can be stale — Shofer's last write might have been followed
	// by user edits, auto-save, or formatter runs.  Accepting the disk
	// state guarantees the new baseline hash matches reality and the entry
	// disappears from the panel on the first click.
	const content = await readDiskText(task.cwd, posix)

	await task.fileContextTracker.overwriteOriginalBase(posix, content)
	// Clear the final snapshot so the file disappears from the panel
	// (it now matches the updated baseline and there's nothing to redo).
	await task.fileContextTracker.removeFinalSnapshot(posix)
	fsLog.info(
		`[ChangedFilesService] acceptFile(${posix}): promoted disk → base, kind=${content !== undefined ? "text" : "absent"}`,
	)
}

/** Accepts all files Shofer edited in the current Task. */
export async function acceptAll(task: Task): Promise<void> {
	const candidates = await task.fileContextTracker.getFilesEditedByRoo()
	fsLog.info(`[ChangedFilesService] acceptAll: ${candidates.length} candidate(s)`)
	for (const p of candidates) {
		try {
			await acceptFile(task, p)
		} catch (err) {
			fsLog.error(`[ChangedFilesService] acceptFile(${p}) failed:`, err)
		}
	}
}
