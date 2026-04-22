import type OpenAI from "openai"

const NEW_TASK_DESCRIPTION = `Create a new task instance in the chosen mode using your provided message and initial todo list (if required).

Synchronous mode (default, is_background omitted or false):
CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools in the same message turn. The parent task will block until the child completes.

Async/background mode (is_background=true):
The child task starts immediately and runs concurrently. The parent receives the child's task_id and continues without blocking. Use check_task_status or wait_for_task to retrieve results later. Multiple background tasks can be started in parallel.`

const MODE_PARAMETER_DESCRIPTION = `Slug of the mode to begin the new task in (e.g., code, debug, architect)`

const MESSAGE_PARAMETER_DESCRIPTION = `Initial user instructions or context for the new task`

const TODOS_PARAMETER_DESCRIPTION = `Optional initial todo list written as a markdown checklist; required when the workspace mandates todos`

const IS_BACKGROUND_PARAMETER_DESCRIPTION = `When true, start the child task in the background and return immediately without blocking the parent. Defaults to false (synchronous delegation).`

const TASK_ID_PARAMETER_DESCRIPTION = `Optional caller-specified identifier for the background task. If omitted, a unique ID is generated. Only used when is_background is true.`

export default {
	type: "function",
	function: {
		name: "new_task",
		description: NEW_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				mode: {
					type: "string",
					description: MODE_PARAMETER_DESCRIPTION,
				},
				message: {
					type: "string",
					description: MESSAGE_PARAMETER_DESCRIPTION,
				},
				todos: {
					type: ["string", "null"],
					description: TODOS_PARAMETER_DESCRIPTION,
				},
				is_background: {
					type: ["boolean", "null"],
					description: IS_BACKGROUND_PARAMETER_DESCRIPTION,
				},
				task_id: {
					type: ["string", "null"],
					description: TASK_ID_PARAMETER_DESCRIPTION,
				},
			},
			required: ["mode", "message", "todos", "is_background", "task_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
