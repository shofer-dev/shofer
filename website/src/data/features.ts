export interface Feature {
	title: string
	description: string
	icon: string
	highlights: string[]
	docsUrl: string
	docsLabel: string
}

export const features: Feature[] = [
	{
		title: "5 Built-in Modes",
		description:
			"Switch between Code, Architect, Ask, Debug, and Orchestrator modes — each with scoped tool access. Create fully custom modes via .shofermodes files to match your exact workflow.",
		icon: "Layers",
		highlights: [
			"Fine-grained tool category control (read, write, execute, mcp, etc.)",
			"File-scoped restrictions (e.g., write only .md files)",
			"Custom role definitions and model assignments per mode",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#3-custom-modes",
		docsLabel: "Custom Modes",
	},
	{
		title: "True Parallel Tasks",
		description:
			"Run multiple independent conversations simultaneously in a tree hierarchy. Each task has its own mode, provider, and context — switch freely without losing state.",
		icon: "GitBranch",
		highlights: [
			"Background subtasks with parent-child communication",
			"Message queuing — type ahead while the AI works",
			"Task states with colored indicators (idle, running, waiting, completed)",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#5-parallel-tasks--sub-tasks",
		docsLabel: "Parallel Tasks",
	},
	{
		title: "Git Worktrees",
		description:
			"Run parallel tasks on different branches in one VS Code window. No more stash/commit gymnastics or multiple windows for PRs.",
		icon: "TreePine",
		highlights: [
			"UI-driven create, switch, and delete operations",
			"Each task scoped to a specific worktree branch",
			"Automatic .worktreeinclude for gitignored files",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#9-git-worktrees",
		docsLabel: "Git Worktrees",
	},
	{
		title: "RAG Code Indexing",
		description:
			"Build a semantic search index of your codebase and git history. Find code and commits by meaning — not just keywords.",
		icon: "Search",
		highlights: [
			"AST-aware parsing via tree-sitter for accurate code chunking",
			"Git history semantic search — discover why and when changes happened",
			"File watcher keeps the index up to date as you edit",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#7-semantic-code-search-rag",
		docsLabel: "RAG Indexing",
	},
	{
		title: "Assistant Agent",
		description:
			"A persistent, read-only AI companion that accumulates codebase knowledge across tasks — surviving restarts. Answers questions without reloading context.",
		icon: "Bot",
		highlights: [
			"Runs on a low-cost model with a large context window",
			"KV-cache friendly append-only context minimizes provider costs",
			"Strictly read-only — can read, search, and look up symbols only",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#13-assistant-agent",
		docsLabel: "Assistant Agent",
	},
	{
		title: "Async MCP Tool Calling",
		description:
			"Fire-and-forget MCP tool invocation with true parallelism. Fan out multiple calls and collect results when they're ready.",
		icon: "Zap",
		highlights: [
			"Non-blocking call_mcp_tool_async with call_id tracking",
			"wait_for_mcp_call with all/any completion strategies",
			"Delete-on-read trimming prevents context bloat",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#6-mcp-servers",
		docsLabel: "MCP Servers",
	},
]
