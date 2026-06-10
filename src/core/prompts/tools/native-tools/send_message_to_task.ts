import type OpenAI from "openai"

const SEND_MESSAGE_TO_TASK_DESCRIPTION = `Send a message to a peer task sharing the same root task. Two modes: async (fire-and-forget, wait=false) and sync (blocking with mandatory timeout, wait=true). The caller and the target must share a root task and have each other in their knownPeers set. Discover the target's task ID via list_background_tasks(scope="peers").

ASYNC MODE (wait=false, default):
- The tool returns immediately. No blocking.
- The message is injected into the recipient's SYSTEM PROMPT on its next agent loop iteration, formatted as "PEER MESSAGE from task <id>".
- ASYNC DOES NOT WAKE UP idle or completed tasks. If the recipient's event loop is not running, the message will never be delivered.
- Use async for non-urgent coordination — the recipient will see it when it gets to its next turn, but may miss it entirely if it is done working.
- The recipient may optionally respond using send_message_to_task.

SYNC MODE (wait=true):
- The sender BLOCKS until the recipient calls attempt_completion or the timeout (default 120s) expires.
- The message is delivered as a PEER PROMPT that wakes up / restarts the recipient's event loop, EVEN IF THE RECIPIENT IS IDLE OR COMPLETED. An idle (completed) recipient will be automatically restarted and will see the prompt immediately.
- The recipient MUST respond by calling attempt_completion — its completion result is returned to the blocked sender.
- WARNING: attempt_completion is TERMINAL — the recipient task ends after responding. Only use sync if you intend for the recipient to stop and answer you. Do NOT sync-message a peer that is doing independent work you don't want interrupted.
- Sync works regardless of whether the recipient is running, idle, or completed. It is the ONLY way to wake up a completed peer.`

const TASK_ID_PARAMETER_DESCRIPTION = `Target peer task ID. Must share the caller's rootTaskId. Discover via list_background_tasks(scope="peers").`

const MESSAGE_PARAMETER_DESCRIPTION = `The message to deliver. In async mode this appears as a PEER MESSAGE notification in the recipient's system prompt. In sync mode it appears as a PEER PROMPT that the recipient must answer via attempt_completion.`

const WAIT_PARAMETER_DESCRIPTION = `When true, block until the recipient calls attempt_completion or timeout expires. When false (default), fire-and-forget — the message is injected into the recipient's system prompt on its next turn (does NOT wake idle tasks).`

const TIMEOUT_SEC_PARAMETER_DESCRIPTION = `Maximum seconds to wait when wait=true. Default: 120. If the recipient does not respond in time, the sender receives a timeout error and the queued message is retracted.`

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
