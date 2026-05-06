import type { ClineSayTool } from "@roo-code/types"
import { TOOL_GROUPS } from "../../shared/tools"

/**
 * Map of ClineSayTool.tool (camelCase) values to their snake_case tool names.
 * Used to resolve a tool's ToolGroup from its UI-facing tool identifier.
 *
 * Only tools that use the `ask === "tool"` auto-approval path need entries here.
 * Tools that go through `ask === "command"` (execute_command) or
 * `ask === "use_mcp_server"` are handled separately.
 */
const SAY_TOOL_TO_NATIVE_NAME: Record<string, string> = {
	// read group
	readFile: "read_file",
	listFiles: "list_files",
	listFilesTopLevel: "list_files",
	listFilesRecursive: "list_files",
	searchFiles: "search_files",
	codebaseSearch: "codebase_search",
	codebaseSearchWithLsp: "codebase_search_with_lsp",
	findFiles: "find_files",
	viewImage: "view_image",
	getErrors: "get_errors",
	getChangedFiles: "get_changed_files",
	getProjectSetupInfo: "get_project_setup_info",
	getSearchResults: "get_search_results",
	readProjectStructure: "read_project_structure",
	listCodeUsages: "list_code_usages",
	fetchWebPage: "fetch_web_page",

	// write group
	editedExistingFile: "apply_diff",
	appliedDiff: "apply_diff",
	newFileCreated: "write_to_file",
	generateImage: "generate_image",
	createDirectory: "create_directory",
	createNewWorkspace: "create_new_workspace",
	fileOp: "file",
	insertEdit: "insert_edit",
	renameSymbol: "rename_symbol",

	// mode group
	switchMode: "switch_mode",
	newTask: "new_task",
	finishTask: "attempt_completion",

	// subtasks group
	waitForTask: "wait_for_task",
	checkTaskStatus: "check_task_status",
	listBackgroundTasks: "list_background_tasks",

	// questions group
	askFollowupQuestion: "ask_followup_question",

	// mode-independent always-available
	updateTodoList: "update_todo_list",
	runSlashCommand: "run_slash_command",
	skill: "skill",
	saveSkill: "skill_save",
	setTaskTitle: "set_task_title",
}

/**
 * Resolve the ToolGroup for a tool from its ClineSayTool identifier.
 *
 * Resolution order:
 *  1. Native tools — look up snake_case name in TOOL_GROUPS
 *  2. External LM tools — infer from naming prefix (browser_ → browser, ide_ → read/execute)
 *  3. Fallback to "uncategorized"
 *
 * @param tool - The tool metadata from the approval payload
 * @returns The ToolGroup this tool belongs to
 */
export function getToolGroupForSayTool(tool: ClineSayTool): string {
	const sayName = tool.tool

	// Native tools: map camelCase → snake_case → group
	const nativeName = SAY_TOOL_TO_NATIVE_NAME[sayName]
	if (nativeName) {
		for (const [group, config] of Object.entries(TOOL_GROUPS)) {
			if ((config.tools as readonly string[]).includes(nativeName)) {
				return group
			}
		}
	}

	// External LM tools: infer group from the tool name prefix
	// This handles browser_* and ide_* tools when they use askApproval.
	if (sayName.startsWith("browser") || sayName.startsWith("browser_")) {
		return "browser"
	}

	// For ide_* tools, we can't easily resolve the exact group here
	// (it depends on the extension's config). Default to "execute" for
	// ide_* since most ide-tools are UI state mutations.
	if (sayName.startsWith("ide_") || sayName.startsWith("ide")) {
		return "execute"
	}

	return "uncategorized"
}

/**
 * @deprecated Use `getToolGroupForSayTool(tool) === "write"` instead.
 */
export function isWriteToolAction(tool: ClineSayTool): boolean {
	return getToolGroupForSayTool(tool) === "write"
}

/**
 * @deprecated Use `getToolGroupForSayTool(tool) === "read"` instead.
 */
export function isReadOnlyToolAction(tool: ClineSayTool): boolean {
	return getToolGroupForSayTool(tool) === "read"
}
