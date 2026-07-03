import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const WAIT_FOR_MCP_CALL_DESCRIPTION = `Block until one or more async MCP tool calls (started with call_mcp_tool_async) complete, then return their results. Use the \`wait\` parameter to control whether to wait for ALL calls or just ANY one of them. The call is event-driven — it does not poll. Use this after starting async MCP calls when you need their results before continuing.`

const CALL_IDS_PARAMETER_DESCRIPTION = `One or more call IDs returned when the async MCP tool calls were started. Accepts a single ID or a list of IDs.`

const WAIT_PARAMETER_DESCRIPTION = `Completion strategy. "all" (default) — waits until every listed call reaches a terminal state. "any" — returns as soon as at least one call completes. Omit or pass null to use the default ("all").`

const TIMEOUT_PARAMETER_DESCRIPTION = `Maximum seconds to wait before returning. Default: 120. If the condition is not met within the timeout the tool returns with each unfinished call marked as status="timeout". Omit or pass null to use the default.`

export default defineNativeTool({
	name: "wait_for_mcp_call",
	description: WAIT_FOR_MCP_CALL_DESCRIPTION,
	schema: z.object({
		call_ids: z.array(z.string()).describe(CALL_IDS_PARAMETER_DESCRIPTION),
		wait: z.enum(["all", "any"]).describe(WAIT_PARAMETER_DESCRIPTION).optional(),
		timeout: z.number().describe(TIMEOUT_PARAMETER_DESCRIPTION).optional(),
	}),
})
