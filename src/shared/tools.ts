import { Anthropic } from "@anthropic-ai/sdk"

import type { ShoferAsk, ToolProgressStatus, ToolGroup, ToolName, GenerateImageParams } from "@shofer/types"

// NOTE: When adding a new tool parameter name to toolParamNames, also add it
// to NativeToolArgs if the tool uses native (typed) arguments.

// Re-export tool metadata from @shofer/types to avoid duplication
export {
	type ToolGroupConfig,
	TOOL_DISPLAY_NAMES,
	TOOL_GROUPS,
	ALWAYS_AVAILABLE_TOOLS,
	TOOL_ALIASES,
} from "@shofer/types"

export type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>

export type AskApproval = (
	type: ShoferAsk,
	partialMessage?: string,
	progressStatus?: ToolProgressStatus,
	forceApproval?: boolean,
) => Promise<boolean>

export type HandleError = (action: string, error: Error) => Promise<void>

export type PushToolResult = (content: ToolResponse) => void

export type AskFinishSubTaskApproval = () => Promise<boolean>

export interface TextContent {
	type: "text"
	content: string
	partial: boolean
	/**
	 * Stable per-block identity assigned when the streamed text block is first
	 * created. Threaded into `Task.say("text", …)` so the partial → final handoff
	 * locates the owning chat message by identity instead of tail position.
	 */
	id?: string
}

export const toolParamNames = [
	"command",
	"path",
	"filePath", // Accepted as alias for path in tools where the model may use either name
	"content",
	"regex",
	"file_pattern",
	"recursive",
	"action",
	"url",
	"coordinate",
	"text",
	"server_name",
	"tool_name",
	"arguments",
	"uri",
	"question",
	"result",
	"diff",
	"mode_slug",
	"reason",
	"title", // set_task_title parameter
	"line",
	"mode",
	"message",
	"cwd",
	"follow_up",
	"form",
	"task",
	"size",
	"query",
	"args",
	"skill", // skill tool parameter
	"start_line",
	"end_line",
	"todos",
	"is_background", // new_task async mode parameter
	"task_id", // check_task_status parameter
	"task_ids", // wait_for_task parameter (accepts multiple IDs)
	"wait", // wait_for_task strategy: "all" | "any"
	"prompt",
	"image",
	// read_file parameters (native protocol)
	"operations", // search_and_replace parameter for multiple operations
	"patch", // apply_patch parameter
	"file_path", // search_replace and edit_file parameter
	"old_string", // search_replace and edit_file parameter
	"new_string", // search_replace and edit_file parameter
	"replace_all", // edit tool parameter for replacing all occurrences
	"expected_replacements", // edit_file parameter for multiple occurrences
	"timeout", // execute_command parameter
	"artifact_id", // read_command_output parameter
	"search", // read_command_output parameter for grep-like search
	"offset", // read_command_output and read_file parameter
	"limit", // read_command_output and read_file parameter
	// read_file indentation mode parameters
	"indentation",
	"anchor_line",
	"max_levels",
	"include_siblings",
	"include_header",
	"max_lines",
	// read_file legacy format parameter (backward compatibility)
	"files",
	"line_ranges",
	// find_files parameter
	"pattern",
	// sleep parameter
	"seconds",
	// file tool parameters (rm/mv)
	"subcommand",
	"destination",
	// give_feedback parameter
	"feedback",
	// sed tool parameters (pattern already listed above for find_files)
	"replacement",
	"isRegex", // sed explicit regex/literal mode
	"global",
	"maxResults", // result cap for grep_search / git_search / rag_search (see helpers/searchCap.ts)
	// attempt_completion rating (feedback already listed above for give_feedback)
	"rating",
	// grep_search parameters
	"fileTypes",
	"excludePattern",
	"isRegex",
	"caseSensitive",
	"wholeWord",
	"contextBefore",
	"contextAfter",
	// insert_edit, rename_symbol parameters
	"column",
	"newName",
	// fetch_web_page parameter
	"urls",
	// call_mcp_tool_async parameters
	"call_id",
	"call_ids",
	"source",
	// check_task_status parameter
	"include_activity",
	// ask_live_memory parameters
	"contextFiles",
	"timeoutMs",
	"softTimeoutSec",
	"softResultLength",
	// create_new_workspace parameters
	"name",
	"folders",
	"openInNewWindow",
	// read_project_structure parameters
	"maxDepth",
	"includeHidden",
	// get_errors parameter
	"filePaths",
	// answer_subtask_question parameter
	"answer",
	// git_search time range parameters
	"since",
	"until",
	// send_message_to_task parameter
	"timeout_sec",
	// new_task peer_task_ids parameter
	"peer_task_ids",
	// list_background_tasks scope parameter
	"scope",
] as const

