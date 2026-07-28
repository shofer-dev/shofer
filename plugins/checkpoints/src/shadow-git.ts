/**
 * shadow-git — the checkpoint engine: one git repository per task, living OUTSIDE
 * the workspace, whose working tree IS the workspace.
 *
 * Ported from the built-in `ShadowCheckpointService` (`packages/core/src/checkpoints/`)
 * when checkpoints became a plugin. The abstract base + single subclass collapsed into
 * one class — the indirection existed for a second implementation that no longer
 * exists — and the ripgrep-based nested-repo *diagnostic* was dropped (it only ever
 * logged; `GIT_DIR` is what actually handles nested repos, see below). The git
 * behaviour itself is unchanged.
 *
 * Why a separate repo rather than committing to the user's own:
 *  - the user's history stays untouched;
 *  - files their `.gitignore` excludes are still captured, so an undo is complete;
 *  - it works in a workspace with no git repository at all.
 */

import fs from "fs/promises"
import os from "os"
import * as path from "path"
import EventEmitter from "events"

import { simpleGit, type SimpleGit, type SimpleGitOptions } from "simple-git"

// Build-time borrow, not a runtime dependency: `build-ui.mjs` inlines these two string
// constants into `main.mjs` exactly as it inlines `simple-git`. Imported by source path
// rather than from `@shofer/types` deliberately — the package entry is a barrel of zod
// schemas that would add ~600 KB to an otherwise ~200 KB bundle, and every other
// `@shofer/types` use in this plugin is type-only and erases. The constants must be
// shared all the same: core's worktree guard keys its path confinement off the same
// directory, and a private copy here would drift silently.
import { EMBEDDED_WORKTREES_DIR, LEGACY_EMBEDDED_WORKTREES_DIR } from "../../../packages/types/src/worktrees.js"

import { fileExistsAtPath } from "./fs-util.js"
import { getExcludePatterns } from "./excludes.js"
import type { CheckpointDiff, CheckpointDiffStat, CheckpointEventMap, CheckpointResult } from "./types.js"

/** Paths whose contents are too broad/personal to ever snapshot wholesale. */
function protectedRoots(): string[] {
	const homedir = os.homedir()
	return [homedir, path.join(homedir, "Desktop"), path.join(homedir, "Documents"), path.join(homedir, "Downloads")]
}

/**
 * Build a git instance whose environment cannot be hijacked by inherited git
 * variables (a Dev Container, a hook, a parent `git` invocation), and which is
 * pinned to the shadow repository.
 *
 * `GIT_DIR` is set to the shadow repo's `.git`; `GIT_WORK_TREE` deliberately is NOT.
 * That single choice is what makes nested repositories work: git treats the shadow
 * repo as the only repository, so a submodule/child clone inside the workspace is
 * staged as ordinary files instead of an empty gitlink (mode 160000) whose contents
 * no checkpoint would ever hold. `core.worktree` (set at init) supplies the working
 * tree, so `git add .` still stages workspace files from the shadow directory.
 */
function createSanitizedGit(baseDir: string, log: (message: string) => void): SimpleGit {
	const dotGitPath = path.join(baseDir, ".git")

	const sanitizedEnv: Record<string, string> = {}
	const removedVars: string[] = []

	for (const [key, value] of Object.entries(process.env)) {
		if (
			key === "GIT_DIR" ||
			key === "GIT_WORK_TREE" ||
			key === "GIT_INDEX_FILE" ||
			key === "GIT_OBJECT_DIRECTORY" ||
			key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
			key === "GIT_CEILING_DIRECTORIES" ||
			key === "GIT_TEMPLATE_DIR"
		) {
			removedVars.push(`${key}=${value}`)
			continue
		}
		if (value !== undefined) {
			sanitizedEnv[key] = value
		}
	}

	sanitizedEnv["GIT_DIR"] = dotGitPath

	if (removedVars.length > 0) {
		log(
			`[createSanitizedGit] removed git environment variables for checkpoint isolation: ${removedVars.join(", ")}`,
		)
	}

	const options: Partial<SimpleGitOptions> = { baseDir, config: [] }
	const git = simpleGit(options)
	git.env(sanitizedEnv)
	return git
}

