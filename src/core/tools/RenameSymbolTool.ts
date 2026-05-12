/**
 * RenameSymbolTool - Renames a symbol and all its references across the codebase.
 *
 * Uses VS Code's LSP rename provider (`vscode.executeDocumentRenameProvider`) to
 * produce a WorkspaceEdit covering all references, then applies it atomically.
 * Ported from workspace-tools `workspace_renameSymbol`.
 */

import * as path from "path"
import * as vscode from "vscode"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface RenameSymbolParams {
	filePath: string
	line: number
	column: number
	newName: string
}

export class RenameSymbolTool extends BaseTool<"rename_symbol"> {
	readonly name = "rename_symbol" as const

	async execute(params: RenameSymbolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { filePath, line, column, newName } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!filePath) {
				task.consecutiveMistakeCount++
				task.recordToolError("rename_symbol")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("rename_symbol", "filePath"))
				return
			}
			if (line == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("rename_symbol")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("rename_symbol", "line"))
				return
			}
			if (column == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("rename_symbol")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("rename_symbol", "column"))
				return
			}
			if (!newName) {
				task.consecutiveMistakeCount++
				task.recordToolError("rename_symbol")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("rename_symbol", "newName"))
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

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Renaming symbol at ${filePath}:${line}:${column} to "${newName}"`,
			} satisfies ShoferSayTool)

			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			const uri = vscode.Uri.file(absolutePath)

			// Open the document first — LSP needs it open to provide rename provider
			const doc = await vscode.workspace.openTextDocument(uri)
			await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
			// Give the language server a moment to analyze the document
			await new Promise<void>((resolve) => setTimeout(resolve, 500))

			const position = new vscode.Position(line - 1, column - 1)

			const workspaceEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
				"vscode.executeDocumentRenameProvider",
				uri,
				position,
				newName,
			)

			if (!workspaceEdit) {
				throw new Error(
					`Cannot rename symbol at ${getReadablePath(task.cwd, filePath)}:${line}:${column}. ` +
						`No rename provider available or symbol not found. Ensure the language server is active.`,
				)
			}

			let editCount = 0
			const affectedFiles = new Set<string>()
			for (const [fileUri, edits] of workspaceEdit.entries()) {
				editCount += edits.length
				affectedFiles.add(getReadablePath(task.cwd, fileUri.fsPath))
			}

			if (editCount === 0) {
				pushToolResult("No changes to apply")
				return
			}

			const success = await vscode.workspace.applyEdit(workspaceEdit)
			if (!success) {
				throw new Error("Failed to apply rename edit")
			}

			pushToolResult(
				`Renamed symbol to "${newName}"\n` +
					`Changed ${editCount} occurrence(s) in ${affectedFiles.size} file(s):\n` +
					Array.from(affectedFiles)
						.map((f) => `  - ${f}`)
						.join("\n"),
			)
		} catch (error) {
			await handleError("renaming symbol", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"rename_symbol">): Promise<void> {
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

export const renameSymbolTool = new RenameSymbolTool()
