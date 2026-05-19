import type OpenAI from "openai"

const WAIT_FOR_MCP_CALL_DESCRIPTION = `Block until one or more async MCP tool calls (started with call_mcp_tool_async) complete, then return their results. Use the \`wait\` parameter to control whether to wait for ALL calls or just ANY one of them. The call is event-driven — it does not poll. Use this after starting async MCP calls when you need their results before continuing.`

const CALL_IDS_PARAMETER_DESCRIPTION = `One or more call IDs returned when the async MCP tool calls were started. Accepts a single ID or a list of IDs.`

const WAIT_PARAMETER_DESCRIPTION = `Completion strategy. "all" (default) — waits until every listed call reaches a terminal state. "any" — returns as soon as at least one call completes. Omit or pass null to use the default ("all").`

const TIMEOUT_PARAMETER_DESCRIPTION = `Maximum seconds to wait before returning. Default: 120. If the condition is not met within the timeout the tool returns with each unfinished call marked as status="timeout". Omit or pass null to use the default.`

export default {
	type: "function",
	function: {
		name: "wait_for_mcp_call",
		description: WAIT_FOR_MCP_CALL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				call_ids: {
					type: "array",
					items: { type: "string" },
					description: CALL_IDS_PARAMETER_DESCRIPTION,
				},
				wait: {
					type: ["string", "null"],
					enum: ["all", "any", null],
					description: WAIT_PARAMETER_DESCRIPTION,
				},
				timeout: {
					type: ["number", "null"],
					description: TIMEOUT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["call_ids", "wait", "timeout"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
