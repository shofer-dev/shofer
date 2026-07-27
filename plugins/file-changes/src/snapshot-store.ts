/**
 * Per-task snapshot store — the plugin's record of "what this task did to this file".
 *
 * Two verbatim copies per path, plus a small metadata file for each:
 *
 * ```
 * <storage>/tasks/<taskId>/
 * ├── base/<relPath>        content before this task's FIRST edit of the file
 * ├── final/<relPath>       content after this task's LAST edit of the file
 * ├── originals/<sha1>.json { kind, hash, _path } for base/
 * └── finals/<sha1>.json    { kind, hash, _path } for final/
 * ```
 *
 * The pair is what makes the change list **self-contained to this task**: every entry
 * is a diff of two copies this task owns, so a concurrent task editing the same file
 * in the same worktree cannot alter what this task reports. The live workspace file is
 * read for exactly two things — capturing `final` after an edit, and detecting that the
 * user reverted a file by hand.
 *
 * Ported from the snapshot half of core's `FileContextTracker`. The metadata layout is
 * unchanged; only its root moved (from the task directory to this plugin's storage), so
 * removing the plugin removes the storage with it.
 */

import crypto from "crypto"
import fs from "fs/promises"
import path from "path"

/**
 * What a snapshot records about a path at capture time.
 *  - `absent` — the file did not exist.
 *  - `text`   — it existed; the content itself lives in `base/` or `final/`.
 *  - `binary` — it existed but the content is not retained. Declared for the store's
 *    consumers; nothing produces it yet (see TODO.md — binary support).
 */
export type SnapshotKind = "absent" | "text" | "binary"

export interface FileSnapshot {
	kind: SnapshotKind
	/** sha256 of the captured bytes (only meaningful when `kind === "text"`). */
	hash?: string
}

/** A snapshot as persisted, with the path it belongs to (the file name is a hash). */
interface StoredSnapshot extends FileSnapshot {
	_path?: string
}

function sha256(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex")
}

export class FileSnapshotStore {
	private readonly taskDir: string

	/**
	 * @param storageDir This plugin's private storage directory (`ctx.storage.dir`).
	 * @param taskId     The task these snapshots belong to.
	 * @param cwd        The task's working directory — a worktree task's subdirectory,
	 *                   NOT the workspace root, or every read resolves against the
	 *                   wrong tree and the panel silently under-reports.
	 */
	constructor(
		storageDir: string,
		readonly taskId: string,
		private cwd: string,
	) {
		this.taskDir = path.join(storageDir, "tasks", taskId)
	}

	/** Re-point at a new working directory (a workflow task moving to a worktree). */
	reassignCwd(cwd: string): void {
		this.cwd = cwd
	}

	/** Absolute path of this task's snapshot directory — removed when the task is deleted. */
	dir(): string {
		return this.taskDir
	}

	private snapshotFileName(relPath: string): string {
		// sha1 over the workspace-relative path: collision-resistant enough for
		// per-file storage, and free of path-length/character problems. The real path
		// is kept inside the JSON.
		return crypto.createHash("sha1").update(relPath).digest("hex") + ".json"
	}

	private metaPath(kind: "originals" | "finals", relPath: string): string {
		return path.join(this.taskDir, kind, this.snapshotFileName(relPath))
	}

	private copyPath(kind: "base" | "final", relPath: string): string {
		return path.join(this.taskDir, kind, relPath)
	}

	private async readSnapshot(kind: "originals" | "finals", relPath: string): Promise<FileSnapshot | undefined> {
		try {
			const raw = await fs.readFile(this.metaPath(kind, relPath), "utf8")
			return JSON.parse(raw) as FileSnapshot
		} catch {
			return undefined
		}
	}

	private async writeSnapshot(kind: "originals" | "finals", relPath: string, snap: FileSnapshot): Promise<void> {
		const file = this.metaPath(kind, relPath)
		await fs.mkdir(path.dirname(file), { recursive: true })
		const payload: StoredSnapshot = { ...snap, _path: relPath }
		await fs.writeFile(file, JSON.stringify(payload), "utf8")
	}

	private snapshotOf(content: string | undefined): FileSnapshot {
		return content === undefined ? { kind: "absent" } : { kind: "text", hash: sha256(content) }
	}

	private async writeCopy(kind: "base" | "final", relPath: string, content: string): Promise<void> {
		const dest = this.copyPath(kind, relPath)
		await fs.mkdir(path.dirname(dest), { recursive: true })
		await fs.writeFile(dest, content, "utf8")
	}

