import type OpenAI from "openai"

const CALL_MCP_TOOL_ASYNC_DESCRIPTION = `Call an MCP server tool asynchronously (fire-and-forget). Returns immediately with a call_id; use check_mcp_call_status to poll or wait_for_mcp_call to block. Prefer this over use_mcp_tool / mcp--<server>--<tool> for long-running calls or when fanning out multiple independent MCP calls in parallel.`

const SERVER_NAME_PARAMETER_DESCRIPTION = `The name of the MCP server providing the tool.`

const TOOL_NAME_PARAMETER_DESCRIPTION = `The name of the tool to execute on the MCP server.`

const ARGUMENTS_PARAMETER_DESCRIPTION = `A JSON object containing the tool's input parameters, following the tool's input schema. Pass null if the tool takes no arguments.`

const SOURCE_PARAMETER_DESCRIPTION = `Optional disambiguator when multiple MCP servers share the same name. "global" selects the user-level server, "project" the workspace-level one. Omit or pass null to use the default resolution.`

export default {
	type: "function",
	function: {
		name: "call_mcp_tool_async",
		description: CALL_MCP_TOOL_ASYNC_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				server_name: {
					type: "string",
					description: SERVER_NAME_PARAMETER_DESCRIPTION,
				},
				tool_name: {
					type: "string",
					description: TOOL_NAME_PARAMETER_DESCRIPTION,
				},
				arguments: {
					type: ["object", "null"],
					description: ARGUMENTS_PARAMETER_DESCRIPTION,
					additionalProperties: true,
				},
				source: {
					type: ["string", "null"],
					enum: ["global", "project", null],
					description: SOURCE_PARAMETER_DESCRIPTION,
				},
			},
			required: ["server_name", "tool_name", "arguments", "source"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
