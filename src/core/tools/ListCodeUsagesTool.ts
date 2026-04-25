/**
 * ListCodeUsagesTool - Finds all references to the symbol at the given file position.
 *
 * Uses VS Code's LSP reference provider (`vscode.executeReferenceProvider`) to locate
 * all usages of a symbol in the codebase. Ported from workspace-tools `workspace_listCodeUsages`.
 */

import * as vscode from "vscode"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ListCodeUsagesParams {
	filePath: string
	line: number
	column: number
}

interface CodeUsage {
	filePath: string
	line: number
	column: number
	preview: string
}

const MAX_USAGES = 50

export class ListCodeUsagesTool extends BaseTool<"list_code_usages"> {
	readonly name = "list_code_usages" as const

	async execute(params: ListCodeUsagesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { filePath, line, column } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!filePath) {
				task.consecutiveMistakeCount++
				task.recordToolError("list_code_usages")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("list_code_usages", "filePath"))
				return
			}
			if (line == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("list_code_usages")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("list_code_usages", "line"))
				return
			}
			if (column == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("list_code_usages")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("list_code_usages", "column"))
				return
			}

			task.consecutiveMistakeCount = 0

			const didApprove = await this.askToolApproval(callbacks, {
				tool: "listCodeUsages",
				path: filePath,
				content: `Listing code usages at ${filePath}:${line}:${column}`,
			})
			if (!didApprove) {
				return
			}

			const absolutePath = require("path").resolve(task.cwd, filePath)
			const uri = vscode.Uri.file(absolutePath)

			// Open the document first — LSP needs it open to provide references
			const doc = await vscode.workspace.openTextDocument(uri)
			await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true })
			// Give the language server a moment to analyze the document
			await new Promise<void>((resolve) => setTimeout(resolve, 500))

			// Convert 1-indexed to 0-indexed
			const position = new vscode.Position(line - 1, column - 1)

			const locations = await vscode.commands.executeCommand<vscode.Location[]>(
				"vscode.executeReferenceProvider",
				uri,
				position,
			)

			if (!locations || locations.length === 0) {
				pushToolResult(
					`No references found at ${getReadablePath(task.cwd, filePath)}:${line}:${column}. ` +
						`Ensure the language server is active and the position is on a symbol.`,
				)
				return
			}

			const usages: CodeUsage[] = []
			for (const location of locations.slice(0, MAX_USAGES)) {
				let preview = ""
				try {
					const locDoc = await vscode.workspace.openTextDocument(location.uri)
					preview = locDoc.lineAt(location.range.start.line).text.trim().slice(0, 150)
				} catch {
					preview = "(unable to read)"
				}
				usages.push({
					filePath: location.uri.fsPath,
					line: location.range.start.line + 1,
					column: location.range.start.character + 1,
					preview,
				})
			}

			const formatted = usages.map(
				(u) => `${getReadablePath(task.cwd, u.filePath)}:${u.line}:${u.column}: ${u.preview}`,
			)

			let output = `Found ${locations.length} reference(s):\n\n${formatted.join("\n")}`
			if (locations.length > MAX_USAGES) {
				output += `\n\n... (showing first ${MAX_USAGES} of ${locations.length})`
			}

			pushToolResult(output)
		} catch (error) {
			await handleError("listing code usages", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const listCodeUsagesTool = new ListCodeUsagesTool()
