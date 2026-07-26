/**
 * Checkpoints — per-task undo history, as a first-party Shofer plugin.
 *
 * Before the agent mutates a file, the workspace is snapshotted into a shadow git
 * repository that lives outside it ({@link ShadowGitRepo}). Every snapshot becomes a
 * row in the task's chat timeline, from which the user can diff or restore. The
 * user's own repository is never touched.
 *
 * This is the plugin-native port of the built-in checkpoints subsystem, built
 * entirely on the public plugin surface:
 *
 * | Built-in piece                                  | Plugin seam                                  |
 * | ----------------------------------------------- | -------------------------------------------- |
 * | pre-tool `checkpointSave` in presentAssistantMessage | `lifecycle.beforeToolCall` (once per `ctx.turn`) |
 * | per-user-message anchor in `Task.handleWebviewAskResponse` | `lifecycle.onUserMessage`           |
 * | `task.say("checkpoint_saved")` + ChatRow bubble  | `ctx.task.marker` + a `chat-message-addon` UI |
 * | `checkpointRestore` (files)                      | `handleRequest("restore")` / `onTimelineRewind` |
 * | `checkpointRestore` (chat rewind + reinit)       | `ctx.task.rewind`                            |
 * | `checkpointDiff` → `showMultiFileDiff`           | `handleRequest("diff")` + `ctx.host.editor`  |
 * | shadow-repo cleanup on task delete               | `lifecycle.onTaskDeleted`                    |
 * | `enableCheckpoints` / `checkpointTimeout` settings | the plugin toggle + manifest `config`      |
 *
 * Removing the feature is removing this directory; nothing in core knows it exists.
 */

import fs from "fs/promises"

import type { PluginContext, ShoferPlugin } from "@shofer/types"

import { CheckpointServiceRegistry } from "./service-registry.js"
import type {
	CheckpointDiffMode,
	CheckpointDiffRequest,
	CheckpointDiffResult,
	CheckpointRestoreRequest,
} from "./types.js"

const PLUGIN_NAME = "checkpoints"

/**
 * Tools whose execution can change files on disk. A snapshot must precede these —
 * afterwards there is nothing left to snapshot. Kept deliberately broad: a tool
 * wrongly included costs one cheap no-op commit, while one wrongly omitted costs the
 * user their undo point.
 */
export const FILE_MUTATING_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"insert_edit",
	"sed",
	"rename_symbol",
	"file",
	"create_directory",
	"generate_image",
	// A subtask edits files in the same workspace under its own task id, so the
	// parent's pre-spawn state is only recoverable if it is snapshotted here.
	"new_task",
])

/**
 * Process-lived state. The manager builds one `ctx` per plugin and reuses it across
 * hook calls, so a single registry keeps every hook on one view of the shadow repos.
 */
interface PluginState {
	ctx?: PluginContext
	registry?: CheckpointServiceRegistry
	/** taskId → the turn a snapshot was last taken in (one per turn, not per tool). */
	lastSnapshotTurn: Map<string, number>
}

const state: PluginState = { lastSnapshotTurn: new Map() }

function config(ctx: PluginContext) {
	const c = ctx.config ?? {}
	const initTimeoutSeconds =
		typeof c.initTimeoutSeconds === "number" && c.initTimeoutSeconds > 0 ? c.initTimeoutSeconds : 15
	const raw = typeof c.excludePatterns === "string" ? c.excludePatterns : ""
	return {
		initTimeoutMs: initTimeoutSeconds * 1000,
		extraExcludePatterns: raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	}
}

/** The registry, built on first use from the initialize-time context. */
function registry(): CheckpointServiceRegistry | undefined {
	const ctx = state.ctx
	if (!ctx) return undefined
	if (state.registry) return state.registry
	if (!ctx.storage) {
		ctx.host?.log.warn("no plugin storage available — checkpoints cannot be stored")
		return undefined
	}

	const { initTimeoutMs, extraExcludePatterns } = config(ctx)
	state.registry = new CheckpointServiceRegistry({
		storageDir: ctx.storage.dir,
		initTimeoutMs,
		extraExcludePatterns,
		log: (message) => ctx.host?.log.info(message),
		warn: (message) => {
			ctx.host?.log.warn(message)
			ctx.host?.notifier.warn(message)
		},
		onCheckpoint: (taskId, event) => {
			// The marker IS the checkpoint's identity: it is what the user clicks, what
			// diff ordering is derived from, and what a rewind anchors to.
			void ctx.task
				?.marker({
					kind: "checkpoint",
					text: event.toHash,
					taskId,
					data: { from: event.fromHash, to: event.toHash },
					restorable: true,
					suppress: event.suppressMessage,
				})
				.catch((error: unknown) => ctx.host?.log.warn(`failed to append checkpoint marker: ${String(error)}`))
		},
	})
	return state.registry
}

