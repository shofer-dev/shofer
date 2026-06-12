import type OpenAI from "openai"

const SEND_MESSAGE_TO_TASK_DESCRIPTION = `Send a message to a peer task sharing the same root task. Two modes: async (fire-and-forget, wait=false) and sync (blocking with mandatory timeout, wait=true). The caller and the target must share a root task (the root/parent task can message any task in its tree; sub-tasks require knownPeers). Discover the target's task ID via list_background_tasks(scope="peers").

IMPORTANT — fail-fast busy check: Messages to a BUSY target are REJECTED immediately when the target cannot meaningfully receive them. Sync messages are rejected for all busy states (running, waiting, waiting_input). Async messages are rejected for waiting_input and waiting targets, but are allowed for running targets (the notification rides along in the system prompt on the next API call). Non-busy targets (idle, completed, paused) always accept messages.

ASYNC MODE (wait=false, default):
- The tool returns immediately. No blocking.
- For a running recipient: the message is injected into the recipient's system prompt on its next turn (PEER MESSAGE notification). The recipient may finish its current work first and respond later.
- For a non-busy recipient (idle, completed, paused): the message is enqueued as an annotated user-turn that wakes/resumes the recipient so it can process the message.
- The recipient may optionally respond using send_message_to_task.
- BUSY TASKS REJECT: async messages to busy targets in waiting_input or waiting states fail immediately. Running targets are allowed.

SYNC MODE (wait=true):
- The sender BLOCKS until the recipient calls attempt_completion or the timeout (default 120s) expires.
- The message is enqueued as a PEER PROMPT that wakes up / restarts idle, completed, or paused recipients. A completed/idle recipient is automatically restarted.
- The recipient MUST respond by calling attempt_completion — its completion result is returned to the blocked sender.
- WARNING: attempt_completion is TERMINAL — the recipient task ends after responding. Only use sync if you intend for the recipient to stop and answer you.
- BUSY TASKS REJECT: sync messages to busy (running, waiting, waiting_input) targets fail immediately. Use async for non-interrupting coordination with running peers.`

const TASK_ID_PARAMETER_DESCRIPTION = `Target peer task ID. Must share the caller's root task (root/parent tasks can message any task in their tree; sub-tasks require knownPeers). Discover via list_background_tasks(scope="peers").`

const MESSAGE_PARAMETER_DESCRIPTION = `The message to deliver. In async mode this appears as a PEER MESSAGE notification in the recipient's system prompt. In sync mode it appears as a PEER PROMPT that the recipient must answer via attempt_completion.`

const WAIT_PARAMETER_DESCRIPTION = `When true, block until the recipient calls attempt_completion or timeout expires. When false (default), fire-and-forget — the message is delivered as a notification to running recipients, or as a user-turn that wakes non-busy (idle/completed/paused) recipients.`

const TIMEOUT_SEC_PARAMETER_DESCRIPTION = `Maximum seconds to wait when wait=true. Default: 120. If the recipient does not respond in time, the sender receives a timeout error and the queued message is retracted.`

export default {
	type: "function",
	function: {
		name: "send_message_to_task",
		description: SEND_MESSAGE_TO_TASK_DESCRIPTION,
		// Note: strict mode is intentionally disabled for this tool.
		// The `wait` and `timeout_sec` parameters are advisory hints — the model
		// MAY omit them and the handler applies defaults. With strict: true, OpenAI
		// Structured Outputs requires ALL properties in `properties` to appear in
		// `required`, forcing the model to emit every optional param on every call.
		// Disabling strict lets the model omit advisory params entirely.
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