export type ToolParamName = (typeof toolParamNames)[number]

/**
 * Type map defining the native (typed) argument structure for each tool.
 * Tools not listed here will fall back to `any` for backward compatibility.
 */
export type NativeToolArgs = {
	ask_live_memory: { question: string; contextFiles?: string[] | null; timeoutMs?: number | null }
	access_mcp_resource: { server_name: string; uri: string }
	read_file: import("@shofer/types").ReadFileToolParams
	read_command_output: { artifact_id: string; search?: string; offset?: number; limit?: number }
	attempt_completion: { result: string | Record<string, unknown>; rating?: string | number; feedback?: string }
	execute_command: { command: string; cwd?: string; timeout?: number | null }
	apply_diff: { path: string; diff: string }
	edit: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
	search_and_replace: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
	search_replace: { file_path: string; old_string: string; new_string: string }
	edit_file: { file_path: string; old_string: string; new_string: string; expected_replacements?: number }
	apply_patch: { patch: string }
	list_files: { path: string; recursive?: boolean }
	// `is_background` is declared boolean in the JSON schema but some models serialize it
	// as a string ("True"/"False") or number (1/0). The actual type is widened here to
	// reflect that reality; NewTaskTool normalizes the value via parseToolBoolean().
	new_task: {
		mode: string
		message: string
		todos?: string
		is_background?: boolean | string | number | null
		softResultLength?: number
		softTimeoutSec?: number
		peer_task_ids?: string[] | null
		title?: string
	}
	check_task_status: { task_id: string; include_activity?: boolean | null }
	wait_for_task: { task_ids: string[]; wait?: "all" | "any"; timeout?: number }
	list_background_tasks: { scope?: "children" | "peers" | null }
	cancel_tasks: { task_ids: string[] }
	answer_subtask_question: { task_id: string; answer: string }
	ask_followup_question: {
		question: string
		follow_up?: Array<{ text: string; mode?: string }> | null
		form?: Array<import("@shofer/types").ParamField> | null
	}
	rag_search: { query: string; path?: string; maxResults?: number | null }
	generate_image: GenerateImageParams
	run_slash_command: { command: string; args?: string }
	skills: { skill: string; args?: string }
	grep_search: {
		path: string
		query: string
		fileTypes?: string | null
		excludePattern?: string | null
		isRegex?: boolean | null
		caseSensitive?: boolean | null
		wholeWord?: boolean | null
		maxResults?: number | null
		contextBefore?: number | null
		contextAfter?: number | null
	}
	switch_mode: { mode_slug: string; reason: string; task_id?: string }
	set_task_title: { title: string }
	give_feedback: { feedback: string }
	update_todo_list: { todos: string }
	use_mcp_tool: { server_name: string; tool_name: string; arguments?: Record<string, unknown> }
	write_to_file: { path: string; content: string }
	// New native tools (ported from workspace-tools)
	create_directory: { path: string }
	create_new_workspace: { path: string; name: string; folders?: string[] | null; openInNewWindow?: boolean | null }
	file: { subcommand: "rm" | "mv"; path: string; destination?: string; recursive?: boolean | null }
	fetch_web_page: { urls: string[]; query?: string | null }
	find_files: { pattern: string; maxResults?: number }
	get_changed_files: Record<string, never>
	get_errors: { filePaths?: string[] | null }
	get_project_setup_info: Record<string, never>
	// get_search_results removed — merged into grep_search
	insert_edit: { path: string; filePath?: string; line: number; column?: number | null; text: string }
	list_code_usages: { path: string; filePath?: string; line: number; column: number }
	read_project_structure: { maxDepth?: number | null; includeHidden?: boolean | null }
	rename_symbol: { path: string; filePath?: string; line: number; column: number; newName: string }
	view_image: { path: string; filePath?: string }
	lsp_search: { query: string; maxResults?: number | null }
	sleep: { seconds: number }
	sed: { path: string; pattern: string; replacement: string; isRegex?: boolean | null; global?: boolean | null }
	git_search: { query: string; maxResults?: number | null; since?: string | null; until?: string | null }
	call_mcp_tool_async: {
		server_name: string
		tool_name: string
		arguments?: Record<string, unknown>
		source?: "global" | "project"
	}
	check_mcp_call_status: { call_id: string }
	wait_for_mcp_call: { call_ids: string[]; wait?: "all" | "any"; timeout?: number }
	send_message_to_task: {
		task_id: string
		message: string
		wait?: boolean | null
		timeout_sec?: number | null
	}
	// `wait` is an alias for attempt_completion. `rating` is required by the schema
	// (assesses the work done so far); `reason` is optional (defaults to "waiting").
	// `rating` is kept optional in this runtime type as a defensive measure — like
	// attempt_completion, the handler tolerates a missing rating from non-strict
	// providers and falls back to a default ("well").
	wait: { rating?: string; reason?: string }
	// Add more tools as they are migrated to native protocol
}

