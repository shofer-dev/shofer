import type { AssistantAgentManager } from "../../../services/assistant-agent/manager"

/**
 * Generate the Assistant Agent section for the task agent's system prompt.
 * Informs the model about the persistent assistant agent's availability,
 * capabilities, and the `ask_assistant_agent` tool.
 *
 * The section is included only when the assistant agent is available (Ready or Busy state).
 * When the agent is unavailable (disabled, unconfigured, in error, etc.), the section
 * is omitted entirely — the `ask_assistant_agent` tool is also filtered out in those cases.
 *
 * @param cwd - Current workspace directory path
 * @param assistantAgentManager - The AssistantAgentManager instance (optional)
 */
export function getAssistantAgentSection(cwd: string, assistantAgentManager?: AssistantAgentManager): string {
	if (!assistantAgentManager || !assistantAgentManager.isAssistantAgentAvailable) {
		return ""
	}

	const modelId = assistantAgentManager.modelId
	const provider = assistantAgentManager.provider
	const contextFilesCount = assistantAgentManager.contextFiles.length
	const estimatedTokens = assistantAgentManager.estimatedTokenCount
	const maxTokens = assistantAgentManager.maxContextTokens
	const fillPercent = maxTokens > 0 ? Math.round((estimatedTokens / maxTokens) * 100) : 0
	const isNearlyFull = assistantAgentManager.isContextNearlyFull

	const fillWarning = isNearlyFull
		? `\n- ⚠️ The assistant agent's context window is nearly full (${fillPercent}%). Consider using \`clear_context\` if answers become less relevant.`
		: ""

	return `====

ASSISTANT AGENT

A persistent, read-only codebase Q&A agent is available for your use via the \`ask_assistant_agent\` tool. It runs on a separate, cost-optimized model (${modelId} via ${provider}) and accumulates codebase knowledge over time.

Key facts:
- **Persistent context** — survives task termination and VS Code restarts. Questions asked by previous tasks (and their answers) are retained in its conversation history.
- **File-aware** — currently has ${contextFilesCount} file(s) in context (~${fillPercent}% of ${maxTokens.toLocaleString()}-token window).${fillWarning}
- **Read-only** — the assistant agent cannot modify files, run commands, or access MCP tools. It can only read and search the codebase.
- **Serialized access** — questions are processed one at a time via a FIFO queue. If another task is already waiting, your question will be queued.

Best practices:
- Use for **simple, factual questions** about the codebase that don't need your full task context (e.g., "What does UserService do?", "Where is authentication logic?").
- Provide **contextFiles** when the question is about specific files — the assistant agent will load them into its context window.
- Use **softTimeoutSec** and **softResultLength** to guide response length/speed when you need a quick, terse answer.
- Do NOT use for complex multi-step reasoning, writing code, or tasks that require executing commands.
`
}
