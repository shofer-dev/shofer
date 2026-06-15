/**
 * Pure-function Slang interpreter — extracted from WorkflowTask.
 *
 * Every function in this module takes all state as explicit parameters
 * and has zero dependencies on ShoferProvider, Task, TaskManager, or any
 * VS Code API. This makes the core VM (advanceAgent, evalExpr, mailbox
 * routing, convergence) unit-testable with plain data fixtures.
 *
 * The only side-effects are in-place mutations of the MailboxEntry[]
 * array and AgentState object — both are owned by the caller and can be
 * constructed fresh per test invocation.
 */

import type { AgentState, FlowState, MailboxEntry } from "./slang-types"
import type {
	Expr,
	StakeOp,
	AwaitOp,
	EscalateOp,
	CommitOp,
	LogOp,
	ErrorOp,
	LetOp,
	SetOp,
	FlowDecl,
	ConvergeStmt,
	AgentDecl,
	Operation,
} from "./slang-ast"

// ── Compiled instruction model ──
//
// Each agent's structured operation tree is compiled once into a flat
// instruction list with explicit jump targets. The agent's program counter
// (`AgentState.opIndex`) indexes into this list. Lowering structured control
// flow (when / repeat) to conditional/unconditional jumps keeps the program
// counter a single integer, which makes both interpretation and checkpoint
// persistence trivial.

export type Instr =
	| { kind: "stake"; op: StakeOp }
	| { kind: "await"; op: AwaitOp }
	| { kind: "escalate"; op: EscalateOp }
	| { kind: "commit"; op: CommitOp }
	| { kind: "log"; op: LogOp }
	| { kind: "error"; op: ErrorOp }
	| { kind: "let"; op: LetOp }
	| { kind: "set"; op: SetOp }
	| { kind: "jump"; target: number }
	| { kind: "branch"; cond: Expr; jumpWhen: boolean; target: number }

/** Result of advancing an agent's program counter over non-blocking instructions. */
export type AdvanceResult =
	| { type: "stake"; op: StakeOp }
	| { type: "escalate"; op: EscalateOp }
	| { type: "await" }
	| { type: "committed" }
	| { type: "error"; op: ErrorOp }
	| { type: "end" }

/**
 * A user-visible message an agent produced while advancing, surfaced to the
 * WorkflowTask chat view. Emitted by `log` / `error` ops and by a `commit`
 * carrying a value. The caller owns the buffer (mutated in place), mirroring
 * the mailbox convention — the pure VM stays free of view side-effects.
 */
export interface EmittedMessage {
	kind: "log" | "error" | "commit"
	message: string
}

