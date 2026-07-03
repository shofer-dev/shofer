import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const FIND_FILES_DESCRIPTION = `Request to find files matching a glob pattern. This tool searches for files by name pattern across the workspace, useful for locating specific file types or files in specific directories.

Parameters:
- pattern: (required) The glob pattern to match files (e.g., '*.ts', '**/*.json', 'src/**/*.test.js'). Patterns are resolved relative to the workspace root — if you are unsure of the exact directory prefix, prepend "**/" to search the entire workspace (e.g., "**/browser.ts" instead of "packages/core/src/browser.ts").
- maxResults: (optional) Maximum number of results to return. Defaults to 100.

Example: Find all TypeScript files
{ "pattern": "**/*.ts" }

Example: Find all JSON files in config directory
{ "pattern": "config/**/*.json" }

Example: Find test files with limit
{ "pattern": "**/*.test.ts", "maxResults": 50 }

Example: Find a file when you don't know the full path prefix
{ "pattern": "**/browser.ts" }`

const PATTERN_PARAMETER_DESCRIPTION = `Glob pattern to match files (e.g., '*.ts', '**/*.json')`

const MAX_RESULTS_PARAMETER_DESCRIPTION = `Maximum number of results to return (default: 100)`

/**
 * `find_files` — first tool migrated to the schema-as-contract foundation
 * (`defineNativeTool`, §3). The Zod schema is the single source of truth: the
 * OpenAI function definition and the static argument type are both derived from
 * it. See `__tests__/find_files.schema-contract.test.ts` for the equivalence
 * proof that the model sees the same schema as before this migration.
 */
const findFiles = defineNativeTool({
	name: "find_files",
	description: FIND_FILES_DESCRIPTION,
	schema: z.object({
		pattern: z.string().describe(PATTERN_PARAMETER_DESCRIPTION),
		maxResults: z.number().describe(MAX_RESULTS_PARAMETER_DESCRIPTION).optional(),
	}),
})

export default findFiles
