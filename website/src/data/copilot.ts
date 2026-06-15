export interface CopilotComparison {
	aspect: string
	copilot: string
	shofer: string
}

export const copilotComparisons: CopilotComparison[] = [
	{
		aspect: "Data Processing",
		copilot: "Cloud-proxied through Microsoft/GitHub infrastructure",
		shofer: "100% local execution — no remote server processes your workspace",
	},
	{
		aspect: "Model Ecosystem",
		copilot: "Curated, vendor-managed picker — OpenAI + Anthropic clusters (Google Gemini removed in 2026)",
		shofer: "Bring-Your-Own-Model — Ollama, LM Studio, Anthropic, OpenAI, OpenRouter, niche/open-weight endpoints, and more",
	},
	{
		aspect: "Network Autonomy",
		copilot: "Requires active internet and constant telemetry handshake",
		shofer: "Fully operational in air-gapped environments with local models",
	},
	{
		aspect: "Agent Orchestration",
		copilot:
			"Parallel Cloud Agents (isolated GitHub Actions envs) + third-party agents — orchestrated via remote envs/hooks, not a developer-authored graph",
		shofer: "Declarative Slang execution graph — deterministic message routing, control flow, and budgets, plus spawn/monitor/converse with child agents",
	},
	{
		aspect: "Async MCP",
		copilot: "Synchronous request-response — entire loop blocks on tool calls",
		shofer: "Fire-and-forget async tool calling with parallel execution",
	},
	{
		aspect: "Cost Control",
		copilot: "Monthly credit allotment; no per-task hard USD cap that halts an agent mid-loop",
		shofer: "Per-task / per-session hard USD caps with automatic agent halting",
	},
	{
		aspect: "Pricing",
		copilot: "Usage-based credit-drawdown billing (Free / Pro / Pro+ / Max) with metered overages",
		shofer: "Free Open Source (Apache 2.0) — pay only for your own API tokens, or $0 fully local",
	},
]

export const copilotMigration = {
	title: "Migrating from GitHub Copilot",
	description:
		"Shofer offers everything Copilot does and much more — with full privacy, model autonomy, and granular control over every aspect of your AI coding experience.",
	command: "/migrate-from-copilot",
	docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_copilot_users.md",
}