/** Render an evaluated message value for display: strings verbatim, else JSON. */
export function formatEmittedValue(value: unknown): string {
	if (value === undefined || value === null) return ""
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/** Guard against compiler/eval bugs producing an infinite control-flow loop. */
export const MAX_CONTROL_FLOW_STEPS = 10_000

// ── Compiler ──

/**
 * Compile an agent's operation tree into a flat instruction list.
 *
 * Lowering rules:
 *   when C { B } [otherwise { E }]:
 *     branch(C, jumpWhen=false) -> elseLabel   (skip body when C is false)
 *     B...
 *     jump endLabel
 *     elseLabel: E...
 *     endLabel:
 *   repeat until C { B }:
 *     loopStart: branch(C, jumpWhen=true) -> endLabel   (exit when C is true)
 *     B...
 *     jump loopStart
 *     endLabel:
 */
export function compileAgentProgram(agent: AgentDecl): Instr[] {
	const instrs: Instr[] = []

	const emitOps = (ops: Operation[]): void => {
		for (const op of ops) emitOp(op)
	}

	const emitOp = (op: Operation): void => {
		switch (op.type) {
			case "StakeOp":
				instrs.push({ kind: "stake", op })
				break
			case "AwaitOp":
				instrs.push({ kind: "await", op })
				break
			case "EscalateOp":
				instrs.push({ kind: "escalate", op })
				break
			case "CommitOp":
				instrs.push({ kind: "commit", op })
				break
			case "LogOp":
				instrs.push({ kind: "log", op })
				break
			case "ErrorOp":
				instrs.push({ kind: "error", op })
				break
			case "LetOp":
				instrs.push({ kind: "let", op })
				break
			case "SetOp":
				instrs.push({ kind: "set", op })
				break
			case "WhenBlock": {
				const branch = { kind: "branch", cond: op.condition, jumpWhen: false, target: -1 } as Extract<
					Instr,
					{ kind: "branch" }
				>
				instrs.push(branch)
				emitOps(op.body)
				if (op.elseBlock) {
					const jumpEnd = { kind: "jump", target: -1 } as Extract<Instr, { kind: "jump" }>
					instrs.push(jumpEnd)
					branch.target = instrs.length
					emitOps(op.elseBlock.body)
					jumpEnd.target = instrs.length
				} else {
					branch.target = instrs.length
				}
				break
			}
			case "RepeatBlock": {
				const loopStart = instrs.length
				const branch = { kind: "branch", cond: op.condition, jumpWhen: true, target: -1 } as Extract<
					Instr,
					{ kind: "branch" }
				>
				instrs.push(branch)
				emitOps(op.body)
				instrs.push({ kind: "jump", target: loopStart })
				branch.target = instrs.length
				break
			}
		}
	}

	emitOps(agent.operations)
	return instrs
}

// ── Optional logging callback (no-op in tests) ──

export interface InterpreterLog {
	info(msg: string): void
	error(msg: string): void
}

const noopLog: InterpreterLog = { info: () => {}, error: () => {} }

// ── advanceAgent ──

/**
 * Advance an agent's program counter, executing all non-blocking
 * instructions (let / set / jump / branch / satisfied commit) until it
 * reaches a blocking instruction (stake / escalate / unsatisfied await),
 * commits, or runs off the end of its program.
 *
 * Mutates `state` and `mailbox` in place.
 */
export function advanceAgent(
	program: Instr[],
	state: AgentState,
	mailbox: MailboxEntry[],
	flowState: FlowState,
	log: InterpreterLog = noopLog,
	/** Optional caller-owned sink for `log`/`error`/`commit` view messages. */
	emitted?: EmittedMessage[],
): AdvanceResult {
	log.info(
		`advanceAgent '${state.name}' enter — opIndex=${state.opIndex}/${program.length} program=[${program.map((i) => i.kind).join(",")}]`,
	)

	let guard = 0
	while (state.opIndex < program.length) {
		if (++guard > MAX_CONTROL_FLOW_STEPS) {
			log.error(`Agent '${state.name}' exceeded control-flow step limit`)
			state.status = "error"
			return { type: "end" }
		}

		const instr = program[state.opIndex]!
		log.info(`advanceAgent '${state.name}' exec opIndex=${state.opIndex} instr=${instr.kind}`)
		switch (instr.kind) {
			case "let":
			case "set":
				state.bindings.set(instr.op.name, evalExpr(instr.op.value, state, flowState))
				state.opIndex++
				break
			case "jump":
				state.opIndex = instr.target
				break
			case "branch": {
				const truthy = toBool(evalExpr(instr.cond, state, flowState))
				state.opIndex = truthy === instr.jumpWhen ? instr.target : state.opIndex + 1
				break
			}
			case "commit":
				if (instr.op.condition && !toBool(evalExpr(instr.op.condition, state, flowState))) {
					log.info(
						`advanceAgent '${state.name}' commit condition NOT met → skip (opIndex now ${state.opIndex + 1})`,
					)
					state.opIndex++
					break
				}
				state.status = "committed"
				if (instr.op.value) {
					const committedValue = evalExpr(instr.op.value, state, flowState)
					state.output = committedValue
					// Surface the commit message to the WorkflowTask view, like log/error.
					emitted?.push({ kind: "commit", message: formatEmittedValue(committedValue) })
				}
				log.info(`advanceAgent '${state.name}' → committed (hasValue=${!!instr.op.value})`)
				return { type: "committed" }
			case "log": {
				if (instr.op.condition && !toBool(evalExpr(instr.op.condition, state, flowState))) {
					state.opIndex++
					break
				}
				const message = instr.op.value ? formatEmittedValue(evalExpr(instr.op.value, state, flowState)) : ""
				emitted?.push({ kind: "log", message })
				log.info(`advanceAgent '${state.name}' log: ${message}`)
				state.opIndex++
				break
			}
			case "error": {
				if (instr.op.condition && !toBool(evalExpr(instr.op.condition, state, flowState))) {
					log.info(`advanceAgent '${state.name}' error condition NOT met → skip`)
					state.opIndex++
					break
				}
				const message = instr.op.value ? formatEmittedValue(evalExpr(instr.op.value, state, flowState)) : ""
				emitted?.push({ kind: "error", message })
				// Advance past the op so a resume can't re-trigger it, then signal the
				// orchestrator to terminate the whole flow.
				state.opIndex++
				state.status = "error"
				log.error(`advanceAgent '${state.name}' → error: ${message}`)
				return { type: "error", op: instr.op }
			}
			case "stake":
				log.info(
					`advanceAgent '${state.name}' → stake call=${instr.op.call.name} recipients=[${instr.op.recipients.map((r) => r.ref).join(",")}] hasOutput=${!!instr.op.output}`,
				)
				return { type: "stake", op: instr.op }
			case "escalate":
				if (instr.op.condition && !toBool(evalExpr(instr.op.condition, state, flowState))) {
					log.info(`advanceAgent '${state.name}' escalate condition NOT met → skip`)
					state.opIndex++
					break
				}
				log.info(`advanceAgent '${state.name}' → escalate target=${instr.op.target || "Human"}`)
				return { type: "escalate", op: instr.op }
			case "await": {
				const sources = instr.op.sources.map((s) => s.ref)
				const mail = consumeMail(mailbox, state.name, sources)
				if (mail) {
					log.info(
						`advanceAgent '${state.name}' await satisfied — mail from=${mail.from} for binding=${instr.op.binding}`,
					)
					state.bindings.set(instr.op.binding, mail.value)
					state.waitingFor = undefined
					state.opIndex++
					break
				}
				state.waitingFor = sources.join(",")
				log.info(
					`advanceAgent '${state.name}' → awaiting ${state.waitingFor} (mailbox has ${mailbox.length} entries)`,
				)
				return { type: "await" }
			}
		}
	}
	return { type: "end" }
}

// ── consumeMail ──

/**
 * Remove and return the first mailbox entry addressed to `recipient`
 * from one of `sources`. Mutates the `mailbox` array in place.
 */
export function consumeMail(mailbox: MailboxEntry[], recipient: string, sources: string[]): MailboxEntry | undefined {
	const wildcard = sources.includes("any") || sources.includes("*")
	const idx = mailbox.findIndex((e) => e.to === recipient && (wildcard || sources.includes(e.from)))
	if (idx === -1) return undefined
	const [entry] = mailbox.splice(idx, 1)
	return entry
}

// ── evalExpr ──

/**
 * Evaluate a slang expression against an agent's local bindings + flow globals.
 * Pure — reads state but does not mutate it.
 */
export function evalExpr(expr: Expr, state: AgentState, flowState: FlowState): unknown {
	switch (expr.type) {
		case "StringLit":
		case "NumberLit":
		case "BoolLit":
			return expr.value
		case "Ident":
			if (state.bindings.has(expr.name)) return state.bindings.get(expr.name)
			if (expr.name in flowState.params) return flowState.params[expr.name]
			switch (expr.name) {
				case "all_committed":
					return allAgentsCommitted(flowState.agents)
				case "committed_count":
					return committedCount(flowState.agents)
				case "round":
					return flowState.round
				default:
					return undefined
			}
		case "AgentRef":
			return flowState.agents.get(expr.name)
		case "ListLit":
			return expr.elements.map((e) => evalExpr(e, state, flowState))
		case "DotAccess": {
			if (expr.object.type === "AgentRef") {
				const target = flowState.agents.get(expr.object.name)
				if (!target) return undefined
				switch (expr.property) {
					case "committed":
						return target.status === "committed"
					case "status":
						return target.status
					case "output":
						return target.output
					default:
						return undefined
				}
			}
			const base = evalExpr(expr.object, state, flowState)
			if (base && typeof base === "object") {
				return (base as Record<string, unknown>)[expr.property]
			}
			return undefined
		}
		case "BinaryExpr": {
			if (expr.op === "&&")
				return toBool(evalExpr(expr.left, state, flowState)) && toBool(evalExpr(expr.right, state, flowState))
			if (expr.op === "||")
				return toBool(evalExpr(expr.left, state, flowState)) || toBool(evalExpr(expr.right, state, flowState))
			const l = evalExpr(expr.left, state, flowState)
			const r = evalExpr(expr.right, state, flowState)
			switch (expr.op) {
				case "==":
					return l === r
				case "!=":
					return l !== r
				case ">":
					return Number(l) > Number(r)
				case ">=":
					return Number(l) >= Number(r)
				case "<":
					return Number(l) < Number(r)
				case "<=":
					return Number(l) <= Number(r)
				case "contains":
					if (typeof l === "string") return l.includes(String(r))
					if (Array.isArray(l)) return l.includes(r)
					return false
				default:
					return false
			}
		}
		default:
			return undefined
	}
}

// ── toBool ──

/** JS-style truthiness over evaluated expression values. */
export function toBool(value: unknown): boolean {
	return Boolean(value)
}

// ── routeOutput ──

/**
 * Deliver a stake's output to all of its recipients (@Agent / @all / @out).
 * Mutates the `mailbox` array in place.
 */
export function routeOutput(
	mailbox: MailboxEntry[],
	agents: Map<string, AgentState>,
	from: string,
	op: StakeOp,
	value: unknown,
): void {
	for (const recipient of op.recipients) {
		const ref = recipient.ref
		if (ref === "out") {
			mailbox.push({ from, to: "out", value, timestamp: Date.now(), funcName: op.call.name })
		} else if (ref === "all") {
			for (const [otherName] of agents) {
				if (otherName === from) continue
				mailbox.push({
					from,
					to: otherName,
					value,
					timestamp: Date.now(),
					funcName: op.call.name,
				})
			}
		} else {
			mailbox.push({ from, to: ref, value, timestamp: Date.now(), funcName: op.call.name })
		}
	}
}

// ── Convergence helpers ──

/** Check whether a flow's converge condition is satisfied. */
export function checkConverge(flowDecl: FlowDecl, flowState: FlowState): boolean {
	const convergeStmt = getConvergeStmt(flowDecl)
	if (convergeStmt) {
		return toBool(evalExpr(convergeStmt.condition, globalEvalState(), flowState))
	}
	return allAgentsCommitted(flowState.agents)
}

/** True when every agent in the flow has status "committed". */
export function allAgentsCommitted(agents: Map<string, AgentState>): boolean {
	for (const [, s] of agents) {
		if (s.status !== "committed") return false
	}
	return true
}

/** Count of agents with status "committed". */
export function committedCount(agents: Map<string, AgentState>): number {
	let count = 0
	for (const [, s] of agents) {
		if (s.status === "committed") count++
	}
	return count
}

// ── Helpers ──

/** Extract the converge condition statement from a flow body. */
function getConvergeStmt(flow: FlowDecl): ConvergeStmt | undefined {
	const stmt = flow.body.find((n) => n.type === "ConvergeStmt")
	if (stmt && stmt.type === "ConvergeStmt") return stmt
	return undefined
}

/** A throwaway agent state for evaluating flow-global converge/budget expressions. */
function globalEvalState(): AgentState {
	return { name: "", taskId: "", status: "idle", opIndex: 0, bindings: new Map(), retryCount: 0 }
}