/**
 * Generic ToolUse interface that provides proper typing for both protocols.
 *
 * @template TName - The specific tool name, which determines the nativeArgs type
 */
export interface ToolUse<TName extends ToolName = ToolName> {
	type: "tool_use"
	id?: string // Optional ID to track tool calls
	name: TName
	/**
	 * The original tool name as called by the model (e.g. an alias like "edit_file"),
	 * if it differs from the canonical tool name used for execution.
	 * Used to preserve tool names in API conversation history.
	 */
	originalName?: string
	// params is a partial record, allowing only some or none of the possible parameters to be used
	params: Partial<Record<ToolParamName, string>>
	partial: boolean
	// nativeArgs is properly typed based on TName if it's in NativeToolArgs, otherwise never
	nativeArgs?: TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : never
	/**
	 * Flag indicating whether the tool call used a legacy/deprecated format.
	 * Used for telemetry tracking to monitor migration from old formats.
	 */
	usedLegacyFormat?: boolean
}

/**
 * Represents a native MCP tool call from the model.
 * In native mode, MCP tools are called directly with their prefixed name (e.g., "mcp_serverName_toolName")
 * rather than through the use_mcp_tool wrapper. This type preserves the original tool name
 * so it appears correctly in API conversation history.
 */
export interface McpToolUse {
	type: "mcp_tool_use"
	id?: string // Tool call ID from the API
	/** The original tool name from the API (e.g., "mcp_serverName_toolName") */
	name: string
	/** Extracted server name from the tool name */
	serverName: string
	/** Extracted tool name from the tool name */
	toolName: string
	/** Arguments passed to the MCP tool */
	arguments: Record<string, unknown>
	partial: boolean
}

export interface ExecuteCommandToolUse extends ToolUse<"execute_command"> {
	name: "execute_command"
	// Pick<Record<ToolParamName, string>, "command"> makes "command" required, but Partial<> makes it optional
	params: Partial<Pick<Record<ToolParamName, string>, "command" | "cwd" | "timeout">>
}

export interface ReadFileToolUse extends ToolUse<"read_file"> {
	name: "read_file"
	params: Partial<
		Pick<
			Record<ToolParamName, string>,
			| "args"
			| "path"
			| "start_line"
			| "end_line"
			| "mode"
			| "offset"
			| "limit"
			| "indentation"
			| "anchor_line"
			| "max_levels"
			| "include_siblings"
			| "include_header"
		>
	>
}

export interface WriteToFileToolUse extends ToolUse<"write_to_file"> {
	name: "write_to_file"
	params: Partial<Pick<Record<ToolParamName, string>, "path" | "content">>
}

