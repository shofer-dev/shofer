export interface Feature {
	title: string
	description: string
	icon: string
	highlights: string[]
	docsUrl: string
	docsLabel: string
}

// Ordered intentionally: the first group is what genuinely sets Shofer apart;
// the second group is the strong, expected baseline (done well, but common
// across modern agents).
export const features: Feature[] = [
	{
		title: "Deterministic Multi-Agent Workflows",
		description:
			"Specify a whole multi-agent pipeline declaratively in a .slang file — agents, message routing, control flow, a convergence condition, and budgets — driven by a non-LLM executor. Repeatable and inspectable, not ad-hoc runtime delegation.",
		icon: "Workflow",
		highlights: [
			"Slang DSL: stake/await, when/repeat, converge, budgets",
			"Per-agent output contracts with automatic retry",
			"A deterministic scheduler — the control flow is the spec",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/slang_specs.md",
		docsLabel: "Slang Spec",
	},
	{
		title: "Live Agent Visualization",
		description:
			"Watch an agent tree execute as it runs: a topology graph, a message-sequence timeline, per-agent swimlanes, an active-time breakdown, and filterable logs — all in-editor.",
		icon: "Activity",
		highlights: [
			"Topology / Sequence / Swimlane diagrams with live runtime overlays",
			"Stats: active-time donut + per-tool breakdown across the whole tree",
			"Filterable per-task Logs (free-text + severity)",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/workflow_visualization.md",
		docsLabel: "Visualization",
	},
	{
		title: "Kernel-Level Command Sandboxing",
		description:
			"Shell commands run inside an OS-level, write-only sandbox (Landlock / bwrap) that confines writes to the active worktree — a deterministic guarantee, not a model-based heuristic. (Linux.)",
		icon: "Shield",
		highlights: [
			"Landlock / bwrap write-only confinement",
			"rename_symbol and edits scoped to the worktree",
			"Safer autonomous runs without trusting a classifier",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/worktree-shell-sandboxing.md",
		docsLabel: "Sandboxing",
	},
	{
		title: "Semantic Code + Git-History Search",
		description:
			"Build a semantic index over your codebase AND your entire git log. Find code and commits by meaning — and discover why and when a change was made, not just where.",
		icon: "Search",
		highlights: [
			"AST-aware parsing via tree-sitter for accurate code chunking",
			"git_search over commit messages and historical diffs",
			"File watcher keeps the index up to date as you edit",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#7-semantic-code-search-rag",
		docsLabel: "RAG Indexing",
	},
	{
		title: "Hard Cost Caps",
		description:
			"Set a USD budget per task or per session. When the limit is hit, the agent loop pauses or aborts — task-level protection against runaway autonomous loops, across any provider.",
		icon: "DollarSign",
		highlights: [
			"Per-task and per-session USD limits",
			"Automatic halt the moment a threshold is crossed",
			"Whole-tree cost & token rollups in the header",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#10-per-task-cost-limit",
		docsLabel: "Cost Limits",
	},
	{
		title: "Assistant Agent",
		description:
			"A persistent, read-only companion that accumulates codebase knowledge across tasks — surviving restarts — backed by the local semantic index. Other tasks query it instead of reloading context.",
		icon: "Bot",
		highlights: [
			"Runs on a low-cost model with a large context window",
			"KV-cache friendly append-only context minimizes provider costs",
			"Strictly read-only — can read, search, and look up symbols only",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#13-assistant-agent",
		docsLabel: "Assistant Agent",
	},

	// ── The strong, expected baseline ──

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
		title: "Built-in & Custom Modes",
		description:
			"Switch between Code, Architect, Debug, and search/review modes — each with scoped tool access. Create fully custom modes via .shofermodes files to match your exact workflow.",
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
