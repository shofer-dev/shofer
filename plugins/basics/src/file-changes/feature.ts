/**
 * File Changes — per-task tracking of the files the agent edited, as a feature of the
 * Basics plugin.
 *
 * The panel above the chat input answers one question: *what did this task do to my
 * workspace, and can I undo it?* It is backed by two verbatim copies per file that the
 * task owns ({@link FileSnapshotStore}), so the answer is this task's own effect —
 * unaffected by a parallel task editing the same file — and revert works with no git
 * repository, no shadow repo, and no checkpoint history.
 *
 * Everything runs on the public plugin surface:
 *
 * | Built-in piece                                   | Plugin seam                                |
 * | ------------------------------------------------ | ------------------------------------------ |
 * | `FileContextTracker.captureOriginal` (base copy)  | `lifecycle.beforeFileEdit`                 |
 * | `captureFinal` after each `shofer_edited`         | `lifecycle.afterFileEdit`                  |
 * | `ChangedFilesService`                             | `src/changed-files.ts`                     |
 * | `get_changed_files` native tool                   | `registerTools`                            |
 * | `changedFiles/*` webview IPC                      | `handleRequest` + the plugin UI channel    |
 * | `FileChangesPanel` (chat)                         | a `chat-footer` UI contribution            |
 * | click-to-diff (`shofer-original:` documents)      | `ctx.host.editor.showMultiFileDiff`        |
 * | per-task directory cleanup on task delete         | `lifecycle.onTaskDeleted`                  |
 *
 * Disabling the feature is flipping `file-changes: false` in the Basics config (or the
 * `basics:file-changes` governance entry): core keeps only the two generic file-edit
 * hooks, which say what happened and to which path, and nothing about panels,
 * baselines or reverts.
 */

import fs from "fs/promises"
import path from "path"

import { defineCustomTool, parametersSchema as z } from "@shofer/types"
import type { PluginContext, PluginFileEdit, PluginFileEditResult } from "@shofer/types"

import type { BasicsFeature } from "../feature.js"
import { FileSnapshotStore } from "./snapshot-store.js"
import {
	acceptAll,
	acceptFile,
	getChangedFiles,
	getFinalContent,
	getOriginalContent,
	restoreAll,
	restoreFile,
	toPosix,
} from "./changed-files.js"
import type { ChangedFilesPayload } from "./types.js"

const FEATURE_NAME = "file-changes"

/** How long to coalesce a burst of edits before refreshing the panel. */
const PUSH_DEBOUNCE_MS = 500

interface PluginState {
	ctx?: PluginContext
	/** taskId → its snapshot store. One per task; the task's cwd is fixed at creation. */
	stores: Map<string, FileSnapshotStore>
	pushTimer?: ReturnType<typeof setTimeout>
	pushPendingTaskId?: string
	/** Serializes panel pushes so a burst of accepts cannot deliver a stale list last. */
	pushChain: Promise<void>
}

const state: PluginState = { stores: new Map(), pushChain: Promise.resolve() }

/**
 * This feature's storage root — scoped below the plugin's: the Basics features share
 * ONE plugin storage dir, and checkpoints keeps per-task state under `tasks/` too.
 */
function storageDirFor(ctx: PluginContext): string | undefined {
	const base = state.ctx?.storage?.dir ?? ctx.storage?.dir
	return base ? path.join(base, "file-changes") : undefined
}

/** The store for a task, created on demand. `undefined` when the host wired no storage. */
function storeFor(ctx: PluginContext, taskId?: string, cwd?: string): FileSnapshotStore | undefined {
	const id = taskId ?? ctx.taskId
	const dir = storageDirFor(ctx)
	if (!id || !dir) return undefined

	const existing = state.stores.get(id)
	const workingDir = cwd ?? ctx.cwd
	if (existing) {
		// A workflow task can move to a worktree mid-flight; every read must follow it
		// or the store silently resolves paths against the wrong tree.
		if (workingDir) existing.reassignCwd(workingDir)
		return existing
	}
	if (!workingDir) return undefined

	const store = new FileSnapshotStore(dir, id, workingDir)
	state.stores.set(id, store)
	return store
}

function cwdFor(ctx: PluginContext): string | undefined {
	return ctx.cwd ?? state.ctx?.cwd ?? ctx.workspacePath ?? state.ctx?.workspacePath
}

async function payloadFor(ctx: PluginContext, taskId?: string): Promise<ChangedFilesPayload> {
	const id = taskId ?? ctx.taskId
	const store = storeFor(ctx, id)
	const cwd = cwdFor(ctx)
	if (!store || !cwd) return { taskId: id ?? "", entries: [] }
	return getChangedFiles(store, cwd)
}

