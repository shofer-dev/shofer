import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { apply_diff } from "./apply_diff"
import applyPatch from "./apply_patch"
import askFollowupQuestion from "./ask_followup_question"
import attemptCompletion from "./attempt_completion"
import ragSearch from "./rag_search"
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
import askHelperAgent from "./ask_helper_agent"
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
import sed from "./sed"
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
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}

	return [
		askHelperAgent,
		accessMcpResource,
		apply_diff,
		applyPatch,
		askFollowupQuestion,
		attemptCompletion,
		ragSearch,
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
		updateTodoList,
		sed,
		sleep,
		viewImage,
		writeToFile,
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
