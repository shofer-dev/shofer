/**
 * FileTool — performs filesystem mutations (`rm`, `mv`) on workspace files
 * and integrates them with Shofer's change-tracking pipeline.
 *
 * Background: when the model uses `execute_command` to invoke `rm` or `mv`,
 * the resulting file mutations bypass {@link DiffViewProvider} and
 * {@link FileContextTracker}, so they never appear in the FileChangesPanel
 * or in `get_changed_files`. This tool closes that gap: it captures the
 * pre-mutation original content via `FileContextTracker.captureOriginal`,
 * performs the mutation, then records each affected path as `shofer_edited`
 * so the panel and per-file Revert/Redo work as for content edits.
 *
 * Subcommands:
 *  - `rm`: delete a file (or directory tree when `recursive=true`).
 *  - `mv`: move/rename a file or directory. Both source and destination
 *    paths are captured so a Revert can resurrect the source and a Redo can
 *    re-apply the move. For directories, all contained files are
 *    individually tracked in the change-tracking system.
 *    Cross-workspace destinations are refused.
 */

import * as path from "path"
import * as fs from "fs/promises"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { fileExistsAtPath } from "../../utils/fs"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface FileToolParams {
	subcommand: "rm" | "mv"
	path: string
	destination?: string | null
	recursive?: boolean | null
}

async function readTextOrUndefined(absPath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(absPath, "utf8")
	} catch {
		return undefined
	}
}

export class FileTool extends BaseTool<"file"> {
	readonly name = "file" as const