export interface ShadowGitRepoOptions {
	taskId: string
	/** The workspace root — the default working tree for the shadow repo. */
	workspaceDir: string
	/** Where this task's shadow repo lives (the plugin's own storage). */
	checkpointsDir: string
	/**
	 * Scope the working tree to a subdirectory instead of the whole workspace. Used by
	 * embedded worktree tasks so a task's checkpoints capture only its own worktree,
	 * never a sibling's.
	 */
	scopedWorktreeDir?: string
	/** Extra `.gitignore`-style exclude patterns from plugin config. */
	extraExcludePatterns?: string[]
	log: (message: string) => void
}

export class ShadowGitRepo extends EventEmitter {
	public readonly taskId: string
	public readonly checkpointsDir: string
	public readonly workspaceDir: string
	public readonly scopedWorktreeDir?: string

	private readonly extraExcludePatterns: string[]
	private _checkpoints: string[] = []
	private _baseHash?: string

	private readonly dotGitDir: string
	private git?: SimpleGit
	private readonly log: (message: string) => void
	private shadowGitConfigWorktree?: string

	public get baseHash() {
		return this._baseHash
	}

	public get isInitialized() {
		return !!this.git
	}

	public getCheckpoints(): string[] {
		return this._checkpoints.slice()
	}

	constructor(options: ShadowGitRepoOptions) {
		super()

		if (protectedRoots().includes(options.workspaceDir)) {
			throw new Error(`Cannot use checkpoints in ${options.workspaceDir}`)
		}

		this.taskId = options.taskId
		this.checkpointsDir = options.checkpointsDir
		this.workspaceDir = options.workspaceDir
		this.scopedWorktreeDir = options.scopedWorktreeDir
		this.extraExcludePatterns = options.extraExcludePatterns ?? []
		this.dotGitDir = path.join(this.checkpointsDir, ".git")
		this.log = options.log
	}

	/**
	 * Create (or re-open) this task's shadow repository. Idempotent per instance;
	 * calling it twice is a programming error, not a recoverable state.
	 */
	public async init(): Promise<{ created: boolean; duration: number }> {
		if (this.git) {
			throw new Error("Shadow git repo already initialized")
		}

		await fs.mkdir(this.checkpointsDir, { recursive: true })
		const git = createSanitizedGit(this.checkpointsDir, this.log)
		await git.version()

		let created = false
		const startTime = Date.now()

		const worktreeTarget = this.scopedWorktreeDir ?? this.workspaceDir

		if (await fileExistsAtPath(this.dotGitDir)) {
			const worktree = await this.getShadowGitConfigWorktree(git)

			if (!worktree) {
				throw new Error("Checkpoints require core.worktree to be set in the shadow git config")
			}

			// Guard against the workspace having moved under an existing shadow repo:
			// staging against the wrong tree would record a "checkpoint" of unrelated files.
			if (!arePathsEqual(worktree.trim(), worktreeTarget)) {
				throw new Error(
					`Checkpoints can only be used in the original workspace: ${worktree.trim()} !== ${worktreeTarget}`,
				)
			}

			// Rewritten every init: the LFS patterns are read from the workspace's
			// `.gitattributes`, which can change between runs.
			await this.writeExcludeFile()
			this._baseHash = await git.revparse(["HEAD"])
		} else {
			this.log(`[ShadowGitRepo#init] creating shadow git repo at ${this.checkpointsDir}`)
			await git.init({ "--template": "" })
			await git.addConfig("core.worktree", worktreeTarget)
			await git.addConfig("commit.gpgSign", "false")
			await git.addConfig("user.name", "Shofer")
			await git.addConfig("user.email", "noreply@example.com")
			await this.writeExcludeFile()
			await this.stageAll(git)
			// `--allow-empty`: an empty workspace must still produce a valid base commit,
			// or every later operation has no `from` to diff against.
			const { commit } = await git.commit("initial commit", { "--allow-empty": null })
			this._baseHash = commit
			created = true
		}

		const duration = Date.now() - startTime
		this.log(`[ShadowGitRepo#init] initialized shadow repo with base commit ${this._baseHash} in ${duration}ms`)

		this.git = git
		this.emit("initialize", {
			type: "initialize",
			workspaceDir: this.workspaceDir,
			baseHash: this._baseHash,
			created,
			duration,
		})

		return { created, duration }
	}

