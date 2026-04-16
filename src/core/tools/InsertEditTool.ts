/**
 * InsertEditTool - Inserts text at a specific position in a file.
 *
 * Applies a text insertion at the given line and column (1-indexed) using VS Code's
 * WorkspaceEdit API. Ported from workspace-tools `workspace_insertEdit`.
 */

import * as path from "path"
import * as vscode from "vscode"

import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface InsertEditParams {
	filePath: string
	line: number
	column: number
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
			if (column == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("insert_edit")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("insert_edit", "column"))
				return
			}
			if (text == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("insert_edit")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("insert_edit", "text"))
				return
			}

			task.consecutiveMistakeCount = 0

			const absolutePath = path.resolve(task.cwd, filePath)
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			const sharedMessageProps: ClineSayTool = {
				tool: "editedExistingFile",
				path: getReadablePath(task.cwd, filePath),
				isOutsideWorkspace,
			}

			const preview = text.length > 100 ? text.slice(0, 100) + "..." : text
			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Inserting at ${filePath}:${line}:${column}\n${preview}`,
			} satisfies ClineSayTool)

			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			const uri = vscode.Uri.file(absolutePath)
			// Convert 1-indexed to 0-indexed
			const position = new vscode.Position(line - 1, column - 1)

			const edit = new vscode.WorkspaceEdit()
			edit.insert(uri, position, text)
			const success = await vscode.workspace.applyEdit(edit)

			if (!success) {
				throw new Error("Failed to apply edit")
			}

			pushToolResult(`Inserted text at ${filePath}:${line}:${column}`)
		} catch (error) {
			await handleError("inserting edit", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"insert_edit">): Promise<void> {
		const filePath: string | undefined = block.params.filePath

		if (!this.hasPathStabilized(filePath)) {
			return
		}

		const absolutePath = filePath ? path.resolve(task.cwd, filePath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "editedExistingFile",
			path: getReadablePath(task.cwd, filePath ?? ""),
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const insertEditTool = new InsertEditTool()
