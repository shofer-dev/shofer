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

/** Default value for a slang parameter type when none is provided by the user. */
function defaultParamValue(type: string): unknown {
	switch (type) {
		case "number":
			return 0
		case "boolean":
			return false
		default:
			return ""
	}
}

/** Coerce a raw user-input string to the expected slang parameter type. */
function coerceParam(raw: string, type: string): unknown {
	switch (type) {
		case "number":
			return Number(raw)
		case "boolean":
			return raw.toLowerCase() === "true" || raw === "1"
		default:
			return raw
	}
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

	override getHistoryExtension(): Partial<HistoryItem> {
		return {
			isWorkflow: true,
			slangSource: this.slangSource,
			flowState: serializeFlowState(this.flowState),
		}
	}

	override async abortTask(): Promise<void> {
		// Persist the aborted state BEFORE the super call disposes the
		// task, so the rehydrated instance from cancelTask sees a
		// terminal status in start() and doesn't restart.
		this.flowState.status = "aborted"
		try {
			await this.persistCheckpoint()
		} catch {
			// Best-effort — persistCheckpoint may fail if the provider
			// reference was already cleared.
		}
		await super.abortTask()
	}

	override async start(): Promise<void> {
		if (this.slangLoopStarted) return
		// If the flow was stopped (via cancelTask) before starting, the
		// rehydrated instance carries a terminal status. Don't restart.
		if ((this.flowState.status as string) !== "running") {
			outputLog(
				`[WorkflowTask#${this.taskId}] Skipping start — flow status is ${this.flowState.status} (was stopped)`,
			)
			return
		}
		this.slangLoopStarted = true
		try {
			this.emit(ShoferEventName.TaskStarted)
			this.taskStartedEmitted = true

			const agentNames = [...this.flowState.agents.keys()]
			outputLog(
				`[WorkflowTask#${this.taskId}] Starting workflow '${this.flowState.flowName}' with ${agentNames.length} agent(s): ${agentNames.join(", ")}`,
			)

			// Emit a canary say() FIRST so that even if the header say() fails,
			// the chat stream is non-empty and WorkflowView won't render the
			// "Starting workflow…" spinner indefinitely. This also serves as a
			// diagnostic: if you see this message but no header, the header's
			// say() call is the failure point.
			await this.sayProgress(
				`⚙️ Initializing workflow **${this.flowState.flowName}** (${agentNames.length} agent(s))…`,
			)

			// Seed the chat stream with a header message so `messages.at(0)` is
			// defined — WorkflowView keys its TaskHeader / Virtuoso off this first
			// message and otherwise renders the empty-stream spinner fallback.
			try {
				await this.say(
					"text",
					`**Workflow: ${this.flowState.flowName}**\n\nOrchestrating ${agentNames.length} agent(s): ${agentNames.map((n) => `\`${n}\``).join(", ")}`,
				)
			} catch (headerError) {
				outputError(`[WorkflowTask#${this.taskId}] Failed to emit header say():`, headerError)
				// Don't re-throw — the canary sayProgress above already seeded
				// the stream, so WorkflowView will show it. Continue with the
				// slang loop so the workflow can still make progress.
			}

			// Collect any flow parameters the user needs to provide BEFORE
			// starting the slang loop. Uses the same ask("followup", …)
			// mechanism as escalate @Human — posts the question to the
			// webview, and the answer arrives later via
			// handleWebviewAskResponse, which unblocks slangLoop().
			if (this.needsFlowParams()) {
				this.requestFlowParams()
				return // slangLoop will be started by handleWebviewAskResponse
			}

			await this.slangLoop()
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] start() failed:`, error)
			// Log the full error shape for diagnostics — especially useful when
			// the error is a non-Error object (e.g. a rejected promise with no
			// .message) that would render as "[object Object]" in the chat.
			if (error && typeof error === "object") {
				try {
					outputError(
						`[WorkflowTask#${this.taskId}] Error detail: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`,
					)
				} catch {
					outputError(`[WorkflowTask#${this.taskId}] Error detail (non-serializable): ${String(error)}`)
				}
			}
			try {
				await this.sayProgress(`❌ Workflow failed: ${error instanceof Error ? error.message : String(error)}`)
			} catch (sayError) {
				outputError(`[WorkflowTask#${this.taskId}] Failed to emit error sayProgress:`, sayError)
			}
			this.flowState.status = "error"
			await this.emitTaskCompleted("poor")
		}
	}

	/** True when the flow declares params that haven't been populated yet. */
	private needsFlowParams(): boolean {
		const declParams = this.flowDecl.params
		if (!declParams || declParams.length === 0) return false
		return declParams.some((p) => !(p.name in (this.flowState.params || {})))
	}

	/**
	 * Post a followup ask so the user can enter parameter values. The
	 * webview (WorkflowView) renders a textbox. When the user responds,
	 * {@link handleWebviewAskResponse} parses the values and starts the
	 * slang loop.
	 */
	/**
	 * Ask one question per missing parameter, sequentially. Each answer
	 * is type-coerced and stored directly. An empty answer falls back to
	 * the type's default. The slang loop starts once all params are
	 * collected (or skipped with defaults).
	 */
	private requestFlowParams(): void {
		const declParams = this.flowDecl.params!
		const missing = declParams.filter((p) => !(p.name in (this.flowState.params || {})))

		const askNext = (index: number): Promise<void> => {
			if (index >= missing.length) {
				for (const p of missing) {
					if (!(p.name in (this.flowState.params || {}))) {
						this.flowState.params[p.name] = defaultParamValue(p.paramType)
					}
				}
				// Persist params immediately so that if the workflow is
				// stopped/cancelled after collection but before
				// slangLoop starts, the rehydrated instance sees the
				// populated params and skips re-asking.
				void this.persistCheckpoint()
				outputLog(`[WorkflowTask#${this.taskId}] Flow params collected, starting slang loop`)
				void this.slangLoop()
				return Promise.resolve()
			}

			const p = missing[index]
			const dv = defaultParamValue(p.paramType)
			const hasDefault = dv !== "" && dv !== 0 && dv !== false
			const question = hasDefault
				? `What value for \`${p.name}\`? (${p.paramType}, default: ${JSON.stringify(dv)})`
				: `What value for \`${p.name}\`? (${p.paramType})`

			return this.ask("followup", JSON.stringify({ question })).then(({ text }) => {
				const raw = text?.trim() ?? ""
				if (raw) {
					this.flowState.params[p.name] = coerceParam(raw, p.paramType)
				} else if (hasDefault) {
					this.flowState.params[p.name] = dv
				}
				outputLog(
					`[WorkflowTask#${this.taskId}] Flow param ${p.name}=${JSON.stringify(this.flowState.params[p.name])} (type=${p.paramType})`,
				)
				return askNext(index + 1)
			})
		}

		outputLog(
			`[WorkflowTask#${this.taskId}] Collecting ${missing.length} flow param(s): ${missing.map((p) => p.name).join(", ")}`,
		)
		void askNext(0).catch((error) => {
			if (this.abort) {
				outputLog(`[WorkflowTask#${this.taskId}] Flow param collection aborted — task is stopping`)
				// Persist the aborted status to history BEFORE cancelTask
				// re-reads it and rehydrates. Without this, the rehydrated
				// instance sees flowState.status === "running" and
				// re-enters requestFlowParams().
				this.flowState.status = "aborted"
				void this.persistCheckpoint()
				return
			}
			outputError(`[WorkflowTask#${this.taskId}] Failed to collect flow params:`, error)
			this.flowState.status = "error"
			void this.emitTaskCompleted("poor")
		})
	}

	/**
	 * Emit a single workflow progress line to BOTH the output channel (for
	 * troubleshooting) and the chat stream (so the user sees live status). The
	 * slang loop drives no LLM, so these `say("text", …)` calls are the only
	 * thing populating WorkflowView — without them the view shows an empty
	 * stream and a spinner.
	 */
	private async sayProgress(message: string): Promise<void> {
		outputLog(`[WorkflowTask#${this.taskId}] ${message}`)
		if (this.abort) return
		try {
			await this.say("text", message)
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] Failed to emit progress say:`, error)
		}
	}

	private async slangLoop(): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) throw new Error("WorkflowTask: provider reference lost")

		const budget = getBudget(this.flowDecl)
		const budgetRounds = budget.bRounds || DEFAULT_BUDGET_ROUNDS
		const budgetTokens = budget.bTokens || DEFAULT_BUDGET_TOKENS

		outputLog(
			`[WorkflowTask#${this.taskId}] #TRACE slangLoop start — flow='${this.flowState.flowName}' budgetRounds=${budgetRounds} budgetTokens=${budgetTokens}`,
		)

		while (
			this.flowState.round < budgetRounds &&
			this.flowState.tokensUsed < budgetTokens &&
			!this.abort &&
			this.flowState.status === "running"
		) {
			this.flowState.round++

			outputLog(
				`[WorkflowTask#${this.taskId}] #TRACE ── Round ${this.flowState.round} begin ── agents: ${[...this.flowState.agents.entries()].map(([n, s]) => `${n}=${s.status}@op${s.opIndex}`).join(", ")}`,
			)

			// 1. Advance every non-running / non-terminal agent over its
			//    non-blocking instructions until it either blocks (stake / await
			//    / escalate) or commits.
			const stakes: string[] = []
			const escalations: string[] = []
			for (const [name, state] of this.flowState.agents) {
				if (state.status === "running" || state.status === "committed" || state.status === "error") {
					outputLog(
						`[WorkflowTask#${this.taskId}] #TRACE advanceAgent skip '${name}' — status=${state.status} (not idle/blocked)`,
					)
					continue
				}
				const result = this.advanceAgent(state)
				outputLog(
					`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${name}' result=${result.type} status=${state.status} opIndex=${state.opIndex}`,
				)
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
						outputLog(
							`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${name}' reached end of program — status forced to ${state.status}`,
						)
						break
				}
			}

			// 2. Converged?
			if (this.checkConverge()) {
				outputLog(`[WorkflowTask#${this.taskId}] #TRACE checkConverge=true → handleConverge`)
				await this.handleConverge()
				return
			}

			// 3. No agent can make progress and none committed → deadlock.
			if (stakes.length === 0 && escalations.length === 0) {
				this.flowState.status = "deadlock"
				const agentDump = [...this.flowState.agents.entries()]
					.map(([n, s]) => `${n}=${s.status}@op${s.opIndex}(taskId=${s.taskId || "none"})`)
					.join(", ")
				outputError(
					`[WorkflowTask#${this.taskId}] #TRACE Deadlock at round ${this.flowState.round}. Agents: [${agentDump}] convergeExpr=${JSON.stringify(getConvergeExpr(this.flowDecl))} allCommitted=${this.allAgentsCommitted()}`,
				)
				await this.sayProgress(
					`⛔ Deadlock at round ${this.flowState.round}: no agent can make progress and none have committed.`,
				)
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
			await this.sayProgress(
				`🔄 Round ${this.flowState.round}: dispatching ${stakes.length} agent(s) — ${stakes.map((n) => `\`${n}\``).join(", ")}`,
			)
			await this.dispatchStakes(stakes)
			await this.waitForStakes(stakes)
			await this.collectStakeResults(stakes)

			// 6. Budget check — exit immediately when a single stake blows
			//    the budget, rather than waiting for the next while-guard
			//    evaluation at the top of the loop.
			if (this.flowState.tokensUsed >= budgetTokens) {
				this.flowState.status = "budget_exceeded"
				outputLog(
					`[WorkflowTask#${this.taskId}] Budget exceeded mid-round: ${this.flowState.tokensUsed} >= ${budgetTokens}`,
				)
				await this.sayProgress(
					`⚠️ Budget exhausted (${this.flowState.tokensUsed} tokens used, limit ${budgetTokens}). Stopping.`,
				)
				await super.abortBackgroundChildren()
				await this.persistCheckpoint()
				await this.emitTaskCompleted("poor")
				return
			}

			await this.sayProgress(
				`✓ Round ${this.flowState.round} complete (${this.committedCount()}/${this.flowState.agents.size} agents committed).`,
			)

			// 7. Re-check convergence and checkpoint.
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
			await this.sayProgress(
				`⚠️ Budget exhausted after ${this.flowState.round} round(s) (${this.flowState.tokensUsed} tokens used). Stopping.`,
			)
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
		if (!program) {
			outputLog(`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}': no compiled program → end`)
			return { type: "end" }
		}

		outputLog(
			`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' enter — opIndex=${state.opIndex}/${program.length} program=[${program.map((i) => i.kind).join(",")}]`,
		)

		let guard = 0
		while (state.opIndex < program.length) {
			if (++guard > MAX_CONTROL_FLOW_STEPS) {
				outputError(`[WorkflowTask#${this.taskId}] Agent '${state.name}' exceeded control-flow step limit`)
				state.status = "error"
				return { type: "end" }
			}

			const instr = program[state.opIndex]!
			outputLog(
				`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' exec opIndex=${state.opIndex} instr=${instr.kind}`,
			)
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
						outputLog(
							`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' commit condition NOT met → skip (opIndex now ${state.opIndex + 1})`,
						)
						state.opIndex++
						break
					}
					state.status = "committed"
					if (instr.op.value) state.output = this.evalExpr(instr.op.value, state)
					outputLog(
						`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' → committed (hasValue=${!!instr.op.value})`,
					)
					return { type: "committed" }
				case "stake":
					outputLog(
						`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' → stake call=${instr.op.call.name} recipients=[${instr.op.recipients.map((r) => r.ref).join(",")}] hasOutput=${!!instr.op.output}`,
					)
					return { type: "stake", op: instr.op }
				case "escalate":
					if (instr.op.condition && !this.toBool(this.evalExpr(instr.op.condition, state))) {
						outputLog(
							`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' escalate condition NOT met → skip`,
						)
						state.opIndex++
						break
					}
					outputLog(
						`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' → escalate target=${instr.op.target || "Human"}`,
					)
					return { type: "escalate", op: instr.op }
				case "await": {
					const sources = instr.op.sources.map((s) => s.ref)
					const mail = this.consumeMail(state.name, sources)
					if (mail) {
						outputLog(
							`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' await satisfied — mail from=${mail.from} for binding=${instr.op.binding}`,
						)
						state.bindings.set(instr.op.binding, mail.value)
						state.waitingFor = undefined
						state.opIndex++
						break
					}
					state.waitingFor = sources.join(",")
					outputLog(
						`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}' → awaiting ${state.waitingFor} (mailbox has ${this.flowState.mailbox.length} entries)`,
					)
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
		return { name: "", taskId: "", status: "idle", opIndex: 0, bindings: new Map(), retryCount: 0 }
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
			const isNew = !state.taskId
			outputLog(
				`[WorkflowTask#${this.taskId}] #TRACE dispatchStakes '${name}' isNew=${isNew} taskId=${state.taskId || "none"} promptLen=${prompt.length}`,
			)
			if (isNew) await this.spawnAgentTask(name, prompt)
			else await this.resumeAgentTask(name, prompt)
			state.status = "running"
		}
	}

	private async spawnAgentTask(agentName: string, prompt: string): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) {
			outputLog(`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' FAIL: no provider`)
			return
		}

		const agentDecl = getAgentDecls(this.flowDecl).find((a) => a.name === agentName)
		if (!agentDecl) {
			outputLog(`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' FAIL: no agentDecl in AST`)
			return
		}

		const agentState = this.flowState.agents.get(agentName)
		if (!agentState) {
			outputLog(
				`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' FAIL: no agentState in flowState`,
			)
			return
		}

		const mode = (agentDecl.meta as any)?.mode || "code"

		try {
			outputLog(
				`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' creating task mode='${mode}' isBackground=true`,
			)
			const task = await provider.createTask(prompt, undefined, this, {
				isBackground: true,
				initialMode: mode,
				initialState: { lifecycle: "idle" },
				openInStack: false,
				keepCurrentTask: true,
			})
			if (task) {
				// Register with TaskManager so the ManagedTask event listeners
				// fire on lifecycle changes (e.g. setState("completed") in
				// response to TaskCompleted). Without this, waitForStakes poll
				// never sees the agent as terminal and the flow deadlocks.
				provider.taskManager.registerBackgroundTask(task)
				this.backgroundChildren.set(task.taskId, {
					taskId: task.taskId,
					status: "running",
					createdAt: Date.now(),
					parentTaskId: this.taskId,
				})

				// Persist the parent-child relationship in the parent workflow's
				// history item so cascade-deletion (deleteManagedTask) can find
				// agent children via the persisted childIds chain.
				try {
					const { historyItem: parentHistory } = await provider.getTaskWithId(this.taskId)
					const backgroundChildIds = Array.from(
						new Set([...(parentHistory.backgroundChildIds ?? []), task.taskId]),
					)
					const childIds = Array.from(new Set([...(parentHistory.childIds ?? []), task.taskId]))
					await provider.updateTaskHistory({
						...parentHistory,
						backgroundChildIds,
						childIds,
					})
				} catch (err) {
					// Non-fatal: parent history metadata may be stale but the agent
					// task still runs.
					outputError(
						`[WorkflowTask#${this.taskId}] Failed to update parent history for agent '${agentName}': ${err}`,
					)
				}
				agentState.taskId = task.taskId
				outputLog(
					`[WorkflowTask#${this.taskId}] Spawned agent '${agentName}' (mode='${mode}') as task ${task.taskId}`,
				)
			} else {
				outputLog(
					`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' createTask returned null/undefined`,
				)
			}
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] Failed to spawn agent '${agentName}':`, error)
			agentState.status = "error"
		}
	}

	private async resumeAgentTask(agentName: string, prompt: string): Promise<void> {
		const agentState = this.flowState.agents.get(agentName)
		if (!agentState?.taskId) {
			outputLog(`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' FAIL: no taskId`)
			return
		}

		const provider = this.providerRef.deref()
		if (!provider) {
			outputLog(`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' FAIL: no provider`)
			return
		}

		try {
			outputLog(`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' taskId=${agentState.taskId}`)
			let agentTask = provider.taskManager.getManagedTaskInstance(agentState.taskId)
			if (!agentTask) {
				outputLog(
					`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' task not live, rehydrating from history`,
				)
				const { historyItem } = await provider.getTaskWithId(agentState.taskId)
				await provider.createTaskWithHistoryItem(historyItem, { keepCurrentTask: true })
				agentTask = provider.taskManager.getManagedTaskInstance(agentState.taskId)
			}
			agentTask?.messageQueueService.addMessage(prompt)
			outputLog(
				`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' prompt queued (${prompt.length} chars)`,
			)
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
		if (taskIds.length === 0) {
			outputLog(
				`[WorkflowTask#${this.taskId}] #TRACE waitForStakes: no taskIds to wait for (agents may not have been spawned)`,
			)
			return
		}

		outputLog(
			`[WorkflowTask#${this.taskId}] #TRACE waitForStakes: waiting for ${taskIds.length} task(s): ${taskIds.join(", ")}`,
		)

		const startTime = Date.now()
		let pollCount = 0
		while (Date.now() - startTime < AGENT_RESULT_TIMEOUT_MS && !this.abort) {
			pollCount++
			let allDone = true
			const statuses: string[] = []
			for (const taskId of taskIds) {
				const handle = this.backgroundChildren.get(taskId)
				// Check the in-memory ManagedTask state first — it is set
				// synchronously by TaskManager in response to TaskCompleted/
				// TaskAborted events and is the authoritative source.
				// The persisted HistoryItem.taskState is a reliable fallback
				// now that the single-writer violation in AttemptCompletionTool
				// has been fixed (Phase 1 of state_simplification.md).
				const managedState = provider.taskManager.getTaskState(taskId)
				const liveLc =
					managedState?.lifecycle === "completed" || managedState?.lifecycle === "error"
						? managedState.lifecycle
						: undefined
				let lc: string | undefined = liveLc
				let source = "live"

				if (liveLc === "completed" || liveLc === "error") {
					// Live task already terminal — use it directly, no history call needed.
				} else {
					try {
						const { historyItem } = await provider.getTaskWithId(taskId)
						lc = historyItem.taskState?.lifecycle
						source = "persisted"
					} catch {
						lc = "fetch_error"
						source = "error"
					}
				}

				statuses.push(`${taskId.slice(-6)}=${lc || "undefined"}(${source})`)
				if (lc === "completed") {
					if (handle) handle.status = "completed"
				} else if (lc === "error") {
					if (handle) handle.status = "error"
				} else {
					allDone = false
				}
			}
			if (pollCount === 1 || pollCount % 10 === 0 || allDone) {
				outputLog(
					`[WorkflowTask#${this.taskId}] #TRACE waitForStakes poll#${pollCount} allDone=${allDone} lifecycles=[${statuses.join(", ")}]`,
				)
			}
			if (allDone) break
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
		}
		const elapsed = Date.now() - startTime
		outputLog(`[WorkflowTask#${this.taskId}] #TRACE waitForStakes done — elapsed=${elapsed}ms polls=${pollCount}`)
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
				// Use in-memory TaskManager state for the lifecycle trace (set
				// synchronously by lifecycle events), not the persisted snapshot.
				const liveLc = provider.taskManager.getTaskState(state.taskId)?.lifecycle
				outputLog(
					`[WorkflowTask#${this.taskId}] #TRACE collectStakeResults '${name}' taskId=${state.taskId} lifecycle=${liveLc} completionResultSummary=${typeof result === "string" ? `"${result.substring(0, 80)}${result.length > 80 ? "..." : ""}"` : String(result)}`,
				)
				let validationError: string | null = null
				const outputSchema = instr.op.output

				// Step 1: Parse JSON from completion result — only when the stake
				// declares an `output:` contract. A schema-less stake (e.g. a plain
				// greeter) returns free-form prose; forcing it through JSON.parse
				// would spuriously fail and trigger pointless re-prompt retries.
				if (outputSchema && typeof result === "string") {
					const parsed = tryParseJson(result)
					if (parsed === undefined) {
						validationError = `Invalid JSON in attempt_completion result: could not extract a JSON object.`
					} else {
						result = parsed
					}
				}

				// Step 2: Validate fields against output schema
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

				// Step 4: Success — reset retry count, store output, route to mailbox,
				// then advance the program counter past the stake so the agent can
				// reach its subsequent instructions (e.g. `commit`). Without this the
				// agent re-evaluates the same stake every round, never commits, and the
				// flow can never converge — eventually burning the round budget or
				// (if its child task errors) tripping the deadlock guard.
				state.retryCount = 0
				state.output = result
				if (instr.op.binding) state.bindings.set(instr.op.binding, result)
				this.routeOutput(name, instr.op, result)
				state.opIndex++
				state.status = "idle"
				outputLog(
					`[WorkflowTask#${this.taskId}] #TRACE collectStakeResults '${name}' success — opIndex advanced to ${state.opIndex}, status→idle, output=${typeof result === "string" ? `"${result.substring(0, 60)}${result.length > 60 ? "..." : ""}"` : String(result).substring(0, 80)}`,
				)
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
		outputLog(`[WorkflowTask#${this.taskId}] Escalation from '${agentName}', awaiting human input: ${reason}`)
		const { text } = await this.ask("followup", reason)
		const response = text ?? ""
		outputLog(`[WorkflowTask#${this.taskId}] Escalation from '${agentName}' answered (${response.length} chars)`)
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
		const result = convergeExpr
			? this.toBool(this.evalExpr(convergeExpr, this.globalEvalState()))
			: this.allAgentsCommitted()
		outputLog(
			`[WorkflowTask#${this.taskId}] #TRACE checkConverge result=${result} hasExpr=${!!convergeExpr} allCommitted=${this.allAgentsCommitted()} committed=${this.committedCount()}/${this.flowState.agents.size}`,
		)
		return result
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
		await this.sayProgress(
			`✅ Workflow **${this.flowState.flowName}** converged after ${this.flowState.round} round(s).`,
		)
		await this.persistCheckpoint()
		await this.emitTaskCompleted("well")
	}

	// ── Persistence ──

	/**
	 * Persist the workflow extension once, eagerly, before the slang loop
	 * starts. Called by the create/restore flows so the first
	 * `postStateToWebview` already carries `isWorkflow`/`slangSource`/`flowState`
	 * and the webview routes to `WorkflowView` on the very first frame (no
	 * `ChatView` flash while waiting for the first in-loop checkpoint).
	 */
	async seedHistory(): Promise<void> {
		await this.persistCheckpoint()
	}

	private async persistCheckpoint(): Promise<void> {
		try {
			const provider = this.providerRef.deref()
			if (!provider) return
			await provider.updateTaskHistory({ id: this.taskId, ...this.getHistoryExtension() } as any)
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