	/**
	 * Write `.git/info/exclude` — local to the shadow repo, so it never touches the
	 * user's `.gitignore` and cannot conflict with it.
	 */
	private async writeExcludeFile() {
		await fs.mkdir(path.join(this.dotGitDir, "info"), { recursive: true })
		const patterns = await getExcludePatterns(this.workspaceDir)

		// A main-workspace shadow repo must not swallow sibling embedded worktrees;
		// each worktree task checkpoints its own scoped tree. The legacy location is
		// excluded too while the transition shim stands.
		if (!this.scopedWorktreeDir) {
			patterns.push(`/${EMBEDDED_WORKTREES_DIR}/`, `/${LEGACY_EMBEDDED_WORKTREES_DIR}/`)
		}

		patterns.push(...this.extraExcludePatterns)
		await fs.writeFile(path.join(this.dotGitDir, "info", "exclude"), patterns.join("\n"))
	}

	/**
	 * `--ignore-errors` so a single unreadable file (permissions, a race with a build)
	 * degrades that file rather than aborting the whole snapshot.
	 */
	private async stageAll(git: SimpleGit) {
		try {
			await git.add([".", "--ignore-errors"])
		} catch (error) {
			this.log(
				`[ShadowGitRepo#stageAll] failed to add files to git: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private async getShadowGitConfigWorktree(git: SimpleGit) {
		if (!this.shadowGitConfigWorktree) {
			try {
				this.shadowGitConfigWorktree = (await git.getConfig("core.worktree")).value || undefined
			} catch (error) {
				this.log(
					`[ShadowGitRepo#getShadowGitConfigWorktree] failed to get core.worktree: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		return this.shadowGitConfigWorktree
	}

	/**
	 * Snapshot the workspace. `allowEmpty` records a commit even with no changes —
	 * that is what gives a user message a rollback anchor of its own; without it a
	 * no-change turn silently has nothing to restore to.
	 */
	public async saveCheckpoint(
		message: string,
		options?: { allowEmpty?: boolean; suppressMessage?: boolean },
	): Promise<CheckpointResult | undefined> {
		try {
			if (!this.git) {
				throw new Error("Shadow git repo not initialized")
			}

			const startTime = Date.now()
			await this.stageAll(this.git)
			const commitArgs = options?.allowEmpty ? { "--allow-empty": null } : undefined
			const result = await this.git.commit(message, commitArgs)
			const fromHash = this._checkpoints[this._checkpoints.length - 1] ?? this._baseHash!
			const toHash = result.commit || fromHash
			const duration = Date.now() - startTime

			if (!result.commit) {
				this.log(`[ShadowGitRepo#saveCheckpoint] found no changes to commit in ${duration}ms`)
				return undefined
			}

			this._checkpoints.push(toHash)
			this.emit("checkpoint", {
				type: "checkpoint",
				fromHash,
				toHash,
				duration,
				suppressMessage: options?.suppressMessage ?? false,
			})
			this.log(`[ShadowGitRepo#saveCheckpoint] checkpoint saved in ${duration}ms -> ${result.commit}`)
			return result
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			this.log(`[ShadowGitRepo#saveCheckpoint] failed to create checkpoint: ${error.message}`)
			this.emit("error", { type: "error", error })
			throw error
		}
	}

	/** Return the working tree to `commitHash`, discarding everything after it. */
	public async restoreCheckpoint(commitHash: string) {
		try {
			if (!this.git) {
				throw new Error("Shadow git repo not initialized")
			}

			const start = Date.now()
			await this.git.clean("f", ["-d", "-f"])
			await this.git.reset(["--hard", commitHash])

			const checkpointIndex = this._checkpoints.indexOf(commitHash)
			if (checkpointIndex !== -1) {
				this._checkpoints = this._checkpoints.slice(0, checkpointIndex + 1)
			}

			const duration = Date.now() - start
			this.emit("restore", { type: "restore", commitHash, duration })
			this.log(`[ShadowGitRepo#restoreCheckpoint] restored checkpoint ${commitHash} in ${duration}ms`)
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			this.log(`[ShadowGitRepo#restoreCheckpoint] failed to restore checkpoint: ${error.message}`)
			this.emit("error", { type: "error", error })
			throw error
		}
	}

	/**
	 * Per-file before/after contents between two checkpoints, or between one and the
	 * current working tree (`to` omitted). Everything is staged first so files the
	 * workspace never tracked still show up.
	 */
	public async getDiff({ from, to }: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
		if (!this.git) {
			throw new Error("Shadow git repo not initialized")
		}

		const result: CheckpointDiff[] = []

		if (!from) {
			from = (await this.git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim()
		}

		await this.stageAll(this.git)

		this.log(`[ShadowGitRepo#getDiff] diffing ${to ? `${from}..${to}` : `${from}..HEAD`}`)
		const { files } = to ? await this.git.diffSummary([`${from}..${to}`]) : await this.git.diffSummary([from])

		const cwdPath = (await this.getShadowGitConfigWorktree(this.git)) || this.workspaceDir || ""

		for (const file of files) {
			const relPath = file.file
			const absPath = path.join(cwdPath, relPath)
			const before = await this.git.show([`${from}:${relPath}`]).catch(() => "")

			const after = to
				? await this.git.show([`${to}:${relPath}`]).catch(() => "")
				: await fs.readFile(absPath, "utf8").catch(() => "")

			result.push({ paths: { relative: relPath, absolute: absPath }, content: { before, after } })
		}

		return result
	}

	/**
	 * Per-file line counts for the same range as {@link getDiff}, without loading file
	 * contents — for a summary the caller can render cheaply.
	 */
	public async getDiffStat({ from, to }: { from?: string; to?: string }): Promise<CheckpointDiffStat[]> {
		if (!this.git) {
			throw new Error("Shadow git repo not initialized")
		}

		if (!from) {
			from = (await this.git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim()
		}

		await this.stageAll(this.git)

		this.log(`[ShadowGitRepo#getDiffStat] diffing ${to ? `${from}..${to}` : `${from}..HEAD`}`)
		const { files } = to ? await this.git.diffSummary([`${from}..${to}`]) : await this.git.diffSummary([from])

		const cwdPath = (await this.getShadowGitConfigWorktree(this.git)) || this.workspaceDir || ""

		// simple-git reports a binary file with `binary: true` and byte counts instead
		// of insertions/deletions; normalize both shapes.
		return files.map((file) => {
			const binary = (file as { binary?: boolean }).binary === true
			return {
				relative: file.file,
				absolute: path.join(cwdPath, file.file),
				insertions: binary ? 0 : ((file as { insertions?: number }).insertions ?? 0),
				deletions: binary ? 0 : ((file as { deletions?: number }).deletions ?? 0),
				binary,
			}
		})
	}

	override emit<K extends keyof CheckpointEventMap>(event: K, data: CheckpointEventMap[K]) {
		return super.emit(event, data)
	}

	override on<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.on(event, listener)
	}

	override off<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.off(event, listener)
	}

	override once<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.once(event, listener)
	}
}

/**
 * Path equality tolerating the differences an OS introduces (`./..` segments,
 * duplicate/trailing separators, case on Windows) — a false mismatch here would
 * refuse checkpoints in the user's own workspace. Mirrors core's `arePathsEqual`;
 * the plugin carries its own so it depends on no core internals.
 */
export function arePathsEqual(path1?: string, path2?: string): boolean {
	if (!path1 && !path2) return true
	if (!path1 || !path2) return false

	const normalize = (p: string): string => {
		let normalized = path.normalize(p)
		if (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
			normalized = normalized.slice(0, -1)
		}
		return normalized
	}

	const a = normalize(path1)
	const b = normalize(path2)
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}
