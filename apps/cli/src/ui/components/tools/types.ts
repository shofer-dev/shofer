/**
 * Types for tool renderer components
 */

import type { ToolData } from "../../types.js"

/**
 * Props passed to all tool renderer components
 */
export interface ToolRendererProps {
	/** Structured tool data */
	toolData: ToolData
	/** Raw content fallback (JSON string) */
	rawContent?: string
}

/**
 * Tool category for grouping similar tools
 */
export type ToolCategory =
	| "file-read"
	| "file-write"
	| "search"
	| "command"
	| "browser"
	| "mode"
	| "completion"
	| "other"

/**
 * Get the category for a tool based on its name
 */
export function getToolCategory(toolName: string): ToolCategory {
	const fileReadTools = [
		"readFile",
		"read_file",
		"fetchInstructions",
		"fetch_instructions",
		"listFilesTopLevel",
		"listFilesRecursive",
		"list_files",
	]
	const fileWriteTools = [
		"editedExistingFile",
		"appliedDiff",
		"apply_diff",
		"newFileCreated",
		"write_to_file",
		"writeToFile",
	]
	const searchTools = ["searchFiles", "search_files", "codebaseSearch", "codebase_search"]
	const commandTools = ["execute_command", "executeCommand"]
	const browserTools = ["browser_action", "browserAction"]
	const modeTools = ["switchMode", "switch_mode", "newTask", "new_task", "finishTask"]
	const completionTools = ["attempt_completion", "attemptCompletion", "ask_followup_question", "askFollowupQuestion"]

	if (fileReadTools.includes(toolName)) return "file-read"
	if (fileWriteTools.includes(toolName)) return "file-write"
	if (searchTools.includes(toolName)) return "search"
	if (commandTools.includes(toolName)) return "command"
	if (browserTools.includes(toolName)) return "browser"
	if (modeTools.includes(toolName)) return "mode"
	if (completionTools.includes(toolName)) return "completion"
	return "other"
}
