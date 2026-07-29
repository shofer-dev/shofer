/**
 * The change list — "which files did this task change, and by how much".
 *
 * Every number here comes from a unified diff of two copies the task owns
 * (`base` ↔ `final`, see {@link FileSnapshotStore}), never from the live workspace
 * file. That is what keeps the list correct when several tasks edit the same file in
 * the same worktree: another task's write is not this task's change.
 *
 * Ported from core's `ChangedFilesService`; the candidate set now comes from the
 * plugin's own store instead of the task metadata.
 */

import fs from "fs/promises"
import path from "path"

import { createTwoFilesPatch, parsePatch } from "../vendor/diff.mjs"

import type { FileSnapshot, FileSnapshotStore } from "./snapshot-store.js"
import { sha256, type ChangedFileEntry, type ChangedFilesPayload } from "./types.js"

/** Normalize to a POSIX-style relative path — the stable key the UI renders and posts back. */
export function toPosix(p: string): string {
	return p.split(path.sep).join("/")
}

/** Exact insertion/deletion counts from a unified diff (not a line-count heuristic). */
export function computeUnifiedDiffStats(
	oldContent: string,
	newContent: string,
	filePath: string,
): { inserted: number; deleted: number } {
	const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, undefined, undefined, { context: 0 })
	let inserted = 0
	let deleted = 0
	for (const parsed of parsePatch(patch)) {
		for (const hunk of parsed.hunks ?? []) {
			for (const line of hunk.lines ?? []) {
				if (line.startsWith("+")) inserted++
				else if (line.startsWith("-")) deleted++
			}
		}
	}
	return { inserted, deleted }
}

async function readDiskText(cwd: string, relPath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path.resolve(cwd, relPath), "utf8")
	} catch {
		return undefined
	}
}

async function existsOnDisk(cwd: string, relPath: string): Promise<boolean> {
	try {
		await fs.access(path.resolve(cwd, relPath))
		return true
	} catch {
		return false
	}
}

function deriveState(original: FileSnapshot | undefined, finalExists: boolean): "modified" | "added" | "deleted" {
	const originallyAbsent = original?.kind === "absent"
	if (originallyAbsent && finalExists) return "added"
	if (!originallyAbsent && !finalExists) return "deleted"
	return "modified"
}

/** The files this task changed, with their net effect. */
export async function getChangedFiles(store: FileSnapshotStore, cwd: string): Promise<ChangedFilesPayload> {
	const candidates = (await store.candidates()).map(toPosix)
	if (candidates.length === 0) {
		return { taskId: store.taskId, entries: [] }
	}

	const entries: ChangedFileEntry[] = []
	for (const relPath of candidates) {
		const original = await store.getOriginalSnapshot(relPath)
		const final = await store.getFinalSnapshot(relPath)
		const baseText = await store.getBaseContent(relPath)

		let finalText: string | undefined
		let finalExists: boolean
		if (final) {
			finalText = final.kind === "absent" ? undefined : await store.getFinalContent(relPath)
			finalExists = final.kind !== "absent"
		} else {
			// No final captured yet (the after-edit hook is fire-and-forget, or a tool
			// produced binary content). Fall back to disk for this one file so the entry
			// is not lost; the next edit captures a real final.
			finalExists = await existsOnDisk(cwd, relPath)
			finalText = finalExists ? await readDiskText(cwd, relPath) : undefined
		}

		const baseAbsent = !original || original.kind === "absent"

		// Net zero: created then deleted, or edited back to where it started.
		if (baseAbsent && !finalExists) continue
		if (!baseAbsent && finalExists && baseText !== undefined && finalText !== undefined && baseText === finalText) {
			continue
		}

		// The one place the live file decides visibility: if it currently matches the
		// baseline the user reverted this file, so it is no longer a change.
		const diskExists = await existsOnDisk(cwd, relPath)
		const diskText = diskExists ? await readDiskText(cwd, relPath) : undefined
		if (baseAbsent && !diskExists) continue
		if (original?.kind === "text" && diskText !== undefined && original.hash === sha256(diskText)) continue

		let insertions = 0
		let deletions = 0
		if (baseText !== undefined && finalText !== undefined) {
			const stats = computeUnifiedDiffStats(baseText, finalText, relPath)
			insertions = stats.inserted
			deletions = stats.deleted
		} else if (baseText === undefined && finalText !== undefined && baseAbsent) {
			insertions = Math.max(0, finalText.split("\n").length - 1)
		} else if (baseText !== undefined && finalText === undefined && !baseAbsent) {
			deletions = Math.max(0, baseText.split("\n").length - 1)
		}

		entries.push({
			path: relPath,
			insertions,
			deletions,
			binary: false,
			state: deriveState(original, finalExists),
			hasOriginalContent: original !== undefined || baseText !== undefined,
			hasFinalContent: final !== undefined,
		})
	}

	// A file whose net effect is +0/−0 has no diff worth showing.
	return { taskId: store.taskId, entries: entries.filter((e) => e.insertions > 0 || e.deletions > 0) }
}

