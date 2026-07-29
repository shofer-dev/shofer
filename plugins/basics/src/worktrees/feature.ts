/**
 * Worktrees — parallel work on branches, as a feature of the Basics plugin.
 *
 * A worktree is a second checkout of the same repository, and Shofer's embedded model
 * puts them inside the workspace (`<workspace>/.worktrees/<name>/`) so several
 * tasks can work on different branches in one window without the user juggling windows.
 * This plugin owns all of that: the git operations, the `.shofer/worktreeinclude` copy,
 * the picker in the chat input, the management view in Settings, the merge/rebase slash
 * commands — and the decision of **where a new task runs**.
 *
 * What stays in core, deliberately:
 *
 * - `task.cwd` (and `HistoryItem.cwd`): "a task runs in a directory" is the execution
 *   model, not a worktree feature. This plugin only chooses the directory.
 * - The path-containment guard in every mutating tool, and the Linux `execute_command`
 *   sandbox: a task confined to a subtree is a **safety** property, and safety that a
 *   user can disable by removing a plugin is not safety.
 *
 * | Piece                                        | Where it is                              |
 * | -------------------------------------------- | ---------------------------------------- |
 * | `git worktree` operations                    | `src/worktree-service.ts`                |
 * | `.shofer/worktreeinclude` copy               | `src/worktree-include.ts`                |
 * | branch status / merge readiness              | `src/worktree-status.ts`                 |
 * | the branch chip in the chat input            | a `chat-input-toolbar` UI contribution   |
 * | the management panel                         | a `settings-tab` UI contribution         |
 * | where a new task runs                        | the `"resolve-task-cwd"` broadcast       |
 * | the six merge/rebase slash commands          | `contributes.commands` (unqualified)     |
 */

import fs from "fs/promises"
import path from "path"

import { EMBEDDED_WORKTREES_DIR, LEGACY_EMBEDDED_WORKTREES_DIR, type PluginContext } from "@shofer/types"

import type { BasicsFeature } from "../feature.js"
import { worktreeService } from "./worktree-service.js"
import { worktreeIncludeService, type CopyProgressCallback } from "./worktree-include.js"
import type {
	BranchInfo,
	CreateWorktreeOptions,
	WorktreeDefaultsResponse,
	WorktreeIncludeStatus,
	WorktreeListResponse,
	WorktreeResult,
	WorktreeStatus,
} from "./types.js"
import { getWorktreeStatus } from "./worktree-status.js"

const FEATURE_NAME = "worktrees"

/**
 * The prefixes a worktree is *recognised* under, relative to the repository root: the
 * current one plus the legacy `.shofer/worktrees/`, so worktrees a user already has stay
 * listed and deletable rather than being orphaned. **Transition shim — drop the legacy
 * entry in a later release.** Creation only ever uses `EMBEDDED_WORKTREES_DIR`.
 */
const RECOGNISED_PREFIXES = [EMBEDDED_WORKTREES_DIR, path.normalize(LEGACY_EMBEDDED_WORKTREES_DIR)]

interface PluginState {
	ctx?: PluginContext
	/**
	 * Where the user wants the **next** task to run, as chosen in the chat input.
	 *
	 * `undefined` — nothing chosen: a new task gets a fresh worktree (the default).
	 * a path      — run there.
	 * `null`      — the user explicitly chose the current branch; do not create one.
	 *
	 * Deliberately plugin-side rather than webview-side: the same decision has to be
	 * available when core asks where to put a task, and a webview flag would have to be
	 * threaded through task creation for a feature core no longer knows about.
	 */
	pendingCwd?: string | null
}

const state: PluginState = {}

function workspaceOf(ctx: PluginContext): string | undefined {
	return ctx.workspacePath ?? state.ctx?.workspacePath ?? ctx.cwd
}

function folders(ctx: PluginContext): readonly string[] | undefined {
	return ctx.workspaceFolders ?? state.ctx?.workspaceFolders
}

/** A random, pronounceable-enough token; the branch, the directory and the label share it. */
function randomSuffix(length = 5): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	let out = ""
	for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
	return out
}

/** Whether `cwd` sits below the repository root rather than at it. */
async function isSubfolderOfRepo(cwd: string): Promise<boolean> {
	const gitRoot = await worktreeService.getGitRootPath(cwd)
	if (!gitRoot) return false
	const normalizedCwd = path.normalize(cwd)
	const normalizedRoot = path.normalize(gitRoot)
	return normalizedCwd !== normalizedRoot && normalizedCwd.startsWith(normalizedRoot)
}

