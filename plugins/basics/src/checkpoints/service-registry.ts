/**
 * Per-task shadow-repository registry.
 *
 * One {@link ShadowGitRepo} per task, created lazily on first use and kept for the
 * life of the plugin. Initialization is memoized as a *promise*, which is what makes
 * the concurrent case safe by construction: two tools mutating files in the same turn
 * both await the same init rather than racing to create two repos over one directory.
 *
 * A task whose init fails — no git, an unusable workspace, a relocated workspace — is
 * marked disabled and never retried. Checkpoints are best-effort: the agent keeps
 * working, it just has no undo history for that task.
 */

import path from "path"

import { ShadowGitRepo } from "./shadow-git.js"

export interface TaskRepoRequest {
	taskId: string
	/** Workspace root (the shadow repo's working tree unless scoped). */
	workspaceDir: string
	/** The task's cwd — a subdirectory means an embedded worktree task. */
	cwd?: string
}

export interface CheckpointServiceRegistryOptions {
	/** Root under which each task's shadow repo lives (the plugin's own storage). */
	storageDir: string
	/** How long init may take before checkpoints are given up on for that task. */
	initTimeoutMs: number
	extraExcludePatterns: string[]
	log: (message: string) => void
	warn: (message: string) => void
	/** Called with each new checkpoint so the plugin can append its timeline marker. */
	onCheckpoint: (taskId: string, event: { fromHash: string; toHash: string; suppressMessage?: boolean }) => void
}

export class CheckpointServiceRegistry {
	private readonly repos = new Map<string, Promise<ShadowGitRepo>>()
	/** Tasks whose checkpoints are off for the rest of the session, and why. */
	private readonly disabled = new Map<string, string>()

	constructor(private readonly options: CheckpointServiceRegistryOptions) {}

	/** Absolute path of a task's shadow repository. */
	public repoDir(taskId: string): string {
		return path.join(this.options.storageDir, "tasks", taskId)
	}

	/** Whether checkpoints have been given up on for `taskId`. */
	public isDisabled(taskId: string): boolean {
		return this.disabled.has(taskId)
	}

	/**
	 * The task's initialized shadow repo, creating it on first call. Returns
	 * `undefined` — never throws — when checkpoints are unavailable for this task, so
	 * every caller can treat "no undo history" as a normal outcome.
	 */
	public async get(request: TaskRepoRequest): Promise<ShadowGitRepo | undefined> {
		if (this.disabled.has(request.taskId)) return undefined
		if (!request.workspaceDir) {
			this.disable(request.taskId, "no workspace folder")
			return undefined
		}

		const existing = this.repos.get(request.taskId)
		if (existing) {
			try {
				return await existing
			} catch {
				return undefined // Already disabled + warned by the creating call.
			}
		}

		const creation = this.create(request)
		this.repos.set(request.taskId, creation)

		try {
			return await creation
		} catch (error) {
			this.disable(request.taskId, error instanceof Error ? error.message : String(error))
			return undefined
		}
	}

	private async create(request: TaskRepoRequest): Promise<ShadowGitRepo> {
		// A task whose cwd is below the workspace root is an embedded worktree task:
		// scope its working tree so it cannot checkpoint a sibling worktree's files.
		const scopedWorktreeDir = request.cwd && request.cwd !== request.workspaceDir ? request.cwd : undefined

		const repo = new ShadowGitRepo({
			taskId: request.taskId,
			workspaceDir: request.workspaceDir,
			checkpointsDir: this.repoDir(request.taskId),
			scopedWorktreeDir,
			extraExcludePatterns: this.options.extraExcludePatterns,
			log: this.options.log,
		})

		repo.on("checkpoint", ({ fromHash, toHash, suppressMessage }) => {
			this.options.onCheckpoint(request.taskId, { fromHash, toHash, suppressMessage })
		})

		// Bound init: `git init` + the first `git add .` over a large workspace can be
		// slow, and blocking a tool call indefinitely would be worse than losing undo.
		let timer: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`shadow repo did not initialize within ${this.options.initTimeoutMs}ms`)),
				this.options.initTimeoutMs,
			)
		})

		try {
			await Promise.race([repo.init(), timeout])
			return repo
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	/** Give up on checkpoints for `taskId`, loudly — a silent loss of undo is worse. */
	public disable(taskId: string, reason: string): void {
		if (this.disabled.has(taskId)) return
		this.disabled.set(taskId, reason)
		this.options.warn(`Checkpoints disabled for this task: ${reason}`)
	}

	/** Forget a task's repo (after its directory is deleted). */
	public forget(taskId: string): void {
		this.repos.delete(taskId)
		this.disabled.delete(taskId)
	}
}
