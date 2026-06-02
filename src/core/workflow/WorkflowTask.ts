/**
 * WorkflowTask — a Task subclass whose main loop is slang-driven, not LLM-driven.
 *
 * The workflow executor is NOT a separate service. It is the WorkflowTask's
 * slangLoop() method, replacing recursivelyMakeShoferRequests(). The Workflow
 * Task itself makes ZERO LLM API calls. All "intelligence" lives inside the
 * agent Tasks it spawns, which are standard Shofer Task instances with full
 * tool access.
 *
 * Design: see docs/todos/workflow_design.md for the full specification.
 */

import * as path from "path"
import * as fs from "fs/promises"
import os from "os"

import type { HistoryItem, TaskHandle } from "@shofer/types"
import { ShoferEventName } from "@shofer/types"

import { Task, type TaskOptions } from "../task/Task"
import { ShoferProvider } from "../webview/ShoferProvider"
import { outputError, outputLog } from "../../utils/outputChannelLogger"

import {
	type AgentState,
	type FlowState,
	type FlowStatus,
	type MailboxEntry,
	deserializeFlowState,
	serializeFlowState,
} from "./slang-types"
import { parseSlang, validateSlangAST } from "./slang-parser"
import type {
	FlowDecl as UpstreamFlowDecl,
	AgentDecl as UpstreamAgentDecl,
	Operation,
	Expr,
	StakeOp,
	AwaitOp,
	EscalateOp,
	CommitOp,
	LetOp,
	SetOp,
} from "./slang-ast"
import { exprAsNumber } from "./slang-ast"

// ─── Adapter: upstream AST → WorkflowTask needs ───

/** Extract agent declarations from an upstream flow body. */
function getAgentDecls(flow: UpstreamFlowDecl): UpstreamAgentDecl[] {
	return flow.body.filter((n): n is UpstreamAgentDecl => n.type === "AgentDecl")
}

/** Get the converge condition expression, if any. */
function getConvergeExpr(flow: UpstreamFlowDecl): Expr | undefined {
	const stmt = flow.body.find((n) => n.type === "ConvergeStmt")
	if (stmt && stmt.type === "ConvergeStmt") return stmt.condition
	return undefined
}

/** Get budget values: { tokens, rounds }. */
function getBudget(flow: UpstreamFlowDecl): { bTokens?: number; bRounds?: number } {
	const stmt = flow.body.find((n) => n.type === "BudgetStmt")
	if (!stmt || stmt.type !== "BudgetStmt") return {}
	const out: { bTokens?: number; bRounds?: number } = {}
	for (const item of stmt.items) {
		if (item.kind === "tokens") out.bTokens = exprAsNumber(item.value)
		else if (item.kind === "rounds") out.bRounds = exprAsNumber(item.value)
	}
	return out
}

/** Refs that denote wildcards / external sinks rather than peer agents. */
const NON_PEER_REFS = new Set(["out", "all", "any", "*", "human"])

/**
 * Names of the peer agents an agent communicates with, derived from the flow's
 * declared topology: every agent it stakes to (sends work) or awaits from
 * (consumes output), recursively through when/repeat control flow. Wildcards
 * and external sinks (@out, @all, @any, @Human) are excluded.
 */
function getCommunicationPeers(agent: UpstreamAgentDecl): Set<string> {
	const peers = new Set<string>()
	const walk = (op: Operation): void => {
		if (op.type === "StakeOp") {
			for (const r of op.recipients) if (!NON_PEER_REFS.has(r.ref)) peers.add(r.ref)
		} else if (op.type === "AwaitOp") {
			for (const s of op.sources) if (!NON_PEER_REFS.has(s.ref)) peers.add(s.ref)
		} else if (op.type === "WhenBlock") {
			for (const inner of op.body) walk(inner)
			if (op.elseBlock) for (const inner of op.elseBlock.body) walk(inner)
		} else if (op.type === "RepeatBlock") {
			for (const inner of op.body) walk(inner)
		}
	}
	for (const op of agent.operations) walk(op)
	return peers
}

