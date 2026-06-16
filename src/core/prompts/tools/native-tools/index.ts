import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { apply_diff } from "./apply_diff"
import applyPatch from "./apply_patch"
import askFollowupQuestion from "./ask_followup_question"
import attemptCompletion from "./attempt_completion"
import ragSearch from "./rag_search"

/**
 * Return a copy of `attempt_completion` with its `result` parameter schema
 * swapped for the given contract JSON Schema.
 *
 * The `rating`, `feedback`, and `strict` fields are spread from the base
 * tool definition so the schema here does not duplicate them — if the base
 * changes (e.g. rating enum), this function picks up the change
 * automatically.  Only the `result` property is replaced; the contract
 * becomes its sub-schema (i.e. the LLM produces `{ result: {<contract>},
 * rating, feedback }`).
 *
 * The contract schema is within the universal + strict-safe subset
 * (§4.3 of todos/output_contract_enforcement.md) so it is safe to send to
 * every provider.  Providers with constrained decoding (OpenAI/Gemini)
 * enforce it at decode time; providers without (DeepSeek Cloud) treat it
 * as a strong semantic hint.
 */
function applyCompletionSchema(
	base: OpenAI.Chat.ChatCompletionFunctionTool,
	schema: Record<string, unknown>,
): OpenAI.Chat.ChatCompletionFunctionTool {
	const baseProps = (base.function.parameters as any)?.properties ?? {}
	return {
		...base,
		function: {
			...base.function,
			parameters: {
				type: "object",
				properties: {
					result: schema as OpenAI.FunctionParameters,
					...(baseProps.rating ? { rating: baseProps.rating } : {}),
					...(baseProps.feedback ? { feedback: baseProps.feedback } : {}),
				},
				required: [
					"result",
					...((base.function.parameters as any)?.required?.filter((k: string) => k !== "result") ?? []),
				],
				additionalProperties: (base.function.parameters as any)?.additionalProperties ?? false,
			},
		},
	}
}
import gitSearch from "./git_search"
import lspSearch from "./lsp_search"
import createDirectory from "./create_directory"
import createNewWorkspace from "./create_new_workspace"
import editTool from "./edit"
import executeCommand from "./execute_command"
import fetchWebPage from "./fetch_web_page"
import fileTool from "./file"
import findFiles from "./find_files"
import generateImage from "./generate_image"
import getChangedFiles from "./get_changed_files"
import getErrors from "./get_errors"
import getProjectSetupInfo from "./get_project_setup_info"
// get_search_results removed — merged into grep_search
import insertEdit from "./insert_edit"
import listCodeUsages from "./list_code_usages"
import listFiles from "./list_files"
import newTask from "./new_task"
import askLiveMemory from "./ask_live_memory"
import readCommandOutput from "./read_command_output"
import { createReadFileTool, type ReadFileToolOptions } from "./read_file"
import readProjectStructure from "./read_project_structure"
import renameSymbol from "./rename_symbol"
import runSlashCommand from "./run_slash_command"
import skillsToolDef from "./skills"
import searchReplace from "./search_replace"
import edit_file from "./edit_file"
import grepSearch from "./grep_search"
import switchMode from "./switch_mode"
import updateTodoList from "./update_todo_list"
import setTaskTitle from "./set_task_title"
import giveFeedback from "./give_feedback"
import checkTaskStatus from "./check_task_status"
import waitForTask from "./wait_for_task"
import listBackgroundTasks from "./list_background_tasks"
import cancelTasks from "./cancel_tasks"
import answerSubtaskQuestion from "./answer_subtask_question"
import callMcpToolAsync from "./call_mcp_tool_async"
import checkMcpCallStatus from "./check_mcp_call_status"
import waitForMcpCall from "./wait_for_mcp_call"
import sed from "./sed"
import sendMessageToTask from "./send_message_to_task"
import sleep from "./sleep"
import wait from "./wait"
import viewImage from "./view_image"
import writeToFile from "./write_to_file"

export { getMcpServerTools } from "./mcp_server"
export { convertOpenAIToolToAnthropic, convertOpenAIToolsToAnthropic } from "./converters"
export type { ReadFileToolOptions } from "./read_file"

/**
 * Options for customizing the native tools array.
 */
export interface NativeToolsOptions {
	/** Whether the model supports image processing (default: false) */
	supportsImages?: boolean
	/**
	 * Per-task JSON Schema override for the `attempt_completion` tool's
	 * `result` parameter. When set, the generic `result: string` is
	 * replaced with the contract schema so providers with constrained
	 * decoding enforce it at decode time.
	 */
	completionSchema?: Record<string, unknown>
	/**
	 * When true, omit `set_task_title` from the returned tools. Used when a
	 * task's title was locked by its spawning parent (via `new_task`'s `title`),
	 * so the agent is never offered a tool it would only be refused (see
	 * `SetTaskTitleTool`).
	 */
	titleLocked?: boolean
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false, completionSchema, titleLocked = false } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}

	const tools: OpenAI.Chat.ChatCompletionTool[] = [
		askLiveMemory,
		accessMcpResource,
		apply_diff,
		applyPatch,
		askFollowupQuestion,
		completionSchema
			? applyCompletionSchema(attemptCompletion as OpenAI.Chat.ChatCompletionFunctionTool, completionSchema)
			: attemptCompletion,
		ragSearch,
		gitSearch,
		lspSearch,
		createDirectory,
		createNewWorkspace,
		executeCommand,
		fetchWebPage,
		fileTool,
		findFiles,
		generateImage,
		getChangedFiles,
		getErrors,
		getProjectSetupInfo,
		// get_search_results removed — merged into grep_search
		insertEdit,
		listCodeUsages,
		listFiles,
		newTask,
		readCommandOutput,
		createReadFileTool(readFileOptions),
		readProjectStructure,
		renameSymbol,
		runSlashCommand,
		skillsToolDef,
		searchReplace,
		edit_file,
		editTool,
		grepSearch,
		switchMode,
		setTaskTitle,
		giveFeedback,
		checkTaskStatus,
		waitForTask,
		listBackgroundTasks,
		cancelTasks,
		answerSubtaskQuestion,
		callMcpToolAsync,
		checkMcpCallStatus,
		waitForMcpCall,
		updateTodoList,
		sed,
		sendMessageToTask,
		sleep,
		wait,
		viewImage,
		writeToFile,
	]
	// A parent-locked title means the agent cannot rename itself, so don't even
	// surface the tool (it would only be refused by SetTaskTitleTool at runtime).
	return titleLocked ? tools.filter((t) => getToolFunctionName(t) !== "set_task_title") : tools
}

/** Function name of a native tool definition (all native tools are functions). */
function getToolFunctionName(tool: OpenAI.Chat.ChatCompletionTool): string {
	return (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
