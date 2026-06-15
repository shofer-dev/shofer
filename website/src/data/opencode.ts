export interface OpenCodeComparison {
	aspect: string
	openCode: string
	shofer: string
}

export const openCodeComparisons: OpenCodeComparison[] = [
	{
		aspect: "Primary Surface",
		openCode: "Terminal UI (TUI), editor-agnostic, with a client-server core",
		shofer: "Native VS Code GUI cockpit — task tree, live diagrams, cost panels — plus a headless CLI",
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
		openCode: "Configurable agents driven imperatively at runtime",
		shofer: "Declarative, deterministic Slang Workflows — repeatable, inspectable, and visualized",
	},
	{
		aspect: "Semantic RAG (code + git)",
		openCode: "LSP-aware; reads files and runs git on demand",
		shofer: "Indexes code and the entire git log; git_search answers why/when by concept",
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
	// No automated importer yet — AGENTS.md rules port over as-is.
	command: "",
	docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/migration/shofer_for_opencode_users.md",
}
