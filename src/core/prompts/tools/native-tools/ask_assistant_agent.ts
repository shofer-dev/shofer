import type OpenAI from "openai"
import { DEFAULT_ASSISTANT_SOFT_TIMEOUT_SEC, DEFAULT_ASSISTANT_SOFT_RESULT_LENGTH } from "@shofer/types"

const ASK_ASSISTANT_AGENT_DESCRIPTION = `Ask a question to the persistent assistant agent that maintains long-term context about the codebase. The assistant agent runs on a separate, cost-optimized model and accumulates codebase knowledge over time. Use this for simple questions about the code that don't require the full task context to be loaded.

This tool is synchronous — the calling task will block until the answer is returned or the timeout is reached.

Parameters:
- question (string, required): The question to ask the assistant agent.
- contextFiles (string[], optional): File paths that are relevant to this question. The assistant agent will load these into its context window if they aren't already present.
- timeoutMs (number, optional): Maximum time to wait for an answer in milliseconds. Defaults to 300000 (5 minutes). If the timeout is exceeded, processing is aborted and the tool returns a timeout error. This is a HARD limit.
- softTimeoutSec (number, optional): Soft recommendation in seconds for how long the assistant agent should spend on this question (default: ${DEFAULT_ASSISTANT_SOFT_TIMEOUT_SEC}). Embedded in the prompt as guidance — the agent will try to wrap up around that time but is NOT cancelled.
- softResultLength (number, optional): Soft recommendation in characters for the maximum length of the assistant agent's final answer (default: ${DEFAULT_ASSISTANT_SOFT_RESULT_LENGTH}). The agent will aim to keep its answer under that size but is NOT post-truncated.

Example: Asking about a codebase structure
{ "question": "What does the UserService class do and where is it defined?" }

Example: Asking with context files
{ "question": "How does the auth middleware work?", "contextFiles": ["src/middleware/auth.ts"] }

Example: Asking with soft constraints (quick + terse)
{ "question": "List the public methods of FooService.", "softTimeoutSec": 20, "softResultLength": 500 }`

const QUESTION_PARAMETER_DESCRIPTION = `The question to ask the assistant agent`

const CONTEXT_FILES_PARAMETER_DESCRIPTION = `Optional file paths that are relevant to this question. The assistant agent will load these into its context window.`

const TIMEOUT_MS_PARAMETER_DESCRIPTION = `Maximum time to wait for an answer in milliseconds (default: 300000 = 5 minutes). HARD limit.`

const SOFT_TIMEOUT_SEC_PARAMETER_DESCRIPTION = `Soft recommendation in seconds for how long the assistant agent should spend on this question (default: ${DEFAULT_ASSISTANT_SOFT_TIMEOUT_SEC}). Embedded in the prompt as guidance; not enforced as cancellation.`

const SOFT_RESULT_LENGTH_PARAMETER_DESCRIPTION = `Soft recommendation in characters for the maximum length of the assistant agent's final answer (default: ${DEFAULT_ASSISTANT_SOFT_RESULT_LENGTH}). Embedded in the prompt as guidance; not enforced via truncation.`

export default {
	type: "function",
	function: {
		name: "ask_assistant_agent",
		description: ASK_ASSISTANT_AGENT_DESCRIPTION,
		// `strict: true` is intentionally omitted: it would force every listed
		// property into `required`, which defeats the point of having truly
		// optional `contextFiles` / `timeoutMs` / `softTimeoutSec` /
		// `softResultLength` parameters that the model can simply leave out
		// of the call.
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
				softTimeoutSec: {
					type: "number",
					description: SOFT_TIMEOUT_SEC_PARAMETER_DESCRIPTION,
				},
				softResultLength: {
					type: "number",
					description: SOFT_RESULT_LENGTH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["question"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