	private async removeCopy(kind: "base" | "final", relPath: string): Promise<void> {
		try {
			await fs.unlink(this.copyPath(kind, relPath))
		} catch {
			/* already gone */
		}
	}

	private async readCopy(kind: "base" | "final", relPath: string): Promise<string | undefined> {
		try {
			return await fs.readFile(this.copyPath(kind, relPath), "utf8")
		} catch {
			return undefined
		}
	}

	/**
	 * Record the file's content as it was before this task's **first** edit of it.
	 * Idempotent — later edits within the task must not overwrite the baseline, or
	 * "revert" would revert to a state the agent itself produced.
	 *
	 * `content === undefined` means the file did not exist (a creation).
	 */
	async captureOriginal(relPath: string, content: string | undefined): Promise<void> {
		if (await this.readSnapshot("originals", relPath)) return

		const snap = this.snapshotOf(content)
		// Write the verbatim copy FIRST: if it fails, no metadata is persisted and the
		// next edit retries. The reverse order would leave a snapshot claiming a base
		// copy that does not exist, which reads as "diff unavailable" forever.
		if (snap.kind === "text" && content !== undefined) {
			await this.writeCopy("base", relPath, content)
		}
		await this.writeSnapshot("originals", relPath, snap)
	}

	/**
	 * Record the file's current on-disk content as the latest state this task produced.
	 * Overwrites any previous final. Deliberately NOT called on revert, so Redo (and
	 * the base↔final diff) keep describing the agent's work rather than the undo.
	 */
	async captureFinal(relPath: string): Promise<void> {
		let content: string | undefined
		try {
			content = await fs.readFile(path.resolve(this.cwd, relPath), "utf8")
		} catch {
			content = undefined
		}

		const snap = this.snapshotOf(content)
		await this.writeSnapshot("finals", relPath, snap)

		if (content === undefined) {
			// The tool deleted the file: a stale copy would make the diff claim content
			// that no longer exists.
			await this.removeCopy("final", relPath)
		} else {
			await this.writeCopy("final", relPath, content)
		}
	}

	getOriginalSnapshot(relPath: string): Promise<FileSnapshot | undefined> {
		return this.readSnapshot("originals", relPath)
	}

	getFinalSnapshot(relPath: string): Promise<FileSnapshot | undefined> {
		return this.readSnapshot("finals", relPath)
	}

	getBaseContent(relPath: string): Promise<string | undefined> {
		return this.readCopy("base", relPath)
	}

	getFinalContent(relPath: string): Promise<string | undefined> {
		return this.readCopy("final", relPath)
	}

	/**
	 * Promote `content` to the new baseline for `relPath` (what "accept" does): the
	 * file stops being a change because the change became the starting point.
	 */
	async overwriteOriginalBase(relPath: string, content: string | undefined): Promise<void> {
		const snap = this.snapshotOf(content)
		await this.writeSnapshot("originals", relPath, snap)
		if (content === undefined) {
			await this.removeCopy("base", relPath)
		} else {
			await this.writeCopy("base", relPath, content)
		}
	}

	/** Forget this task's last produced state for `relPath` (accept, after promotion). */
	async removeFinalSnapshot(relPath: string): Promise<void> {
		try {
			await fs.unlink(this.metaPath("finals", relPath))
		} catch {
			/* already gone */
		}
		await this.removeCopy("final", relPath)
	}

	/**
	 * Every path this task touched, most recently first.
	 *
	 * Derived from the snapshots themselves rather than from the task's metadata: the
	 * store is the only thing that knows what it captured, so a plugin install/uninstall
	 * cannot leave the list and the data disagreeing. A path appears here as soon as
	 * *either* half exists — a tool that produced a file without a readable baseline
	 * (a generated image) still shows up, with diffing disabled.
	 */
	async candidates(): Promise<string[]> {
		const seen = new Map<string, number>()
		for (const kind of ["originals", "finals"] as const) {
			const dir = path.join(this.taskDir, kind)
			let names: string[]
			try {
				names = await fs.readdir(dir)
			} catch {
				continue
			}
			for (const name of names) {
				if (!name.endsWith(".json")) continue
				const file = path.join(dir, name)
				try {
					const [raw, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)])
					const parsed = JSON.parse(raw) as StoredSnapshot
					if (!parsed._path) continue
					const at = stat.mtimeMs
					if ((seen.get(parsed._path) ?? 0) < at) seen.set(parsed._path, at)
				} catch {
					/* unreadable snapshot — skip it rather than failing the whole list */
				}
			}
		}
		return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([relPath]) => relPath)
	}
}
