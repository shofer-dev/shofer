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
		copilot: "Curated cloud-managed multi-model picker",
		shofer: "Bring-Your-Own-Model — Ollama, LM Studio, Anthropic, OpenAI, OpenRouter, and more",
	},
	{
		aspect: "Network Autonomy",
		copilot: "Requires active internet and constant telemetry handshake",
		shofer: "Fully operational in air-gapped environments with local models",
	},
	{
		aspect: "Agent Orchestration",
		copilot: "Monolithic single-agent — no dynamic sub-agent management",
		shofer: "Agent-to-Agent orchestration — spawn, monitor, and converse with child agents",
	},
	{
		aspect: "Async MCP",
		copilot: "Synchronous request-response — entire loop blocks on tool calls",
		shofer: "Fire-and-forget async tool calling with parallel execution",
	},
	{
		aspect: "Cost Control",
		copilot: "No per-session cost tracking or limits",
		shofer: "Per-task USD cost caps with automatic agent halting",
	},
	{
		aspect: "Subscription",
		copilot: "$10–$39/month SaaS subscription",
		shofer: "Free Open Source (Apache 2.0) — pay only for your own API tokens",
	},
]

export const copilotMigration = {
	title: "Migrating from GitHub Copilot",
	description:
		"Shofer offers everything Copilot does and much more — with full privacy, model autonomy, and granular control over every aspect of your AI coding experience.",
	command: "/migrate-from-copilot",
	docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#11-slash-commands",
}
