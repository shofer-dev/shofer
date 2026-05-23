/**
 * FindFilesTool - Finds files by glob pattern.
 *
 * Similar to VS Code's workspace.findFiles, returns paths matching the glob pattern.
 */

import * as path from "path"
import * as vscode from "vscode"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface FindFilesParams {
	pattern: string
	maxResults?: number
}

const DEFAULT_MAX_RESULTS = 100

export class FindFilesTool extends BaseTool<"find_files"> {
	readonly name = "find_files" as const

	async execute(params: FindFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pattern, maxResults = DEFAULT_MAX_RESULTS } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!pattern) {
				task.consecutiveMistakeCount++
				task.recordToolError("find_files")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("find_files", "pattern"))
				return
			}

			task.consecutiveMistakeCount = 0

			const sharedMessageProps: ShoferSayTool = {
				tool: "findFiles",
				path: pattern,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Finding files matching: ${pattern}`,
			} satisfies ShoferSayTool)

			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			// Find files matching the glob pattern using VS Code's built-in API
			// Exclude node_modules, .git, bazel artifacts, and .shofer/worktrees (git clones that produce 4-5x noise)
			const uris = await vscode.workspace.findFiles(
				new vscode.RelativePattern(task.cwd, pattern),
				"{**/node_modules/**,**/.git/**,**/bazel-bin/**,**/bazel-out/**,**/bazel-testlogs/**,.shofer/worktrees/**}",
				maxResults + 1,
			)

			const limitedUris = uris.slice(0, maxResults)
			const didHitLimit = uris.length > maxResults
			const limitedFiles = limitedUris.map((uri) => path.relative(task.cwd, uri.fsPath))

			if (limitedFiles.length === 0) {
				pushToolResult(`No files found matching pattern: ${pattern}`)
				return
			}

			let result = limitedFiles.join("\n")
			if (didHitLimit) {
				result += `\n\n... limited to ${maxResults} results (${uris.length} total matches)`
			}

			pushToolResult(result)
		} catch (error) {
			await handleError("finding files", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"find_files">): Promise<void> {
		const pattern: string | undefined = block.params.pattern

		const sharedMessageProps: ShoferSayTool = {
			tool: "findFiles",
			path: pattern ?? "",
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ShoferSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const findFilesTool = new FindFilesTool()
