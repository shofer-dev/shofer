export interface MigrationComparison {
	feature: string
	shofer: string
	rooCode: string
}

export const rooCodeComparisons: MigrationComparison[] = [
	{
		feature: "Parallel Tasks",
		shofer: "Multiple concurrent independent conversations with task tree hierarchy",
		rooCode: "Single task at a time — starting a new task abandoned the current one",
	},
	{
		feature: "Background Subtasks",
		shofer: "Fan out work without blocking the parent. Parent can answer child questions, cancel children, and poll results",
		rooCode: "Synchronous only — parent blocked until child completed",
	},
	{
		feature: "Async MCP Calls",
		shofer: "Fire-and-forget with call_id tracking, all/any wait strategies, delete-on-read trimming",
		rooCode: "All MCP calls were synchronous and blocking",
	},
	{
		feature: "RAG Code Indexing",
		shofer: "Fast AST-aware tree-sitter parsing, git history semantic search, submodule-aware scanning",
		rooCode: "Limited to code, and slow",
	},
	{
		feature: "Git Worktrees",
		shofer: "Native UI-driven worktree management within one VS Code window",
		rooCode: "Required separate VS Code windows per worktree",
	},
	{
		feature: "Cost Limits",
		shofer: "Set a USD budget cap per task globally and per-task. When reached, the task automatically pauses or aborts — preventing runaway spend.",
		rooCode: "No spending limits — runaway loops could consume tokens indefinitely",
	},
	{
		feature: "Assistant Agent",
		shofer: "Persistent read-only companion with cross-session context reuse",
		rooCode: "Not available",
	},
	{
		feature: "LSP Symbol Refactoring",
		shofer: "rename_symbol and list_code_usages via Language Server Protocol",
		rooCode: "No LSP-powered refactoring tools",
	},
]

export const rooCodeMigration = {
	title: "Migrating from Roo-Code",
	description:
		"Shofer is a major architectural improvement over Roo-Code — a complete rebuild with parallel tasks, async MCP calling, semantic code & git indexing, native worktree support, and dozens of new features.",
	command: "/migrate-from-roocode",
	docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#11-slash-commands",
}
