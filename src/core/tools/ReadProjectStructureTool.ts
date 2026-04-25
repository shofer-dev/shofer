/**
 * ReadProjectStructureTool - Builds and returns an ASCII tree of the workspace directory structure.
 *
 * Scans the workspace root recursively up to a configurable depth, skipping noise directories
 * like node_modules, .git, and build artifacts. Ported from workspace-tools `workspace_readProjectStructure`.
 */

import * as path from "path"
import * as vscode from "vscode"

import { Task } from "../task/Task"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ReadProjectStructureParams {
	maxDepth?: number | null
	includeHidden?: boolean | null
}

interface DirectoryEntry {
	name: string
	type: "file" | "directory"
	children?: DirectoryEntry[]
}

const DEFAULT_MAX_DEPTH = 3

const SKIP_DIRS = new Set([
	"node_modules",
	"__pycache__",
	".git",
	"dist",
	"out",
	"build",
	"bazel-bin",
	"bazel-out",
	"bazel-testlogs",
])

export class ReadProjectStructureTool extends BaseTool<"read_project_structure"> {
	readonly name = "read_project_structure" as const

	async execute(params: ReadProjectStructureParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks
		const maxDepth = params.maxDepth ?? DEFAULT_MAX_DEPTH
		const includeHidden = params.includeHidden ?? false

		try {
			task.consecutiveMistakeCount = 0

			const didApprove = await this.askToolApproval(callbacks, {
				tool: "readProjectStructure",
				content: "Reading project structure",
			})
			if (!didApprove) {
				return
			}

			const rootPath = task.cwd
			const rootUri = vscode.Uri.file(rootPath)

			const buildTree = async (uri: vscode.Uri, depth: number): Promise<DirectoryEntry[]> => {
				if (depth > maxDepth) {
					return []
				}

				const entries = await vscode.workspace.fs.readDirectory(uri)
				const result: DirectoryEntry[] = []

				for (const [name, type] of entries) {
					if (!includeHidden && name.startsWith(".")) {
						continue
					}
					if (type === vscode.FileType.Directory && SKIP_DIRS.has(name)) {
						continue
					}

					const entry: DirectoryEntry = {
						name,
						type: type === vscode.FileType.Directory ? "directory" : "file",
					}

					if (type === vscode.FileType.Directory && depth < maxDepth) {
						const childUri = vscode.Uri.joinPath(uri, name)
						entry.children = await buildTree(childUri, depth + 1)
					}

					result.push(entry)
				}

				result.sort((a, b) => {
					if (a.type !== b.type) {
						return a.type === "directory" ? -1 : 1
					}
					return a.name.localeCompare(b.name)
				})

				return result
			}

			const tree = await buildTree(rootUri, 0)

			const formatTree = (entries: DirectoryEntry[], prefix: string = ""): string[] => {
				const lines: string[] = []
				for (let i = 0; i < entries.length; i++) {
					const entry = entries[i]
					const isLast = i === entries.length - 1
					const connector = isLast ? "└── " : "├── "
					const suffix = entry.type === "directory" ? "/" : ""
					lines.push(`${prefix}${connector}${entry.name}${suffix}`)

					if (entry.children && entry.children.length > 0) {
						const childPrefix = prefix + (isLast ? "    " : "│   ")
						lines.push(...formatTree(entry.children, childPrefix))
					}
				}
				return lines
			}

			const treeLines = formatTree(tree)
			pushToolResult(path.basename(rootPath) + "/\n" + treeLines.join("\n"))
		} catch (error) {
			await handleError("reading project structure", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const readProjectStructureTool = new ReadProjectStructureTool()
