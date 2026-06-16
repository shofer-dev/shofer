export interface Feature {
	title: string
	description: string
	icon: string
	highlights: string[]
	docsUrl: string
	docsLabel: string
	/** Same-page anchor the card's "Learn more" link jumps to. */
	anchor: string
	/** High-level expanded copy for the detail section (omit to skip a detail block — e.g. Workflows links to its own #workflows section). */
	detail?: string
	/** Screenshot captions; >1 renders a carousel. Real images TBD — placeholders for now. */
	images?: string[]
}

// Card order is curated; it also matches the order the detail/target sections
// appear on the page, so each card's "Learn more" jumps straight down.
export const features: Feature[] = [
	{
		title: "Provable Multi-Agent Workflows",
		description:
			"Specify a whole multi-agent pipeline declaratively in a .slang file — agents, message routing, control flow, a convergence condition, and budgets — then a non-LLM executor runs it. Few agents offer this; fewer make the pipeline statically analyzable before it runs.",
		icon: "Workflow",
		highlights: [
			"Slang DSL: stake/await, when/repeat, converge, budgets",
			"Statically analyzable — deadlocks & orphan agents caught before a run",
			"Per-agent output contracts + a deterministic, repeatable scheduler",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/slang_specs.md",
		docsLabel: "Slang Spec",
		// Links to its own dedicated section below — no separate detail block.
		anchor: "workflows",
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
		anchor: "live-visualization",
		detail: "Open WorkflowView and the whole agent tree becomes legible. A topology graph shows the current round — who's running and who they're sending to or waiting on. A sequence timeline replays every message, escalations to @Human included. Per-agent swimlanes mark exactly which step each agent is on, a Stats tab breaks active time down by phase and tool across the entire tree, and a filterable Logs stream shows everything that happened. The same diagrams render for any .slang file in an editor tab.",
		images: [
			"Topology — the agent graph for the current round",
			"Sequence — message timeline, including escalations to @Human",
			"State — per-agent swimlanes marking the executing op",
			"Stats — active-time donut + per-tool breakdown across the tree",
			"Logs — filterable by free text and severity",
		],
	},
	{
		title: "Memory that stays in-sync",
		description:
			"Long-lived memory you can talk to: a persistent, read-only Assistant Agent that accumulates codebase knowledge across tasks — surviving restarts — backed by the local semantic index. Other tasks just ask it instead of reloading context.",
		icon: "Bot",
		highlights: [
			"Runs on a low-cost model with a large context window",
			"KV-cache friendly append-only context minimizes provider costs",
			"Strictly read-only — can read, search, and look up symbols only",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#13-assistant-agent",
		docsLabel: "Assistant Agent",
		anchor: "assistant-agent",
		detail: "A long-lived, read-only companion agent accumulates codebase knowledge as you work and survives restarts, backed by the local semantic index. Other tasks query it via ask_assistant_agent instead of re-reading and re-paying for the same context — so a warm, shared context window serves many cheap queries.",
		images: ["Tasks querying the shared Assistant Agent context"],
	},
	{
		title: "Fast, Local Code & Git RAG Indexing",
		description:
			"A semantic index over your code and your entire git history — kept fast because it's incremental (only what changed is re-embedded), and computed and stored on a backend you own.",
		icon: "Search",
		highlights: [
			"Semantic code search — AST-aware chunking via tree-sitter",
			"Git-history indexing — git_search finds why & when a change was made",
			"Incremental — only changed files/segments are re-embedded",
			"Bring your own backend — choose the embedding model and vector store",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#7-semantic-code-search-rag",
		docsLabel: "RAG Indexing",
		anchor: "code-git-search",
		detail: "Shofer's RAG is fast because it's incremental — it re-embeds only what changed, not the whole repo on every edit. It indexes your code with AST-aware, tree-sitter chunking and your entire git log (commit messages + diffs), so git_search answers why and when a change was made, by meaning, not just where the text lives today. And it runs on a backend you own: pick your embedding model (e.g. local via Ollama) and your vector store, so the index is computed and stored on infrastructure you control.",
		images: ["Local RAG over code and git history, indexed incrementally"],
	},
	{
		title: "Parallel Tasks & Async MCP",
		description:
			"Parallelism end to end: run many independent tasks at once in a tree, and fire MCP tool calls fire-and-forget instead of blocking the loop. Each task keeps its own mode, provider, and context.",
		icon: "GitBranch",
		highlights: [
			"Many independent tasks in a tree — switch without losing state",
			"Background subtasks with parent-child communication + message queuing",
			"Fire-and-forget call_mcp_tool_async with call_id tracking",
			"wait_for_mcp_call all/any strategies; delete-on-read trimming",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#5-parallel-tasks--sub-tasks",
		docsLabel: "Parallel Tasks",
		anchor: "parallel-async",
		detail: "Parallelism runs through the whole product. Run many independent conversations at once in a task tree — each with its own mode, provider, and context — switching freely without losing state, queueing messages while an agent works, and fanning out background subtasks that report back to their parent. MCP tool calls are async too: dispatch them fire-and-forget, track them by call_id, wait for all or any to finish, and trim results on read so long-running tools never block the loop or bloat the context.",
		images: ["The task tree with several tasks running at once", "Parallel MCP calls tracked by call_id"],
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
		anchor: "cost-caps",
		detail: "Give a task or session a hard USD budget. Shofer tracks spend live across the whole task tree and pauses or aborts the moment the cap is crossed — so a runaway autonomous loop can't quietly burn your balance. It works the same on any provider, including metered cloud APIs.",
		images: ["A per-task USD budget with live spend tracking"],
	},
	{
		title: "Git Worktrees",
		description:
			"Run parallel tasks on different branches in one VS Code window. No more stash/commit gymnastics or multiple windows for PRs — and each worktree is kernel-sandboxed.",
		icon: "TreePine",
		highlights: [
			"UI-driven create, switch, and delete operations",
			"Each task scoped to a specific worktree branch",
			"Automatic .worktreeinclude for gitignored files",
			"Kernel-level (Landlock/bwrap) command sandboxing confined to the worktree",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#9-git-worktrees",
		docsLabel: "Git Worktrees",
		anchor: "git-worktrees",
		detail: "Keep parallel tasks on separate branches in a single VS Code window — no stash dance, no extra windows for PRs. Create, switch, and delete worktrees from the UI; each task is scoped to its branch, and .worktreeinclude carries over the gitignored files a fresh checkout would miss. Each worktree is also a security boundary: shell commands run inside an OS-level, write-only sandbox (Landlock / bwrap) that confines writes to the active worktree — a kernel-enforced guarantee, not a model's best guess — making long, unattended runs far safer. (Linux.)",
		images: [
			"Worktree selector with per-task branch isolation",
			"A shell command blocked from writing outside the active worktree",
		],
	},
	{
		title: "6 Built-in Modes. Infinite Customizations.",
		description:
			"Code, Architect, Debug, Code Search, Web Search, and Reviewer out of the box — each with scoped tool access. Define your own modes via .shofermodes to match any workflow exactly.",
		icon: "Layers",
		highlights: [
			"Fine-grained tool-category control (read, write, execute, mcp, …)",
			"File-scoped restrictions (e.g. write only .md files)",
			"Custom role definitions and a model assignment per mode",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#3-custom-modes",
		docsLabel: "Custom Modes",
		// Links to its own dedicated #modes section — no separate detail block.
		anchor: "modes",
	},
]
