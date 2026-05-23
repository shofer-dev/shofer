/**
 * CreateNewWorkspaceTool - Creates a new workspace/project directory structure.
 *
 * Creates a new directory with optional subdirectories, then opens the workspace
 * in VS Code. Ported from workspace-tools `workspace_createNewWorkspace`.
 */

import * as path from "path"
import * as fs from "fs/promises"

import { type ShoferSayTool } from "@shofer/types"
import * as vscode from "vscode"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { validateWorktreePath } from "../../utils/worktreePathGuard"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CreateNewWorkspaceParams {
	path: string
	name: string
	folders?: string[] | null
	openInNewWindow?: boolean | null
}

export class CreateNewWorkspaceTool extends BaseTool<"create_new_workspace"> {
	readonly name = "create_new_workspace" as const

	async execute(params: CreateNewWorkspaceParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { path: wsPath, name, folders, openInNewWindow } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		if (!wsPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("create_new_workspace")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("create_new_workspace", "path"))
			return
		}
		if (!name) {
			task.consecutiveMistakeCount++
			task.recordToolError("create_new_workspace")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("create_new_workspace", "name"))
			return
		}

		try {
			task.consecutiveMistakeCount = 0

			const resolvedWsPath = path.isAbsolute(wsPath) ? wsPath : path.resolve(task.cwd, wsPath)
			const projectRoot = path.join(resolvedWsPath, name)

			// For worktree tasks: prevent creating a new workspace inside the
			// master checkout or another worktree. Completely external paths
			// (outside workspacePath) are allowed — that's a new, independent project.
			const worktreeErr = validateWorktreePath(task, projectRoot)
			if (worktreeErr) {
				task.consecutiveMistakeCount++
				task.recordToolError("create_new_workspace")
				task.didToolFailInCurrentTurn = true
				pushToolResult(worktreeErr)
				return
			}

			const subfolders = folders ?? []
			const forceNewWindow = openInNewWindow ?? false

			const folderList = subfolders.length > 0 ? `\nSubdirectories: ${subfolders.join(", ")}` : ""
			const sharedMessageProps: ShoferSayTool = {
				tool: "createNewWorkspace",
				path: getReadablePath(task.cwd, projectRoot),
				content: `Create workspace "${name}" at ${projectRoot}${folderList}`,
			}

			const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps satisfies ShoferSayTool))
			if (!didApprove) {
				return
			}

			// Create root directory
			await fs.mkdir(projectRoot, { recursive: true })

			// Create subdirectories
			const createdDirs: string[] = [name + "/"]
			for (const folder of subfolders) {
				const folderPath = path.join(projectRoot, folder)
				await fs.mkdir(folderPath, { recursive: true })
				createdDirs.push(`${name}/${folder}/`)
			}

			// Open the new workspace folder in VS Code
			const projectUri = vscode.Uri.file(projectRoot)
			await vscode.commands.executeCommand("vscode.openFolder", projectUri, { forceNewWindow })

			pushToolResult(
				`Created workspace "${name}" at ${projectRoot}\n` +
					`Directories: ${createdDirs.join(", ")}\n` +
					`Opening ${forceNewWindow ? "in new window" : "in current window"}...`,
			)
		} catch (error) {
			await handleError("creating new workspace", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"create_new_workspace">): Promise<void> {
		const name = block.nativeArgs?.name ?? block.params.path
		if (!this.hasPathStabilized(name)) {
			return
		}
		await task
			.ask("tool", JSON.stringify({ tool: "createNewWorkspace", path: name ?? "" }), block.partial)
			.catch(() => {})
	}
}

export const createNewWorkspaceTool = new CreateNewWorkspaceTool()
