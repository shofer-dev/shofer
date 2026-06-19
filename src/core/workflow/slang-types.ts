/**
 * Slang runtime types for Shofer workflow execution.
 *
 * The parser produces the canonical upstream AST (see slang-ast.ts); this file
 * defines only the RUNTIME state that the WorkflowTask interpreter mutates and
 * persists (FlowState / AgentState / MailboxEntry) plus its (de)serializers.
 *
 * Design: Self-contained, no external dependencies.
 */

// ── Flow State (runtime) ──

export interface FlowState {
	flowName: string
	params: Record<string, unknown>
	agents: Map<string, AgentState>
	round: number
	tokensUsed: number
	status: FlowStatus
	/**
	 * True once the slang loop has entered (after flow-param collection / the
	 * initial questions) and begun spawning agents. From this point the
	 * workflow's worktree is locked: subtasks now exist and their cwd must not
	 * move. Editable only while this is falsy.
	 */
	started?: boolean
	/** In-flight mailbox (cleared each round). For full history, see `mailboxHistory`. */
	mailbox: MailboxEntry[]
	/** Accumulated history of all mailbox entries ever produced. Persisted
	 *  across rounds so the sequence diagram can be reconstructed post-mortem. */
	mailboxHistory: MailboxEntry[]
	// Slang source file path
	sourcePath?: string
}

export type FlowStatus = "running" | "converged" | "budget_exceeded" | "escalated" | "deadlock" | "error" | "aborted"

export interface AgentState {
	name: string
	taskId: string
	status: AgentStatus
	opIndex: number
	bindings: Map<string, unknown>
	output?: unknown
	// Which agent (by name) this agent is currently sending to
	sendingTo?: string
	// Which agent (by name) this agent is waiting for
	waitingFor?: string
	/** Number of consecutive output-validation failures for the current stake. */
	retryCount: number
}

export type AgentStatus = "idle" | "running" | "committed" | "blocked" | "error"

export interface MailboxEntry {
	from: string // agent name
	to: string // agent name or "@out"
	value: unknown
	timestamp: number
	funcName?: string
	/** Number of tokens consumed by the agent that produced this stake. */
	tokensUsed?: number
	/** USD cost incurred by the agent that produced this stake. */
	costUsd?: number
	/** Wall-clock duration of the agent turn that produced this stake (ms). */
	durationMs?: number
	/** Agent mode slug for the child task (e.g. "code", "architect"). */
	mode?: string
}

// ── Serialization helpers ──

/**
 * Serialize FlowState to a JSON-safe object for persistence.
 * Converts Maps to arrays of [key, value] pairs.
 */
export function serializeFlowState(state: FlowState): Record<string, unknown> {
	return {
		flowName: state.flowName,
		params: state.params,
		agents: Array.from(state.agents.entries()).map(([name, agent]) => [
			name,
			{
				...agent,
				bindings: Array.from(agent.bindings.entries()),
			},
		]),
		round: state.round,
		tokensUsed: state.tokensUsed,
		status: state.status,
		started: state.started ?? false,
		mailbox: state.mailbox,
		mailboxHistory: state.mailboxHistory,
		sourcePath: state.sourcePath,
	}
}

// ── Inline topology snapshot (Mermaid) ──

/** Split a comma-joined ref list (sendingTo/waitingFor) into clean names. */
function splitRefs(refs: string | undefined): string[] {
	return (refs ?? "")
		.split(",")
		.map((r) => r.trim())
		.filter(Boolean)
}