/** Workspace root for a task — the hook context's, falling back to the plugin's. */
function workspaceFor(ctx: PluginContext): string | undefined {
	return ctx.workspacePath ?? state.ctx?.workspacePath ?? ctx.cwd
}

/**
 * Snapshot the workspace for `taskId`.
 *
 * `force` records a commit even when nothing changed — a user message needs an
 * anchor of its own even if the previous turn touched no files, or "restore to
 * before this message" has nothing to point at.
 */
async function snapshot(
	ctx: PluginContext,
	taskId: string,
	options: { force?: boolean; suppress?: boolean } = {},
): Promise<void> {
	const reg = registry()
	if (!reg) return

	const workspaceDir = workspaceFor(ctx)
	if (!workspaceDir) return

	const repo = await reg.get({ taskId, workspaceDir, cwd: ctx.cwd })
	if (!repo) return

	try {
		await repo.saveCheckpoint(`Task: ${taskId}, Time: ${Date.now()}`, {
			allowEmpty: options.force ?? false,
			suppressMessage: options.suppress ?? false,
		})
	} catch (error) {
		// A failing snapshot means the shadow repo is no longer trustworthy for this
		// task; stop rather than silently producing an incomplete history.
		reg.disable(taskId, error instanceof Error ? error.message : String(error))
	}
}

/** This plugin's checkpoint markers on `taskId`, oldest first. */
async function markers(taskId?: string) {
	const list = (await state.ctx?.task?.listMarkers(taskId)) ?? []
	return list.filter((m) => m.kind === "checkpoint")
}

/**
 * Resolve which two commits a diff request compares, mirroring the four modes the
 * checkpoint row offers. Returns a notice code instead of a range when there is
 * nothing meaningful to show.
 */
export function resolveDiffRange(
	hashes: string[],
	commitHash: string,
	mode: CheckpointDiffMode,
): { from: string; to?: string; title: string } | { notice: "no-first" | "no-previous" } {
	if ((mode === "from-init" || mode === "full") && hashes.length < 1) {
		return { notice: "no-first" }
	}

	const index = hashes.indexOf(commitHash)

	switch (mode) {
		case "checkpoint":
			return {
				from: commitHash,
				to: index !== -1 && index < hashes.length - 1 ? hashes[index + 1] : undefined,
				title: "Changes from this checkpoint to the next",
			}
		case "from-init":
			return { from: hashes[0]!, to: commitHash, title: "Changes since the first checkpoint" }
		case "to-current":
			return { from: commitHash, to: undefined, title: "Changes from this checkpoint to now" }
		case "full":
			return { from: hashes[0]!, to: undefined, title: "Changes since the first checkpoint" }
		default:
			return { notice: "no-previous" }
	}
}

async function computeDiff(ctx: PluginContext, request: CheckpointDiffRequest): Promise<CheckpointDiffResult> {
	const taskId = ctx.taskId
	const reg = registry()
	const workspaceDir = workspaceFor(ctx)
	if (!taskId || !reg || !workspaceDir) return { notice: "no-changes" }

	const repo = await reg.get({ taskId, workspaceDir, cwd: ctx.cwd })
	if (!repo) return { notice: "no-changes" }

	const hashes = (await markers(taskId)).map((m) => m.text)
	const range = resolveDiffRange(hashes, request.commitHash, request.mode)
	if ("notice" in range) return { notice: range.notice }

	const changes = await repo.getDiff({ from: range.from, to: range.to })
	if (!changes.length) return { notice: "no-changes" }
	return { title: range.title, changes }
}

/**
 * Restore the workspace to `commitHash`, and — in `restore` mode — rewind the
 * conversation to the marker that named it, so the chat and the files agree.
 */
async function restore(ctx: PluginContext, request: CheckpointRestoreRequest): Promise<{ rewound: boolean }> {
	const taskId = ctx.taskId
	const reg = registry()
	const workspaceDir = workspaceFor(ctx)
	if (!taskId || !reg || !workspaceDir) {
		throw new Error("checkpoints: no task/workspace to restore")
	}

	const repo = await reg.get({ taskId, workspaceDir, cwd: ctx.cwd })
	if (!repo) {
		throw new Error("checkpoints: no checkpoint history for this task")
	}

	await repo.restoreCheckpoint(request.commitHash)

	if (request.mode !== "restore") {
		// Files only: the conversation still describes work that is no longer on disk,
		// which is exactly what "preview" means here.
		return { rewound: false }
	}

	await state.ctx?.task?.rewind(request.ts, { includeTargetMessage: false })
	return { rewound: true }
}