/** Push the current list to the panel, serialized so the last push always wins. */
function pushUpdate(ctx: PluginContext, taskId?: string): void {
	const id = taskId ?? ctx.taskId
	if (!id || !ctx.ui) return
	state.pushChain = state.pushChain
		.then(async () => {
			const payload = await payloadFor(ctx, id)
			ctx.ui?.postMessage({ type: "changedFiles", payload })
		})
		.catch((error: unknown) => {
			ctx.host?.log.warn(`[${FEATURE_NAME}] failed to push the change list: ${String(error)}`)
		})
}

/** Coalesce a burst of edits (a tool rewriting ten files) into one panel refresh. */
function schedulePush(ctx: PluginContext, taskId?: string): void {
	state.pushPendingTaskId = taskId ?? ctx.taskId
	if (state.pushTimer) clearTimeout(state.pushTimer)
	state.pushTimer = setTimeout(() => {
		state.pushTimer = undefined
		const id = state.pushPendingTaskId
		if (id) pushUpdate(state.ctx ?? ctx, id)
	}, PUSH_DEBOUNCE_MS)
}

/**
 * Refuse to touch the workspace while the task is still producing output — the agent
 * would be writing the file the user is reverting. Read-only requests are unaffected.
 */
function assertNotStreaming(ctx: PluginContext): void {
	if (ctx.taskStreaming) {
		throw new Error("Pause or cancel the task before reverting files it is still editing.")
	}
}

interface RevertRequest {
	path: string
	/** The user already confirmed discarding their own edits (asked for by the UI). */
	confirmed?: boolean
}

/**
 * Revert one file. When the file on disk no longer matches what the agent produced,
 * the user has edited it since — so ask before discarding their work.
 */
async function revert(ctx: PluginContext, request: RevertRequest): Promise<{ reverted: boolean }> {
	assertNotStreaming(ctx)
	const store = storeFor(ctx)
	const cwd = cwdFor(ctx)
	if (!store || !cwd) throw new Error("No task workspace to revert in.")

	const relPath = toPosix(request.path)
	if (!request.confirmed && (await hasUserEdits(store, cwd, relPath))) {
		const proceed = "Revert anyway"
		const choice = await ctx.host?.notifier.showChoice(
			`${relPath} has been modified since Shofer last wrote it. Reverting discards those changes.`,
			[proceed],
			{ severity: "warn", modal: true },
		)
		if (choice !== proceed) return { reverted: false }
	}

	await restoreFile(store, cwd, relPath)
	pushUpdate(ctx)
	return { reverted: true }
}

/** Whether the live file diverges from the last state the agent produced. */
async function hasUserEdits(store: FileSnapshotStore, cwd: string, relPath: string): Promise<boolean> {
	const finalText = await getFinalContent(store, relPath)
	if (finalText === null) return false
	try {
		const current = await fs.readFile(path.resolve(cwd, relPath), "utf8")
		return current !== finalText
	} catch {
		// Gone from disk while a produced state exists — treat as a user change, so the
		// user is asked rather than surprised.
		return true
	}
}

async function revertEverything(ctx: PluginContext, confirmed?: boolean): Promise<{ reverted: boolean }> {
	assertNotStreaming(ctx)
	const store = storeFor(ctx)
	const cwd = cwdFor(ctx)
	if (!store || !cwd) throw new Error("No task workspace to revert in.")

	if (!confirmed) {
		const proceed = "Revert all"
		const choice = await ctx.host?.notifier.showChoice(
			"Revert every file Shofer changed in this task?",
			[proceed],
			{ severity: "warn", modal: true },
		)
		if (choice !== proceed) return { reverted: false }
	}

	await restoreAll(store, cwd, (relPath, error) =>
		ctx.host?.log.warn(`[${FEATURE_NAME}] revert failed for ${relPath}: ${String(error)}`),
	)
	pushUpdate(ctx)
	return { reverted: true }
}

/** Build the before/after pair the host's diff viewer renders. */
async function diffFor(ctx: PluginContext, relPath: string) {
	const store = storeFor(ctx)
	const cwd = cwdFor(ctx)
	if (!store || !cwd) return undefined

	const posix = toPosix(relPath)
	const before = (await getOriginalContent(store, posix)) ?? ""
	// The right-hand side is what THIS task last wrote, not the live file — the diff
	// then says the same thing the row's +/− counts do. Falls back to disk only when no
	// produced state was captured yet.
	const after = (await getFinalContent(store, posix)) ?? (await readLive(cwd, posix))
	return {
		title: `${path.basename(posix)} (Shofer changes)`,
		changes: [
			{
				paths: { relative: posix, absolute: path.resolve(cwd, posix) },
				content: { before, after },
			},
		],
	}
}

async function readLive(cwd: string, relPath: string): Promise<string> {
	try {
		return await fs.readFile(path.resolve(cwd, relPath), "utf8")
	} catch {
		return ""
	}
}

