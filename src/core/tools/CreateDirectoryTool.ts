/**
 * CreateDirectoryTool - Creates a new directory at the specified path.
 *
 * Creates the directory including any necessary parent directories (mkdir -p behavior).
 */

import * as path from "path"
import * as fs from "fs/promises"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CreateDirectoryParams {
	path: string
}

export class CreateDirectoryTool extends BaseTool<"create_directory"> {
	readonly name = "create_directory" as const

	async execute(params: CreateDirectoryParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { path: relDirPath } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!relDirPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("create_directory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("create_directory", "path"))
				return
			}

			task.consecutiveMistakeCount = 0

			const absolutePath = path.resolve(task.cwd, relDirPath)
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			const sharedMessageProps: ShoferSayTool = {
				tool: "createDirectory",
				path: getReadablePath(task.cwd, relDirPath),
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Creating directory: ${relDirPath}`,
			} satisfies ShoferSayTool)

			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			// Create the directory (recursively creates parents)
			await fs.mkdir(absolutePath, { recursive: true })

			pushToolResult(`Created directory: ${relDirPath}`)
		} catch (error) {
			await handleError("creating directory", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"create_directory">): Promise<void> {
		const relDirPath: string | undefined = block.params.path

		if (!this.hasPathStabilized(relDirPath)) {
			return
		}

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ShoferSayTool = {
			tool: "createDirectory",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ShoferSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const createDirectoryTool = new CreateDirectoryTool()