export interface RagSearchToolUse extends ToolUse<"rag_search"> {
	name: "rag_search"
	params: Partial<Pick<Record<ToolParamName, string>, "query" | "path" | "maxResults">>
}

export interface GrepSearchToolUse extends ToolUse<"grep_search"> {
	name: "grep_search"
	params: Partial<Pick<Record<ToolParamName, string>, "path" | "regex" | "file_pattern">>
}

export interface GitSearchToolUse extends ToolUse<"git_search"> {
	name: "git_search"
	params: Partial<Pick<Record<ToolParamName, string>, "query" | "maxResults">>
}

export interface ListFilesToolUse extends ToolUse<"list_files"> {
	name: "list_files"
	params: Partial<Pick<Record<ToolParamName, string>, "path" | "recursive">>
}

export interface UseMcpToolToolUse extends ToolUse<"use_mcp_tool"> {
	name: "use_mcp_tool"
	params: Partial<Pick<Record<ToolParamName, string>, "server_name" | "tool_name" | "arguments">>
}

export interface AccessMcpResourceToolUse extends ToolUse<"access_mcp_resource"> {
	name: "access_mcp_resource"
	params: Partial<Pick<Record<ToolParamName, string>, "server_name" | "uri">>
}

export interface AskFollowupQuestionToolUse extends ToolUse<"ask_followup_question"> {
	name: "ask_followup_question"
	params: Partial<Pick<Record<ToolParamName, string>, "question" | "follow_up" | "form">>
}

export interface AttemptCompletionToolUse extends ToolUse<"attempt_completion"> {
	name: "attempt_completion"
	params: Partial<Pick<Record<ToolParamName, string>, "result" | "rating" | "feedback">>
}

export interface SwitchModeToolUse extends ToolUse<"switch_mode"> {
	name: "switch_mode"
	params: Partial<Pick<Record<ToolParamName, string>, "mode_slug" | "reason" | "task_id">>
}

export interface NewTaskToolUse extends ToolUse<"new_task"> {
	name: "new_task"
	params: Partial<Pick<Record<ToolParamName, string>, "mode" | "message" | "todos">>
}

export interface RunSlashCommandToolUse extends ToolUse<"run_slash_command"> {
	name: "run_slash_command"
	params: Partial<Pick<Record<ToolParamName, string>, "command" | "args">>
}

export interface SkillsToolUse extends ToolUse<"skills"> {
	name: "skills"
	params: Partial<Pick<Record<ToolParamName, string>, "skill" | "args">>
}

export interface GenerateImageToolUse extends ToolUse<"generate_image"> {
	name: "generate_image"
	params: Partial<Pick<Record<ToolParamName, string>, "prompt" | "path" | "image">>
}

export type DiffResult =
	| { success: true; content: string; failParts?: DiffResult[] }
	| ({
			success: false
			error?: string
			details?: {
				similarity?: number
				threshold?: number
				matchedRange?: { start: number; end: number }
				searchContent?: string
				bestMatch?: string
			}
			failParts?: DiffResult[]
	  } & ({ error: string } | { failParts: DiffResult[] }))

export interface DiffItem {
	content: string
	startLine?: number
}

export interface DiffStrategy {
	/**
	 * Get the name of this diff strategy for analytics and debugging
	 * @returns The name of the diff strategy
	 */
	getName(): string

	/**
	 * Apply a diff to the original content
	 * @param originalContent The original file content
	 * @param diffContent The diff content in the strategy's format (string for legacy, DiffItem[] for new)
	 * @param startLine Optional line number where the search block starts. If not provided, searches the entire file.
	 * @param endLine Optional line number where the search block ends. If not provided, searches the entire file.
	 * @returns A DiffResult object containing either the successful result or error details
	 */
	applyDiff(
		originalContent: string,
		diffContent: string | DiffItem[],
		startLine?: number,
		endLine?: number,
	): Promise<DiffResult>

	getProgressStatus?(toolUse: ToolUse, result?: any): ToolProgressStatus
}
