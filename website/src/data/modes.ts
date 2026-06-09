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
		name: "Debug",
		icon: "🪲",
		description: "Troubleshooting errors and diagnosing root causes.",
		groups: "read, write, execute, mcp, subtasks, questions",
		slug: "debug",
	},
	{
		name: "Code Search",
		icon: "🔎",
		description: "Searching the codebase for functions, patterns, and context. Read + execute only.",
		groups: "read, execute, mcp, questions",
		slug: "code-search",
	},
	{
		name: "Web Search",
		icon: "🌐",
		description: "Browsing and extracting web content. Browser + MCP.",
		groups: "browser, mcp, questions",
		slug: "web-search",
	},
	{
		name: "Reviewer",
		icon: "👀",
		description: "Reviewing code for bugs, security issues, and design problems. Diagnostic only.",
		groups: "read, execute, mcp, questions",
		slug: "reviewer",
	},
]
