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
	/** Alternative to `detail`: render the expanded copy as a bulleted list. */
	detailBullets?: string[]
	/** Screenshots for the detail section. */
	images?: { src: string; caption: string }[]
	/** Controls how images are laid out.
	 *  - "carousel" (default for >1): scrolls one at a time.
	 *  - "grid": shows images side-by-side in a responsive grid.
	 *  - "side": image sits to the right of the text (single images only).
	 *  - "side-carousel": a carousel of all images sits to the right of the text. */
	imageLayout?: "carousel" | "grid" | "side" | "side-carousel"
}

// Card order is curated; it also matches the order the detail/target sections
// appear on the page, so each card's "Learn more" jumps straight down.
export const features: Feature[] = [
	{
		title: "Provable Multi-Agent Workflows",
		description:
			"Specify a whole multi-agent pipeline declaratively in a .slang file — agents, message routing, control flow, a convergence condition, and budgets — then a non-LLM executor runs it.",
		icon: "Workflow",
		highlights: [
			"Slang DSL: a deliberately constrained language to express multi-agent interactions",
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
			"Shofer gives you the tools to introspect, troubleshoot and optimize your multi-agent workflows, with beautiful diagrams right on your IDE.",
		icon: "Activity",
		highlights: [
			"Topology / Sequence / Swimlane diagrams with live runtime overlays",
			"Latency/Reliability breakdowns: active-time donut + per-tool breakdown across the whole tree",
			"Filterable per-session Logs",
			"Export the complete wire protocol for any session to a .json file for offline analysis",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/docs/workflow_visualization.md",
		docsLabel: "Visualization",
		anchor: "live-visualization",
		detail: "Open WorkflowView and the whole agent tree becomes legible. A topology graph shows the current round — who's running and who they're sending to or waiting on. A sequence timeline replays every message, escalations to @Human included. Per-agent swimlanes mark exactly which step each agent is on, a Stats tab breaks active time down by phase and tool across the entire tree, and a filterable Logs stream shows everything that happened. The same diagrams render for any .slang file in an editor tab.",
		images: [
			{ src: "workflow-topology.png", caption: "Topology — the agent graph for the current round" },
			{
				src: "task-sequence-diagram.png",
				caption: "Sequence — message timeline, including escalations to @Human",
			},
			{ src: "swimlanes.png", caption: "State — per-agent swimlanes marking the executing op" },
			{ src: "task-stats.png", caption: "Stats — active-time donut + per-tool breakdown across the tree" },
			{ src: "logs.png", caption: "Logs — filterable by free text and severity" },
		],
	},
	{
		title: "Codebase memory that stays in-sync",
		description:
			"Long-lived memory you can talk to: a persistent, read-only Assistant Agent that accumulates codebase knowledge across sessions — backed by the local semantic index. Other sessions just ask it instead of reloading context.",
		icon: "Bot",
		highlights: [
			"Runs on a low-cost model with a large context window",
			"KV-cache friendly and Read-only — with powerful code exploration tools",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#13-assistant-agent",
		docsLabel: "Assistant Agent",
		anchor: "assistant-agent",
		detail: "A long-lived, read-only companion agent accumulates codebase knowledge as you work, backed by the local semantic index (RAG). Other sessions query it instead of re-reading and re-paying for the same context — so a warm, shared context window serves many cheap queries.",
		images: [{ src: "live-memory.png", caption: "Sessions querying the shared Assistant Agent context" }],
		imageLayout: "side",
	},
	{
		title: "Fast Code & Git Indexing",
		description:
			"A semantic index over your code and your entire git history — kept fast because it's incremental, and computed and stored on the backend of your choice.",
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
		detail: "Shofer's RAG is fast because it's incremental — it re-embeds only what changed. It indexes your code with AST-aware, tree-sitter chunking and your entire git log, so your agents can get the historical context of a change. And it runs on a backend you own: pick your embedding model (e.g. local via Ollama) and your vector store, so the index is computed and stored on infrastructure you control.",
		images: [{ src: "rag-indexing.png", caption: "Local RAG over code and git history, indexed incrementally" }],
		imageLayout: "side",
	},
	{
		title: "Parallel and Asynchronous",
		description:
			"Parallelism end to end: run many independent sessions at once in a tree, and asynchronous MCP tool calls (fire-and-forget) instead of blocking the loop.",
		icon: "GitBranch",
		highlights: [
			"Many independent sessions in a tree — switch without losing state",
			"Background subtasks with parent-child communication + message queuing",
			"Fire-and-forget call_mcp_tool_async with call_id tracking",
			"wait_for_mcp_call all/any strategies; delete-on-read trimming",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#5-parallel-tasks--sub-tasks",
		docsLabel: "Parallel Tasks",
		anchor: "parallel-async",
		detail: "Parallelism runs through the whole product. Run many independent conversations at once in a task tree — switching freely without losing state, queueing messages while an agent works, and fanning out background subtasks that report back to their parent. Both A2A and MCP tool calling are fully asynchronous, so that your agents can do more work in the same amount of time.",
		images: [
			{ src: "task-tree-hierarchy.png", caption: "The task tree with several tasks running at once" },
			{ src: "parallelism.png", caption: "Parallel MCP calls tracked by call_id" },
		],
		imageLayout: "side",
	},
	{
		title: "Hard Cost Caps",
		description:
			"Set a USD budget per session. When the limit is hit, the agent loop pauses or aborts — session-level protection against runaway autonomous loops, across any provider.",
		icon: "DollarSign",
		highlights: [
			"Per-session USD limits",
			"Automatic halt soon after the moment a threshold is crossed",
			"Whole-tree cost & token rollups in the header",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#10-per-task-cost-limit",
		docsLabel: "Cost Limits",
		anchor: "cost-caps",
		detail: "Give a session a hard USD budget. Shofer tracks spend live across the whole task tree and pauses or aborts soon after the moment the cap is crossed — so a runaway autonomous loop can't quietly burn your balance.",
		images: [{ src: "cost-limits.png", caption: "A per-session USD budget with live spend tracking" }],
	},
	{
		title: "Excellent Git Worktree Support",
		description:
			"Run parallel sessions on different branches in one VS Code window. No more stash/commit gymnastics or accidental overwrites — and each worktree is kernel-sandboxed.",
		icon: "TreePine",
		highlights: [
			"UI-driven create, switch, and delete operations",
			"Each session scoped to a specific worktree branch",
			"Automatic .worktreeinclude for gitignored files",
			"Kernel-level (Landlock/bwrap) command sandboxing confined to the worktree",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#9-git-worktrees",
		docsLabel: "Git Worktrees",
		anchor: "git-worktrees",
		detail: "Keep parallel sessions on separate branches in a single VS Code window — no stash dance, no extra windows. Create, switch, and delete worktrees from the UI; each session is scoped to its branch. Each worktree is a security boundary: shell commands run inside an OS-level sandbox that confines writes to the active worktree. (available in Linux only)",
		images: [
			{ src: "worktree1.png", caption: "Worktree selector with per-session branch isolation" },
			{ src: "worktree2.png", caption: "A shell command blocked from writing outside the active worktree" },
		],
		imageLayout: "grid",
	},
	{
		title: "6 Built-in Modes. Infinite Customizations.",
		description:
			"Code, Architect, Debug, Code Search, Web Search, and Reviewer out of the box — each with scoped tool access. Define your own modes via .shofermodes to match any workflow exactly.",
		icon: "Layers",
		highlights: [
			"Fine-grained tool-category control (read, write, execute, mcp, …)",
			"File-scoped restrictions (e.g. write only .md files)",
			"Precise customization on what goes into the system prompt",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md#3-custom-modes",
		docsLabel: "Custom Modes",
		// Links to its own dedicated #modes section — no separate detail block.
		anchor: "modes",
	},
	{
		title: "Git submodules, changelist, LSP support, and overall UI/UX Polish",
		description:
			"Thoughtful details that make the agent feel like a first-class development tool — session changelog, agent self-assessment, native git submodule support, LSP-powered refactoring, and MCP-aware auto-approval.",
		icon: "Zap",
		highlights: [
			"Working changelist: see every file changed in a session at a glance",
			"Agent self-assessment & rating after each task",
			"Git submodule support — works out of the box, no configuration needed",
			"Full set of input capabilities — receive user input using check/radio boxes, dropdowns, etc",
			"Auto-approval categories extend to MCP tools",
		],
		docsUrl: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md",
		docsLabel: "User Manual",
		anchor: "ui-ux",
		detailBullets: [
			"A session changelog shows every file modified at a glance — no more git diff to remember what happened.",
			"Each task ends with an agent self-assessment and rating, giving you a quick signal on quality.",
			"Git submodules work out of the box — no configuration, no workarounds — Shofer's code-indexer, git-history watcher, and file watcher descend into nested repos automatically.",
			"LSP integration lets the agent rename symbols and find all usages across the workspace via the language server.",
			"And the auto-approval system extends to per-MCP-tool toggles and categories, so you can keep fast iteration with fine-grained control.",
		],
		images: [
			{ src: "auto-approve.png", caption: "Per-MCP-tool auto-approval toggles in Settings" },
			{ src: "changelist.png", caption: "Session changelog — every file changed, at a glance" },
			{ src: "rating.png", caption: "Agent self-assessment and rating overlay after a task completes" },
		],
		imageLayout: "side-carousel",
	},
]
