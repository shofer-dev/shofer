import { parametersSchema as z } from "@shofer/types"

import { MAX_SUBTASK_RESULT_LENGTH } from "../../../task/subtask-limits.js"
import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const ATTEMPT_COMPLETION_DESCRIPTION = `After each tool use, the user will respond with the result of that tool use, i.e. if it succeeded or failed, along with any reasons for failure. Once you've received the results of tool uses and can confirm that the task is complete, use this tool to present the result of your work to the user. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again.

IMPORTANT NOTE: This tool CANNOT be used until you've confirmed from the user that any previous tool uses were successful. Failure to do so will result in code corruption and system failure. Before using this tool, you must confirm that you've received successful results from the user for any previous tool uses. If not, then DO NOT use this tool.

If you are running as a subtask with a SUBTASK CONSTRAINTS section in your system prompt, your result will be truncated if it exceeds the specified limit. Keep your result concise and within the character budget.

Parameters:
- result: (required) The result of the task. Formulate this result in a way that is final and does not require further input from the user. Do not write an interrogative sentence (e.g., "Would you like me to…?"). A question mark that is part of a code reference, filename, URL, or technical term is fine.
- rating: (required) A self-assessment of how successfully you completed the task. Use one of: "poor" (significant issues or incomplete), "well" (acceptable but room for improvement), "excellent" (executed excellently, high quality).
- feedback: (optional) Free-text feedback for Shofer.Dev engineers about tooling, system prompt, or other issues encountered during the task. Use this to report things that didn't work as expected or suggest concrete improvements. Only provide this if you noticed something worth reporting.

Example: Completing after updating CSS
{ "result": "I've updated the CSS to use flexbox layout for better responsiveness", "rating": "excellent" }`

const RESULT_PARAMETER_DESCRIPTION = `Final result message to deliver to the user once the task is complete. If running as a subtask, aim to keep within the character budget suggested in your SUBTASK CONSTRAINTS (hard safety cap: ${MAX_SUBTASK_RESULT_LENGTH} characters).`

// `feedback` is optional; `result`/`rating` are required. The output-contract
// variant (see `applyCompletionSchema` in ./index) replaces `result` with a
// per-task schema and keeps `feedback` optional.
export default defineNativeTool({
	name: "attempt_completion",
	description: ATTEMPT_COMPLETION_DESCRIPTION,
	schema: z.object({
		result: z.string().describe(RESULT_PARAMETER_DESCRIPTION),
		rating: z
			.enum(["poor", "well", "excellent"])
			.describe("Self-assessment rating: 'poor', 'well', or 'excellent'"),
		feedback: z
			.string()
			.describe(
				"Optional feedback for Shofer.Dev engineers to improve tooling, system prompt, etc. Only provide if you detected something that didn't work as expected or have a concrete improvement idea.",
			)
			.optional(),
	}),
})
