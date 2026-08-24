import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource.js"
import { apply_diff } from "./apply_diff.js"
import applyPatch from "./apply_patch.js"
import askFollowupQuestion from "./ask_followup_question.js"
import attemptCompletion from "./attempt_completion.js"

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
 * (§4 of docs/output_contract_enforcement.md) so it is safe to send to
 * every provider.  Providers with constrained decoding (OpenAI/Gemini)
 * enforce it at decode time; providers without (DeepSeek Cloud) treat it
 * as a strong semantic hint.
 */
function applyCompletionSchema(
	base: OpenAI.Chat.ChatCompletionFunctionTool,
	schema: Record<string, unknown>,
): OpenAI.Chat.ChatCompletionFunctionTool {
	const baseParams = base.function.parameters as Record<string, unknown> | undefined
	const baseProps = (baseParams?.properties as Record<string, unknown> | undefined) ?? {}
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
				// Keep `feedback` optional in the contract variant. The base tool is
				// defined via `defineNativeTool`, whose strict pre-bake lists every
				// property (incl. the optional `feedback`) in `required`; filter it
				// out here so the output-contract variant requires only result+rating.
				required: [
					"result",
					...((baseParams?.required as string[] | undefined)?.filter(
						(k: string) => k !== "result" && k !== "feedback",
					) ?? []),
				],
				additionalProperties: (baseParams?.additionalProperties as boolean | undefined) ?? false,
			},
		},
	}
}
import describeTools from "./describe_tools.js"
import lspSearch from "./lsp_search.js"
import createDirectory from "./create_directory.js"
import createNewWorkspace from "./create_new_workspace.js"
import editTool from "./edit.js"
import executeCommand from "./execute_command.js"
import fetchWebPage from "./fetch_web_page.js"
import fileTool from "./file.js"
import findFiles from "./find_files.js"
import generateImage from "./generate_image.js"
import getErrors from "./get_errors.js"
import getProjectSetupInfo from "./get_project_setup_info.js"
// get_search_results removed — merged into grep_search
import insertEdit from "./insert_edit.js"
import listCodeUsages from "./list_code_usages.js"
import listFiles from "./list_files.js"
import newTask from "./new_task.js"
import readCommandOutput from "./read_command_output.js"
import readOutputChannel from "./read_output_channel.js"
import { createReadFileTool, type ReadFileToolOptions } from "./read_file.js"
import readProjectStructure from "./read_project_structure.js"
import renameSymbol from "./rename_symbol.js"
import runSlashCommand from "./run_slash_command.js"
import skillsToolDef from "./skills.js"
import searchReplace from "./search_replace.js"
import edit_file from "./edit_file.js"
import grepSearch from "./grep_search.js"
import switchMode from "./switch_mode.js"
import updateTodoList from "./update_todo_list.js"
import setTaskTitle from "./set_task_title.js"
import giveFeedback from "./give_feedback.js"
import checkTaskStatus from "./check_task_status.js"
import waitForTask from "./wait_for_task.js"
import listBackgroundTasks from "./list_background_tasks.js"
import cancelTasks from "./cancel_tasks.js"
import answerSubtaskQuestion from "./answer_subtask_question.js"
import callMcpToolAsync from "./call_mcp_tool_async.js"
import checkMcpCallStatus from "./check_mcp_call_status.js"
import waitForMcpCall from "./wait_for_mcp_call.js"
import sed from "./sed.js"
import sendMessageToTask from "./send_message_to_task.js"
import sleep from "./sleep.js"
import wait from "./wait.js"
import viewImage from "./view_image.js"
import writeToFile from "./write_to_file.js"

export { getMcpServerTools } from "./mcp_server.js"
export { convertOpenAIToolToAnthropic, convertOpenAIToolsToAnthropic } from "./converters.js"
export type { ReadFileToolOptions } from "./read_file.js"

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
		accessMcpResource,
		apply_diff,
		applyPatch,
		askFollowupQuestion,
		completionSchema
			? applyCompletionSchema(attemptCompletion as OpenAI.Chat.ChatCompletionFunctionTool, completionSchema)
			: attemptCompletion,
		describeTools,
		lspSearch,
		createDirectory,
		createNewWorkspace,
		executeCommand,
		fetchWebPage,
		fileTool,
		findFiles,
		generateImage,
		getErrors,
		getProjectSetupInfo,
		// get_search_results removed — merged into grep_search
		insertEdit,
		listCodeUsages,
		listFiles,
		newTask,
		readCommandOutput,
		readOutputChannel,
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
