import { z } from "zod"

/**
 * The grammar every tool-category name obeys: a lowercase slug, hyphen-separated,
 * at most 64 characters — the same rule skill names follow.
 *
 * It is deliberately a strict subset of the platform's object-tag atom with `:`
 * excluded, so namespaced categories stay open without renaming anything. Two
 * consequences the callers rely on:
 *
 *   - `*` is NOT a valid name, so the `alwaysAllowGroups` wildcard can never
 *     collide with a real category;
 *   - every builtin group name is itself a valid slug, so "builtin or slug"
 *     collapses to "slug" at every validation site.
 *
 * A string that fails this rule is malformed input, not a name: it is dropped to
 * `uncategorized`, which is the fail-closed guard for undeclared tools.
 */
export const toolGroupNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Tool group names must be lowercase alphanumeric words joined by hyphens")

/**
 * BuiltinToolGroup — the 8 RESERVED categories that carry native tools or
 * special semantics. They are the closed vocabulary the exhaustive records
 * ({@link TOOL_GROUPS}, `GROUP_GATE`) are keyed by. Single source of truth.
 *
 *   read          – Read-only data access (files, search, diagnostics)
 *   write         – Content mutations (apply_diff, write_to_file, etc.)
 *   execute       – System command execution (execute_command, sleep)
 *   mcp           – MCP protocol tools (use_mcp_tool, access_mcp_resource)
 *   mode          – Mode switching and task lifecycle
 *   subtasks      – Background / delegated task management
 *   questions     – User-facing questions (ask_followup_question)
 *   uncategorized – Fallback for tools that declare NOTHING (or declare a name
 *                   that is not a valid slug)
 *
 * Any other slug is a DYNAMIC category, minted on first use by whatever declared
 * it (an MCP server's `_meta`, an `mcp.json` override, a private-tool provider,
 * a plugin's custom tool). Adding a 9th builtin is a coordinated change and needs
 * justification; adding a dynamic category needs nothing.
 */
export const toolGroups = ["read", "write", "execute", "mcp", "mode", "subtasks", "questions", "uncategorized"] as const

export const toolGroupsSchema = z.enum(toolGroups)

export type BuiltinToolGroup = z.infer<typeof toolGroupsSchema>

/**
 * The name of any tool category — a builtin or a dynamic one.
 *
 * `(string & {})` keeps the builtin literals as editor completions while still
 * accepting an arbitrary slug. Everything that can carry a dynamic name (MCP tool
 * metadata, mode group entries, private-tool meta) takes this type; only the two
 * exhaustive records take {@link BuiltinToolGroup}.
 */
export type ToolGroup = BuiltinToolGroup | (string & {})

/**
 * ToolName
 */

export const toolNames = [
	"execute_command",
	"read_file",
	"read_command_output",
	"read_output_channel",
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
	"list_background_tasks",
	"cancel_tasks",
	"sed",
	// Git History Search
	// Async MCP tool calling
	"call_mcp_tool_async",
	"check_mcp_call_status",
	"wait_for_mcp_call",
	// The mailbox (docs/task_messaging.md): one send, one answer, one park
	"send_message",
	"reply",
	"wait",
	// On-demand schema loading: hands back the full contract of a stubbed tool
	"describe_tools",
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
	read_output_channel: "read output channels",
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
	list_background_tasks: "list background tasks",
	cancel_tasks: "cancel background tasks",
	sed: "regex find-and-replace on files",
	call_mcp_tool_async: "call mcp tools asynchronously",
	check_mcp_call_status: "check async mcp call status",
	wait_for_mcp_call: "wait for async mcp calls",
	send_message: "send mail to another task",
	reply: "answer a request in the mailbox",
	wait: "wait for mail",
	describe_tools: "read tool schemas",
} as const

/**
 * TOOL_GROUPS
 * Defines the BUILTIN tool groups and their native-tool membership.
 *
 * A dynamic category has no entry here — it carries no native tools by
 * construction, so every lookup goes through {@link getToolGroupConfig}, which
 * answers `undefined` (an empty native set) rather than throwing.
 */
export const TOOL_GROUPS: Record<BuiltinToolGroup, ToolGroupConfig> = {
	read: {
		tools: [
			"read_file",
			"read_output_channel",
			"grep_search",
			"list_files",
			// New native tools
			"find_files",
			"read_project_structure",
			"view_image",
			// get_search_results removed — merged into grep_search
			"list_code_usages",
			"get_errors",
			"get_project_setup_info",
			"lsp_search",
			"fetch_web_page",
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
		tools: ["execute_command", "read_command_output"],
	},
	mcp: {
		tools: [
			"use_mcp_tool",
			"access_mcp_resource",
			"call_mcp_tool_async",
			"check_mcp_call_status",
			"wait_for_mcp_call",
		],
	},
	mode: {
		tools: ["switch_mode"],
	},
	subtasks: {
		tools: ["new_task", "check_task_status", "cancel_tasks"],
	},
	questions: {
		tools: ["ask_followup_question"],
	},
	uncategorized: {
		tools: [],
	},
}

/**
 * The native tools a group contributes, or `undefined` when the group is not a
 * builtin.
 *
 * Every consumer that resolves a group name coming from CONFIG (a mode's `tools`
 * array, an agent's declared groups) must go through this: those names are
 * slug-validated but open, so a dynamic category — or a typo — reaches the lookup
 * and a bare `TOOL_GROUPS[name].tools` would throw a TypeError.
 */
export function getToolGroupConfig(group: string): ToolGroupConfig | undefined {
	return (TOOL_GROUPS as Record<string, ToolGroupConfig | undefined>)[group]
}

/**
 * ALWAYS_AVAILABLE_TOOLS
 * Tools that are always available to all modes and cannot be disabled.
 *
 * `describe_tools` is a member so that a mode which tiers its schemas gets it
 * without listing it, but it is REMOVED again by `computeToolAccess` for a mode
 * that declares no tiering: a mode with no stubs has nothing to describe, and
 * offering it there would change every existing mode's tool array.
 */
export const ALWAYS_AVAILABLE_TOOLS: ToolName[] = [
	"attempt_completion",
	"describe_tools",
	"update_todo_list",
	"run_slash_command",
	"skills",
	"set_task_title",
	"give_feedback",
	"list_background_tasks",
	// The mailbox tools are always available and never mode-gated: a task that
	// can be addressed must be able to read and answer its box whatever mode it
	// runs in, or mail lands somewhere nobody can reach it.
	"send_message",
	"reply",
	"wait",
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
 * CROSS_ASSISTANT_ALIASES
 * Maps foreign tool names (from other AI coding assistants' schemas) to
 * Shofer canonical tool names. These are PARSER-ONLY — used to resolve
 * incoming tool calls. They MUST NOT be exposed to the model in function
 * definitions (the model should see Shofer's canonical names, not foreign ones).
 */
export const CROSS_ASSISTANT_ALIASES: Record<string, ToolName> = {
	search_content: "grep_search",
	search_file: "find_files",
	search_files: "find_files",
	find_file: "find_files",
	iterative_search: "grep_search",
	internal_search: "grep_search",
	bash: "execute_command",
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
