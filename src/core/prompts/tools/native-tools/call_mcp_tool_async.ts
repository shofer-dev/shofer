import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "./defineNativeTool"

const CALL_MCP_TOOL_ASYNC_DESCRIPTION = `Call an MCP server tool asynchronously (fire-and-forget). Returns immediately with a call_id; use check_mcp_call_status to poll or wait_for_mcp_call to block. Prefer this over use_mcp_tool / mcp--<server>--<tool> for long-running calls or when fanning out multiple independent MCP calls in parallel.`

const SERVER_NAME_PARAMETER_DESCRIPTION = `The name of the MCP server providing the tool.`

const TOOL_NAME_PARAMETER_DESCRIPTION = `The name of the tool to execute on the MCP server.`

const ARGUMENTS_PARAMETER_DESCRIPTION = `A JSON object containing the tool's input parameters, following the tool's input schema. Pass null if the tool takes no arguments.`

const SOURCE_PARAMETER_DESCRIPTION = `Optional disambiguator when multiple MCP servers share the same name. "global" selects the user-level server, "project" the workspace-level one. Omit or pass null to use the default resolution.`

export default defineNativeTool({
	name: "call_mcp_tool_async",
	description: CALL_MCP_TOOL_ASYNC_DESCRIPTION,
	schema: z.object({
		server_name: z.string().describe(SERVER_NAME_PARAMETER_DESCRIPTION),
		tool_name: z.string().describe(TOOL_NAME_PARAMETER_DESCRIPTION),
		// Free-form object: the called tool's own input schema governs its shape.
		arguments: z.record(z.string(), z.unknown()).describe(ARGUMENTS_PARAMETER_DESCRIPTION).optional(),
		source: z.enum(["global", "project"]).describe(SOURCE_PARAMETER_DESCRIPTION).optional(),
	}),
})
