import type OpenAI from "openai"

const SEND_MESSAGE_TO_TASK_DESCRIPTION = `Send a message to a peer task sharing the same root task. Two modes: async (fire-and-forget, wait=false) and sync (blocking with mandatory timeout, wait=true).

Async mode (wait = false, default): The tool returns immediately. The recipient sees the message as a notification on its next turn (or is woken up if idle). The recipient may optionally respond using send_message_to_task.

Sync mode (wait = true): The sender blocks until the recipient calls attempt_completion or the timeout expires. The recipient answers by calling attempt_completion — its result is returned to the blocked sender. WARNING: attempt_completion is terminal, so the recipient task ends after responding. Only sync-message a running peer if you intend to interrupt and redirect it; for coordination without interruption, prefer async mode.

Both the caller and the target must be background (async) tasks spawned with is_background=true.`

const TASK_ID_PARAMETER_DESCRIPTION = `Target peer task ID (must share the caller's rootTaskId).`

const MESSAGE_PARAMETER_DESCRIPTION = `The message to deliver to the peer.`

const WAIT_PARAMETER_DESCRIPTION = `When true, block until the recipient responds or timeout expires. Default: false (async / fire-and-forget).`

const TIMEOUT_SEC_PARAMETER_DESCRIPTION = `Maximum seconds to wait when wait=true. Default: 120. Always applied in sync mode — no unbounded blocking.`

export default {
	type: "function",
	function: {
		name: "send_message_to_task",
		description: SEND_MESSAGE_TO_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_id: {
					type: "string",
					description: TASK_ID_PARAMETER_DESCRIPTION,
				},
				message: {
					type: "string",
					description: MESSAGE_PARAMETER_DESCRIPTION,
				},
				wait: {
					type: ["boolean", "null"],
					description: WAIT_PARAMETER_DESCRIPTION,
				},
				timeout_sec: {
					type: ["number", "null"],
					description: TIMEOUT_SEC_PARAMETER_DESCRIPTION,
				},
			},
			required: ["task_id", "message"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