	async execute(params: FileToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { subcommand, path: relPath, destination, recursive } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!subcommand || (subcommand !== "rm" && subcommand !== "mv")) {
				task.consecutiveMistakeCount++
				task.recordToolError("file")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("file", "subcommand"))
				return
			}
			if (!relPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("file")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("file", "path"))
				return
			}
			if (subcommand === "mv" && !destination) {
				task.consecutiveMistakeCount++
				task.recordToolError("file")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("file", "destination"))
				return
			}

			task.consecutiveMistakeCount = 0

			const absPath = path.resolve(task.cwd, relPath)
			if (isPathOutsideWorkspace(absPath)) {
				pushToolResult(`Error: path '${relPath}' is outside the workspace.`)
				return
			}

			let absDest: string | undefined
			if (subcommand === "mv") {
				absDest = path.resolve(task.cwd, destination as string)
				if (isPathOutsideWorkspace(absDest)) {
					pushToolResult(`Error: destination '${destination}' is outside the workspace.`)
					return
				}
			}

			const sayTool: ShoferSayTool = {
				tool: subcommand === "rm" ? "removeFile" : "moveFile",
				fileOp: subcommand,
				path: getReadablePath(task.cwd, relPath),
				destination: absDest ? getReadablePath(task.cwd, destination as string) : undefined,
				isOutsideWorkspace: false,
				content:
					subcommand === "rm"
						? `Deleting ${relPath}${recursive ? " (recursive)" : ""}`
						: `Moving ${relPath} → ${destination}`,
			}

			const didApprove = await this.askToolApproval(callbacks, sayTool)
			if (!didApprove) {
				return
			}

			const tracker = task.fileContextTracker
			const srcExists = await fileExistsAtPath(absPath)

			if (subcommand === "rm") {
				if (!srcExists) {
					pushToolResult(`Error: '${relPath}' does not exist.`)
					return
				}

				const srcStat = await fs.stat(absPath)
				if (srcStat.isDirectory() && !recursive) {
					pushToolResult(`Error: '${relPath}' is a directory; pass recursive=true to delete it.`)
					return
				}

				// For directories, capture originals + mark each contained file individually.
				const filesToTrack = srcStat.isDirectory() ? await collectFilesRecursive(absPath, task.cwd) : [relPath]

				for (const f of filesToTrack) {
					const fAbs = path.resolve(task.cwd, f)
					const original = await readTextOrUndefined(fAbs)
					await tracker.captureOriginal(f, original)
				}

				if (srcStat.isDirectory()) {
					await fs.rm(absPath, { recursive: true, force: true })
				} else {
					await fs.unlink(absPath)
				}

				for (const f of filesToTrack) {
					await tracker.trackFileContext(f, "shofer_edited")
				}

				pushToolResult(
					srcStat.isDirectory()
						? `Deleted directory '${relPath}' (${filesToTrack.length} file(s)).`
						: `Deleted '${relPath}'.`,
				)
				return
			}

			// subcommand === "mv"
			if (!srcExists) {
				pushToolResult(`Error: source '${relPath}' does not exist.`)
				return
			}
			if (await fileExistsAtPath(absDest!)) {
				pushToolResult(`Error: destination '${destination}' already exists.`)
				return
			}

			const srcStat = await fs.stat(absPath)
			const relDest = toWorkspaceRel(absDest!, task.cwd)

			if (srcStat.isDirectory()) {
				// Collect all files under the source directory.
				const srcFiles = await collectFilesRecursive(absPath, task.cwd)
				const relSrcPrefix = relPath + "/"

				// Capture originals for every contained file.
				for (const relSrc of srcFiles) {
					const fAbs = path.resolve(task.cwd, relSrc)
					const original = await readTextOrUndefined(fAbs)
					await tracker.captureOriginal(relSrc, original)
				}

				// Perform the directory rename.
				await fs.rename(absPath, absDest!)

				// Track each file at both its old and new paths.
				for (const relSrc of srcFiles) {
					const suffix = relSrc.startsWith(relSrcPrefix) ? relSrc.slice(relSrcPrefix.length) : relSrc
					const relDst = relDest + "/" + suffix

					await tracker.trackFileContext(relSrc, "shofer_edited")
					await tracker.trackFileContext(relDst, "shofer_edited")
				}

				pushToolResult(`Moved directory '${relPath}' → '${relDest}' (${srcFiles.length} file(s)).`)
				return
			}

			// File move (existing behavior).
			// Capture pre-mutation originals for both endpoints. Source originally
			// had content; destination originally absent (we already verified).
			const srcOriginal = await readTextOrUndefined(absPath)
			await tracker.captureOriginal(relPath, srcOriginal)
			await tracker.captureOriginal(relDest, undefined)

			// Ensure destination directory exists.
			await fs.mkdir(path.dirname(absDest!), { recursive: true })
			await fs.rename(absPath, absDest!)

			// Track both endpoints; this triggers debounced panel push and final-snapshot capture.
			await tracker.trackFileContext(relPath, "shofer_edited")
			await tracker.trackFileContext(relDest, "shofer_edited")

			pushToolResult(`Moved '${relPath}' → '${relDest}'.`)
		} catch (error) {
			await handleError(
				`running file ${params?.subcommand ?? ""}`,
				error instanceof Error ? error : new Error(String(error)),
			)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"file">): Promise<void> {
		const subcommand = block.params.subcommand
		const relPath = block.params.path
		if (!this.hasPathStabilized(relPath)) {
			return
		}
		const isRm = subcommand === "rm"
		const sharedMessageProps: ShoferSayTool = {
			tool: isRm ? "removeFile" : "moveFile",
			fileOp: (subcommand as "rm" | "mv") ?? undefined,
			path: getReadablePath(task.cwd, relPath ?? ""),
			destination: block.params.destination ? getReadablePath(task.cwd, block.params.destination) : undefined,
			content: "",
		}
		const partialMessage = JSON.stringify(sharedMessageProps satisfies ShoferSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

/** Collect all regular files under `absDir`, returning workspace-relative POSIX paths. */
async function collectFilesRecursive(absDir: string, cwd: string): Promise<string[]> {
	const out: string[] = []
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		for (const ent of entries) {
			const full = path.join(dir, ent.name)
			if (ent.isDirectory()) {
				await walk(full)
			} else if (ent.isFile()) {
				out.push(toWorkspaceRel(full, cwd))
			}
		}
	}
	await walk(absDir)
	return out
}

function toWorkspaceRel(absPath: string, cwd: string): string {
	return path.relative(cwd, absPath).split(path.sep).join("/")
}

export const fileTool = new FileTool()