const plugin: ShoferPlugin = {
	name: PLUGIN_NAME,

	initialize(ctx: PluginContext): void {
		state.ctx = ctx
		// Drop everything derived from the previous context. `initialize` runs again
		// when the user edits this plugin's config, and a registry still holding the
		// old timeout/excludes would keep applying settings the user just changed.
		state.registry = undefined
		state.lastSnapshotTurn.clear()
		ctx.host?.log.info("checkpoints plugin initialized")
	},

	lifecycle: {
		/**
		 * Snapshot BEFORE a file-mutating tool runs — the hook is awaited, which is the
		 * whole point: once the tool has written, the pre-mutation state is gone. The
		 * per-turn guard keeps a turn that issues ten edits to one checkpoint, matching
		 * what the user thinks of as "a step".
		 */
		async beforeToolCall(toolName: string, _args: Record<string, unknown>, ctx: PluginContext) {
			const taskId = ctx.taskId
			if (!taskId || !FILE_MUTATING_TOOLS.has(toolName)) return { allow: true }

			const turn = ctx.turn ?? 0
			if (state.lastSnapshotTurn.get(taskId) === turn) return { allow: true }
			state.lastSnapshotTurn.set(taskId, turn)

			// `force`: a turn that ends up changing nothing still gets an anchor, so the
			// user can restore to "before the agent started this step".
			await snapshot(ctx, taskId, { force: true })
			return { allow: true }
		},

		/**
		 * Anchor every user message, suppressed from the timeline: the row would be
		 * noise, but "undo back to what I asked for" needs a point to undo to.
		 */
		async onUserMessage(info: { taskId: string }, ctx: PluginContext) {
			await snapshot(ctx, info.taskId, { force: true, suppress: true })
		},

		/** Warm the shadow repo so the first edit of a task isn't the one that waits for `git init`. */
		async beforeTaskStart(ctx: PluginContext) {
			const taskId = ctx.taskId
			const workspaceDir = workspaceFor(ctx)
			if (!taskId || !workspaceDir) return
			void registry()?.get({ taskId, workspaceDir, cwd: ctx.cwd })
		},

		/**
		 * The user deleted/edited a message and asked for the workspace to come back
		 * with it. Restore to the first checkpoint at or after that point — the state
		 * as it was before the discarded work — while its marker still exists.
		 */
		async onTimelineRewind(
			info: { ts: number; taskId: string; operation: string; restoreState: boolean },
			ctx: PluginContext,
		) {
			if (!info.restoreState) return

			const target = (await markers(info.taskId)).find((m) => m.ts > info.ts)
			if (!target) {
				ctx.host?.log.info(`[onTimelineRewind] no checkpoint after ts ${info.ts} — nothing to restore`)
				return
			}

			const reg = registry()
			const workspaceDir = workspaceFor(ctx)
			if (!reg || !workspaceDir) return
			const repo = await reg.get({ taskId: info.taskId, workspaceDir, cwd: ctx.cwd })
			await repo?.restoreCheckpoint(target.text)
		},

		/** The task is gone; its shadow repository would otherwise sit in storage forever. */
		async onTaskDeleted(info: { taskId: string }, ctx: PluginContext) {
			const reg = registry()
			if (!reg) return
			try {
				await fs.rm(reg.repoDir(info.taskId), { recursive: true, force: true })
			} catch (error) {
				ctx.host?.log.warn(`failed to remove shadow repo for ${info.taskId}: ${String(error)}`)
			}
			reg.forget(info.taskId)
		},
	},

	/**
	 * Request/response surface for this plugin's own UI (and, for a task running on a
	 * remote executor, for the controller reaching that executor).
	 *
	 * `diff` and `restore` are answered where the task's shadow repo lives, so they
	 * are routed to the owning host. `local:show-diff` is answered on the host with
	 * the user's editor — the executor has no viewer to open.
	 */
	async handleRequest(method: string, params: unknown, ctx: PluginContext): Promise<unknown> {
		switch (method) {
			case "diff":
				return computeDiff(ctx, params as CheckpointDiffRequest)

			case "restore":
				return restore(ctx, params as CheckpointRestoreRequest)

			case "list":
				return markers(ctx.taskId)

			case "local:show-diff": {
				const { title, changes } = params as { title: string; changes: [] }
				await ctx.host?.editor?.showMultiFileDiff(title, changes)
				return { shown: true }
			}

			default:
				throw new Error(`checkpoints: unknown request method "${method}"`)
		}
	},
}

export default plugin
