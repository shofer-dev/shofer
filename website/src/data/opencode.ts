export interface OpenCodeComparison {
	aspect: string
	openCode: string
	shofer: string
}

export const openCodeComparisons: OpenCodeComparison[] = [
	{
		aspect: "Primary Surface",
		openCode:
			"Multi-surface & editor-agnostic — TUI, Desktop app, and IDE extensions (VS Code, Cursor, JetBrains, Zed, Neovim, Emacs) over the open ACP standard",
		shofer: "Deeply VS Code-native GUI cockpit — task tree, live diagrams, cost panels — plus a headless CLI",
	},
	{
		aspect: "Philosophy",
		openCode: "Open-source, model-agnostic, local-first",
		shofer: "Open-source (Apache 2.0), model-agnostic, local-first — same foundation",
	},
	{
		aspect: "Task Visibility",
		openCode: "Terminal transcript / TUI panes",
		shofer: "Graphical task tree + Topology / Sequence / Swimlane diagrams, Stats, and Logs",
	},
	{
		aspect: "Multi-Agent Orchestration",
		openCode:
			"Declarative custom agents in Markdown (.opencode/agents/) with per-agent permission locking; routing imperative at runtime",
		shofer: "Declarative, deterministic Slang Workflows — the control flow itself is declarative, repeatable, inspectable, and visualized",
	},
	{
		aspect: "Parallelism",
		openCode: "Specialized subagents (general / explore / scout) run isolated parallel background tasks",
		shofer: "Many concurrent tasks and full workflow trees, with background subtasks and async MCP",
	},
	{
		aspect: "Code Understanding",
		openCode: "Deep real-time LSP integration — feeds live compiler diagnostics & type errors back to the model",
		shofer: "Precomputed semantic index over code and the entire git log; git_search answers why/when by concept",
	},
	{
		aspect: "Worktrees & Sandboxing",
		openCode: "Manual git worktree; permission prompts",
		shofer: "Native worktree UI + OS-level command sandboxing (Landlock/bwrap)",
	},
	{
		aspect: "Config Portability",
		openCode: "opencode.json + AGENTS.md",
		shofer: "Reads AGENTS.md directly — your project rules carry over",
	},
]

export const openCodeMigration = {
	title: "Migrating from OpenCode",
	description:
		"Same open-source, model-agnostic philosophy — plus a graphical VS Code cockpit, parallel orchestration, semantic code & git-log search, native worktrees, and a deterministic multi-agent Workflow engine. Your AGENTS.md rules carry over directly.",
	command: "/migrate-from-opencode",
	docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_opencode_users.md",
}
