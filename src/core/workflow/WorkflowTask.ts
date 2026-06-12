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

import { readFileSync } from "fs"
import * as path from "path"
import * as fs from "fs/promises"
import os from "os"

import type { CompletionRating, HistoryItem, TaskHandle, WorkflowVizMeta } from "@shofer/types"
import { ShoferEventName } from "@shofer/types"

import { Task, type TaskOptions } from "../task/Task"
import { SlangEditorProvider } from "../webview/SlangEditorProvider"
import { ShoferProvider } from "../webview/ShoferProvider"
import { workflowLog } from "../../utils/logging/subsystems"
import { runWithLogTaskContext } from "../../utils/logging"
import { waitForTasksEventDriven } from "./wait-for-task-helper"

import {
	type AgentState,
	type FlowState,
	type FlowStatus,
	type MailboxEntry,
	deserializeFlowState,
	serializeFlowState,
} from "./slang-types"
import {
	advanceAgent as advanceAgentPure,
	allAgentsCommitted as allAgentsCommittedPure,
	checkConverge as checkConvergePure,
	committedCount as committedCountPure,
	compileAgentProgram,
	consumeMail as consumeMailPure,
	evalExpr as evalExprPure,
	routeOutput as routeOutputPure,
	toBool as toBoolPure,
	type AdvanceResult,
	type Instr,
	MAX_CONTROL_FLOW_STEPS,
} from "./slang-interpreter"
import { parseSlang, parseSlang as parseSlangFull, validateSlangAST } from "./slang-parser"
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
	OutputSchema,
} from "./slang-ast"
import { exprAsNumber, contractToJsonSchema } from "./slang-ast"
import { aggregateRatings } from "./aggregate-rating"

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

