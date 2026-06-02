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
	mailbox: MailboxEntry[]
	// Slang source file path
	sourcePath?: string
}

export type FlowStatus = "running" | "converged" | "budget_exceeded" | "escalated" | "deadlock" | "error"

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
		mailbox: state.mailbox,
		sourcePath: state.sourcePath,
	}
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
		mailbox: (data.mailbox as MailboxEntry[]) || [],
		sourcePath: data.sourcePath as string | undefined,
	}
}
