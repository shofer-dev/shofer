import { z } from "zod"

/**
 * ToolGroup — 8 categories shared across mode filtering, auto-approval,
 * and external tool classification. Single source of truth.
 *
 *   read          – Read-only data access (files, search, diagnostics)
 *   write         – Content mutations (apply_diff, write_to_file, etc.)
 *   execute       – System command execution (execute_command, sleep)
 *   mcp           – MCP protocol tools (use_mcp_tool, access_mcp_resource)
 *   mode          – Mode switching and task lifecycle
 *   subtasks      – Background / delegated task management
 *   questions     – User-facing questions (ask_followup_question)
 *   uncategorized – Fallback for tools without explicit classification
 */
export const toolGroups = [
	"read",
	"write",
	"execute",
	"browser",
	"mcp",
	"mode",
	"subtasks",
	"questions",
	"uncategorized",
] as const

export const toolGroupsSchema = z.enum(toolGroups)

export type ToolGroup = z.infer<typeof toolGroupsSchema>

/**
 * ToolName
 */

export const toolNames = [
	"execute_command",
	"read_file",
	"read_command_output",
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"grep_search",
	"list_files",
	"use_mcp_tool",
	"access_mcp_resource",
	"ask_followup_question",
	"attempt_completion",
	"switch_mode",
	"new_task",
	"rag_search",
	"update_todo_list",
	"run_slash_command",
	"skills",
	"generate_image",
	"custom_tool",
	// New native tools (ported from workspace-tools)
	"create_directory",
	"create_new_workspace",
	"file",
	"fetch_web_page",
	"find_files",
	"get_errors",
	"get_project_setup_info",
	// get_search_results removed — merged into grep_search
	"get_changed_files",
	"insert_edit",
	"list_code_usages",
	"read_project_structure",
	"rename_symbol",
	"view_image",
	"lsp_search",
	"set_task_title",
	"give_feedback",
	// Async background task tools
	"check_task_status",
	"wait_for_task",
	"list_background_tasks",
	"cancel_tasks",
	"answer_subtask_question",
	"sleep",
	"sed",
	// Assistant Agent
	"ask_assistant_agent",
	// Git History Search
	"git_search",
] as const

export const toolNamesSchema = z.enum(toolNames)

export type ToolName = z.infer<typeof toolNamesSchema>

/**
 * ToolGroupConfig
 * Defines the configuration for a tool group.
 */
export type ToolGroupConfig = {
	tools: readonly ToolName[]
	customTools?: readonly ToolName[] // Opt-in only tools - only available when explicitly included via model's includedTools
}

/**
 * TOOL_DISPLAY_NAMES
 * Human-readable display names for each tool.
 */
export const TOOL_DISPLAY_NAMES: Record<ToolName, string> = {
	execute_command: "run commands",
	read_file: "read files",
	read_command_output: "read command output",
	write_to_file: "write files",
	apply_diff: "apply changes",
	edit: "edit files",
	search_and_replace: "apply changes using search and replace",
	search_replace: "apply single search and replace",
	edit_file: "edit files using search and replace",
	apply_patch: "apply patches using codex format",
	grep_search: "search files",
	list_files: "list files",
	use_mcp_tool: "use mcp tools",
	access_mcp_resource: "access mcp resources",
	ask_followup_question: "ask questions",
	attempt_completion: "complete tasks",
	switch_mode: "switch modes",
	new_task: "create new task",
	rag_search: "codebase search",
	update_todo_list: "update todo list",
	run_slash_command: "run slash command",
	skills: "load skill",
	generate_image: "generate images",
	custom_tool: "use custom tools",
	// New native tools (ported from workspace-tools)
	create_directory: "create directories",
	create_new_workspace: "create workspaces",
	file: "manage files (rm/mv)",
	fetch_web_page: "fetch web pages",
	find_files: "find files by pattern",
	get_changed_files: "list files changed by Shofer",
	get_errors: "get diagnostics",
	get_project_setup_info: "get project info",
	// get_search_results removed — merged into grep_search
	insert_edit: "insert text at position",
	list_code_usages: "find code references",
	read_project_structure: "read project structure",
	rename_symbol: "rename symbols",
	view_image: "view images",
	lsp_search: "search codebase via LSP",
	set_task_title: "set task title",
	give_feedback: "send feedback to shofer",
	check_task_status: "check background task status",
	wait_for_task: "wait for background task",
	list_background_tasks: "list background tasks",
	cancel_tasks: "cancel background tasks",
	answer_subtask_question: "answer subtask question",
	sleep: "wait / sleep",
	sed: "regex find-and-replace on files",
	ask_assistant_agent: "ask assistant agent",
	git_search: "search git history",
} as const

/**
 * TOOL_GROUPS
 * Defines available tool groups and their membership.
 */
export const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
	read: {
		tools: [
			"read_file",
			"grep_search",
			"list_files",
			"rag_search",
			// New native tools
			"find_files",
			"read_project_structure",
			"view_image",
			// get_search_results removed — merged into grep_search
			"list_code_usages",
			"get_errors",
			"get_project_setup_info",
			"get_changed_files",
			"lsp_search",
			"fetch_web_page",
			"ask_assistant_agent",
			"git_search",
		],
	},
	write: {
		tools: [
			"apply_diff",
			"write_to_file",
			"generate_image",
			// New native tools
			"insert_edit",
			"rename_symbol",
			"create_directory",
			"create_new_workspace",
			"file",
			"sed",
		],
		customTools: ["edit", "search_replace", "edit_file", "apply_patch"],
	},
	execute: {
		tools: ["execute_command", "read_command_output", "sleep"],
	},
	mcp: {
		tools: ["use_mcp_tool", "access_mcp_resource"],
	},
	mode: {
		tools: ["switch_mode"],
	},
	subtasks: {
		tools: [
			"new_task",
			"check_task_status",
			"wait_for_task",
			"list_background_tasks",
			"cancel_tasks",
			"answer_subtask_question",
		],
	},
	questions: {
		tools: ["ask_followup_question"],
	},
	browser: {
		tools: [],
	},
	uncategorized: {
		tools: [],
	},
}

/**
 * ALWAYS_AVAILABLE_TOOLS
 * Tools that are always available to all modes and cannot be disabled.
 */
export const ALWAYS_AVAILABLE_TOOLS: ToolName[] = [
	"attempt_completion",
	"update_todo_list",
	"run_slash_command",
	"skills",
	"set_task_title",
	"give_feedback",
] as const

/**
 * TOOL_ALIASES
 * Maps alias name -> canonical tool name.
 * Allows models to use alternative names for tools.
 */
export const TOOL_ALIASES: Record<string, ToolName> = {
	write_file: "write_to_file",
	search_and_replace: "edit",
} as const

/**
 * ToolUsage
 */

export const toolUsageSchema = z.record(
	toolNamesSchema,
	z.object({
		attempts: z.number(),
		failures: z.number(),
	}),
)

export type ToolUsage = z.infer<typeof toolUsageSchema>