// ── Compiled instruction model ──
//
// Each agent's structured operation tree is compiled once into a flat
// instruction list with explicit jump targets. The agent's program counter
// (`AgentState.opIndex`) indexes into this list. Lowering structured control
// flow (when / repeat) to conditional/unconditional jumps keeps the program
// counter a single integer, which makes both interpretation and checkpoint
// persistence trivial.

type Instr =
	| { kind: "stake"; op: StakeOp }
	| { kind: "await"; op: AwaitOp }
	| { kind: "escalate"; op: EscalateOp }
	| { kind: "commit"; op: CommitOp }
	| { kind: "let"; op: LetOp }
	| { kind: "set"; op: SetOp }
	| { kind: "jump"; target: number }
	| { kind: "branch"; cond: Expr; jumpWhen: boolean; target: number }

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
function compileAgentProgram(agent: UpstreamAgentDecl): Instr[] {
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

/**
 * Best-effort extraction of a JSON value from an agent's completion result.
 * Tries a direct parse first, then falls back to the last brace-delimited
 * block embedded in surrounding prose. Returns `undefined` when no JSON is found.
 */
function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		const match = text.match(/\{[\s\S]*\}/)
		if (match) {
			try {
				return JSON.parse(match[0])
			} catch {
				/* fall through */
			}
		}
		return undefined
	}
}

// ─── Types ──

export interface WorkflowTaskOptions extends TaskOptions {
	slangSource: string
	flowDecl: UpstreamFlowDecl
	flowState?: FlowState
	flowParams?: Record<string, unknown>
}

/** Result of advancing an agent's program counter over non-blocking instructions. */
type AdvanceResult =
	| { type: "stake"; op: StakeOp }
	| { type: "escalate"; op: EscalateOp }
	| { type: "await" }
	| { type: "committed" }
	| { type: "end" }

// ── Constants ──

const DEFAULT_BUDGET_TOKENS = 300000
const DEFAULT_BUDGET_ROUNDS = 30
/** Maximum consecutive output-validation failures before marking the agent as error. */
const MAX_RETRIES = 3
/** Max wall-clock time to wait for a round's spawned agent tasks to complete. */
const AGENT_RESULT_TIMEOUT_MS = 300_000
/** Poll interval while waiting for agent tasks to reach a terminal lifecycle. */
const POLL_INTERVAL_MS = 500
/** Guard against compiler/eval bugs producing an infinite control-flow loop. */
const MAX_CONTROL_FLOW_STEPS = 10_000

// ── WorkflowTask ──

export class WorkflowTask extends Task {
	readonly slangSource: string
	readonly flowDecl: UpstreamFlowDecl
	flowState: FlowState
	private slangLoopStarted = false

	/**
	 * Compiled, flat instruction list per agent. Rebuilt from the AST in the
	 * constructor and never serialized — the program counter persisted in
	 * `AgentState.opIndex` indexes into this list, so it must be deterministic
	 * w.r.t. the (immutable) slang source.
	 */
	private readonly programs = new Map<string, Instr[]>()

	constructor(options: WorkflowTaskOptions) {
		const flowName = options.flowDecl.name
		super({ ...options, startTask: false, initialMode: flowName })

		this.slangSource = options.slangSource
		this.flowDecl = options.flowDecl

		for (const agentDecl of getAgentDecls(this.flowDecl)) {
			this.programs.set(agentDecl.name, compileAgentProgram(agentDecl))
		}

		if (options.flowState) {
			this.flowState = options.flowState
		} else {
			const params = options.flowParams || {}
			const agents = new Map<string, AgentState>()
			for (const agentDecl of getAgentDecls(this.flowDecl)) {
				agents.set(agentDecl.name, {
					name: agentDecl.name,
					taskId: "",
					status: "idle",
					opIndex: 0,
					bindings: new Map(),
					retryCount: 0,
				})
			}
			this.flowState = {
				flowName,
				params,
				agents,
				round: 0,
				tokensUsed: 0,
				status: "running",
				mailbox: [],
				sourcePath: undefined,
			}
		}
	}