/** Get budget values: { tokens, rounds, timeMs } (time in seconds → milliseconds). */
function getBudget(flow: UpstreamFlowDecl): { bTokens?: number; bRounds?: number; bTime?: number } {
	const stmt = flow.body.find((n) => n.type === "BudgetStmt")
	if (!stmt || stmt.type !== "BudgetStmt") return {}
	const out: { bTokens?: number; bRounds?: number; bTime?: number } = {}
	for (const item of stmt.items) {
		if (item.kind === "tokens") out.bTokens = exprAsNumber(item.value)
		else if (item.kind === "rounds") out.bRounds = exprAsNumber(item.value)
		else if (item.kind === "time") {
			const t = exprAsNumber(item.value)
			if (t !== undefined) out.bTime = t * 1000
		}
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

// ── Compiled instruction model ──
//
// Each agent's structured operation tree is compiled once into a flat
// instruction list with explicit jump targets. The agent's program counter
// (`AgentState.opIndex`) indexes into this list. Lowering structured control
// flow (when / repeat) to conditional/unconditional jumps keeps the program
// counter a single integer, which makes both interpretation and checkpoint
// persistence trivial.

// Instr type, AdvanceResult, compileAgentProgram, and MAX_CONTROL_FLOW_STEPS are now
// imported from ./slang-interpreter (pure-function extraction).

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

// AdvanceResult type is now imported from ./slang-interpreter.

// ── Constants ──

/** Default workflow budgets — 0 means unlimited (no enforcement). */
const DEFAULT_BUDGET_TOKENS = 0
const DEFAULT_BUDGET_ROUNDS = 0
const DEFAULT_BUDGET_TIME = 0
/** Maximum consecutive output-validation failures before marking the agent as error. */
const MAX_RETRIES = 3
/** Max wall-clock time to wait for a round's spawned agent tasks to complete. */
const AGENT_RESULT_TIMEOUT_MS = 120_000
/** Poll interval while waiting for agent tasks to reach a terminal lifecycle. */
const POLL_INTERVAL_MS = 500

// ── WorkflowTask ──

export class WorkflowTask extends Task {
	readonly slangSource: string
	readonly flowDecl: UpstreamFlowDecl
	flowState: FlowState
	private slangLoopStarted = false
	/**
	 * True once {@link slangLoop} has actually begun iterating. Distinct from
	 * {@link slangLoopStarted} (set in `start()` before flow-parameter
	 * collection): while the task is blocked asking the user for flow params,
	 * `slangLoopStarted` is already true but no orchestration work has run yet.
	 * `abortTask()` uses this to detect a stop during param collection, where
	 * there is nothing to resume and the user should just see a stop
	 * confirmation.
	 */

	/**
	 * Resolved token budget for the current slang loop execution.
	 * 0 means unlimited. Set at the start of {@link slangLoop} so
	 * helper methods (e.g. {@link collectStakeResults}) can enforce
	 * per-agent without threading the budget through every call site.
	 * Not serialized — a restored flow re-evaluates the budget from
	 * the slang source on restart.
	 */
	private loopBudgetTokens = 0
	/**
	 * Absolute deadline (ms since epoch) for wall-clock time budget.
	 * 0 means unlimited. Computed once at slang-loop entry from
	 * {@link getBudget} and checked at the top of every while iteration
	 * and after every stake dispatch. Not serialized — a restored flow
	 * re-evaluates the budget from the slang source on restart.
	 */
	private loopDeadline = 0
	private slangLoopEntered = false

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
				mailboxHistory: [],
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
		// Decide whether this is a stop during flow-parameter collection
		// BEFORE mutating any state below.
		const stoppedDuringParamCollection =
			!this.slangLoopEntered && (this.flowState.status as string) === "running" && !this.abort

		// Persist the aborted state BEFORE the super call disposes the task,
		// so the rehydrated instance from cancelTask sees a terminal status in
		// start() and doesn't restart. Setting it first also makes the racing
		// requestFlowParams().catch() (woken by the say() below mutating
		// lastMessageTs) observe a terminal status and take its stop branch.
		this.flowState.status = "aborted"

		// When the workflow is stopped before the slang loop has begun any
		// real work (i.e. while it is still blocked collecting flow params),
		// there is nothing to resume — the task was merely waiting on a user
		// question. Emit a confirmation line so the user sees that the
		// workflow stopped. Emitting a `say` here also makes the last chat
		// message a non-ask, which clears the pending `followup` ask in the
		// webview so the Stop button disappears (cancelTask skips rehydrate
		// for stopped workflows, so no other state push would clear it).
		// `say` throws once `this.abort` is set, so this must run before the
		// super call below.
		if (stoppedDuringParamCollection) {
			try {
				await this.say("text", `🛑 Workflow **${this.flowState.flowName}** stopped.`)
			} catch (error) {
				workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to emit stop confirmation:`, error)
			}
		}

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
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] Skipping start — flow status is ${this.flowState.status} (was stopped)`,
			)
			return
		}
		this.slangLoopStarted = true
		try {
			this.emit(ShoferEventName.TaskStarted)
			this.taskStartedEmitted = true

			const agentNames = [...this.flowState.agents.keys()]
			workflowLog.info(
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
				workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to emit header say():`, headerError)
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
			workflowLog.error(`[WorkflowTask#${this.taskId}] start() failed:`, error)
			// Log the full error shape for diagnostics — especially useful when
			// the error is a non-Error object (e.g. a rejected promise with no
			// .message) that would render as "[object Object]" in the chat.
			if (error && typeof error === "object") {
				try {
					workflowLog.error(
						`[WorkflowTask#${this.taskId}] Error detail: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`,
					)
				} catch {
					workflowLog.error(`[WorkflowTask#${this.taskId}] Error detail (non-serializable): ${String(error)}`)
				}
			}
			try {
				await this.sayProgress(`❌ Workflow failed: ${error instanceof Error ? error.message : String(error)}`)
			} catch (sayError) {
				workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to emit error sayProgress:`, sayError)
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
				workflowLog.info(`[WorkflowTask#${this.taskId}] Flow params collected, starting slang loop`)
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
				workflowLog.info(
					`[WorkflowTask#${this.taskId}] Flow param ${p.name}=${JSON.stringify(this.flowState.params[p.name])} (type=${p.paramType})`,
				)
				return askNext(index + 1)
			})
		}

		workflowLog.info(
			`[WorkflowTask#${this.taskId}] Collecting ${missing.length} flow param(s): ${missing.map((p) => p.name).join(", ")}`,
		)
		void askNext(0).catch((error) => {
			if (this.abort || (this.flowState.status as string) === "aborted") {
				workflowLog.info(`[WorkflowTask#${this.taskId}] Flow param collection aborted — task is stopping`)
				// Persist the aborted status to history BEFORE cancelTask
				// re-reads it and rehydrates. Without this, the rehydrated
				// instance sees flowState.status === "running" and
				// re-enters requestFlowParams().
				this.flowState.status = "aborted"
				void this.persistCheckpoint()
				return
			}
			workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to collect flow params:`, error)
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
		workflowLog.info(`[WorkflowTask#${this.taskId}] ${message}`)
		if (this.abort) return
		try {
			await this.say("text", message)
		} catch (error) {
			workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to emit progress say:`, error)
		}
	}

	/**
	 * Establish the ambient log context so every line emitted while the workflow
	 * orchestration loop runs is attributed to this workflow instance for the
	 * "Logs" tab. Child agent tasks spawned within install their own context,
	 * so their logs are attributed to the child, not the workflow.
	 */
	private slangLoop(): Promise<void> {
		return runWithLogTaskContext({ taskId: this.taskId, rootTaskId: this.rootTaskId }, () => this.slangLoopInner())
	}

	private async slangLoopInner(): Promise<void> {
		this.slangLoopEntered = true
		const provider = this.providerRef.deref()
		if (!provider) throw new Error("WorkflowTask: provider reference lost")

		const budget = getBudget(this.flowDecl)
		const budgetRounds = budget.bRounds || DEFAULT_BUDGET_ROUNDS
		const budgetTokens = budget.bTokens || DEFAULT_BUDGET_TOKENS
		const budgetTime = budget.bTime || DEFAULT_BUDGET_TIME
		this.loopBudgetTokens = budgetTokens
		this.loopDeadline = budgetTime > 0 ? Date.now() + budgetTime : 0

		workflowLog.info(
			`[WorkflowTask#${this.taskId}] #TRACE slangLoop start — flow='${this.flowState.flowName}' budgetRounds=${budgetRounds} budgetTokens=${budgetTokens} budgetTime=${budgetTime}`,
		)

		// Push the initial (round 0) visualization before the loop runs so the
		// WorkflowView tab bar and diagrams appear immediately — even before
		// the first agent is dispatched — rather than only after round 1.
		this.notifySlangEditor()

		while (
			(budgetRounds === 0 || this.flowState.round < budgetRounds) &&
			(budgetTokens === 0 || this.flowState.tokensUsed < budgetTokens) &&
			(this.loopDeadline === 0 || Date.now() < this.loopDeadline) &&
			!this.abort &&
			this.flowState.status === "running"
		) {
			this.flowState.round++

			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE ── Round ${this.flowState.round} begin ── agents: ${[...this.flowState.agents.entries()].map(([n, s]) => `${n}=${s.status}@op${s.opIndex}`).join(", ")}`,
			)

			// 1. Advance every non-running / non-terminal agent over its
			//    non-blocking instructions until it either blocks (stake / await
			//    / escalate) or commits.
			const stakes: string[] = []
			const escalations: string[] = []
			for (const [name, state] of this.flowState.agents) {
				if (state.status === "running" || state.status === "committed" || state.status === "error") {
					workflowLog.info(
						`[WorkflowTask#${this.taskId}] #TRACE advanceAgent skip '${name}' — status=${state.status} (not idle/blocked)`,
					)
					continue
				}
				const result = this.advanceAgent(state)
				workflowLog.info(
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
						workflowLog.info(
							`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${name}' reached end of program — status forced to ${state.status}`,
						)
						break
				}
			}

			// 2. Converged?
			if (this.checkConverge()) {
				workflowLog.info(`[WorkflowTask#${this.taskId}] #TRACE checkConverge=true → handleConverge`)
				await this.handleConverge()
				return
			}

			// 3. No agent can make progress and none committed → deadlock.
			// Abort the entire agent subtree (recursive — agent tasks may
			// have spawned their own children). Budget-exhaustion paths
			// below do the same via super.abortBackgroundChildren().
			if (stakes.length === 0 && escalations.length === 0) {
				this.flowState.status = "deadlock"
				const agentDump = [...this.flowState.agents.entries()]
					.map(([n, s]) => `${n}=${s.status}@op${s.opIndex}(taskId=${s.taskId || "none"})`)
					.join(", ")
				workflowLog.error(
					`[WorkflowTask#${this.taskId}] #TRACE Deadlock at round ${this.flowState.round}. Agents: [${agentDump}] convergeExpr=${JSON.stringify(getConvergeExpr(this.flowDecl))} allCommitted=${this.allAgentsCommitted()}`,
				)
				await this.sayProgress(
					`⛔ Deadlock at round ${this.flowState.round}: no agent can make progress and none have committed. Aborting all children.`,
				)
				await super.abortBackgroundChildren()
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
			// Reflect the freshly-dispatched "running" agents in the viz before
			// we block waiting on them, so progress is visible mid-round.
			this.notifySlangEditor()
			await this.waitForStakes(stakes)
			await this.collectStakeResults(stakes)

			// 6. Budget checks — exit immediately when a single stake blows
			//    the budget, rather than waiting for the next while-guard
			//    evaluation at the top of the loop. 0 means unlimited.
			if (budgetTokens > 0 && this.flowState.tokensUsed >= budgetTokens) {
				this.flowState.status = "budget_exceeded"
				workflowLog.info(
					`[WorkflowTask#${this.taskId}] Token budget exceeded mid-round: ${this.flowState.tokensUsed} >= ${budgetTokens}`,
				)
				await this.sayProgress(
					`⚠️ Token budget exhausted (${this.flowState.tokensUsed} tokens used, limit ${budgetTokens}). Stopping.`,
				)
				await super.abortBackgroundChildren()
				await this.persistCheckpoint()
				await this.emitTaskCompleted("poor")
				return
			}
			if (this.loopDeadline > 0 && Date.now() >= this.loopDeadline) {
				this.flowState.status = "budget_exceeded"
				const elapsed = budgetTime / 1000
				workflowLog.info(`[WorkflowTask#${this.taskId}] Time budget exceeded mid-round: ${elapsed}s`)
				await this.sayProgress(`⚠️ Time budget exhausted (${elapsed}s limit). Stopping.`)
				await super.abortBackgroundChildren()
				await this.persistCheckpoint()
				await this.emitTaskCompleted("poor")
				return
			}

			await this.sayProgress(
				`✓ Round ${this.flowState.round} complete (${this.committedCount()}/${this.flowState.agents.size} agents committed).`,
			)

			// Push runtime state to the Slang custom editor so the visualization
			// highlights per-agent progress (opIndex, status, mailbox).
			this.notifySlangEditor()

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
			workflowLog.info(`[WorkflowTask#${this.taskId}] Budget exhausted after ${this.flowState.round} rounds`)
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
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}': no compiled program → end`,
			)
			return { type: "end" }
		}
		return advanceAgentPure(program, state, this.flowState.mailbox, this.flowState, {
			info: (msg) => workflowLog.info(`[WorkflowTask#${this.taskId}] #TRACE ${msg}`),
			error: (msg) => workflowLog.error(`[WorkflowTask#${this.taskId}] ${msg}`),
		})
	}

	/** Remove and return the first mailbox entry addressed to `recipient` from one of `sources`. */
	private consumeMail(recipient: string, sources: string[]): MailboxEntry | undefined {
		return consumeMailPure(this.flowState.mailbox, recipient, sources)
	}

	/** Evaluate a slang expression against an agent's local bindings + flow globals. */
	private evalExpr(expr: Expr, state: AgentState): unknown {
		return evalExprPure(expr, state, this.flowState)
	}

	/** JS-style truthiness over evaluated expression values. */
	private toBool(value: unknown): boolean {
		return toBoolPure(value)
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

	/**
	 * Peer agent tasks an agent may query directly via send_message_to_task.
	 *
	 * Derived exclusively from the agent's declared `peers:` list (WI2) — the
	 * authoritative source for direct-message grants. When no `peers:` are
	 * declared, returns an empty array (prompt and `knownPeers` are both empty
	 * for direct-message peers — the agent can only reach parent + own children).
	 */
	private getPeerResources(agentName: string): Array<{ name: string; taskId: string; role: string }> {
		const decl = getAgentDecls(this.flowDecl).find((a) => a.name === agentName)
		if (!decl) return []
		const declaredPeers = decl.meta.peers
		if (!declaredPeers || declaredPeers.length === 0) return []
		const resources: Array<{ name: string; taskId: string; role: string }> = []
		for (const peerName of declaredPeers) {
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
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE dispatchStakes '${name}' isNew=${isNew} taskId=${state.taskId || "none"} promptLen=${prompt.length}`,
			)
			if (isNew) await this.spawnAgentTask(name, prompt, instr.op.output)
			else await this.resumeAgentTask(name, prompt)
			state.status = "running"
		}
	}

	/**
	 * Spawn a background child Task for the given agent.
	 *
	 * @param agentName   Workflow agent name
	 * @param prompt      System prompt for the agent task
	 * @param outputSchema Optional stake output contract — when set, synthesizes
	 *                     a JSON Schema override for `attempt_completion`'s
	 *                     `result` parameter so providers with constrained
	 *                     decoding enforce the contract at decode time.
	 */
	private async spawnAgentTask(agentName: string, prompt: string, outputSchema?: OutputSchema): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) {
			workflowLog.info(`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' FAIL: no provider`)
			return
		}

		const agentDecl = getAgentDecls(this.flowDecl).find((a) => a.name === agentName)
		if (!agentDecl) {
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' FAIL: no agentDecl in AST`,
			)
			return
		}

		const agentState = this.flowState.agents.get(agentName)
		if (!agentState) {
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' FAIL: no agentState in flowState`,
			)
			return
		}

		const mode = (agentDecl.meta as any)?.mode || "code"

		try {
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' creating task mode='${mode}' isBackground=true`,
			)
			const completionSchema = outputSchema ? contractToJsonSchema(outputSchema) : undefined
			const task = await provider.createTask(prompt, undefined, this, {
				isBackground: true,
				initialMode: mode,
				initialState: { lifecycle: "idle" },
				openInStack: false,
				keepCurrentTask: true,
				completionSchema,
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
					workflowLog.error(
						`[WorkflowTask#${this.taskId}] Failed to update parent history for agent '${agentName}': ${err}`,
					)
				}
				agentState.taskId = task.taskId

				// Set knownPeers from declared peers: grant.
				// Baseline: parent (workflow root) is always permitted.
				const peerSet = new Set<string>([this.taskId])
				const declaredPeers = agentDecl.meta.peers
				if (declaredPeers && declaredPeers.length > 0) {
					for (const peerName of declaredPeers) {
						const peerState = this.flowState.agents.get(peerName)
						if (peerState?.taskId) {
							peerSet.add(peerState.taskId)
						}
					}
				}
				task.knownPeers = peerSet

				// Back-fill: this agent's taskId into the knownPeers of any
				// already-live agent that declared it as a peer.
				for (const [otherName, otherState] of this.flowState.agents) {
					if (otherName === agentName || !otherState.taskId) continue
					const otherDecl = getAgentDecls(this.flowDecl).find((a) => a.name === otherName)
					if (otherDecl?.meta.peers?.includes(agentName)) {
						const otherTask = provider.taskManager.getManagedTaskInstance(otherState.taskId)
						if (otherTask?.knownPeers) {
							otherTask.knownPeers.add(task.taskId)
						}
					}
				}

				workflowLog.info(
					`[WorkflowTask#${this.taskId}] Spawned agent '${agentName}' (mode='${mode}') as task ${task.taskId}`,
				)
			} else {
				workflowLog.info(
					`[WorkflowTask#${this.taskId}] #TRACE spawnAgentTask '${agentName}' createTask returned null/undefined`,
				)
			}
		} catch (error) {
			workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to spawn agent '${agentName}':`, error)
			agentState.status = "error"
		}
	}

	private async resumeAgentTask(agentName: string, prompt: string): Promise<void> {
		const agentState = this.flowState.agents.get(agentName)
		if (!agentState?.taskId) {
			workflowLog.info(`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' FAIL: no taskId`)
			return
		}

		const provider = this.providerRef.deref()
		if (!provider) {
			workflowLog.info(`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' FAIL: no provider`)
			return
		}

		try {
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' taskId=${agentState.taskId}`,
			)
			let agentTask = provider.taskManager.getManagedTaskInstance(agentState.taskId)
			if (!agentTask) {
				workflowLog.info(
					`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' task not live, rehydrating from history`,
				)
				const { historyItem } = await provider.getTaskWithId(agentState.taskId)
				await provider.createTaskWithHistoryItem(historyItem, { keepCurrentTask: true })
				agentTask = provider.taskManager.getManagedTaskInstance(agentState.taskId)
			}
			agentTask?.messageQueueService.addMessage(prompt)
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' prompt queued (${prompt.length} chars)`,
			)
		} catch (error) {
			workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to resume agent '${agentName}':`, error)
			agentState.status = "error"
		}
	}

	// ── Wait & collect ──

	/**
	 * Wait for dispatched agent tasks using the shared event-driven helper
	 * (same primitive used by {@link WaitForTaskTool}).
	 *
	 * Also handles routed agent questions (WI4): when a child's
	 * `ask_followup_question` routes up to the WorkflowTask (parent),
	 * the helper calls {@link relayChildQuestion} to surface it to the
	 * user via `this.ask("followup", …)` and delivers the answer back
	 * through the `answer_subtask_question` path.
	 */
	private async waitForStakes(names: string[]): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return

		const taskIds = names.map((n) => this.flowState.agents.get(n)?.taskId).filter(Boolean) as string[]
		if (taskIds.length === 0) {
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE waitForStakes: no taskIds to wait for (agents may not have been spawned)`,
			)
			return
		}

		workflowLog.info(
			`[WorkflowTask#${this.taskId}] #TRACE waitForStakes: waiting for ${taskIds.length} task(s): ${taskIds.join(", ")}`,
		)

		const handles = new Map<string, TaskHandle>()
		for (const taskId of taskIds) {
			const handle = this.backgroundChildren.get(taskId)
			if (handle) handles.set(taskId, handle)
		}
		if (handles.size === 0) return

		const isTerminal = (id: string) => {
			const h = handles.get(id)!
			return h.status === "completed" || h.status === "error" || h.status === "cancelled"
		}

		// Preseed with persisted state for tasks that may have completed
		// between rounds (the event already fired).
		for (const [taskId, handle] of handles) {
			if (!isTerminal(taskId)) {
				const managedState = provider.taskManager.getTaskState(taskId)
				if (managedState?.lifecycle === "completed") {
					handle.status = "completed"
				} else if (managedState?.lifecycle === "error") {
					handle.status = "error"
				}
			}
		}

		const startTime = Date.now()
		// Bound the per-stake wait by the remaining flow time budget so
		// the flow's `time(N)` ceiling is authoritative — a hung agent
		// fails fast instead of blocking for AGENT_RESULT_TIMEOUT_MS.
		const timeoutMs =
			this.loopDeadline > 0
				? Math.max(0, Math.min(AGENT_RESULT_TIMEOUT_MS, this.loopDeadline - Date.now()))
				: AGENT_RESULT_TIMEOUT_MS
		await waitForTasksEventDriven(provider, {
			handles,
			conditionMet: () => [...handles.keys()].every((id) => isTerminal(id)),
			timeoutMs,
			abortSignal: this.abortSignal,
			onNeedsParentInput: async (childTaskId: string) => {
				// WI4: Relay the child's question to the user, then deliver
				// the answer via answer_subtask_question.
				return this.relayChildQuestion(childTaskId)
			},
		})

		const elapsed = Date.now() - startTime
		const statuses = [...handles.entries()].map(([id, h]) => `${id.slice(-6)}=${h.status}`)
		workflowLog.info(
			`[WorkflowTask#${this.taskId}] #TRACE waitForStakes done — elapsed=${elapsed}ms statuses=[${statuses.join(", ")}]`,
		)
	}

	/**
	 * Relay a routed child question (from {@link AskFollowupQuestionTool})
	 * to the user via {@link Task.ask}, then deliver the answer back
	 * through the {@link AnswerSubtaskQuestionTool} path.
	 *
	 * This is WI4: the WorkflowTask acts as a relay, surfacing the
	 * question in WorkflowView and piping the answer back to the child,
	 * exactly as a parent LLM would.
	 *
	 * Returns true if the question was answered, false if the child was
	 * not in question-awaiting state or the relay failed.
	 */
	private async relayChildQuestion(childTaskId: string): Promise<boolean> {
		const provider = this.providerRef.deref()
		if (!provider) return false

		const liveInstance = provider.taskManager.getManagedTaskInstance(childTaskId)
		if (!liveInstance) return false

		const pendingQuestion = liveInstance.getPendingParentQuestion()
		if (!pendingQuestion) return false

		// Emit followup ask as the SAME JSON shape AskFollowupQuestionTool
		// sends (line 43): { question, suggest: [{ answer, mode }] }.
		// ChatRow.tsx:528 parses followup asks with safeJsonParse<FollowUpData>,
		// so a plain string would render degraded and lose suggestion buttons.
		const followUpJson = {
			question: `Agent asked:\n> ${pendingQuestion.question}\n\nYour answer:`,
			suggest: pendingQuestion.suggestions.map((s) => ({ answer: s.answer, mode: s.mode })),
		}

		workflowLog.info(
			`[WorkflowTask#${this.taskId}] Relaying child question from task ${childTaskId}: "${pendingQuestion.question}"`,
		)

		// Block the executor on the user's answer — sibling agents keep
		// running in their own task loops; only the workflow's wait phase
		// is paused.
		const { text } = await this.ask("followup", JSON.stringify(followUpJson))
		const answer = text ?? ""

		workflowLog.info(`[WorkflowTask#${this.taskId}] Relay answer for task ${childTaskId} (${answer.length} chars)`)

		// Deliver the answer via answer_subtask_question path —
		// resolvePendingParentQuestion settles the Promise the child
		// is awaiting in AskFollowupQuestionTool.execute.
		liveInstance.resolvePendingParentQuestion(answer)
		return true
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
				const agentTokens = (historyItem.tokensIn || 0) + (historyItem.tokensOut || 0)
				this.flowState.tokensUsed += agentTokens

				// Per-agent budget check — if an agent alone blows the
				// budget (token or time), abort immediately rather than
				// waiting for all stakes to complete. 0 means unlimited.
				if (this.loopBudgetTokens > 0 && this.flowState.tokensUsed >= this.loopBudgetTokens) {
					this.flowState.status = "budget_exceeded"
					workflowLog.info(
						`[WorkflowTask#${this.taskId}] Token budget exceeded mid-round after collecting agent '${name}' result: ${this.flowState.tokensUsed} >= ${this.loopBudgetTokens}`,
					)
					await this.sayProgress(
						`⚠️ Token budget exhausted (${this.flowState.tokensUsed} tokens used, limit ${this.loopBudgetTokens}). Stopping.`,
					)
					await super.abortBackgroundChildren()
					await this.persistCheckpoint()
					await this.emitTaskCompleted("poor")
					return
				}
				if (this.loopDeadline > 0 && Date.now() >= this.loopDeadline) {
					this.flowState.status = "budget_exceeded"
					workflowLog.info(
						`[WorkflowTask#${this.taskId}] Time budget exceeded mid-round after collecting agent '${name}' result`,
					)
					await this.sayProgress(`⚠️ Time budget exhausted. Stopping.`)
					await super.abortBackgroundChildren()
					await this.persistCheckpoint()
					await this.emitTaskCompleted("poor")
					return
				}

				let result: unknown = historyItem.completionResultSummary
				// Use in-memory TaskManager state for the lifecycle trace (set
				// synchronously by lifecycle events), not the persisted snapshot.
				const liveLc = provider.taskManager.getTaskState(state.taskId)?.lifecycle
				workflowLog.info(
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
						workflowLog.error(
							`[WorkflowTask#${this.taskId}] Agent '${name}' exceeded max retries (${MAX_RETRIES}) for output validation:\n${validationError}`,
						)
						state.status = "error"
					} else {
						workflowLog.info(
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
				// Enrich the mailbox history entries with per-agent metadata
				// so the sequence diagram can show tokens, cost, duration, and
				// mode on hover.
				const agentCost = historyItem.totalCost || 0
				const agentDuration = historyItem.activeTimeMs || 0
				const managed = provider.taskManager.getManagedTask(state.taskId)
				const agentMode = (managed as { mode?: string } | undefined)?.mode
				const beforeEnrich = this.flowState.mailboxHistory.length
				this.routeOutput(name, instr.op, result)
				// Stamp the newly pushed history entries with metadata.
				for (let hi = beforeEnrich; hi < this.flowState.mailboxHistory.length; hi++) {
					const entry = this.flowState.mailboxHistory[hi]!
					entry.tokensUsed = agentTokens
					entry.costUsd = agentCost
					entry.durationMs = agentDuration
					if (agentMode) entry.mode = agentMode
				}
				state.opIndex++
				state.status = "idle"
				workflowLog.info(
					`[WorkflowTask#${this.taskId}] #TRACE collectStakeResults '${name}' success — opIndex advanced to ${state.opIndex}, status→idle, output=${typeof result === "string" ? `"${result.substring(0, 60)}${result.length > 60 ? "..." : ""}"` : String(result).substring(0, 80)}`,
				)
			} catch (error) {
				workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to read result for '${name}':`, error)
				state.status = "error"
			}
		}
	}

	/** Deliver a stake's output to all of its recipients (@Agent / @all / @out). */
	private routeOutput(from: string, op: StakeOp, value: unknown): void {
		const before = this.flowState.mailbox.length
		routeOutputPure(this.flowState.mailbox, this.flowState.agents, from, op, value)
		// Append any newly delivered entries to the persistent history so the
		// sequence diagram can be reconstructed even after the workflow completes.
		const added = this.flowState.mailbox.length - before
		if (added > 0) {
			this.flowState.mailboxHistory.push(...this.flowState.mailbox.slice(before))
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
		workflowLog.info(
			`[WorkflowTask#${this.taskId}] Escalation from '${agentName}', awaiting human input: ${reason}`,
		)
		const { text } = await this.ask("followup", reason)
		const response = text ?? ""
		workflowLog.info(
			`[WorkflowTask#${this.taskId}] Escalation from '${agentName}' answered (${response.length} chars)`,
		)
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
		const result = checkConvergePure(this.flowDecl, this.flowState)
		const convergeExpr = getConvergeExpr(this.flowDecl)
		workflowLog.info(
			`[WorkflowTask#${this.taskId}] #TRACE checkConverge result=${result} hasExpr=${!!convergeExpr} allCommitted=${this.allAgentsCommitted()} committed=${this.committedCount()}/${this.flowState.agents.size}`,
		)
		return result
	}

	private allAgentsCommitted(): boolean {
		return allAgentsCommittedPure(this.flowState.agents)
	}

	private committedCount(): number {
		return committedCountPure(this.flowState.agents)
	}

	/**
	 * Aggregate child agent ratings using the minimum-common-denominator rule:
	 * one "poor" pulls the workflow down to "poor"; two "excellent" + one "well" → "well".
	 * If no committed agent has a rating (all errored / no committed agents), defaults to "poor".
	 */
	private async aggregateChildRatings(): Promise<CompletionRating> {
		const provider = this.providerRef.deref()
		if (!provider) return "poor"

		const ratings: CompletionRating[] = []

		for (const [, agentState] of this.flowState.agents) {
			if (agentState.status !== "committed" || !agentState.taskId) continue

			try {
				const { historyItem } = await provider.getTaskWithId(agentState.taskId)
				const rating = historyItem.taskState?.rating
				if (rating) {
					ratings.push(rating)
				}
			} catch {
				workflowLog.info(
					`[WorkflowTask#${this.taskId}] aggregateChildRatings: could not read HistoryItem for agent '${agentState.name}' (taskId=${agentState.taskId})`,
				)
			}
		}

		return aggregateRatings(ratings)
	}

	private async handleConverge(): Promise<void> {
		this.flowState.status = "converged"
		await this.sayProgress(
			`✅ Workflow **${this.flowState.flowName}** converged after ${this.flowState.round} round(s).`,
		)
		await this.persistCheckpoint()
		const rating = await this.aggregateChildRatings()
		await this.emitTaskCompleted(rating)
	}

	// ── Persistence ──

	/**
	 * Persist the workflow extension once, eagerly, before the slang loop
	 * starts. Called by the create/restore flows so the first
	 * `postInitState` already carries `isWorkflow`/`slangSource`/`flowState`
	 * and the webview routes to `WorkflowView` on the very first frame (no
	 * `ChatView` flash while waiting for the first in-loop checkpoint).
	 */
	async seedHistory(): Promise<void> {
		await this.persistCheckpoint()
	}

	/**
	 * Push the current FlowState to the Slang custom editor AND the WorkflowView
	 * webview so both surfaces show live per-agent runtime progress (opIndex,
	 * status, mailbox). When no editor is open for the .slang file the custom
	 * editor path is a no-op — the webview path still works independently.
	 */
	private notifySlangEditor(): void {
		const sourcePath = this.flowState.sourcePath
		const runState = serializeFlowState(this.flowState)

		// Push to the Slang custom editor (if open).
		if (sourcePath) {
			try {
				SlangEditorProvider.notifyRuntimeState(sourcePath, runState)
			} catch (error) {
				workflowLog.info(`[WorkflowTask#${this.taskId}] Failed to notify Slang editor of runtime state:`, error)
			}
		}

		// Push to the WorkflowView webview. The flow header metadata and the
		// self-contained diagram HTML are each pushed once; thereafter only
		// the serialized FlowState is pushed so SlangViz can forward it as a
		// `runtimeState` postMessage and the render engine patches the
		// diagrams in-place — no iframe reload, no lost zoom/pan/view.
		const provider = this.providerRef.deref()
		if (provider) {
			if (!this._vizHtmlPushed) {
				// Flow header metadata rendered natively in TaskHeader.
				const meta = buildWorkflowVizMeta(this.slangSource)
				if (meta) provider.postConfigUpdate("workflowVizMeta", meta)

				const html = buildWorkflowVizHtml(this.slangSource, this.flowState, runState)
				if (html) {
					provider.postConfigUpdate("workflowVizHtml", html)
					this._vizHtmlPushed = true
				}
			}
			provider.postConfigUpdate("workflowVizRunState", runState)
		}
	}

	/** Whether the static viz HTML has been pushed to the webview yet. */
	private _vizHtmlPushed = false

	private async persistCheckpoint(): Promise<void> {
		try {
			const provider = this.providerRef.deref()
			if (!provider) return
			await provider.updateTaskHistory({ id: this.taskId, ...this.getHistoryExtension() } as any)
		} catch (error) {
			workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to persist checkpoint:`, error)
		}
	}

	private async emitTaskCompleted(rating: "poor" | "well" | "excellent"): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return
		try {
			// Persist the terminal flow checkpoint first so any consumer that
			// reads the HistoryItem in response to the event below sees the
			// converged/budget_exceeded/deadlock flowState.
			await this.persistCheckpoint()

			// Emit the canonical Task lifecycle event — the same contract every
			// Task uses to signal terminal state (cf. AttemptCompletionTool.
			// emitTaskCompleted). This is what TaskManager.onComplete listens on
			// to write `taskState`, what the public ShoferAPI re-emits to external
			// consumers (e.g. integration harness `waitForCompletion`), and what
			// the webview observes to leave the running state. The WorkflowTask
			// root has no parentTaskId, so `isSubtask` is false.
			//
			// We still pass through TaskManager.setState explicitly below as a
			// fallback for the case where the root task is not registered with
			// the TaskManager event listeners; setState is idempotent (guarded
			// by statesEqual) so the listener-driven write and this one collapse.
			this.emit(ShoferEventName.TaskCompleted, this.taskId, this.getTokenUsage(), this.toolUsage, {
				rating,
				isSubtask: !!this.parentTaskId,
			})

			const taskManager = provider.taskManager
			if (taskManager) {
				taskManager.setState(this.taskId, { lifecycle: "completed", rating })
			}
		} catch (error) {
			workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to emit completion:`, error)
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
		workflowLog.info(`[Workflow] Warnings for '${flowDecl.name}':\n${warnings.join("\n")}`)
	}

	const state = await provider.getState()
	const apiConfiguration = state?.apiConfiguration
	if (!apiConfiguration) throw new Error("No API configuration available")

	return new WorkflowTask({
		provider,
		apiConfiguration,
		slangSource,
		flowDecl,
		flowParams,
		// Wire the same provider-level event forwarding that createTask() gets,
		// so the workflow root's TaskCompleted reaches the public ShoferAPI.
		onCreated: provider.onTaskCreated,
	})
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
		// Wire the same provider-level event forwarding that createTask() gets,
		// so the workflow root's TaskCompleted reaches the public ShoferAPI.
		onCreated: provider.onTaskCreated,
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

/**
 * Priority order for workflow discovery (lowest to highest):
 *   1. Built-in  — shipped with the extension under dist/media/workflows/
 *   2. Global    — ~/.shofer/workflows/
 *   3. Project   — .shofer/workflows/ (highest priority, overrides lower layers)
 */
export async function discoverWorkflows(workspacePath: string): Promise<Map<string, string>> {
	const workflows = new Map<string, string>()
	// Built-in workflows — lowest priority
	// In dev, __dirname = src/; in deployed VSIX, __dirname = dist/.
	// Both contain media/workflows/ after build.
	const builtinDir = path.join(__dirname, "media", "workflows")
	workflowLog.info(`[discoverWorkflows] __dirname=${__dirname} builtinDir=${builtinDir}`)
	await loadFromDir(builtinDir, workflows)
	// Global user workflows — medium priority
	const globalDir = path.join(os.homedir(), ".shofer", "workflows")
	await loadFromDir(globalDir, workflows)
	// Project workflows — highest priority
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

// ── Workflow Viz Meta + HTML Builder (for WorkflowView webview) ──

/**
 * Extracts flow metadata from a parsed Slang source for native rendering
 * in the WorkflowView TaskHeader. Companion to buildWorkflowVizHtml() —
 * together they replace the old monolithic all-in-one iframe approach.
 */
export function buildWorkflowVizMeta(slangSource: string): WorkflowVizMeta | undefined {
	if (!slangSource) return undefined

	const { ast, errors } = parseSlangFull(slangSource)
	if (errors.length > 0 || ast.flows.length === 0) return undefined

	const flowDeclaration = ast.flows[0]

	const meta: WorkflowVizMeta = {
		icon: flowDeclaration.icon,
		displayTitle: flowDeclaration.title || flowDeclaration.name,
		flowName: flowDeclaration.title ? flowDeclaration.name : undefined,
		description: flowDeclaration.description,
		params: flowDeclaration.params?.map((p) => ({ name: p.name, type: p.paramType, description: p.description })),
		agentCount: 0,
	}

	// Extract param descriptions from ParamMetaDecl nodes and count agents
	const paramDescriptions = new Map<string, string>()
	for (const item of flowDeclaration.body) {
		if (item.type === "ParamMetaDecl" && item.description) {
			paramDescriptions.set(item.name, item.description)
		}
		if (item.type === "AgentDecl") meta.agentCount++
	}

	// Enrich param entries with descriptions from ParamMetaDecl
	if (meta.params) {
		for (const p of meta.params) {
			const desc = paramDescriptions.get(p.name)
			if (desc) p.description = desc
		}
	}

	// Extract convergence condition and budgets
	for (const item of flowDeclaration.body) {
		if (item.type === "ConvergeStmt" && item.condition) {
			meta.convergeCondition = _exprStr(item.condition)
		}
		if (item.type === "BudgetStmt" && item.items) {
			meta.budgets = item.items.map((b) => ({ kind: b.kind, value: _exprStr(b.value) }))
		}
	}

	return meta
}

/** Simple expression-to-string for converge conditions and budget values. */
function _exprStr(e: Expr): string {
	switch (e.type) {
		case "NumberLit":
			return String(e.value)
		case "StringLit":
			return `"${e.value.replace(/"/g, '\\"')}"`
		case "BoolLit":
			return String(e.value)
		case "Ident":
			return e.name
		case "AgentRef":
			return "@" + e.name
		default:
			return e.type
	}
}

/**
 * Builds a self-contained HTML page that renders the three slang
 * visualization diagrams (topology, sequence, swimlane) with live
 * runtime state overlays. The page is meant to be rendered in a
 * sandboxed iframe in WorkflowView via srcdoc.
 *
 * The header (.flow-header), tab bar (.view-selector-tabs), and
 * runtime banner (.runtime-banner) are now rendered natively in the
 * WorkflowView React tree (TaskHeader + tab bar), so this HTML only
 * contains the diagram SVG and zoom controls.
 *
 * We read slang-render.js, slang-render.css and dagre.min.js at module
 * init time (same files SlangEditorProvider ships to dist/) and inline
 * them so the iframe needs no external network access — important
 * because the parent webview CSP (default-src 'none', strict-dynamic)
 * is inherited by the srcdoc iframe and would block a CDN load.
 *
 * Each <script> carries a `{{CSP_NONCE}}` placeholder that SlangViz
 * replaces with the live webview nonce before assigning srcdoc, so the
 * scripts satisfy the inherited 'nonce-…' policy.
 *
 * The rendering is initialised via a `safeRender()` call in an inline
 * script that passes both the parsed flow AST and the serialized
 * FlowState as the `runState` field so per-agent progress badges
 * appear immediately.
 */
export function buildWorkflowVizHtml(
	slangSource: string,
	flowState: FlowState,
	runState: Record<string, unknown>,
): string {
	if (!slangSource) return ""

	const { ast, errors } = parseSlangFull(slangSource)
	if (errors.length > 0 || ast.flows.length === 0) return ""

	const flowDeclaration = ast.flows[0]

	// Strip parser-internal Span objects that don't serialise into JSON.
	const flow = stripSpans(flowDeclaration)
	const diags: string[] = []

	// Load the render engine, CSS and dagre (read once, cached after first
	// call). In the bundled output, __dirname is src/dist/ (where extension.js
	// lives); esbuild copies these three assets to the same directory.
	const RENDER_JS = _lazyReadFile(path.join(__dirname, "slang-render.js"))
	const RENDER_CSS = _lazyReadFile(path.join(__dirname, "slang-render.css"))
	const DAGRE_JS = _lazyReadFile(path.join(__dirname, "dagre.min.js"))

	const payload = JSON.stringify({
		type: "render",
		context: "workflowView", // distinguishes from standalone .slang editor
		fileName: flowState.sourcePath ?? "workflow",
		flow,
		diags,
		runState,
	})
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")

	// dagre, the render engine and the bootstrap are all inlined and
	// nonce-stamped (placeholder replaced by SlangViz) so they execute under
	// the parent webview's inherited CSP without any network access.
	//
	// The HTML no longer includes the flow header, tab bar, or runtime
	// banner — those are rendered natively in the WorkflowView React tree.
	// The iframe only holds the diagram SVG + zoom controls.
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Slang — Workflow Viz</title>
<style>${RENDER_CSS}</style>
</head>
<body>
<div id="app"></div>
<div id="diags" class="diag-section"></div>
<script nonce="{{CSP_NONCE}}">${DAGRE_JS}</script>
<script nonce="{{CSP_NONCE}}">${RENDER_JS}</script>
<script nonce="{{CSP_NONCE}}">(function () { "use strict"; var __payload = ${payload}; safeRender(__payload); })();</script>
</body>
</html>`
}

/** Strip Span wrapper objects from a parsed AST so it JSON-serialises. */
function stripSpans(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj
	if (Array.isArray(obj)) return obj.map(stripSpans)
	if (typeof obj !== "object") return obj
	const record = obj as Record<string, unknown>
	if ("start" in record && "end" in record && Object.keys(record).length === 2) return undefined
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(record)) {
		if (key === "location" || key === "span") continue
		out[key] = stripSpans(record[key])
	}
	return out
}

const _fileCache = new Map<string, string>()

function _lazyReadFile(filePath: string): string {
	const cached = _fileCache.get(filePath)
	if (cached !== undefined) return cached
	try {
		const content = readFileSync(filePath, "utf-8")
		_fileCache.set(filePath, content)
		return content
	} catch {
		workflowLog.warn(`[WorkflowViz] Failed to read ${filePath}; viz will be empty`)
		return ""
	}
}
