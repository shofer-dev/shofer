/**
 * Slang AST types for Shofer workflow specification parsing.
 *
 * Based on the Slang Specification v0.7.5 / v0.8.0.
 * Defines the complete AST node hierarchy for .slang workflow files.
 *
 * Design: Self-contained, no external dependencies. The parser
 * produces these types and WorkflowTask consumes them.
 */

// ── Top-level ──

export interface SlangAST {
	flows: FlowDecl[]
}

export interface FlowDecl {
	name: string
	params: FlowParam[]
	agents: AgentDecl[]
	constraints: FlowConstraints
}

export interface FlowParam {
	name: string
	type: string // e.g. "string", "number", "boolean"
}

export interface FlowConstraints {
	convergeWhen?: string // condition expression
	budgetTokens?: number
	budgetRounds?: number
}

// ── Agents ──

export interface AgentDecl {
	name: string
	mode?: string
	model?: string
	role?: string
	retry?: number
	tools?: string[]
	ops: AgentOp[]
}

export type AgentOp = StakeOp | AwaitOp | LetOp | SetOp | CommitOp | EscalateOp | RepeatOp | WhenOp

// ── Operations ──

export interface StakeOp {
	kind: "stake"
	funcName: string
	args: Record<string, StakeArg>
	target?: string // @AgentName, @out, @all, @any
	output?: Record<string, string> // field: type
	sourceSpan?: SourceSpan
}

export interface AwaitOp {
	kind: "await"
	binding: string
	source: string // @AgentName, @any, @Human, etc.
	sourceSpan?: SourceSpan
}

export interface LetOp {
	kind: "let"
	name: string
	value: StakeOp // let x = stake func(args) -> @Target
	sourceSpan?: SourceSpan
}

export interface SetOp {
	kind: "set"
	name: string
	value: unknown // literal value or expression
	sourceSpan?: SourceSpan
}

export interface CommitOp {
	kind: "commit"
	value?: unknown
	condition?: string
	sourceSpan?: SourceSpan
}

export interface EscalateOp {
	kind: "escalate"
	recipient: string // @Human
	reason?: string
	condition?: string
	sourceSpan?: SourceSpan
}

export interface RepeatOp {
	kind: "repeat"
	condition: string // e.g. "until expr"
	body: AgentOp[]
	sourceSpan?: SourceSpan
}

export interface WhenOp {
	kind: "when"
	condition: string
	body: AgentOp[]
	elseBody?: AgentOp[]
	sourceSpan?: SourceSpan
}

// ── Arguments ──

export type StakeArg = string | number | boolean | StakeArgReference

export interface StakeArgReference {
	kind: "ref"
	name: string // references a binding, param, or agent property
}

// ── Source Spans (for error messages) ──

export interface SourceSpan {
	start: { line: number; column: number; offset: number }
	end: { line: number; column: number; offset: number }
}

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
