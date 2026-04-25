/**
 * GetErrorsTool - Retrieves compile/lint errors and warnings from the workspace.
 *
 * Uses VS Code's language server diagnostics to get errors and warnings,
 * optionally filtered to specific files. Ported from workspace-tools `workspace_getErrors`.
 */

import * as path from "path"
import * as vscode from "vscode"

import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface GetErrorsParams {
	filePaths?: string[] | null
}

type Severity = "error" | "warning" | "info" | "hint"

interface DiagnosticEntry {
	filePath: string
	line: number
	column: number
	severity: Severity
	message: string
	source?: string
}

function mapSeverity(severity: vscode.DiagnosticSeverity): Severity {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return "error"
		case vscode.DiagnosticSeverity.Warning:
			return "warning"
		case vscode.DiagnosticSeverity.Information:
			return "info"
		case vscode.DiagnosticSeverity.Hint:
			return "hint"
		default:
			return "info"
	}
}

export class GetErrorsTool extends BaseTool<"get_errors"> {
	readonly name = "get_errors" as const

	async execute(params: GetErrorsParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { filePaths } = params
		const { handleError, pushToolResult } = callbacks

		try {
			task.consecutiveMistakeCount = 0

			const didApprove = await this.askToolApproval(callbacks, {
				tool: "getErrors",
				path: filePaths?.[0],
				content: filePaths
					? `Getting diagnostics for ${filePaths.length} file(s)`
					: "Getting workspace diagnostics",
			})
			if (!didApprove) {
				return
			}

			const allDiagnostics = vscode.languages.getDiagnostics()
			const entries: DiagnosticEntry[] = []

			// Build set of absolute paths to filter by
			const targetPaths = filePaths?.map((p) => (path.isAbsolute(p) ? p : path.resolve(task.cwd, p)))

			for (const [uri, diagnostics] of allDiagnostics) {
				if (targetPaths && !targetPaths.some((t) => t === uri.fsPath)) {
					continue
				}

				for (const diag of diagnostics) {
					// Only include errors and warnings
					if (diag.severity > vscode.DiagnosticSeverity.Warning) {
						continue
					}
					entries.push({
						filePath: uri.fsPath,
						line: diag.range.start.line + 1,
						column: diag.range.start.character + 1,
						severity: mapSeverity(diag.severity),
						message: diag.message,
						source: diag.source,
					})
				}
			}

			if (entries.length === 0) {
				const scope = filePaths ? "in specified files" : "in workspace"
				pushToolResult(`No errors or warnings ${scope}`)
				return
			}

			// Sort by severity then by file
			const severityOrder: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 }
			entries.sort((a, b) => {
				const diff = severityOrder[a.severity] - severityOrder[b.severity]
				if (diff !== 0) return diff
				return a.filePath.localeCompare(b.filePath)
			})

			// Group by file
			const byFile = new Map<string, DiagnosticEntry[]>()
			for (const entry of entries) {
				const relPath = getReadablePath(task.cwd, entry.filePath)
				const existing = byFile.get(relPath) ?? []
				existing.push(entry)
				byFile.set(relPath, existing)
			}

			const sections: string[] = []
			for (const [file, diags] of byFile) {
				const lines = diags.map((d) => {
					const source = d.source ? `[${d.source}] ` : ""
					return `  ${d.line}:${d.column} ${d.severity}: ${source}${d.message}`
				})
				sections.push(`${file}:\n${lines.join("\n")}`)
			}

			const errorCount = entries.filter((e) => e.severity === "error").length
			const warningCount = entries.filter((e) => e.severity === "warning").length
			pushToolResult(`Found ${errorCount} error(s), ${warningCount} warning(s)\n\n${sections.join("\n\n")}`)
		} catch (error) {
			await handleError("getting errors", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const getErrorsTool = new GetErrorsTool()
