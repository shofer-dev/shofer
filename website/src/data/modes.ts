export interface Mode {
	name: string
	icon: string
	description: string
	groups: string
	slug: string
}

export const modes: Mode[] = [
	{
		name: "Code",
		icon: "💻",
		description: "Writing, modifying, and refactoring code. Broadest tool access.",
		groups: "read, write, execute, mcp, mode, subtasks, questions",
		slug: "code",
	},
	{
		name: "Architect",
		icon: "🏗️",
		description: "Planning and designing before writing code. Read + markdown-only writes.",
		groups: "read, write (.md only), mcp, questions",
		slug: "architect",
	},
	{
		name: "Ask",
		icon: "❓",
		description: "Getting explanations, answers, or recommendations. Read-only + MCP.",
		groups: "read, mcp",
		slug: "ask",
	},
	{
		name: "Debug",
		icon: "🪲",
		description: "Troubleshooting errors and diagnosing root causes.",
		groups: "read, write, execute, mcp, subtasks, questions",
		slug: "debug",
	},
	{
		name: "Orchestrator",
		icon: "🪃",
		description: "Coordinating complex multi-step work by delegating to sub-tasks.",
		groups: "delegates via new_task",
		slug: "orchestrator",
	},
]
