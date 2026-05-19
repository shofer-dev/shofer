import type OpenAI from "openai"

const CHECK_MCP_CALL_STATUS_DESCRIPTION = `Check the status of an async MCP tool call previously started with call_mcp_tool_async. Non-blocking — returns immediately with the current status (running, completed, error, cancelled). When the call has finished, the response also includes the tool's result or error message.`

const CALL_ID_PARAMETER_DESCRIPTION = `The call ID returned when the async MCP tool call was started.`

export default {
	type: "function",
	function: {
		name: "check_mcp_call_status",
		description: CHECK_MCP_CALL_STATUS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				call_id: {
					type: "string",
					description: CALL_ID_PARAMETER_DESCRIPTION,
				},
			},
			required: ["call_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
