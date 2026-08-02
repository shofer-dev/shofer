/**
 * collisions — the one thing that crosses tasks: which live task touched which paths.
 *
 * One plugin instance observes every task in the host, so this is a Map, not the
 * original's flock'd shared file. The trigger stays STRUCTURAL: a projected edit whose
 * path another live task touched fires the cross-task-collision detector directly —
 * the model is only asked to write the advisory, so it cannot hallucinate a conflict.
 * Entries expire on a TTL so a dead task's paths stop warning; tasks on other hosts
 * (other hosts sharing the workspace) are invisible by scope.
 */

/** How long a touched path stays visible to other tasks. */
const INDEX_TTL_MS = 15 * 60 * 1000

interface TaskTouches {
	cwd?: string
	/** path → last touch (unix ms) */
	paths: Map<string, number>
}

export interface Collision {
	path: string
	otherTaskId: string
	/** Same working directory ⇒ later writer wins silently (urgent); else diverging worktrees. */
	sameCwd: boolean
}

export class CollisionIndex {
	private byTask = new Map<string, TaskTouches>()

	touch(taskId: string, path: string, cwd: string | undefined, now: number): void {
		let entry = this.byTask.get(taskId)
		if (!entry) {
			entry = { cwd, paths: new Map() }
			this.byTask.set(taskId, entry)
		}
		if (cwd) entry.cwd = cwd
		entry.paths.set(path, now)
	}

	forget(taskId: string): void {
		this.byTask.delete(taskId)
	}

	/** Collisions for `taskId` on `path` right now — live entries in OTHER tasks. */
	check(taskId: string, path: string, cwd: string | undefined, now: number): Collision[] {
		const cutoff = now - INDEX_TTL_MS
		const collisions: Collision[] = []
		for (const [otherId, touches] of this.byTask) {
			if (otherId === taskId) continue
			const at = touches.paths.get(path)
			if (at === undefined || at < cutoff) continue
			collisions.push({ path, otherTaskId: otherId, sameCwd: !!cwd && touches.cwd === cwd })
		}
		return collisions
	}

	/** Drop expired paths (and empty tasks) — self-healing, no cleanup path needed. */
	compact(now: number): void {
		const cutoff = now - INDEX_TTL_MS
		for (const [taskId, touches] of this.byTask) {
			for (const [path, at] of touches.paths) {
				if (at < cutoff) touches.paths.delete(path)
			}
			if (touches.paths.size === 0) this.byTask.delete(taskId)
		}
	}
}