export const fileChangesFeature: BasicsFeature = {
	id: "file-changes",

	initialize(ctx: PluginContext): void {
		state.ctx = ctx
		// Stores hold a storage dir and a cwd resolved from the previous context; drop
		// them so a config/workspace change is picked up rather than cached.
		state.stores.clear()
		ctx.host?.log.info("file-changes feature initialized")
	},

	lifecycle: {
		/**
		 * The baseline. Awaited on purpose — after the tool writes, the content that
		 * makes revert possible no longer exists anywhere.
		 */
		async beforeFileEdit(edit: PluginFileEdit, ctx: PluginContext) {
			const store = storeFor(ctx)
			if (!store) return
			await store.captureOriginal(toPosix(edit.path), edit.before)
		},

		/** What the agent produced — the right-hand side of every diff, and Redo's source. */
		async afterFileEdit(edit: PluginFileEditResult, ctx: PluginContext) {
			const store = storeFor(ctx)
			if (!store) return
			await store.captureFinal(toPosix(edit.path))
			schedulePush(ctx)
		},

		/** The task is gone; its baselines would otherwise sit in storage forever. */
		async onTaskDeleted(info: { taskId: string }, ctx: PluginContext) {
			const dir = storageDirFor(ctx)
			state.stores.delete(info.taskId)
			if (!dir) return
			try {
				await fs.rm(path.join(dir, "tasks", info.taskId), { recursive: true, force: true })
			} catch (error) {
				ctx.host?.log.warn(`[${FEATURE_NAME}] failed to remove snapshots for ${info.taskId}: ${String(error)}`)
			}
		},
	},

	registerTools(ctx: PluginContext) {
		return [
			defineCustomTool({
				name: "get_changed_files",
				description:
					"List the files you have changed in this task, with per-file insertion and deletion counts. Reflects the net effect of your edits against the state each file was in before you first touched it — a file you edited and then restored is not listed.",
				parameters: z.object({}),
				async execute(): Promise<string> {
					const payload = await payloadFor(ctx)
					if (payload.entries.length === 0) {
						return "No files have been changed by Shofer in the current task."
					}
					let insertions = 0
					let deletions = 0
					const lines = payload.entries
						.slice()
						.sort((a, b) => a.path.localeCompare(b.path))
						.map((entry) => {
							if (entry.binary) return `  ${entry.path}  (binary)`
							insertions += entry.insertions
							deletions += entry.deletions
							return `  ${entry.path}  +${entry.insertions}  -${entry.deletions}`
						})
					return `Files Shofer edited in this task: ${payload.entries.length} (+${insertions} -${deletions})\n${lines.join("\n")}`
				},
			}),
		]
	},

	/** Core's completion-time broadcast; routed here by `main.ts` un-namespaced. */
	broadcasts: ["task-stats"],

	/**
	 * The panel's request surface; methods arrive bare (the UI sends `file-changes:get`
	 * etc. and `main.ts` strips the prefixes). Everything that reads or mutates this
	 * task's snapshots is answered on the host that owns the task (so a task running on
	 * a remote executor behaves identically); `show-diff` rides the `local:` routing
	 * prefix and is answered on the UI's host, because only it has the user's editor.
	 */
	async handleRequest(method: string, params: unknown, ctx: PluginContext): Promise<unknown> {
		switch (method) {
			case "get":
				return payloadFor(ctx)

			case "diff":
				return diffFor(ctx, (params as { path: string }).path)

			case "revert":
				return revert(ctx, params as RevertRequest)

			case "revert-all":
				return revertEverything(ctx, (params as { confirmed?: boolean } | undefined)?.confirmed)

			case "accept": {
				// Accept rewrites only this plugin's baseline — it never touches the
				// workspace — so it is safe while the task is running.
				const store = storeFor(ctx)
				const cwd = cwdFor(ctx)
				if (!store || !cwd) throw new Error("No task workspace to accept in.")
				await acceptFile(store, cwd, (params as { path: string }).path)
				pushUpdate(ctx)
				return { accepted: true }
			}

			case "accept-all": {
				const store = storeFor(ctx)
				const cwd = cwdFor(ctx)
				if (!store || !cwd) throw new Error("No task workspace to accept in.")
				await acceptAll(store, cwd, (relPath, error) =>
					ctx.host?.log.warn(`[${FEATURE_NAME}] accept failed for ${relPath}: ${String(error)}`),
				)
				pushUpdate(ctx)
				return { accepted: true }
			}

			case "task-stats": {
				// The broadcast question core asks every plugin when a task completes, for
				// the +/− badge on its history entry (`pluginRegistry.requestAll`).
				const payload = await payloadFor(ctx)
				return payload.entries.reduce(
					(totals, entry) => ({
						insertions: totals.insertions + entry.insertions,
						deletions: totals.deletions + entry.deletions,
					}),
					{ insertions: 0, deletions: 0 },
				)
			}

			case "show-diff": {
				const { title, changes } = params as { title: string; changes: [] }
				await ctx.host?.editor?.showMultiFileDiff(title, changes)
				return { shown: true }
			}

			default:
				throw new Error(`${FEATURE_NAME}: unknown request method "${method}"`)
		}
	},
}
