/**
 * ChangedFilesService — single source of truth for "files Roo edited in the
 * current Task and their net state".
 *
 * Backends:
 *   1. Checkpoint backend (preferred): uses the shadow-git checkpoint
 *      service's `getDiffStat({ from: baseHash })` to compute net state for
 *      the candidate paths Roo edited.
 *   2. Tracker backend (fallback, used when checkpoints are unavailable):
 *      compares current on-disk content of each candidate path against the
 *      per-task original-content snapshot stored by FileContextTracker.
 *
 * The candidate set always comes from
 * `FileContextTracker.getFilesEditedByRoo()`. The checkpoint diff alone is
 * NOT used to derive the file list: pre-existing diffs / external user
 * edits must not appear in the panel, only files Roo touched.
 *
 * The same module also provides revert/redo/diff primitives used by the
 * panel and by IPC handlers.
 */

import * as path from "path"
import * as crypto from "crypto"
import fs from "fs/promises"

import type { ChangedFileEntry, ChangedFilesPayload } from "@roo-code/types"

import { Task } from "../task/Task"
import { getCheckpointService } from "../checkpoints"
import type { CheckpointDiffStat } from "../../services/checkpoints/types"
import type { FileSnapshot } from "../context-tracking/FileContextTracker"

/** Normalize to POSIX-style workspace-relative path for stable webview keys. */
function toPosix(p: string): string {
	return p.split(path.sep).join("/")
}

function sha256(s: string): string {
	return crypto.createHash("sha256").update(s).digest("hex")
}

/**
 * Returns the unified set of files Roo edited in the current Task, with net
 * state computed by whichever backend is currently available.
 */
export async function getChangedFiles(task: Task): Promise<ChangedFilesPayload> {
	const candidates = (await task.fileContextTracker.getFilesEditedByRoo()).map(toPosix)

	if (candidates.length === 0) {
		return { taskId: task.taskId, entries: [], backend: "none", degraded: false }
	}

	// Try the checkpoint backend first.
	let checkpointDiff: CheckpointDiffStat[] | undefined
	let checkpointReason: string | undefined
	try {
		const service = await getCheckpointService(task)
		if (service?.isInitialized && service.baseHash) {
			checkpointDiff = await service.getDiffStat({ from: service.baseHash })
		} else {
			checkpointReason = "checkpoints not initialized"
		}
	} catch (err) {
		checkpointReason = err instanceof Error ? err.message : String(err)
	}

	if (checkpointDiff) {
		const byPath = new Map<string, CheckpointDiffStat>()
		for (const d of checkpointDiff) byPath.set(toPosix(d.relative), d)

		const entries: ChangedFileEntry[] = []
		for (const relPath of candidates) {
			const stat = byPath.get(relPath)
			// File Roo edited but currently matches base (e.g. created then
			// removed, or user reverted by hand) — drop from the list.
			if (!stat) continue
			const original = await task.fileContextTracker.getOriginalSnapshot(relPath)
			const final = await task.fileContextTracker.getFinalSnapshot(relPath)
			entries.push({
				path: relPath,
				insertions: stat.insertions,
				deletions: stat.deletions,
				binary: stat.binary,
				state: deriveState(original, await readDiskExists(task.cwd, relPath)),
				source: "checkpoint",
				hasOriginalContent: original !== undefined,
				hasFinalContent: final !== undefined,
			})
		}
		return { taskId: task.taskId, entries, backend: "checkpoint", degraded: false }
	}

	// Fallback — tracker backend.
	const entries: ChangedFileEntry[] = []
	for (const relPath of candidates) {
		const original = await task.fileContextTracker.getOriginalSnapshot(relPath)
		const currentExists = await readDiskExists(task.cwd, relPath)
		const currentContent = currentExists ? await readDiskText(task.cwd, relPath) : undefined

		// Net-state filter: if disk matches the captured original, drop.
		if (original) {
			if (original.kind === "absent" && !currentExists) continue
			if (original.kind === "text" && currentContent !== undefined && original.hash === sha256(currentContent))
				continue
		}

		const final = await task.fileContextTracker.getFinalSnapshot(relPath)
		entries.push({
			path: relPath,
			insertions: countLineDelta(original, currentContent).inserted,
			deletions: countLineDelta(original, currentContent).deleted,
			binary: false, // tracker backend does not detect binary
			state: deriveState(original, currentExists),
			source: "tracker",
			hasOriginalContent: original !== undefined,
			hasFinalContent: final !== undefined,
		})
	}

	return {
		taskId: task.taskId,
		entries,
		backend: "tracker",
		degraded: true,
		reason: checkpointReason,
	}
}

function deriveState(original: FileSnapshot | undefined, currentExists: boolean): "modified" | "added" | "deleted" {
	const originallyAbsent = original?.kind === "absent"
	if (originallyAbsent && currentExists) return "added"
	if (!originallyAbsent && !currentExists) return "deleted"
	return "modified"
}

function countLineDelta(
	original: FileSnapshot | undefined,
	currentContent: string | undefined,
): { inserted: number; deleted: number } {
	// Without a real diff library we approximate: report total lines changed
	// as max(currentLines, originalLines) - common-prefix-or-suffix lines.
	// For a simple, cheap heuristic that's "good enough" for the panel header
	// in tracker mode, just compare line counts.
	const origText = original?.kind === "text" ? (original.content ?? "") : ""
	const currText = currentContent ?? ""
	const origLines = origText ? origText.split("\n").length : 0
	const currLines = currText ? currText.split("\n").length : 0
	if (origText === currText) return { inserted: 0, deleted: 0 }
	return {
		inserted: Math.max(0, currLines - origLines),
		deleted: Math.max(0, origLines - currLines),
	}
}

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

