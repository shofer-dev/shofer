export interface ClaudeCodeComparison {
	aspect: string
	claudeCode: string
	shofer: string
}

export const claudeCodeComparisons: ClaudeCodeComparison[] = [
	{
		aspect: "Primary Surface",
		claudeCode: "Terminal-first CLI, with companion IDE and web/desktop apps",
		shofer: "Native VS Code GUI cockpit — task tree, live diagrams, cost panels — plus a headless CLI",
	},
	{
		aspect: "Model Ecosystem",
		claudeCode: "Anthropic Claude models only (Opus / Sonnet / Haiku)",
		shofer: "Bring-Your-Own-Model — Anthropic, OpenAI, OpenRouter, xAI, Bedrock, or local via Ollama/LM Studio",
	},
	{
		aspect: "Offline / Air-Gapped",
		claudeCode: "Requires connectivity to Anthropic's API",
		shofer: "Fully operational offline with local models",
	},
	{
		aspect: "Source Availability",
		claudeCode: "Proprietary agent (open SDK, closed core)",
		shofer: "100% open-source (Apache 2.0) — inspect every tool hook and prompt",
	},
	{
		aspect: "Multi-Agent Orchestration",
		claudeCode: "Imperative subagents the model spawns at runtime",
		shofer: "Declarative, deterministic Slang Workflows — repeatable, inspectable, and visualized",
	},
	{
		aspect: "Semantic RAG (code + git)",
		claudeCode: "Reads files and runs git on demand; no persistent index",
		shofer: "Indexes code and the entire git log; git_search answers why/when by concept",
	},
	{
		aspect: "Cost Control",
		claudeCode: "Per-session reporting",
		shofer: "Hard per-task / per-session USD caps that halt runaway loops",
	},
]

export const claudeCodeMigration = {
	title: "Migrating from Claude Code",
	description:
		"Keep the agentic power, but bring any model (including local/offline), a graphical cockpit, deterministic Slang Workflows, semantic code & git-log search, native worktrees, and hard cost caps.",
	command: "/migrate-from-claude",
	docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_claude_code_users.md",
}