/** Escape a name for use inside a quoted Mermaid node label (keep our own `<br/>`). */
function escapeMermaidLabel(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const MERMAID_STATUS_CLASS: Record<AgentStatus, string> = {
	running: "running",
	blocked: "blocked",
	committed: "committed",
	error: "error",
	idle: "idle",
}

/**
 * Render the current agent topology as an inline Mermaid flowchart, so a
 * per-round snapshot can be embedded directly in the Events feed (under the
 * round headline) instead of in a separate Topology tab.
 *
 * Mirrors the Topology view's edge logic (`topologyCurrentEdges()` in
 * slang-render.js): a `running` agent draws an outbound solid edge to each
 * `sendingTo` target; a `blocked` agent draws an outbound dashed edge to each
 * `waitingFor` source. Only edges between known agent nodes are kept, deduped
 * by `from>to>kind`. Node colors match `agentStatusColor()` so the inline
 * diagram is consistent with the rest of the workflow UI.
 *
 * Edge direction + label are chosen so that "tail → label → head" reads as a
 * true sentence: `A -->|sends to| B` ("A sends to B") and, for a blocked agent,
 * `B -.->|waiting for| A` ("B waiting for A") — the arrow points from the
 * waiter to what it's waiting on, i.e. in the dependency direction.
 *
 * Returns a fenced ```mermaid block, or "" when there are no agents.
 */
const EDGE_STYLE: Record<"stake" | "await", { arrow: string; label: string }> = {
	stake: { arrow: "-->", label: "sends to" },
	await: { arrow: "-.->", label: "waiting for" },
}

export function topologyToMermaid(agents: Map<string, AgentState>): string {
	if (agents.size === 0) return ""

	// Stable, Mermaid-safe node ids (agent names may contain characters that
	// aren't valid bare ids); the human name lives in the quoted label.
	const id = new Map<string, string>()
	let i = 0
	for (const name of agents.keys()) id.set(name, `a${i++}`)

	const edges: string[] = []
	const seen = new Set<string>()
	const addEdge = (from: string, to: string, kind: "stake" | "await") => {
		if (!id.has(from) || !id.has(to)) return
		const key = `${from}>${to}>${kind}`
		if (seen.has(key)) return
		seen.add(key)
		const { arrow, label } = EDGE_STYLE[kind]
		edges.push(`    ${id.get(from)} ${arrow}|${label}| ${id.get(to)}`)
	}
	for (const [name, st] of agents) {
		// "A sends to B": running agent → each recipient.
		if (st.status === "running") for (const t of splitRefs(st.sendingTo)) addEdge(name, t, "stake")
		// "B waiting for A": blocked agent → each source it's parked on (arrow in
		// the dependency direction, not the data-flow direction).
		else if (st.status === "blocked") for (const s of splitRefs(st.waitingFor)) addEdge(name, s, "await")
	}

	const nodes: string[] = []
	for (const [name, st] of agents) {
		const cls = MERMAID_STATUS_CLASS[st.status] ?? "idle"
		const detail =
			st.status === "running" || st.status === "blocked" ? `${st.status} · op ${st.opIndex}` : st.status
		nodes.push(`    ${id.get(name)}["${escapeMermaidLabel(name)}<br/>${detail}"]:::${cls}`)
	}

	return [
		"```mermaid",
		// Marker (a Mermaid comment, ignored by the parser) telling MarkdownBlock
		// to render this diagram non-interactively — no zoom/save toolbox, no
		// click-to-open. These per-round snapshots are decorative, not artifacts.
		"%% shofer:noninteractive",
		"flowchart LR",
		"    classDef running fill:#22c55e,stroke:#15803d,color:#fff",
		"    classDef blocked fill:#a855f7,stroke:#7e22ce,color:#fff",
		"    classDef committed fill:#888888,stroke:#555555,color:#fff",
		"    classDef error fill:#f87171,stroke:#b91c1c,color:#fff",
		"    classDef idle fill:#3b82f6,stroke:#1d4ed8,color:#fff",
		...nodes,
		...edges,
		"```",
	].join("\n")
}

/**
 * Deserialize a JSON-safe object back to FlowState.
 */
export function deserializeFlowState(data: Record<string, unknown>): FlowState {
	const agents = new Map<string, AgentState>()
	const agentsArr = data.agents as [string, Record<string, unknown>][]
	if (agentsArr) {
		for (const [name, agent] of agentsArr) {
			const bindings = new Map<string, unknown>()
			const bindingsArr = agent.bindings as [string, unknown][]
			if (bindingsArr) {
				for (const [k, v] of bindingsArr) {
					bindings.set(k, v)
				}
			}
			agents.set(name, {
				name: agent.name as string,
				taskId: agent.taskId as string,
				status: agent.status as AgentStatus,
				opIndex: agent.opIndex as number,
				bindings,
				output: agent.output,
				sendingTo: agent.sendingTo as string | undefined,
				waitingFor: agent.waitingFor as string | undefined,
				retryCount: (agent.retryCount as number) || 0,
			})
		}
	}
	return {
		flowName: data.flowName as string,
		params: data.params as Record<string, unknown>,
		agents,
		round: (data.round as number) || 0,
		tokensUsed: (data.tokensUsed as number) || 0,
		status: (data.status as FlowStatus) || "running",
		started: (data.started as boolean) ?? false,
		mailbox: (data.mailbox as MailboxEntry[]) || [],
		mailboxHistory: (data.mailboxHistory as MailboxEntry[]) || [],
		sourcePath: data.sourcePath as string | undefined,
	}
}
