/**
 * GetChangedFilesTool - Reports the files changed during the current task.
 *
 * Mirrors VS Code Copilot's `copilot_getChangedFiles`, but exposes BOTH
 * available signals separately (rather than merging them) so the model can
 * reason about conflicts between cumulative state and recent activity:
 *
 *  1. **Cumulative diff** (shadow-git checkpoint) — every file that differs
 *     from the task's base commit, with line insertions/deletions and binary
 *     detection. This represents the full picture of what has changed since
 *     the task began, regardless of which actor made the change.
 *  2. **This session's edits** (FileContextTracker) — files Roo itself edited
 *     during the current run. Useful for distinguishing Roo-driven changes
 *     from pre-existing diffs / external edits, and works even when the
 *     checkpoint service is unavailable.
 *
 * Both sources are always reported when available; their intersection and
 * symmetric difference are visible to the caller.
 */

import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { getCheckpointService } from "../checkpoints"

import { BaseTool, ToolCallbacks } from "./BaseTool"

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GetChangedFilesParams {}

interface CheckpointEntry {
	path: string
	insertions: number
	deletions: number
	binary: boolean
}

export class GetChangedFilesTool extends BaseTool<"get_changed_files"> {
	readonly name = "get_changed_files" as const

	async execute(_params: GetChangedFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			task.consecutiveMistakeCount = 0

			const sharedMessageProps: ClineSayTool = {
				tool: "getChangedFiles",
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: "Getting changed files",
			} satisfies ClineSayTool)

			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			// Source 1: shadow-git checkpoint diff (cumulative since task start).
			let checkpointEntries: CheckpointEntry[] = []
			let checkpointError: string | undefined
			let checkpointAvailable = false
			try {
				const service = await getCheckpointService(task)
				if (service?.isInitialized && service.baseHash) {
					checkpointAvailable = true
					const stats = await service.getDiffStat({ from: service.baseHash })
					checkpointEntries = stats.map((s) => ({
						path: s.relative,
						insertions: s.insertions,
						deletions: s.deletions,
						binary: s.binary,
					}))
				}
			} catch (err) {
				checkpointError = err instanceof Error ? err.message : String(err)
			}

			// Source 2: FileContextTracker — files Roo edited in this session.
			const sessionEdits = (await task.fileContextTracker.getFilesEditedByRoo()).slice().sort()

			if (checkpointEntries.length === 0 && sessionEdits.length === 0 && !checkpointError) {
				pushToolResult("No files have been changed by Roo in the current task.")
				return
			}

			const sections: string[] = []

			// --- Section 1: cumulative checkpoint diff -----------------------
			if (checkpointError) {
				sections.push(`Cumulative changes since task start: unavailable (${checkpointError})`)
			} else if (!checkpointAvailable) {
				sections.push("Cumulative changes since task start: unavailable (checkpoints not initialized)")
			} else if (checkpointEntries.length === 0) {
				sections.push("Cumulative changes since task start: none")
			} else {
				const sorted = checkpointEntries.slice().sort((a, b) => a.path.localeCompare(b.path))
				let totalIns = 0
				let totalDel = 0
				const lines = sorted.map((e) => {
					const display = getReadablePath(task.cwd, e.path)
					if (e.binary) return `  ${display}  (binary)`
					totalIns += e.insertions
					totalDel += e.deletions
					return `  ${display}  +${e.insertions}  -${e.deletions}`
				})
				sections.push(
					`Cumulative changes since task start: ${sorted.length} file(s) (+${totalIns} -${totalDel})\n${lines.join("\n")}`,
				)
			}

			// --- Section 2: files Roo edited in this session -----------------
			if (sessionEdits.length === 0) {
				sections.push("Files Roo edited in this session: none")
			} else {
				const checkpointPaths = new Set(checkpointEntries.map((e) => e.path))
				const lines = sessionEdits.map((p) => {
					const display = getReadablePath(task.cwd, p)
					// Annotate when the tracker knows about a file the checkpoint
					// diff does not (yet) reflect — useful for conflict detection.
					const inCheckpoint = checkpointPaths.has(p)
					const note = checkpointAvailable && !inCheckpoint ? "  (not in checkpoint diff)" : ""
					return `  ${display}${note}`
				})
				sections.push(`Files Roo edited in this session: ${sessionEdits.length}\n${lines.join("\n")}`)
			}

			pushToolResult(sections.join("\n\n"))
		} catch (error) {
			await handleError("getting changed files", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const getChangedFilesTool = new GetChangedFilesTool()
