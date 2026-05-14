import type OpenAI from "openai"

const ASK_HELPER_AGENT_DESCRIPTION = `Ask a question to the persistent helper agent that maintains long-term context about the codebase. The helper agent runs on a separate, cost-optimized model and accumulates codebase knowledge over time. Use this for simple questions about the code that don't require the full task context to be loaded.

This tool is synchronous — the calling task will block until the answer is returned or the timeout is reached.

Parameters:
- question (string, required): The question to ask the helper agent.
- contextFiles (string[], optional): File paths that are relevant to this question. The helper agent will load these into its context window if they aren't already present.
- timeoutMs (number, optional): Maximum time to wait for an answer in milliseconds. Defaults to 300000 (5 minutes). If the timeout is exceeded, processing is aborted and the tool returns a timeout error.

Example: Asking about a codebase structure
{ "question": "What does the UserService class do and where is it defined?" }

Example: Asking with context files
{ "question": "How does the auth middleware work?", "contextFiles": ["src/middleware/auth.ts"] }`

const QUESTION_PARAMETER_DESCRIPTION = `The question to ask the helper agent`

const CONTEXT_FILES_PARAMETER_DESCRIPTION = `Optional file paths that are relevant to this question. The helper agent will load these into its context window.`

const TIMEOUT_MS_PARAMETER_DESCRIPTION = `Maximum time to wait for an answer in milliseconds (default: 300000 = 5 minutes)`

export default {
	type: "function",
	function: {
		name: "ask_helper_agent",
		description: ASK_HELPER_AGENT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: QUESTION_PARAMETER_DESCRIPTION,
				},
				contextFiles: {
					type: "array",
					items: { type: "string" },
					description: CONTEXT_FILES_PARAMETER_DESCRIPTION,
				},
				timeoutMs: {
					type: "number",
					description: TIMEOUT_MS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["question"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
