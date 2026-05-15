/**
 * InsertEditTool — Inserts text at a specific (1-based) line/column position in a workspace file.
 *
 * Reads the file, computes the post-insert content, and routes the write through
 * DiffViewProvider so the user gets the same approval flow, expandable unified-diff
 * preview in the chat row, FileChangesPanel tracking (captureOriginal + captureFinal
 * via DiffViewProvider's internal hooks), preventFocusDisruption support, and
 * write-protection handling that the other edit tools (write_to_file, sed, apply_diff)
 * provide.
 */

import * as path from "path"
import * as fs from "fs/promises"
import { type ShoferSayTool, DEFAULT_WRITE_DELAY_MS } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { fileExistsAtPath } from "../../utils/fs"
import { formatResponse } from "../prompts/responses"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

interface InsertEditParams {
	filePath: string
	line: number
	column?: number | null
	text: string
}

export class InsertEditTool extends BaseTool<"insert_edit"> {
	readonly name = "insert_edit" as const

	async execute(params: InsertEditParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { filePath, line, column, text } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!filePath) {
				task.consecutiveMistakeCount++
				task.recordToolError("insert_edit")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("insert_edit", "filePath"))
				return
			}
			if (line == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("insert_edit")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("insert_edit", "line"))
				return
			}
			if (text == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("insert_edit")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("insert_edit", "text"))
				return
			}

			// Column is optional; default to 1 (start of line) when not provided.
			const resolvedColumn = column ?? 1

			const accessAllowed = task.shoferIgnoreController?.validateAccess(filePath)
			if (!accessAllowed) {
				await task.say("shoferignore_error", filePath)
				pushToolResult(formatResponse.shoferIgnoreError(filePath))
				return
			}

			const absolutePath = path.resolve(task.cwd, filePath)
			const fileExists = await fileExistsAtPath(absolutePath)
			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("insert_edit")
				const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Use write_to_file to create new files; insert_edit only modifies existing ones.\n</error_details>`
				await task.say("error", formattedError)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formattedError)
				return
			}

			task.consecutiveMistakeCount = 0

			// Decode HTML entities that may have leaked into the text parameter
			// (e.g. &gt; → >, &lt; → <, &amp; → &). Safety net for older XML
			// protocol payloads; native JSON tool calls should never produce them.
			// &amp; must be decoded first so other entities aren't broken by partial decode.
			const safeText = text
				.replace(/&amp;/g, "&")
				.replace(/&gt;/g, ">")
				.replace(/&lt;/g, "<")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")

			const originalContent = await fs.readFile(absolutePath, "utf-8")
			const newContent = insertAtPosition(originalContent, line, resolvedColumn, safeText)

			if (newContent === originalContent) {
				pushToolResult(`No insertion performed (empty text) at ${filePath}:${line}:${resolvedColumn}`)
				return
			}

			const unifiedPatch = sanitizeUnifiedDiff(
				formatResponse.createPrettyPatch(filePath, originalContent, newContent),
			)
			const diffStats = computeDiffStats(unifiedPatch) || undefined

			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)
			const isWriteProtected = task.shoferProtectedController?.isWriteProtected(filePath) || false

			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
			const sharedMessageProps: ShoferSayTool = {
				tool: "editedExistingFile",
				path: getReadablePath(task.cwd, filePath),
				isOutsideWorkspace,
			}

			if (isPreventFocusDisruptionEnabled) {
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unifiedPatch,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ShoferSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)
				if (!didApprove) {
					return
				}

				task.diffViewProvider.editType = "modify"
				task.diffViewProvider.originalContent = originalContent
				await task.diffViewProvider.saveDirectly(filePath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				task.diffViewProvider.editType = "modify"
				await task.diffViewProvider.open(filePath)
				await task.diffViewProvider.update(newContent, true)
				task.diffViewProvider.scrollToFirstDiff()

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unifiedPatch,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ShoferSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)
				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					task.processQueuedMessages()
					return
				}

				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			await task.fileContextTracker.trackFileContext(filePath, "shofer_edited" as RecordSource)
			task.didEditFile = true

			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
			pushToolResult(`Inserted text at ${filePath}:${line}:${resolvedColumn}\n${message}`)

			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
		} catch (error) {
			await handleError("inserting edit", error instanceof Error ? error : new Error(String(error)))
			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"insert_edit">): Promise<void> {
		const filePath: string | undefined = block.params.file_path

		if (!this.hasPathStabilized(filePath)) {
			return
		}

		const absolutePath = filePath ? path.resolve(task.cwd, filePath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ShoferSayTool = {
			tool: "editedExistingFile",
			path: getReadablePath(task.cwd, filePath ?? ""),
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ShoferSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

/**
 * Insert `text` at the given 1-based line and column in `source`.
 *
 * Lines beyond the file's end are clamped to a trailing insertion point; columns
 * beyond a line's length are clamped to that line's end. This matches the
 * behaviour of VS Code's WorkspaceEdit.insert when given out-of-range positions.
 */
function insertAtPosition(source: string, line: number, column: number, text: string): string {
	const lines = source.split("\n")
	const lineIdx = Math.max(0, Math.min(line - 1, lines.length - 1))
	const target = lines[lineIdx] ?? ""
	const colIdx = Math.max(0, Math.min(column - 1, target.length))
	lines[lineIdx] = target.slice(0, colIdx) + text + target.slice(colIdx)
	return lines.join("\n")
}

export const insertEditTool = new InsertEditTool()
