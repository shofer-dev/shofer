/**
 * RenameSymbolTool - Renames a symbol and all its references across the codebase.
 *
 * Uses VS Code's LSP rename provider (`vscode.executeDocumentRenameProvider`) to
 * produce a WorkspaceEdit covering all references, then applies it atomically.
 * Ported from workspace-tools `workspace_renameSymbol`.
 */

import * as path from "path"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { validateWorktreePath } from "../../utils/worktreePathGuard"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { fsLog } from "../../utils/logging/subsystems"

interface RenameSymbolParams {
	path: string
	filePath?: string
	line: number
	column: number
	newName: string
}

export class RenameSymbolTool extends BaseTool<"rename_symbol"> {
	readonly name = "rename_symbol" as const

	async execute(params: RenameSymbolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const filePath = params.path ?? params.filePath ?? ""
		const { line, column, newName } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!filePath) {
				task.consecutiveMistakeCount++
				task.recordToolError("rename_symbol")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("rename_symbol", "path"))
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

			const worktreeErr = validateWorktreePath(task, filePath)
			if (worktreeErr) {
				task.consecutiveMistakeCount++
				task.recordToolError("rename_symbol")
				task.didToolFailInCurrentTurn = true
				pushToolResult(worktreeErr)
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
			const affectedRelPaths: string[] = []
			const affectedDisplayPaths = new Set<string>()
			for (const [fileUri, edits] of workspaceEdit.entries()) {
				editCount += edits.length
				const relPath = path.relative(task.cwd, fileUri.fsPath).split(path.sep).join("/")
				affectedRelPaths.push(relPath)
				affectedDisplayPaths.add(getReadablePath(task.cwd, fileUri.fsPath))
			}

			if (editCount === 0) {
				pushToolResult("No changes to apply")
				return
			}

			// For worktree-scoped tasks, validate that the rename does not
			// modify files outside the worktree boundary before applying edits.
			for (const relPath of affectedRelPaths) {
				const worktreeErr = validateWorktreePath(task, relPath)
				if (worktreeErr) {
					task.consecutiveMistakeCount++
					task.recordToolError("rename_symbol")
					task.didToolFailInCurrentTurn = true
					pushToolResult(worktreeErr)
					return
				}
			}

			// Capture originals before mutation so the file-changes panel
			// can show diffs and support revert/accept.
			for (const relPath of affectedRelPaths) {
				try {
					let original: string | undefined
					try {
						original = await fs.readFile(path.resolve(task.cwd, relPath), "utf8")
					} catch {
						// File may be new or unreadable; absent is fine.
					}
					await task.fileContextTracker?.captureOriginal(relPath, original)
				} catch (err) {
					fsLog.warn(`[RenameSymbolTool] captureOriginal failed for ${relPath}:`, err)
				}
			}

			const success = await vscode.workspace.applyEdit(workspaceEdit)
			if (!success) {
				throw new Error("Failed to apply rename edit")
			}

			// Track each affected file so the file-changes panel picks them up.
			for (const relPath of affectedRelPaths) {
				try {
					await task.fileContextTracker?.trackFileContext(relPath, "shofer_edited")
					task.didEditFile = true
				} catch (err) {
					fsLog.warn(`[RenameSymbolTool] trackFileContext failed for ${relPath}:`, err)
				}
			}

			pushToolResult(
				`Renamed symbol to "${newName}"\n` +
					`Changed ${editCount} occurrence(s) in ${affectedDisplayPaths.size} file(s):\n` +
					Array.from(affectedDisplayPaths)
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