	getWorkflowHistoryExtension(): Partial<HistoryItem> {
		return {
			isWorkflow: true,
			slangSource: this.slangSource,
			flowState: serializeFlowState(this.flowState),
		}
	}

	override async start(): Promise<void> {
		if (this.slangLoopStarted) return
		this.slangLoopStarted = true
		try {
			this.emit(ShoferEventName.TaskStarted)
			this.taskStartedEmitted = true
			await this.slangLoop()
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] slangLoop failed:`, error)
			this.flowState.status = "error"
			await this.emitTaskCompleted("poor")
		}
	}

	private async slangLoop(): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) throw new Error("WorkflowTask: provider reference lost")

		const budget = getBudget(this.flowDecl)
		const budgetRounds = budget.bRounds || DEFAULT_BUDGET_ROUNDS
		const budgetTokens = budget.bTokens || DEFAULT_BUDGET_TOKENS

		while (
			this.flowState.round < budgetRounds &&
			this.flowState.tokensUsed < budgetTokens &&
			!this.abort &&
			this.flowState.status === "running"
		) {
			this.flowState.round++

			// 1. Advance every non-running / non-terminal agent over its
			//    non-blocking instructions until it either blocks (stake / await
			//    / escalate) or commits.
			const stakes: string[] = []
			const escalations: string[] = []
			for (const [name, state] of this.flowState.agents) {
				if (state.status === "running" || state.status === "committed" || state.status === "error") continue
				const result = this.advanceAgent(state)
				switch (result.type) {
					case "stake":
						stakes.push(name)
						break
					case "escalate":
						escalations.push(name)
						break
					case "await":
						state.status = "blocked"
						break
					case "committed":
						// status already set inside advanceAgent
						break
					case "end":
						// Program exhausted with no explicit commit — treat as done
						// (advanceAgent may have set "error" via its step-limit guard).
						if ((state.status as string) !== "error") state.status = "committed"
						break
				}
			}

			// 2. Converged?
			if (this.checkConverge()) {
				await this.handleConverge()
				return
			}

			// 3. No agent can make progress and none committed → deadlock.
			if (stakes.length === 0 && escalations.length === 0) {
				this.flowState.status = "deadlock"
				outputError(`[WorkflowTask#${this.taskId}] Deadlock at round ${this.flowState.round}`)
				await this.persistCheckpoint()
				await this.emitTaskCompleted("poor")
				return
			}

			// 4. Handle escalations synchronously (blocks on human input), then
			//    restart the round so freshly-delivered mail is consumed.
			if (escalations.length > 0) {
				for (const name of escalations) await this.handleEscalation(name)
				await this.persistCheckpoint()
				continue
			}

			// 5. Dispatch all staking agents in parallel, wait, collect results.
			await this.dispatchStakes(stakes)
			await this.waitForStakes(stakes)
			await this.collectStakeResults(stakes)

			// 6. Re-check convergence and checkpoint.
			if (this.checkConverge()) {
				await this.handleConverge()
				return
			}
			await this.persistCheckpoint()
		}

