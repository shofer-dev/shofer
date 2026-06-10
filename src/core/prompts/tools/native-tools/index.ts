import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { apply_diff } from "./apply_diff"
import applyPatch from "./apply_patch"
import askFollowupQuestion from "./ask_followup_question"
import attemptCompletion from "./attempt_completion"
import ragSearch from "./rag_search"

/**
 * Return a deep copy of the standard `attempt_completion` tool definition
 * with its `result` parameter schema replaced by the given JSON Schema
 * contract.
 *
 * The contract schema is injected as `result.parameters` so providers with
 * constrained decoding (OpenAI/Gemini) enforce it at decode time.
 * Providers without (DeepSeek Cloud) treat it as a semantic hint.
 */
function applyCompletionSchema(
	base: OpenAI.Chat.ChatCompletionFunctionTool,
	schema: Record<string, unknown>,
): OpenAI.Chat.ChatCompletionFunctionTool {
	return {
		...base,
		function: {
			...base.function,
			parameters: {
				type: "object",
				properties: {
					result: schema as OpenAI.FunctionParameters,
					rating: {
						type: "string",
						description: "Self-assessment rating: 'poor', 'well', or 'excellent'",
						enum: ["poor", "well", "excellent"],
					},
					feedback: {
						type: "string",
						description:
							"Optional feedback for Shofer.Dev engineers to improve tooling, system prompt, etc. Only provide if you detected something that didn't work as expected or have a concrete improvement idea.",
					},
				},
				required: ["result", "rating"],
				additionalProperties: false,
			},
			// Keep the base strict flag — it's already true on attempt_completion
			strict: true,
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
import askAssistantAgent from "./ask_assistant_agent"
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
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false, completionSchema } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}

	const tools: OpenAI.Chat.ChatCompletionTool[] = [
		askAssistantAgent,
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
		viewImage,
		writeToFile,
	]
	return tools
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
