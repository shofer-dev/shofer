/**
 * GetChangedFilesTool - Reports the files Roo has changed during the current task,
 * along with the number of inserted and deleted lines per file.
 *
 * Mirrors VS Code Copilot's `copilot_getChangedFiles`. Two complementary sources
 * are combined to produce the result:
 *
 *  1. The shadow-git checkpoint service (`ShadowCheckpointService.getDiffStat`),
 *     when checkpoints are enabled. This is the authoritative source for
 *     line-level insertions/deletions because it diffs the task's base commit
 *     against the current working tree.
 *  2. The {@link FileContextTracker} (`getFilesEditedByRoo`), which records every
 *     file Roo edited during the task. Used as a fallback when checkpoints are
 *     disabled, and to surface files that the checkpoint diff doesn't yet
 *     include (e.g. immediately after an edit before staging).
 *
 * When the checkpoint diff is unavailable, line counts are reported as `null`
 * for files known only via the tracker.
 */

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { getCheckpointService } from "../checkpoints"

import { BaseTool, ToolCallbacks } from "./BaseTool"

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GetChangedFilesParams {}

interface ChangedFileEntry {
	path: string
	insertions: number | null
	deletions: number | null
	binary: boolean
	source: "checkpoint" | "tracker"
}

export class GetChangedFilesTool extends BaseTool<"get_changed_files"> {
	readonly name = "get_changed_files" as const

	async execute(_params: GetChangedFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			task.consecutiveMistakeCount = 0

			const byPath = new Map<string, ChangedFileEntry>()

			// Source 1: shadow-git checkpoint diff (authoritative for line counts).
			let checkpointError: string | undefined
			try {
				const service = await getCheckpointService(task)
				if (service?.isInitialized && service.baseHash) {
					const stats = await service.getDiffStat({ from: service.baseHash })
					for (const stat of stats) {
						byPath.set(stat.relative, {
							path: stat.relative,
							insertions: stat.insertions,
							deletions: stat.deletions,
							binary: stat.binary,
							source: "checkpoint",
						})
					}
				}
			} catch (err) {
				checkpointError = err instanceof Error ? err.message : String(err)
			}

			// Source 2: FileContextTracker — surfaces files Roo edited even if
			// checkpoints are disabled or the diff is empty.
			const trackedEdits = await task.fileContextTracker.getFilesEditedByRoo()
			for (const filePath of trackedEdits) {
				if (!byPath.has(filePath)) {
					byPath.set(filePath, {
						path: filePath,
						insertions: null,
						deletions: null,
						binary: false,
						source: "tracker",
					})
				}
			}

			if (byPath.size === 0) {
				pushToolResult("No files have been changed by Roo in the current task.")
				return
			}

			// Sort: checkpoint-known files first, then by path.
			const entries = Array.from(byPath.values()).sort((a, b) => {
				if (a.source !== b.source) {
					return a.source === "checkpoint" ? -1 : 1
				}
				return a.path.localeCompare(b.path)
			})

			let totalInsertions = 0
			let totalDeletions = 0
			const lines: string[] = []
			for (const entry of entries) {
				const display = getReadablePath(task.cwd, entry.path)
				if (entry.source === "checkpoint") {
					if (entry.binary) {
						lines.push(`  ${display}  (binary)`)
					} else {
						totalInsertions += entry.insertions ?? 0
						totalDeletions += entry.deletions ?? 0
						lines.push(`  ${display}  +${entry.insertions ?? 0}  -${entry.deletions ?? 0}`)
					}
				} else {
					// Tracker-only entry: line counts unknown.
					const reason = checkpointError ? "checkpoints unavailable" : "not yet in checkpoint"
					lines.push(`  ${display}  +?  -?  (${reason})`)
				}
			}

			const header =
				`Changed files in current task: ${entries.length}` + ` (+${totalInsertions} -${totalDeletions})`
			pushToolResult(`${header}\n${lines.join("\n")}`)
		} catch (error) {
			await handleError("getting changed files", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const getChangedFilesTool = new GetChangedFilesTool()