		// Loop exited without convergence: budget exhausted (or aborted).
		if (!this.abort && this.flowState.status === "running") {
			this.flowState.status = "budget_exceeded"
			outputLog(`[WorkflowTask#${this.taskId}] Budget exhausted after ${this.flowState.round} rounds`)
			await super.abortBackgroundChildren()
			await this.persistCheckpoint()
			await this.emitTaskCompleted("poor")
		}
	}

	// ── Interpreter ──

	/**
	 * Advance an agent's program counter, executing all non-blocking
	 * instructions (let / set / jump / branch / satisfied commit) until it
	 * reaches a blocking instruction (stake / escalate / unsatisfied await),
	 * commits, or runs off the end of its program.
	 */
	private advanceAgent(state: AgentState): AdvanceResult {
		const program = this.programs.get(state.name)
		if (!program) return { type: "end" }

		let guard = 0
		while (state.opIndex < program.length) {
			if (++guard > MAX_CONTROL_FLOW_STEPS) {
				outputError(`[WorkflowTask#${this.taskId}] Agent '${state.name}' exceeded control-flow step limit`)
				state.status = "error"
				return { type: "end" }
			}

			const instr = program[state.opIndex]!
			switch (instr.kind) {
				case "let":
				case "set":
					state.bindings.set(instr.op.name, this.evalExpr(instr.op.value, state))
					state.opIndex++
					break
				case "jump":
					state.opIndex = instr.target
					break
				case "branch": {
					const truthy = this.toBool(this.evalExpr(instr.cond, state))
					state.opIndex = truthy === instr.jumpWhen ? instr.target : state.opIndex + 1
					break
				}
				case "commit":
					if (instr.op.condition && !this.toBool(this.evalExpr(instr.op.condition, state))) {
						state.opIndex++
						break
					}
					state.status = "committed"
					if (instr.op.value) state.output = this.evalExpr(instr.op.value, state)
					return { type: "committed" }
				case "stake":
					return { type: "stake", op: instr.op }
				case "escalate":
					if (instr.op.condition && !this.toBool(this.evalExpr(instr.op.condition, state))) {
						state.opIndex++
						break
					}
					return { type: "escalate", op: instr.op }
				case "await": {
					const sources = instr.op.sources.map((s) => s.ref)
					const mail = this.consumeMail(state.name, sources)
					if (mail) {
						state.bindings.set(instr.op.binding, mail.value)
						state.waitingFor = undefined
						state.opIndex++
						break
					}
					state.waitingFor = sources.join(",")
					return { type: "await" }
				}
			}
		}
		return { type: "end" }
	}

	/** Remove and return the first mailbox entry addressed to `recipient` from one of `sources`. */
	private consumeMail(recipient: string, sources: string[]): MailboxEntry | undefined {
		const wildcard = sources.includes("any") || sources.includes("*")
		const idx = this.flowState.mailbox.findIndex(
			(e) => e.to === recipient && (wildcard || sources.includes(e.from)),
		)
		if (idx === -1) return undefined
		const [entry] = this.flowState.mailbox.splice(idx, 1)
		return entry
	}

	/** Evaluate a slang expression against an agent's local bindings + flow globals. */
	private evalExpr(expr: Expr, state: AgentState): unknown {
		switch (expr.type) {
			case "StringLit":
			case "NumberLit":
			case "BoolLit":
				return expr.value
			case "Ident":
				if (state.bindings.has(expr.name)) return state.bindings.get(expr.name)
				if (expr.name in this.flowState.params) return this.flowState.params[expr.name]
				switch (expr.name) {
					case "all_committed":
						return this.allAgentsCommitted()
					case "committed_count":
						return this.committedCount()
					case "round":
						return this.flowState.round
					default:
						return undefined
				}
			case "AgentRef":
				return this.flowState.agents.get(expr.name)
			case "ListLit":
				return expr.elements.map((e) => this.evalExpr(e, state))
			case "DotAccess": {
				if (expr.object.type === "AgentRef") {
					const target = this.flowState.agents.get(expr.object.name)
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
				const base = this.evalExpr(expr.object, state)
				if (base && typeof base === "object") {
					return (base as Record<string, unknown>)[expr.property]
				}
				return undefined
			}
			case "BinaryExpr": {
				if (expr.op === "&&")
					return this.toBool(this.evalExpr(expr.left, state)) && this.toBool(this.evalExpr(expr.right, state))
				if (expr.op === "||")
					return this.toBool(this.evalExpr(expr.left, state)) || this.toBool(this.evalExpr(expr.right, state))
				const l = this.evalExpr(expr.left, state)
				const r = this.evalExpr(expr.right, state)
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

	/** JS-style truthiness over evaluated expression values. */
	private toBool(value: unknown): boolean {
		return Boolean(value)
	}

	/** A throwaway agent state for evaluating flow-global converge/budget expressions. */
	private globalEvalState(): AgentState {
		return { name: "", taskId: "", status: "idle", opIndex: 0, bindings: new Map() }
	}

	// ── Dispatch ──

	/** Build the prompt sent to an agent task for a stake operation. */
	private buildStakePrompt(agentName: string, state: AgentState, op: StakeOp): string {
		let prompt = `Execute: ${op.call.name}`
		if (op.call.args.length > 0) {
			const args: Record<string, unknown> = {}
			let positional = 0
			for (const arg of op.call.args) {
				const key = arg.name ?? `arg${positional++}`
				args[key] = this.evalExpr(arg.value, state)
			}
			prompt += `\n\nArguments:\n${JSON.stringify(args, null, 2)}`
		}
		if (state.bindings.size > 0) {
			prompt += `\n\nCurrent context:\n${JSON.stringify(Object.fromEntries(state.bindings), null, 2)}`
		}
		if (op.output) {
			prompt += `\n\nOUTPUT CONTRACT:\nYour attempt_completion result MUST be ONLY a valid JSON object (no markdown, no extra text) with exactly these fields:\n`
			for (const f of op.output.fields) prompt += `  - ${f.name}: ${f.fieldType}\n`
			prompt += `\nExample: {"${op.output.fields.map((f) => f.name).join('": ..., "')}": ...}\n\nThe result will be validated against this schema. Missing fields or non-JSON will cause a retry (max ${MAX_RETRIES} retries before the agent is marked as error).`
		}
		const peers = this.getPeerResources(agentName)
		if (peers.length > 0) {
			prompt += `\n\nPEER RESOURCES (use send_message_to_task to query):\n`
			for (const p of peers) prompt += `- ${p.name} (task ID: ${p.taskId}) — ${p.role}\n`
		}
		return prompt
	}

	/** Peer agent tasks an agent may query directly via send_message_to_task.
	 *
	 * Derived from the flow's declared communication topology: an agent may
	 * directly query any live peer it stakes to or awaits from, regardless of
	 * mode. This keeps direct-query access aligned with the edges the workflow
	 * author actually declared rather than an arbitrary mode allowlist. */
	private getPeerResources(agentName: string): Array<{ name: string; taskId: string; role: string }> {
		const decl = getAgentDecls(this.flowDecl).find((a) => a.name === agentName)
		if (!decl) return []
		const peerNames = getCommunicationPeers(decl)
		const resources: Array<{ name: string; taskId: string; role: string }> = []
		for (const peerName of peerNames) {
			if (peerName === agentName) continue
			const agentState = this.flowState.agents.get(peerName)
			if (!agentState || !agentState.taskId || agentState.status === "committed") continue
			const peerDecl = getAgentDecls(this.flowDecl).find((a) => a.name === peerName)
			resources.push({
				name: peerName,
				taskId: agentState.taskId,
				role: peerDecl?.meta?.role || `Agent '${peerName}'`,
			})
		}
		return resources
	}

	/** Dispatch (spawn or resume) every staking agent for this round. */
	private async dispatchStakes(names: string[]): Promise<void> {
		for (const name of names) {
			const state = this.flowState.agents.get(name)
			const program = this.programs.get(name)
			if (!state || !program) continue
			const instr = program[state.opIndex]
			if (!instr || instr.kind !== "stake") continue

			const prompt = this.buildStakePrompt(name, state, instr.op)
			if (!state.taskId) await this.spawnAgentTask(name, prompt)
			else await this.resumeAgentTask(name, prompt)
			state.status = "running"
		}
	}

	private async spawnAgentTask(agentName: string, prompt: string): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return

		const agentDecl = getAgentDecls(this.flowDecl).find((a) => a.name === agentName)
		if (!agentDecl) return

		const agentState = this.flowState.agents.get(agentName)
		if (!agentState) return

		const mode = (agentDecl.meta as any)?.mode || "code"

		try {
			const task = await provider.createTask(prompt, undefined, this, {
				isBackground: true,
				initialMode: mode,
				initialState: { lifecycle: "idle" },
				openInStack: false,
				keepCurrentTask: true,
			})
			if (task) {
				this.backgroundChildren.set(task.taskId, {
					taskId: task.taskId,
					status: "running",
					createdAt: Date.now(),
					parentTaskId: this.taskId,
				})
				agentState.taskId = task.taskId
			}
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] Failed to spawn agent '${agentName}':`, error)
			agentState.status = "error"
		}
	}

	private async resumeAgentTask(agentName: string, prompt: string): Promise<void> {
		const agentState = this.flowState.agents.get(agentName)
		if (!agentState?.taskId) return

		const provider = this.providerRef.deref()
		if (!provider) return

		try {
			let agentTask = provider.taskManager.getManagedTaskInstance(agentState.taskId)
			if (!agentTask) {
				const { historyItem } = await provider.getTaskWithId(agentState.taskId)
				await provider.createTaskWithHistoryItem(historyItem, { keepCurrentTask: true })
				agentTask = provider.taskManager.getManagedTaskInstance(agentState.taskId)
			}
			agentTask?.messageQueueService.addMessage(prompt)
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] Failed to resume agent '${agentName}':`, error)
			agentState.status = "error"
		}
	}

	// ── Wait & collect ──

	/** Poll spawned agent tasks until they all reach a terminal lifecycle or timeout. */
	private async waitForStakes(names: string[]): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return

		const taskIds = names.map((n) => this.flowState.agents.get(n)?.taskId).filter(Boolean) as string[]
		if (taskIds.length === 0) return

		const startTime = Date.now()
		while (Date.now() - startTime < AGENT_RESULT_TIMEOUT_MS && !this.abort) {
			let allDone = true
			for (const taskId of taskIds) {
				const handle = this.backgroundChildren.get(taskId)
				try {
					const { historyItem } = await provider.getTaskWithId(taskId)
					const lc = historyItem.taskState?.lifecycle
					if (lc === "completed") {
						if (handle) handle.status = "completed"
					} else if (lc === "error") {
						if (handle) handle.status = "error"
					} else {
						allDone = false
					}
				} catch {
					allDone = false
				}
			}
			if (allDone) break
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
		}
	}

	/**
	 * Read each staking agent's completion result, bind/route its output, then
	 * advance its program counter past the stake.
	 */
	private async collectStakeResults(names: string[]): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return

		for (const name of names) {
			const state = this.flowState.agents.get(name)
			const program = this.programs.get(name)
			if (!state || !program) continue
			const instr = program[state.opIndex]
			if (!instr || instr.kind !== "stake") continue

			try {
				const { historyItem } = await provider.getTaskWithId(state.taskId)
				this.flowState.tokensUsed += (historyItem.tokensIn || 0) + (historyItem.tokensOut || 0)

				let result: unknown = historyItem.completionResultSummary
				let validationError: string | null = null

				// Step 1: Parse JSON from completion result
				if (typeof result === "string") {
					const parsed = tryParseJson(result)
					if (parsed === undefined) {
						validationError = `Invalid JSON in attempt_completion result: could not extract a JSON object.`
					} else {
						result = parsed
					}
				}

				// Step 2: Validate fields against output schema
				const outputSchema = instr.op.output
				if (!validationError && outputSchema) {
					if (typeof result !== "object" || result === null || Array.isArray(result)) {
						validationError = `Result must be a JSON object, got ${typeof result}. Expected fields: ${outputSchema.fields.map((f) => `${f.name} (${f.fieldType})`).join(", ")}`
					} else {
						const obj = result as Record<string, unknown>
						const missing = outputSchema.fields.filter((f) => !(f.name in obj))
						if (missing.length > 0) {
							validationError = `Missing required fields: ${missing.map((f) => `${f.name} (${f.fieldType})`).join(", ")}. Expected: ${outputSchema.fields.map((f) => `${f.name} (${f.fieldType})`).join(", ")}`
						}
					}
				}

				// Step 3: Re-prompt on validation failure
				if (validationError) {
					state.retryCount++
					if (state.retryCount > MAX_RETRIES) {
						outputError(
							`[WorkflowTask#${this.taskId}] Agent '${name}' exceeded max retries (${MAX_RETRIES}) for output validation:\n${validationError}`,
						)
						state.status = "error"
					} else {
						outputLog(
							`[WorkflowTask#${this.taskId}] Agent '${name}' output validation failed (retry ${state.retryCount}/${MAX_RETRIES}): ${validationError}`,
						)
						state.status = "idle"
						// Re-prompt the agent with the validation error — do NOT advance opIndex
						const retryPrompt = `\n\nYour previous response was invalid:\n${validationError}\n\nPlease retry the operation by placing ONLY a valid JSON object in your attempt_completion result (no other text, no markdown fences).`
						await this.resumeAgentTask(name, retryPrompt)
					}
					continue
				}

				// Step 4: Success — reset retry count, store output, route to mailbox
				state.retryCount = 0
				state.output = result
				if (instr.op.binding) state.bindings.set(instr.op.binding, result)
				this.routeOutput(name, instr.op, result)
				state.status = "idle"
			} catch (error) {
				outputError(`[WorkflowTask#${this.taskId}] Failed to read result for '${name}':`, error)
				state.status = "error"
			}
		}
	}

	/** Deliver a stake's output to all of its recipients (@Agent / @all / @out). */
	private routeOutput(from: string, op: StakeOp, value: unknown): void {
		for (const recipient of op.recipients) {
			const ref = recipient.ref
			if (ref === "out") {
				this.flowState.mailbox.push({ from, to: "out", value, timestamp: Date.now(), funcName: op.call.name })
			} else if (ref === "all") {
				for (const [otherName] of this.flowState.agents) {
					if (otherName === from) continue
					this.flowState.mailbox.push({
						from,
						to: otherName,
						value,
						timestamp: Date.now(),
						funcName: op.call.name,
					})
				}
			} else {
				this.flowState.mailbox.push({ from, to: ref, value, timestamp: Date.now(), funcName: op.call.name })
			}
		}
	}

	// ── Escalate ──

	/** Block for human input on an agent's escalate operation, then deliver the reply. */
	private async handleEscalation(agentName: string): Promise<void> {
		const state = this.flowState.agents.get(agentName)
		const program = this.programs.get(agentName)
		if (!state || !program) return
		const instr = program[state.opIndex]
		if (!instr || instr.kind !== "escalate") return

		this.flowState.status = "escalated"
		const reason = instr.op.reason || `Agent '${agentName}' needs your input.`
		const { text } = await this.ask("followup", reason)
		const response = text ?? ""

		this.flowState.mailbox.push({
			from: instr.op.target || "Human",
			to: agentName,
			value: response,
			timestamp: Date.now(),
			funcName: "escalate",
		})
		state.opIndex++
		state.status = "idle"
		this.flowState.status = "running"
	}

	// ── Converge ──

	private checkConverge(): boolean {
		const convergeExpr = getConvergeExpr(this.flowDecl)
		if (!convergeExpr) return this.allAgentsCommitted()
		return this.toBool(this.evalExpr(convergeExpr, this.globalEvalState()))
	}

	private allAgentsCommitted(): boolean {
		for (const [, s] of this.flowState.agents) {
			if (s.status !== "committed") return false
		}
		return true
	}

	private committedCount(): number {
		let count = 0
		for (const [, s] of this.flowState.agents) {
			if (s.status === "committed") count++
		}
		return count
	}

	private async handleConverge(): Promise<void> {
		this.flowState.status = "converged"
		await this.persistCheckpoint()
		await this.emitTaskCompleted("well")
	}

	// ── Persistence ──

	private async persistCheckpoint(): Promise<void> {
		try {
			const provider = this.providerRef.deref()
			if (!provider) return
			await provider.updateTaskHistory({ id: this.taskId, ...this.getWorkflowHistoryExtension() } as any)
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] Failed to persist checkpoint:`, error)
		}
	}

	private async emitTaskCompleted(rating: "poor" | "well" | "excellent"): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return
		try {
			const taskManager = provider.taskManager
			if (taskManager) {
				await (taskManager as any).setState?.(this.taskId, { lifecycle: "completed", rating })
			}
			await this.persistCheckpoint()
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] Failed to emit completion:`, error)
		}
	}
}

