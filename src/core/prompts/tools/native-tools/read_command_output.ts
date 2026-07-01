import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "@shofer/core"

/**
 * Native tool definition for read_command_output.
 *
 * This tool allows the LLM to retrieve full command output that was truncated
 * during execute_command. When command output exceeds the preview threshold,
 * the full output is persisted to disk and an artifact_id is provided. The
 * LLM can then use this tool to read the full content or search within it.
 */

const READ_COMMAND_OUTPUT_DESCRIPTION = `Retrieve the full output from a command that was truncated in execute_command. Use this tool when:
1. The execute_command result shows "[OUTPUT TRUNCATED - Full output saved to artifact: cmd-XXXX.txt]"
2. You need to see more of the command output beyond the preview
3. You want to search for specific content in large command output

The tool supports two modes:
- **Read mode**: Read output starting from a byte offset with optional limit
- **Search mode**: Filter lines matching a regex or literal pattern (like grep)

Parameters:
- artifact_id: (required) The artifact filename from the truncated output message (e.g., "cmd-1706119234567.txt")
- search: (optional) Pattern to filter lines. Supports regex or literal strings. Case-insensitive. **Omit this parameter entirely if you don't need to filter - do not pass null or empty string.**
- offset: (optional) Byte offset to start reading from. Default: 0. Use for pagination.
- limit: (optional) Maximum bytes to return. Default: 40KB.

Example: Reading truncated command output
{ "artifact_id": "cmd-1706119234567.txt" }

Example: Reading with pagination (after first 40KB)
{ "artifact_id": "cmd-1706119234567.txt", "offset": 40960 }

Example: Searching for errors in build output
{ "artifact_id": "cmd-1706119234567.txt", "search": "error|failed|Error" }

Example: Finding specific test failures
{ "artifact_id": "cmd-1706119234567.txt", "search": "FAIL" }`

const ARTIFACT_ID_DESCRIPTION = `The artifact filename from the truncated command output (e.g., "cmd-1706119234567.txt")`

const SEARCH_DESCRIPTION = `Optional regex or literal pattern to filter lines (case-insensitive, like grep). Omit this parameter if not searching - do not pass null or empty string.`

const OFFSET_DESCRIPTION = `Byte offset to start reading from (default: 0, for pagination)`

const LIMIT_DESCRIPTION = `Maximum bytes to return (default: 40KB)`

export default defineNativeTool({
	name: "read_command_output",
	description: READ_COMMAND_OUTPUT_DESCRIPTION,
	schema: z.object({
		artifact_id: z.string().describe(ARTIFACT_ID_DESCRIPTION),
		search: z.string().describe(SEARCH_DESCRIPTION).optional(),
		offset: z.number().describe(OFFSET_DESCRIPTION).optional(),
		limit: z.number().describe(LIMIT_DESCRIPTION).optional(),
	}),
})
