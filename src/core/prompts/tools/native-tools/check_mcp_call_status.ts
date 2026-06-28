import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "./defineNativeTool"

const CHECK_MCP_CALL_STATUS_DESCRIPTION = `Check the status of an async MCP tool call previously started with call_mcp_tool_async. Non-blocking — returns immediately with the current status (running, completed, error, cancelled). When the call has finished, the response also includes the tool's result or error message.`

const CALL_ID_PARAMETER_DESCRIPTION = `The call ID returned when the async MCP tool call was started.`

export default defineNativeTool({
	name: "check_mcp_call_status",
	description: CHECK_MCP_CALL_STATUS_DESCRIPTION,
	schema: z.object({
		call_id: z.string().describe(CALL_ID_PARAMETER_DESCRIPTION),
	}),
})
