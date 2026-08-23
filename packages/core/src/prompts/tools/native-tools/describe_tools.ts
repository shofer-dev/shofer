import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

/**
 * `describe_tools` — the discovery half of on-demand schema loading.
 *
 * A mode that declares `tools_full_schema` sends most of its tools to the model
 * as stubs (name + one line, no parameters). This tool hands back the FULL
 * contract of any of them, answered entirely client-side from the definitions
 * the tool build already assembled — no MCP round trip, and nothing is added to
 * the request's tools array, which is what keeps the provider's prompt-prefix
 * cache alive (the answer rides the append-only message stream instead).
 */
const DESCRIBE_TOOLS_DESCRIPTION = `Return the full parameter schema of one or more tools. Tools whose description says their parameters are omitted are declared to you as stubs: call describe_tools with their names FIRST, then call them with the arguments the returned schema requires. Ask for every tool you are about to use in a single call. Names must be exactly as they appear in your tool list.`

const NAMES_DESCRIPTION = `Tool names to describe, exactly as they appear in your tool list (e.g. "some_tool" or "mcp--<server>--<tool>").`

export default defineNativeTool({
	name: "describe_tools",
	description: DESCRIBE_TOOLS_DESCRIPTION,
	schema: z.object({
		names: z.array(z.string()).describe(NAMES_DESCRIPTION),
	}),
})