// ── Factory ──

export async function createWorkflowTask(
	provider: ShoferProvider,
	slangSource: string,
	flowParams?: Record<string, unknown>,
): Promise<WorkflowTask> {
	const { ast, errors } = parseSlang(slangSource)
	if (errors.length > 0) throw new Error(`Slang parse errors:\n${errors.join("\n")}`)
	if (ast.flows.length === 0) throw new Error("No flows found in .slang source")

	const flowDecl = ast.flows[0]

	const warnings = validateSlangAST(ast)
	if (warnings.length > 0) {
		outputLog(`[Workflow] Warnings for '${flowDecl.name}':\n${warnings.join("\n")}`)
	}

	const state = await provider.getState()
	const apiConfiguration = state?.apiConfiguration
	if (!apiConfiguration) throw new Error("No API configuration available")

	return new WorkflowTask({ provider, apiConfiguration, slangSource, flowDecl, flowParams })
}

/**
 * Reconstruct a WorkflowTask from a persisted workflow HistoryItem.
 *
 * Unlike {@link createWorkflowTask} (which starts a fresh flow), this recompiles
 * the agent programs from the persisted slang source and rehydrates the saved
 * {@link FlowState} (program counters, bindings, mailbox, round/token counters)
 * so the slang loop can resume exactly where it left off. The original `taskId`
 * is preserved by threading the `historyItem` through to the `Task` superclass.
 */
