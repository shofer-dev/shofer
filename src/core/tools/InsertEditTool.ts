/**
 * InsertEditTool - Inserts text at a specific position in a file.
 *
 * Applies a text insertion at the given line and column (1-indexed) using VS Code's
 * WorkspaceEdit API. Ported from workspace-tools `workspace_insertEdit`.
 */

import * as path from "path"
import * as vscode from "vscode"
import * as fs from "fs/promises"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

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
			// column is optional; default to 1 (start of line) when not provided.
			const resolvedColumn = column ?? 1
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

			const sharedMessageProps: ShoferSayTool = {
				tool: "editedExistingFile",
				path: getReadablePath(task.cwd, filePath),
				isOutsideWorkspace,
			}

			const preview = text.length > 100 ? text.slice(0, 100) + "..." : text
			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Inserting at ${filePath}:${line}:${resolvedColumn}\n${preview}`,
			} satisfies ShoferSayTool)

			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			// Capture original content before mutation for FileChangesPanel.
			try {
				let original: string | undefined
				try {
					original = await fs.readFile(absolutePath, "utf8")
				} catch {
					// File may not exist yet.
				}
				await task.fileContextTracker?.captureOriginal(filePath, original)
			} catch (err) {
				console.warn(`[InsertEditTool] captureOriginal failed for ${filePath}:`, err)
			}

			// Decode HTML entities that may have leaked into the text parameter
			// (e.g. > → >, < → <, & → &). This is a safety net; native
			// JSON tool calls should never produce encoded text, but earlier XML
			// protocol versions did pass encoded payloads.
			// & must be decoded first so that other entities (which begin with &)
			// aren't broken by a partial decode.
			const safeText = text
				.replace(/&amp;/g, "&")
				.replace(/&gt;/g, ">")
				.replace(/&lt;/g, "<")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")

			const uri = vscode.Uri.file(absolutePath)
			// Convert 1-indexed to 0-indexed
			const position = new vscode.Position(line - 1, resolvedColumn - 1)

			const edit = new vscode.WorkspaceEdit()
			edit.insert(uri, position, safeText)
			const success = await vscode.workspace.applyEdit(edit)

			if (!success) {
				throw new Error("Failed to apply edit")
			}

			// Track as a Shofer edit so it appears in the FileChangesPanel.
			await task.fileContextTracker?.trackFileContext(filePath, "roo_edited")
			task.didEditFile = true

			pushToolResult(`Inserted text at ${filePath}:${line}:${resolvedColumn}`)
		} catch (error) {
			await handleError("inserting edit", error instanceof Error ? error : new Error(String(error)))
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

export const insertEditTool = new InsertEditTool()
