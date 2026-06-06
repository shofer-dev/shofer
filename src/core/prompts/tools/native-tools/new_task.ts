import type OpenAI from "openai"

const NEW_TASK_DESCRIPTION = `Create a new task instance in the chosen mode using your provided message and initial todo list (if required).

Synchronous mode (default, is_background omitted or false):
CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools in the same message turn. The parent task will block until the child completes.

Async/background mode (is_background=true):
The child task starts immediately and runs concurrently. The parent receives the child's task_id and continues without blocking. Use check_task_status or wait_for_task to retrieve results later. Multiple background tasks can be started in parallel.`

const MODE_PARAMETER_DESCRIPTION = `Slug of the mode to begin the new task in (e.g., code, debug, architect)`

const MESSAGE_PARAMETER_DESCRIPTION = `Initial user instructions or context for the new task`

const TODOS_PARAMETER_DESCRIPTION = `Optional initial todo list written as a markdown checklist; required when the workspace mandates todos. IMPORTANT: Do NOT copy the parent task's todo list — each child/subtask manages its own independent todo list starting fresh.`

const IS_BACKGROUND_PARAMETER_DESCRIPTION = `When true, start the child task in the background and return immediately without blocking the parent. Defaults to false (synchronous delegation).`

const SOFT_RESULT_LENGTH_PARAMETER_DESCRIPTION = `Soft suggestion for how many characters the parent is willing to accept as the completion result. The subtask should aim to keep its attempt_completion result within this budget by summarizing concisely, but it is not a hard limit — the parent may handle longer results. Defaults to 2000. Hard safety cap: 100000 characters.`

const SOFT_TIMEOUT_SEC_PARAMETER_DESCRIPTION = `Soft guidance (in seconds) for how long the parent expects to wait for this subtask. Not a hard deadline; the parent may wait longer and the child may take longer. Defaults to 300 (5 minutes). Use this to pace your work accordingly.`

const PEER_TASK_IDS_PARAMETER_DESCRIPTION = `Least-privilege peer scope: the spawned child's baseline knownPeers is parent-only. If provided, these task IDs are added (must share rootTaskId). If omitted/null, the child can only communicate with its parent and its own children — sibling access is denied. Validated against rootTaskId at spawn time — unknown IDs are rejected.`

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
				softResultLength: {
					type: "number",
					description: SOFT_RESULT_LENGTH_PARAMETER_DESCRIPTION,
				},
				softTimeoutSec: {
					type: "number",
					description: SOFT_TIMEOUT_SEC_PARAMETER_DESCRIPTION,
				},
				peer_task_ids: {
					type: ["array", "null"],
					items: { type: "string" },
					description: PEER_TASK_IDS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["mode", "message", "todos", "is_background"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