export async function createWorkflowTaskFromHistory(
	provider: ShoferProvider,
	historyItem: HistoryItem,
): Promise<WorkflowTask> {
	if (!historyItem.slangSource) {
		throw new Error(`HistoryItem ${historyItem.id} is flagged as a workflow but has no slangSource`)
	}

	const { ast, errors } = parseSlang(historyItem.slangSource)
	if (errors.length > 0) throw new Error(`Slang parse errors:\n${errors.join("\n")}`)
	if (ast.flows.length === 0) throw new Error("No flows found in persisted .slang source")

	const flowDecl = ast.flows[0]
	const flowState = historyItem.flowState
		? deserializeFlowState(historyItem.flowState as Record<string, unknown>)
		: undefined

	const state = await provider.getState()
	const apiConfiguration = state?.apiConfiguration
	if (!apiConfiguration) throw new Error("No API configuration available")

	return new WorkflowTask({
		provider,
		apiConfiguration,
		slangSource: historyItem.slangSource,
		flowDecl,
		flowState,
		historyItem,
	})
}

/** Flow statuses from which the slang loop should NOT be resumed. */
export const TERMINAL_FLOW_STATUSES: ReadonlySet<FlowStatus> = new Set<FlowStatus>([
	"converged",
	"budget_exceeded",
	"deadlock",
	"error",
])

// ── .slang File Discovery ──

export async function discoverWorkflows(workspacePath: string): Promise<Map<string, string>> {
	const workflows = new Map<string, string>()
	const globalDir = path.join(os.homedir(), ".shofer", "workflows")
	await loadFromDir(globalDir, workflows)
	const projectDir = path.join(workspacePath, ".shofer", "workflows")
	await loadFromDir(projectDir, workflows)
	return workflows
}

async function loadFromDir(dir: string, workflows: Map<string, string>): Promise<void> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".slang")) {
				const filePath = path.join(dir, entry.name)
				const content = await fs.readFile(filePath, "utf-8")
				workflows.set(entry.name.replace(/\.slang$/, ""), content)
			}
		}
	} catch {
		/* dir doesn't exist */
	}
}
