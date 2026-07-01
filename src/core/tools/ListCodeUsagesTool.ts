/**
 * ListCodeUsagesTool - Finds all references to the symbol at the given file position.
 *
 * Uses VS Code's LSP reference provider (`vscode.executeReferenceProvider`) to locate
 * all usages of a symbol in the codebase. Ported from workspace-tools `workspace_listCodeUsages`.
 */

import * as path from "path"

import { Task } from "../task/Task"
import { getReadablePath } from "@shofer/core"
import { getHost } from "@shofer/types"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ListCodeUsagesParams {
	path: string
	filePath?: string
	line: number
	column: number
}

const MAX_USAGES = 50

export class ListCodeUsagesTool extends BaseTool<"list_code_usages"> {
	readonly name = "list_code_usages" as const

	async execute(params: ListCodeUsagesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const filePath = params.path ?? params.filePath ?? ""
		const { line, column } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!filePath) {
				task.consecutiveMistakeCount++
				task.recordToolError("list_code_usages")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("list_code_usages", "path"))
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

			const absolutePath = path.resolve(task.cwd, filePath)
			const { total, references } = await getHost().lsp.findReferences(absolutePath, line, column, MAX_USAGES)

			if (total === 0) {
				pushToolResult(
					`No references found at ${getReadablePath(task.cwd, filePath)}:${line}:${column}. ` +
						`Ensure the language server is active and the position is on a symbol.`,
				)
				return
			}

			const formatted = references.map(
				(u) => `${getReadablePath(task.cwd, u.filePath)}:${u.line}:${u.column}: ${u.preview}`,
			)

			let output = `Found ${total} reference(s):\n\n${formatted.join("\n")}`
			if (total > MAX_USAGES) {
				output += `\n\n... (showing first ${MAX_USAGES} of ${total})`
			}

			pushToolResult(output)
		} catch (error) {
			await handleError("listing code usages", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const listCodeUsagesTool = new ListCodeUsagesTool()
