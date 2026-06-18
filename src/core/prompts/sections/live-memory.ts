import type { LiveMemoryManager } from "../../../services/live-memory/manager"

/**
 * Generate the Live Memory section for the task agent's system prompt.
 * Informs the model about the persistent live memory agent's availability,
 * capabilities, and the `ask_live_memory` tool.
 *
 * The section is included only when the live memory agent is available (Ready or Busy state).
 * When the agent is unavailable (disabled, unconfigured, in error, etc.), the section
 * is omitted entirely — the `ask_live_memory` tool is also filtered out in those cases.
 *
 * @param cwd - Current workspace directory path
 * @param liveMemoryManager - The LiveMemoryManager instance (optional)
 */
export function getLiveMemorySection(cwd: string, liveMemoryManager?: LiveMemoryManager): string {
	if (!liveMemoryManager || !liveMemoryManager.isLiveMemoryAvailable) {
		return ""
	}

	const modelId = liveMemoryManager.modelId
	const provider = liveMemoryManager.provider
	const contextFilesCount = liveMemoryManager.contextFiles.length
	const estimatedTokens = liveMemoryManager.estimatedTokenCount
	const maxTokens = liveMemoryManager.maxContextTokens
	const fillPercent = maxTokens > 0 ? Math.round((estimatedTokens / maxTokens) * 100) : 0
	const isNearlyFull = liveMemoryManager.isContextNearlyFull

	const fillWarning = isNearlyFull
		? `\n- ⚠️ The live memory agent's context window is nearly full (${fillPercent}%). Consider using \`clear_context\` if answers become less relevant.`
		: ""

	return `====

LIVE MEMORY

A persistent, read-only codebase Q&A agent is available for your use via the \`ask_live_memory\` tool. It runs on a separate, cost-optimized model (${modelId} via ${provider}) and accumulates codebase knowledge over time.

Key facts:
- **Persistent context** — survives task termination and VS Code restarts. Questions asked by previous tasks (and their answers) are retained in its conversation history.
- **File-aware** — currently has ${contextFilesCount} file(s) in context (~${fillPercent}% of ${maxTokens.toLocaleString()}-token window).${fillWarning}
- **Read-only** — the live memory agent cannot modify files, run commands, or access MCP tools. It can only read and search the codebase.
- **Serialized access** — questions are processed one at a time via a FIFO queue. If another task is already waiting, your question will be queued.

Best practices:
- Use for **simple, factual questions** about the codebase that don't need your full task context (e.g., "What does UserService do?", "Where is authentication logic?").
- Provide **contextFiles** when the question is about specific files — the live memory agent will load them into its context window.
- Use **softTimeoutSec** and **softResultLength** to guide response length/speed when you need a quick, terse answer.
- Do NOT use for complex multi-step reasoning, writing code, or tasks that require executing commands.
`
}