/**
 * The file as it was before this task touched it. `""` for a file that did not exist
 * (so the diff editor shows a clean set of additions), `null` when nothing was captured.
 */
export async function getOriginalContent(store: FileSnapshotStore, relPath: string): Promise<string | null> {
	const posix = toPosix(relPath)
	const snap = await store.getOriginalSnapshot(posix)
	if (snap?.kind === "absent") return ""
	const baseText = await store.getBaseContent(posix)
	return baseText ?? null
}

/** The last state this task produced for the file, or `null` when none was captured. */
export async function getFinalContent(store: FileSnapshotStore, relPath: string): Promise<string | null> {
	const posix = toPosix(relPath)
	const snap = await store.getFinalSnapshot(posix)
	if (!snap) return null
	if (snap.kind === "absent") return ""
	return (await store.getFinalContent(posix)) ?? null
}

/**
 * Put the file back the way it was before this task touched it.
 *
 * The final snapshot is deliberately left alone: it is the record of what the agent
 * produced, and overwriting it here would make the change un-redoable.
 */
export async function restoreFile(store: FileSnapshotStore, cwd: string, relPath: string): Promise<void> {
	const posix = toPosix(relPath)
	const abs = path.resolve(cwd, posix)
	const snap = await store.getOriginalSnapshot(posix)
	if (!snap) {
		throw new Error(`No baseline was captured for ${relPath}; cannot revert it.`)
	}

	if (snap.kind === "absent") {
		try {
			await fs.unlink(abs)
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
		}
		return
	}

	const baseText = await store.getBaseContent(posix)
	if (baseText === undefined) {
		throw new Error(`The baseline copy for ${relPath} is missing; cannot revert it.`)
	}
	await fs.mkdir(path.dirname(abs), { recursive: true })
	await fs.writeFile(abs, baseText, "utf8")
}

/**
 * Accept the file's current state as the new baseline — it leaves the list because
 * there is no longer a difference to show.
 *
 * Reads the **disk**, not the final snapshot: after the agent's write the file may have
 * been reformatted on save, or edited by the user. Promoting the final snapshot when
 * disk has moved on leaves a hash mismatch, and the entry comes straight back.
 */
export async function acceptFile(store: FileSnapshotStore, cwd: string, relPath: string): Promise<void> {
	const posix = toPosix(relPath)
	const content = await readDiskText(cwd, posix)
	await store.overwriteOriginalBase(posix, content)
	await store.removeFinalSnapshot(posix)
}

/** Apply `op` to every file in the list, keeping going past a single failure. */
async function forEachCandidate(
	store: FileSnapshotStore,
	cwd: string,
	op: (relPath: string) => Promise<void>,
	onError?: (relPath: string, error: unknown) => void,
): Promise<void> {
	for (const relPath of await store.candidates()) {
		try {
			await op(toPosix(relPath))
		} catch (error) {
			onError?.(relPath, error)
		}
	}
}

export function restoreAll(
	store: FileSnapshotStore,
	cwd: string,
	onError?: (relPath: string, error: unknown) => void,
): Promise<void> {
	return forEachCandidate(store, cwd, (relPath) => restoreFile(store, cwd, relPath), onError)
}

export function acceptAll(
	store: FileSnapshotStore,
	cwd: string,
	onError?: (relPath: string, error: unknown) => void,
): Promise<void> {
	return forEachCandidate(store, cwd, (relPath) => acceptFile(store, cwd, relPath), onError)
}