/**
 * Returns the original-content snapshot for the given file in the current
 * Task, or null when none is available (file was never edited by Roo or
 * snapshot is missing). Binary originals return null.
 */
export async function getOriginalContent(task: Task, relPath: string): Promise<string | null> {
	const snap = await task.fileContextTracker.getOriginalSnapshot(toPosix(relPath))
	if (!snap) return null
	if (snap.kind === "text") return snap.content ?? ""
	// "absent" -> empty document, so the diff editor can show the additions.
	if (snap.kind === "absent") return ""
	return null
}

/** Like {@link getOriginalContent}, but for the last captured final state. */
export async function getFinalContent(task: Task, relPath: string): Promise<string | null> {
	const snap = await task.fileContextTracker.getFinalSnapshot(toPosix(relPath))
	if (!snap) return null
	if (snap.kind === "text") return snap.content ?? ""
	if (snap.kind === "absent") return ""
	return null
}

/**
 * Reverts a single file in the current Task back to its original state.
 *
 * Strategy:
 *  - If the checkpoint backend is available, use `git checkout baseHash --
 *    <path>` against the shadow worktree (the workspace itself).
 *  - Otherwise fall back to the per-task original-content snapshot:
 *      - kind === "text"  -> overwrite the file
 *      - kind === "absent" -> delete the file (if it exists)
 */
export async function restoreFile(task: Task, relPath: string): Promise<void> {
	const posix = toPosix(relPath)
	const abs = path.resolve(task.cwd, posix)

	// Try checkpoint backend first.
	try {
		const service = await getCheckpointService(task)
		if (service?.isInitialized && service.baseHash) {
			// Use the shadow git directly via its public restore API on a single path.
			// `restoreCheckpoint` resets the entire worktree, which is wrong here;
			// we want a per-file checkout instead. Drive the underlying simple-git
			// instance through its `raw` interface via a small helper exposed below.
			await checkoutSingleFileFromBase(service as any, posix)
			await captureFinalAfter(task, posix)
			return
		}
	} catch (err) {
		console.warn(`[ChangedFilesService] checkpoint restoreFile failed for ${relPath}, falling back:`, err)
	}

	// Fallback — tracker backend.
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
	} else if (snap.kind === "text") {
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, snap.content ?? "", "utf8")
	}
	await captureFinalAfter(task, posix)
}

/**
 * Reverts every file Roo edited in the current Task. Prefers the checkpoint
 * backend's atomic `restoreCheckpoint(baseHash)` when available; otherwise
 * iterates `restoreFile` over the tracker candidate set.
 */
export async function restoreAll(task: Task): Promise<void> {
	try {
		const service = await getCheckpointService(task)
		if (service?.isInitialized && service.baseHash) {
			await service.restoreCheckpoint(service.baseHash)
			// Refresh final snapshots so the panel reflects post-revert state.
			const candidates = await task.fileContextTracker.getFilesEditedByRoo()
			for (const p of candidates) await captureFinalAfter(task, toPosix(p))
			return
		}
	} catch (err) {
		console.warn(`[ChangedFilesService] checkpoint restoreAll failed, falling back:`, err)
	}
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
 * Re-applies the last captured final content for a file. Used by per-file
 * Redo after a Revert. If no final snapshot is available, throws.
 */
export async function redoFile(task: Task, relPath: string): Promise<void> {
	const posix = toPosix(relPath)
	const abs = path.resolve(task.cwd, posix)
	const snap = await task.fileContextTracker.getFinalSnapshot(posix)
	if (!snap) {
		throw new Error(`No final snapshot available for ${relPath}; cannot redo.`)
	}
	if (snap.kind === "absent") {
		try {
			await fs.unlink(abs)
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err
		}
	} else {
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, snap.content ?? "", "utf8")
	}
}

/**
 * Per-file checkout from the shadow-git base commit. Implemented by reading
 * the file content from `<baseHash>:<relPath>` and writing it to disk (or
 * deleting the file when it did not exist at base). This is equivalent to
 * `git checkout baseHash -- <relPath>` against the shadow worktree but
 * avoids touching the shadow index for paths the user might want to keep.
 */
async function checkoutSingleFileFromBase(service: any, relPath: string): Promise<void> {
	const git = service.git
	const baseHash: string = service.baseHash
	const workspaceDir: string = service.workspaceDir
	if (!git || !baseHash || !workspaceDir) {
		throw new Error("Shadow git service not in usable state for per-file restore")
	}
	const abs = path.resolve(workspaceDir, relPath)
	let originalContent: string | null = null
	try {
		originalContent = await git.show([`${baseHash}:${relPath}`])
	} catch {
		// File did not exist at base.
		originalContent = null
	}
	if (originalContent === null) {
		try {
			await fs.unlink(abs)
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err
		}
		return
	}
	await fs.mkdir(path.dirname(abs), { recursive: true })
	await fs.writeFile(abs, originalContent, "utf8")
}

async function captureFinalAfter(task: Task, relPath: string): Promise<void> {
	try {
		await task.fileContextTracker.captureFinal(relPath)
	} catch (err) {
		console.warn(`[ChangedFilesService] captureFinal failed for ${relPath}:`, err)
	}
}
