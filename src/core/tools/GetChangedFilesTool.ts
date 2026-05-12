/**
 * GetChangedFilesTool — reports the files Shofer has edited in the current Task.
 *
 * Backed by the working-directory `ChangedFilesService`. The tool surfaces
 * only files Shofer touched in this Task, with their current net state against
 * the per-task base copy. Files reverted back to base state are intentionally
 * omitted.
 */

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { getChangedFiles } from "../file-changes/ChangedFilesService"

import { BaseTool, ToolCallbacks } from "./BaseTool"

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GetChangedFilesParams {}

export class GetChangedFilesTool extends BaseTool<"get_changed_files"> {
	readonly name = "get_changed_files" as const

	async execute(_params: GetChangedFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			task.consecutiveMistakeCount = 0

			const didApprove = await this.askToolApproval(callbacks, {
				tool: "getChangedFiles",
				content: "Getting changed files",
			})
			if (!didApprove) {
				return
			}

			const payload = await getChangedFiles(task)

			if (payload.entries.length === 0) {
				pushToolResult("No files have been changed by Shofer in the current task.")
				return
			}

			let totalIns = 0
			let totalDel = 0
			const lines = payload.entries
				.slice()
				.sort((a, b) => a.path.localeCompare(b.path))
				.map((e) => {
					const display = getReadablePath(task.cwd, e.path)
					if (e.binary) return `  ${display}  (binary)`
					totalIns += e.insertions
					totalDel += e.deletions
					return `  ${display}  +${e.insertions}  -${e.deletions}`
				})

			pushToolResult(
				`Files Shofer edited in this task: ${payload.entries.length} (+${totalIns} -${totalDel})\n${lines.join("\n")}`,
			)
		} catch (error) {
			await handleError("getting changed files", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const getChangedFilesTool = new GetChangedFilesTool()