/**
 * Whether `cwd` is itself one of our embedded worktrees — at the current path or the
 * legacy one, since an existing worktree must stay manageable.
 *
 * Anchored to the resolved git root via `path.relative`, not a substring match, so an
 * unrelated directory whose name merely contains `.worktrees` cannot pass.
 */
function isEmbeddedWorktree(gitRootPath: string, cwd: string): boolean {
	const rel = path.relative(path.resolve(gitRootPath), path.resolve(cwd))
	if (rel.startsWith("..") || path.isAbsolute(rel)) return false
	return RECOGNISED_PREFIXES.some((prefix) => rel.startsWith(prefix + path.sep))
}

async function listWorktrees(ctx: PluginContext): Promise<WorktreeListResponse> {
	const cwd = workspaceOf(ctx)
	const open = folders(ctx)

	if (!cwd) {
		return {
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath: "",
			error: "no-workspace",
		}
	}
	if (open && open.length > 1) {
		// "The repository" is ambiguous with several roots, and guessing one would put a
		// worktree somewhere the user did not ask for.
		return {
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: true,
			isSubfolder: false,
			gitRootPath: "",
			error: "multi-root",
		}
	}
	if (!(await worktreeService.checkGitRepo(cwd))) {
		return {
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath: "",
			error: "not-a-repo",
		}
	}

	const gitRootPath = (await worktreeService.getGitRootPath(cwd)) || ""
	const subfolder = await isSubfolderOfRepo(cwd)
	// A workspace opened ON an embedded worktree is a subfolder, but a legitimate one:
	// it is a checkout this feature created.
	if (subfolder && !(gitRootPath && isEmbeddedWorktree(gitRootPath, cwd))) {
		return {
			worktrees: [],
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: true,
			gitRootPath,
			error: "subfolder",
		}
	}

	try {
		return {
			worktrees: await worktreeService.listWorktrees(cwd),
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath,
		}
	} catch (error) {
		return {
			worktrees: [],
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

interface CreateRequest extends CreateWorktreeOptions {
	initSubmodules?: boolean
	copyWorktreeInclude?: boolean
}

/**
 * Keep `.worktrees/` out of the repository's own history.
 *
 * The worktrees live INSIDE the workspace, so without this every checkout the plugin
 * creates shows up as untracked noise in the main one — and can be committed by
 * accident. A repository that still carries the old `.shofer/worktrees/` line keeps it:
 * it is harmless, and rewriting a user's `.gitignore` is not this plugin's business.
 */
async function ensureGitignored(cwd: string): Promise<void> {
	const gitignorePath = path.join(cwd, ".gitignore")
	const entry = `${EMBEDDED_WORKTREES_DIR}/`
	let content = ""
	try {
		content = await fs.readFile(gitignorePath, "utf-8")
	} catch {
		// No .gitignore yet — the write below creates one.
	}
	if (content.split(/\r?\n/).some((line) => line.trim().replace(/\/$/, "") === entry.replace(/\/$/, ""))) return
	const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n"
	await fs.appendFile(gitignorePath, `${separator}${entry}\n`, "utf-8")
}

/**
 * Create a worktree, then optionally seed it: the `.shofer/worktreeinclude` files (the
 * untracked things a checkout needs to be usable, like `node_modules`) and submodules.
 *
 * Progress is pushed to the plugin's UI as it goes, because both steps can take minutes
 * and a silent modal reads as a hang.
 */
async function createWorktree(ctx: PluginContext, request: CreateRequest): Promise<WorktreeResult> {
	const cwd = workspaceOf(ctx)
	if (!cwd) return { success: false, message: "no-workspace" }
	if (!(await worktreeService.checkGitRepo(cwd))) return { success: false, message: "not-a-repo" }

	const step = (name: string, detail?: string) => ctx.ui?.postMessage({ type: "worktrees:step", name, detail })
	const onProgress: CopyProgressCallback = (progress) =>
		ctx.ui?.postMessage({ type: "worktrees:copy-progress", ...progress })

	const options: CreateRequest = { ...request, path: enforceConventions(cwd, request) }

	try {
		await ensureGitignored(cwd)
	} catch (error) {
		// Worth saying, not worth refusing over: an un-ignored worktree is untidy, a
		// missing one is a failed action.
		ctx.host?.log.warn(`[${FEATURE_NAME}] could not update .gitignore: ${String(error)}`)
	}

	const result = await worktreeService.createWorktree(cwd, options)

	if (result.success && result.worktree && options.copyWorktreeInclude !== false) {
		try {
			step("copy")
			const copied = await worktreeIncludeService.copyWorktreeIncludeFiles(cwd, result.worktree.path, onProgress)
			if (copied.length > 0) result.copiedItems = copied.length
			step("copy", "done")
		} catch (error) {
			// A missing node_modules is inconvenient; a missing worktree is worse. Keep it.
			ctx.host?.log.warn(`[${FEATURE_NAME}] worktreeinclude copy failed: ${String(error)}`)
			step("copy", "failed")
		}
	}

	if (result.success && result.worktree && options.initSubmodules !== false) {
		step("submodules")
		const submodules = await worktreeService.initSubmodules(result.worktree.path, 1)
		step("submodules", submodules.success ? "done" : "failed")
		if (!submodules.success) {
			// A worktree whose submodules are empty directories is not usable, and leaving
			// it behind would look like success. Tear it down and say so.
			ctx.host?.log.warn(`[${FEATURE_NAME}] submodule init failed; removing ${result.worktree.path}`)
			const cleanup = await worktreeService.deleteWorktree(cwd, result.worktree.path, true)
			if (!cleanup.success) {
				ctx.host?.log.warn(`[${FEATURE_NAME}] cleanup after failed submodule init: ${cleanup.message}`)
			}
			return { success: false, message: `submodules-failed: ${submodules.error ?? ""}`.trim() }
		}
	}

	return result
}

/**
 * Force the two conventions this feature rests on: a worktree lives under
 * `<workspace>/.worktrees/`, and when a branch is being created the directory
 * basename matches it — so branch, directory and badge are one name the user can track.
 *
 * Creation is deliberately NOT tolerant of the legacy prefix: a request pointing at
 * `.shofer/worktrees/` is rewritten to the current one like any other stray path.
 */
function enforceConventions(cwd: string, request: CreateRequest): string {
	const prefix = path.join(cwd, EMBEDDED_WORKTREES_DIR)
	let target = path.resolve(cwd, request.path)
	if (!target.startsWith(prefix + path.sep) && target !== prefix) {
		target = path.join(prefix, path.basename(request.path))
	}
	if (request.createNewBranch && request.branch && path.basename(target) !== request.branch) {
		target = path.join(prefix, request.branch)
	}
	return target
}

/** The name a new worktree gets when nobody chose one: branch, directory and label alike. */
async function defaults(ctx: PluginContext): Promise<WorktreeDefaultsResponse> {
	const cwd = workspaceOf(ctx) ?? ""
	const name = `shofer-${randomSuffix()}`
	return { suggestedBranch: name, suggestedPath: path.join(cwd, EMBEDDED_WORKTREES_DIR, name) }
}

/**
 * Where should a task about to start run?
 *
 * Core broadcasts this question to every plugin when a task is created and takes the
 * first answer (`pluginRegistry.requestAll("resolve-task-cwd")`). The rule the user sees:
 *
 * - they picked a worktree in the chat input ⇒ run there;
 * - they explicitly picked "current branch" ⇒ answer nothing, and the task runs in the
 *   workspace like any other;
 * - they did neither ⇒ a fresh worktree, so parallel work never collides by default.
 *
 * A failure is reported as `{ error }` rather than thrown: core's broadcast treats a
 * throw as "this plugin does not answer that question", and being mistaken for silence
 * here would put the agent's edits on the user's current branch — the one outcome the
 * default exists to prevent. With `{ error }` core aborts the task and shows the reason.
 */
async function resolveTaskCwd(ctx: PluginContext): Promise<{ cwd?: string; error?: string } | undefined> {
	const chosen = state.pendingCwd
	state.pendingCwd = undefined

	if (chosen === null) return undefined
	if (typeof chosen === "string" && chosen.length > 0) return { cwd: chosen }

	const listing = await listWorktrees(ctx)
	// Not a git repo, several roots, or a subfolder checkout: there is nothing to branch
	// from, so the task simply runs where it is.
	if (!listing.isGitRepo || listing.error) return undefined

	const { suggestedBranch, suggestedPath } = await defaults(ctx)
	const result = await createWorktree(ctx, {
		path: suggestedPath,
		branch: suggestedBranch,
		createNewBranch: true,
		initSubmodules: true,
	})
	if (!result.success || !result.worktree) {
		return { error: `Could not create a worktree for this task: ${result.message}` }
	}
	return { cwd: result.worktree.path }
}

export const worktreesFeature: BasicsFeature = {
	id: "worktrees",

	initialize(ctx: PluginContext): void {
		state.ctx = ctx
		state.pendingCwd = undefined
		ctx.host?.log.info("worktrees feature initialized")
	},

	/** Core's task-placement broadcast; routed here by `main.ts` un-namespaced. */
	broadcasts: ["resolve-task-cwd"],

	/**
	 * The UI's request surface, and core's one question. Methods arrive bare — the UI
	 * sends `local:worktrees:<method>` and `main.ts` strips both prefixes.
	 *
	 * Every method is answered on the host that owns the workspace — worktrees are
	 * directories on that machine, so unlike a per-task feature there is nothing to route
	 * to an executor.
	 */
	async handleRequest(method: string, params: unknown, ctx: PluginContext): Promise<unknown> {
		const cwd = workspaceOf(ctx)

		switch (method) {
			case "list":
				return listWorktrees(ctx)

			case "create":
				return createWorktree(ctx, params as CreateRequest)

			case "delete": {
				const { path: target, force } = params as { path: string; force?: boolean }
				if (!cwd) throw new Error("no-workspace")
				return worktreeService.deleteWorktree(cwd, target, force ?? false)
			}

			case "branches": {
				if (!cwd) throw new Error("no-workspace")
				// Include branches already checked out elsewhere: this list is for picking a
				// BASE to branch from, and an existing worktree's branch is a valid base.
				return worktreeService.getAvailableBranches(cwd, true) satisfies Promise<BranchInfo>
			}

			case "defaults":
				return defaults(ctx)

			case "include-status": {
				if (!cwd) throw new Error("no-workspace")
				return worktreeIncludeService.getStatus(cwd) satisfies Promise<WorktreeIncludeStatus>
			}

			case "branch-has-include": {
				if (!cwd) throw new Error("no-workspace")
				return worktreeIncludeService.branchHasWorktreeInclude(cwd, (params as { branch: string }).branch)
			}

			case "create-include": {
				if (!cwd) throw new Error("no-workspace")
				const { content } = params as { content: string }
				try {
					await worktreeIncludeService.createWorktreeInclude(cwd, content)
					// The user is about to want to edit it — showing it beats telling them
					// where it is. Best-effort: the file exists either way.
					await ctx.host?.editor?.openFile(path.join(cwd, ".shofer", "worktreeinclude")).catch(() => {})
					return { success: true, message: "created" } satisfies WorktreeResult
				} catch (error) {
					return {
						success: false,
						message: error instanceof Error ? error.message : String(error),
					} satisfies WorktreeResult
				}
			}

			case "checkout": {
				if (!cwd) throw new Error("no-workspace")
				return worktreeService.checkoutBranch(cwd, (params as { branch: string }).branch)
			}

			case "status": {
				// The status the user cares about is the one for the task's OWN worktree; in
				// the embedded model the workspace cwd is always the main checkout.
				const target = (params as { cwd?: string } | undefined)?.cwd || cwd
				if (!target) throw new Error("no-workspace")
				return getWorktreeStatus(target) satisfies Promise<WorktreeStatus>
			}

			case "select": {
				// `null` = the user chose the current branch; a path = run there.
				const { cwd: chosen } = params as { cwd: string | null }
				state.pendingCwd = chosen
				return { selected: chosen }
			}

			case "selection":
				return { cwd: state.pendingCwd ?? undefined, optedOut: state.pendingCwd === null }

			case "open-task": {
				// Parity with the built-in control this replaced: creating a worktree from
				// the chat input puts you IN it. `openTask` with no text lands idle, so the
				// user types the first message — the plugin made a place, not a prompt.
				const { cwd: target, name } = params as { cwd: string; name?: string }
				if (!ctx.task) throw new Error("task control unavailable")
				// The pick is consumed by the task being opened, not by the next one the
				// user starts somewhere else.
				state.pendingCwd = undefined
				return { taskId: await ctx.task.openTask({ cwd: target, name }) }
			}

			case "set-task-cwd": {
				// Re-point a task that exists but has not begun work — a workflow still
				// collecting its parameters. The host refuses once agents are running, and
				// that refusal surfaces in the picker rather than being swallowed here.
				const { cwd: target, taskId } = params as { cwd: string; taskId?: string }
				if (!ctx.task) throw new Error("task control unavailable")
				await ctx.task.setCwd(target, taskId)
				return { cwd: target }
			}

			case "resolve-task-cwd":
				return resolveTaskCwd(ctx)

			default:
				throw new Error(`${FEATURE_NAME}: unknown request method "${method}"`)
		}
	},
}
