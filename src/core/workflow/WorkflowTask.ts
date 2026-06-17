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
import { findLastIndex } from "../../shared/array"
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
	interpolate as interpolatePure,
	routeOutput as routeOutputPure,
	toBool as toBoolPure,
	type AdvanceResult,
	type EmittedMessage,
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

/** Resolve a budget expression value: number literal or flow-param identifier. */
function resolveBudgetNum(expr: Expr, params: Record<string, unknown>): number | undefined {
	const lit = exprAsNumber(expr)
	if (lit !== undefined) return lit
	if (expr.type === "Ident" && expr.name in params) {
		const v = params[expr.name]
		if (typeof v === "number") return v
		if (typeof v === "string") {
			const n = Number(v)
			if (!Number.isNaN(n)) return n
		}
	}
	return undefined
}

/** Get budget values: { tokens, rounds, timeMs } (time in seconds → milliseconds). */
function getBudget(
	flow: UpstreamFlowDecl,
	params?: Record<string, unknown>,
): { bTokens?: number; bRounds?: number; bTime?: number } {
	const stmt = flow.body.find((n) => n.type === "BudgetStmt")
	if (!stmt || stmt.type !== "BudgetStmt") return {}
	const p = params ?? {}
	const out: { bTokens?: number; bRounds?: number; bTime?: number } = {}
	for (const item of stmt.items) {
		if (item.kind === "tokens") out.bTokens = resolveBudgetNum(item.value, p)
		else if (item.kind === "rounds") out.bRounds = resolveBudgetNum(item.value, p)
		else if (item.kind === "time") {
			const t = resolveBudgetNum(item.value, p)
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

/** Join names into a natural list: "A", "A and B", or "A, B and C". */
function joinNames(names: string[], conj: string = "and"): string {
	if (names.length <= 1) return names[0] ?? ""
	if (names.length === 2) return `${names[0]} ${conj} ${names[1]}`
	return `${names.slice(0, -1).join(", ")} ${conj} ${names[names.length - 1]}`
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

	/**
	 * Wall-clock dispatch time (epoch ms) per agent for the round's in-flight
	 * stake, keyed by agent name. Used to enforce a per-stake `timeout(N)`.
	 * Transient — set at dispatch each round, never serialized.
	 */
	private readonly stakeDispatchedAt = new Map<string, number>()

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

		// Push the aborted FlowState to the viz so the swimlane's
		// currently-executing-op marker stops blinking the moment the user stops
		// the flow (the blink is gated on a "running" status).
		try {
			this.notifySlangEditor()
		} catch {
			// Best-effort — the provider reference may already be cleared.
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
	 * Collect the flow's input parameters with a SINGLE structured followup.
	 * The payload carries every missing parameter's name, type and default
	 * (see {@link FollowUpData.paramForm}); the webview (WorkflowView) renders
	 * a typed form and submits all answers at once as a JSON object via the
	 * normal `messageResponse` path. Each value is type-coerced; blanks fall
	 * back to the type's default. The slang loop starts once the answer is
	 * applied.
	 *
	 * Robustness/fallback: if the answer is not a JSON object (older client or
	 * a plain-text reply), a single-param flow uses the raw text; multi-param
	 * flows fall back to type defaults.
	 */
	private requestFlowParams(): void {
		const declParams = this.flowDecl.params!
		const missing = declParams.filter((p) => !(p.name in (this.flowState.params || {})))

		const paramForm = missing.map((p) => {
			const type = p.paramType === "number" || p.paramType === "boolean" ? p.paramType : "string"
			return {
				name: p.name,
				type,
				// Author-provided default wins; otherwise the type's neutral default.
				default: (p.default ?? defaultParamValue(p.paramType)) as string | number | boolean | string[],
				...(p.description ? { description: p.description } : {}),
				// Presentation metadata → the form's widget (dropdown / radio /
				// checkbox-group / slider). When absent the form falls back to a
				// multiline textarea (string), number input, or single checkbox (boolean).
				...(p.widget ? { widget: p.widget } : {}),
				...(p.options ? { options: p.options } : {}),
				...(p.min !== undefined ? { min: p.min } : {}),
				...(p.max !== undefined ? { max: p.max } : {}),
				...(p.step !== undefined ? { step: p.step } : {}),
			}
		})

		const question =
			missing.length === 1
				? `This workflow needs one input before it can start:`
				: `This workflow needs ${missing.length} inputs before it can start:`

		workflowLog.info(
			`[WorkflowTask#${this.taskId}] Collecting ${missing.length} flow param(s) via form: ${missing.map((p) => p.name).join(", ")}`,
		)

		const applyAnswer = (text: string | undefined): void => {
			const raw = text?.trim() ?? ""
			let values: Record<string, unknown> = {}
			try {
				const parsed = raw ? JSON.parse(raw) : {}
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					values = parsed as Record<string, unknown>
				}
			} catch {
				// Not JSON — a single-param flow can take the raw text directly.
				if (missing.length === 1 && raw) {
					values = { [missing[0].name]: raw }
				}
			}

			for (const p of missing) {
				const v = values[p.name]
				if (v !== undefined && v !== null && v !== "") {
					// The form may submit values as strings — coerce to the declared type.
					this.flowState.params[p.name] = typeof v === "string" ? coerceParam(v, p.paramType) : v
				} else {
					this.flowState.params[p.name] = defaultParamValue(p.paramType)
				}
				workflowLog.info(
					`[WorkflowTask#${this.taskId}] Flow param ${p.name}=${JSON.stringify(this.flowState.params[p.name])} (type=${p.paramType})`,
				)
			}

			// Write the final values back onto the question message and mark it
			// answered. The answer was submitted via objectResponse (no chat echo),
			// so without this the persisted form would re-render editable with
			// default values after a reload. Embedding answeredValues lets the
			// webview replay the form read-only with what the user entered.
			try {
				const idx = findLastIndex(
					this.shoferMessages,
					(m) => m.type === "ask" && m.ask === "followup" && !m.isAnswered,
				)
				if (idx !== -1) {
					const msg = this.shoferMessages[idx]
					const answeredValues: Record<string, string | number | boolean> = {}
					for (const p of missing) {
						const fv = this.flowState.params[p.name]
						if (typeof fv === "string" || typeof fv === "number" || typeof fv === "boolean") {
							answeredValues[p.name] = fv
						}
					}
					try {
						const payload = JSON.parse(msg.text || "{}")
						payload.answeredValues = answeredValues
						msg.text = JSON.stringify(payload)
					} catch {
						// Leave the message text untouched if it is not parseable JSON.
					}
					msg.isAnswered = true
					// Push the edited message to the webview so its in-memory (app-root
					// context) copy carries the embedded answeredValues. Without this
					// the form re-mounts EMPTY after a Chat-tab switch: persistence
					// alone only updates disk, not the live webview state.
					const provider = this.providerRef.deref()
					if (provider) {
						void provider.postMessageToWebview({ type: "messageUpdated", shoferMessage: msg })
					}
					// Also persist the in-place edit so it survives a full reload.
					void this.overwriteShoferMessages(this.shoferMessages)
				}
			} catch (e) {
				workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to record answered param form:`, e)
			}

			// Persist params immediately so that if the workflow is
			// stopped/cancelled after collection but before slangLoop starts,
			// the rehydrated instance sees the populated params and skips re-asking.
			void this.persistCheckpoint()
			workflowLog.info(`[WorkflowTask#${this.taskId}] Flow params collected, starting slang loop`)
			void this.slangLoop()
		}

		this.ask("followup", JSON.stringify({ question, paramForm }))
			.then(({ text }) => applyAnswer(text))
			.catch((error) => {
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
		// Lock the worktree from here on: the loop is about to spawn agents
		// (subtasks), whose cwd must not move. Persisted via serializeFlowState so
		// the webview's WorktreeIndicator switches to read-only.
		this.flowState.started = true
		const provider = this.providerRef.deref()
		if (!provider) throw new Error("WorkflowTask: provider reference lost")

		const budget = getBudget(this.flowDecl, this.flowState.params)
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
				const { result, emitted } = this.advanceAgent(state)
				// Surface any log/error/commit messages the agent produced while
				// advancing to the chat view, in program order, before acting on the
				// blocking result below.
				for (const m of emitted) await this.emitAgentMessage(name, m)
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
					case "error":
						// An `error` op prematurely terminates the whole flow. The
						// agent's message was already surfaced above; tear down the
						// rest of the tree and finish.
						this.flowState.status = "error"
						workflowLog.error(
							`[WorkflowTask#${this.taskId}] #TRACE Agent '${name}' raised error at round ${this.flowState.round} — terminating flow`,
						)
						await super.abortBackgroundChildren()
						await this.persistCheckpoint()
						await this.emitTaskCompleted("poor")
						return
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
					`⛔ Deadlock at round ${this.flowState.round}: no agent can make progress and none have committed. Aborting all children.\n\nAgent states: ${agentDump}`,
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
			await this.sayProgress(this.describeRoundDispatch(stakes))
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

	/**
	 * Build a self-explanatory progress line for a round's dispatch step. Rather
	 * than the terse "dispatching N agent(s)", it spells out, in plain language,
	 * the state of the whole flow at this instant:
	 *   - who is now doing work — the agents being dispatched/resumed (`stakes`),
	 *   - who is parked waiting and for whose input (`blocked` agents + `waitingFor`),
	 *   - who has already finished (`committed`) or failed (`error`).
	 * Escalations are resolved earlier in the round, so no agent is awaiting the
	 * human here. `stakes` is guaranteed non-empty at the call site.
	 */
	private describeRoundDispatch(stakes: string[]): string {
		const staking = new Set(stakes)
		const waiting: string[] = []
		const done: string[] = []
		const failed: string[] = []
		for (const [name, state] of this.flowState.agents) {
			if (staking.has(name)) continue
			if (state.status === "committed") done.push(name)
			else if (state.status === "error") failed.push(name)
			else if (state.status === "blocked") {
				const from = this.describeWaitSources(state.waitingFor)
				waiting.push(from ? `${name} is waiting for input from ${from}` : `${name} is waiting`)
			}
		}

		const parts: string[] = []
		if (stakes.length > 0) parts.push(`Waiting for ${joinNames(stakes)} to finish`)
		parts.push(...waiting)
		if (done.length > 0) parts.push(`${joinNames(done)} ${done.length === 1 ? "has" : "have"} finished`)
		if (failed.length > 0) parts.push(`${joinNames(failed)} ${failed.length === 1 ? "has" : "have"} failed`)

		const body = parts.length > 0 ? `${parts.join(". ")}.` : `dispatching ${stakes.length} agent(s).`
		return `🔄 Round ${this.flowState.round}: ${body}`
	}

	/** Render an await's source list for humans ("Builder", "you", "Builder or you"). */
	private describeWaitSources(waitingFor: string | undefined): string {
		if (!waitingFor) return ""
		const sources = waitingFor
			.split(",")
			.map((s) => s.trim().replace(/^@/, ""))
			.filter(Boolean)
			.map((s) => (s === "Human" ? "you" : s === "any" || s === "*" ? "any agent" : s))
		return joinNames(sources, "or")
	}

	// ── Interpreter ──

	/**
	 * Advance an agent's program counter, executing all non-blocking
	 * instructions (let / set / jump / branch / satisfied commit) until it
	 * reaches a blocking instruction (stake / escalate / unsatisfied await),
	 * commits, or runs off the end of its program.
	 */
	private advanceAgent(state: AgentState): { result: AdvanceResult; emitted: EmittedMessage[] } {
		const program = this.programs.get(state.name)
		if (!program) {
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE advanceAgent '${state.name}': no compiled program → end`,
			)
			return { result: { type: "end" }, emitted: [] }
		}
		const emitted: EmittedMessage[] = []
		const result = advanceAgentPure(
			program,
			state,
			this.flowState.mailbox,
			this.flowState,
			{
				info: (msg) => workflowLog.info(`[WorkflowTask#${this.taskId}] #TRACE ${msg}`),
				error: (msg) => workflowLog.error(`[WorkflowTask#${this.taskId}] ${msg}`),
			},
			emitted,
		)
		return { result, emitted }
	}

	/**
	 * Surface a `log` / `error` / `commit` message an agent produced to the
	 * WorkflowTask chat view. `error` and `commit` carry distinct prefixes so the
	 * user can tell a premature abort from a normal completion at a glance.
	 */
	private async emitAgentMessage(agentName: string, m: EmittedMessage): Promise<void> {
		switch (m.kind) {
			case "log":
				await this.sayProgress(m.message ? `📝 **${agentName}**: ${m.message}` : `📝 **${agentName}** logged.`)
				break
			case "commit":
				await this.sayProgress(`✅ **${agentName}** committed: ${m.message}`)
				break
			case "error":
				await this.sayProgress(
					m.message
						? `🛑 **${agentName}** raised an error: ${m.message}`
						: `🛑 **${agentName}** raised an error.`,
				)
				break
		}
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
			else await this.resumeAgentTask(name, prompt, instr.op.output)
			state.status = "running"
			// Stamp dispatch time so a per-stake `timeout(N)` can be enforced from
			// here (waitForStakes bounds the wait; collectStakeResults detects the
			// expiry). Transient — re-set on every dispatch, never serialized.
			this.stakeDispatchedAt.set(name, Date.now())
			// Record this round's outbound recipients so the live topology can
			// draw the agent's active stake edges (and the sequence its pending
			// send). Comma-joined like `waitingFor`. Cleared once the result is
			// routed (collectStakeResults) or the agent errors.
			const recipients = instr.op.recipients.map((r) => r.ref).filter(Boolean)
			state.sendingTo = recipients.length > 0 ? recipients.join(",") : undefined
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
				// Inject the agent's declared `.slang` role into its system prompt
				// (the slang `role:` is otherwise parsed-but-not-consumed). Layered
				// on top of the mode's roleDefinition for this agent task only.
				// `${…}` placeholders in the role resolve against the flow params +
				// the agent's bindings (e.g. ${design_dir}/${design_filename}).
				agentRole: agentDecl.meta?.role
					? interpolatePure(agentDecl.meta.role, agentState, this.flowState)
					: undefined,
				// Enforce the agent's declared `.slang` `tools:` restriction (otherwise
				// parsed-but-not-consumed). Intersects with the mode's tools when the
				// task builds its tool array, so e.g. an `architect`-mode orchestrator
				// declared `tools: [questions, subtasks]` cannot read or edit files —
				// it can only coordinate. ALWAYS_AVAILABLE tools are retained.
				agentToolGroups: agentDecl.meta?.tools,
				// The agent's declared `.slang` `api_configuration:` (legacy alias
				// `model:`) selects its API-configuration profile by name (per-task
				// only — never activates the profile globally). An unknown name falls
				// back to the global profile. Lets different agents in one workflow
				// run on different models.
				initialApiConfigName: agentDecl.meta?.apiConfiguration,
				// The agent's `.slang` `context { include_agents_md }` overrides
				// whether AGENTS.md rules are injected into its system prompt
				// (undefined ⇒ inherit the global setting).
				agentIncludeAgentsMd: agentDecl.meta?.context?.include_agents_md,
				initialState: { lifecycle: "idle" },
				openInStack: false,
				keepCurrentTask: true,
				completionSchema,
				// Title the agent task with its declared name from the .slang file and
				// lock it: the agent cannot rename itself via set_task_title, so the
				// task list stays aligned with the workflow's agent declarations.
				initialTitle: agentName,
				// Inherit the workflow's worktree: every agent in the tree operates
				// inside the same directory the WorkflowTask runs in (the worktree the
				// user selected at launch, or the workspace root when none was picked).
				cwd: this.cwd,
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
			await this.sayProgress(
				`❌ Failed to spawn agent \`${agentName}\`: ${error instanceof Error ? error.message : String(error)} — marking it errored.`,
			)
			agentState.status = "error"
		}
	}

	private async resumeAgentTask(agentName: string, prompt: string, outputSchema?: OutputSchema): Promise<void> {
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
			// Apply THIS stake's output contract as the per-task strict completion
			// schema (or clear it when the stake has none). spawnAgentTask only sets
			// the schema for an agent's FIRST stake, so without this an agent whose
			// contract-bearing stake is a LATER stake (e.g. a verifier that first
			// acknowledges readiness, then evaluates with an `output:` contract)
			// would never get strict enforcement — the model returns prose and
			// fails post-hoc validation, retries out, and the flow deadlocks.
			if (agentTask) {
				agentTask.completionSchema = outputSchema ? contractToJsonSchema(outputSchema) : undefined
			}
			agentTask?.messageQueueService.addMessage(prompt)

			// Reset the stale terminal markers BEFORE waitForStakes runs. Otherwise
			// its preseed sees the PREVIOUS stake's "completed" lifecycle, treats this
			// stake as already done, and returns in ~0ms — and collectStakeResults
			// then reads the stale prior completion.
			const handle = this.backgroundChildren.get(agentState.taskId)
			if (handle) handle.status = "running"
			provider.taskManager.setState(agentState.taskId, { lifecycle: "running" })

			// CRITICAL: actually re-drive the agent's task loop.
			//
			// When this agent finished its PREVIOUS stake it called
			// attempt_completion — the agent's self-declared terminal state, which
			// sets `abort = true` and lets the task loop EXIT (it does NOT leave the
			// task parked in a `completion_result` ask polling the queue). With no
			// live loop, the prompt we just queued is never drained, the agent never
			// runs this stake, waitForStakes times out, and collectStakeResults reads
			// the STALE prior completion — which (on an `output:` contract stake)
			// retry-loops into a deadlock. This is exactly the failure mode that left
			// a verifier's readiness ack standing in for its never-produced verdict.
			//
			// `cancelAndProcessQueuedMessages()` restarts the loop with the queued
			// prompt — the same path the webview "Send Now" flow and
			// SendMessageToTaskTool use to wake a completed/stopped peer. A still-live
			// instance (e.g. one just rehydrated into its `resume_completed_task` ask,
			// where `abort === false`) drains the queue via its active ask() loop, so
			// only a stopped loop needs restarting.
			const loopStopped = agentTask?.abort ?? false
			if (loopStopped && agentTask) {
				void agentTask.cancelAndProcessQueuedMessages()
			}
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] #TRACE resumeAgentTask '${agentName}' prompt queued (${prompt.length} chars), loop ${loopStopped ? "restarted via cancelAndProcessQueuedMessages" : "live — will drain on next ask"}`,
			)
		} catch (error) {
			workflowLog.error(`[WorkflowTask#${this.taskId}] Failed to resume agent '${agentName}':`, error)
			await this.sayProgress(
				`❌ Failed to resume agent \`${agentName}\`: ${error instanceof Error ? error.message : String(error)} — marking it errored.`,
			)
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

		// Per-agent deadline (epoch ms) for an explicit `timeout(N)` stake clause:
		// dispatch time + N seconds. `Infinity` when the stake has no timeout — a
		// running agent is making progress and may legitimately take a long time, so
		// it is NOT cut off by any implicit cap. The flow's own `time(N)` budget
		// (loopDeadline) applies on top of all agents.
		const agentDeadline = new Map<string, number>() // taskId → epoch ms
		for (const name of names) {
			const st = this.flowState.agents.get(name)
			if (!st?.taskId) continue
			const program = this.programs.get(name)
			const instr = program?.[st.opIndex]
			const timeoutSec = instr && instr.kind === "stake" ? instr.op.timeout : undefined
			const dispatchedAt = this.stakeDispatchedAt.get(name) ?? startTime
			agentDeadline.set(st.taskId, timeoutSec && timeoutSec > 0 ? dispatchedAt + timeoutSec * 1000 : Infinity)
		}

		// Settled = every staked agent is either terminal, past its own per-stake
		// timeout, or the whole-flow time budget has elapsed.
		const flowExpired = () => this.loopDeadline > 0 && Date.now() >= this.loopDeadline
		const allSettled = () =>
			flowExpired() ||
			[...handles.keys()].every((id) => isTerminal(id) || Date.now() >= (agentDeadline.get(id) ?? Infinity))

		// Wait in slices: each slice runs until all terminal (helper conditionMet) or
		// the earliest pending deadline fires; then we re-evaluate. The loop ends
		// once everything is settled, or the user aborts.
		while (!allSettled() && !this.abort) {
			let earliest = Infinity
			for (const id of handles.keys()) {
				if (isTerminal(id)) continue
				const dl = agentDeadline.get(id) ?? Infinity
				if (Date.now() >= dl) continue // already expired — counted as settled above
				if (dl < earliest) earliest = dl
			}
			const flowDl = this.loopDeadline > 0 ? this.loopDeadline : Infinity
			const effective = Math.min(earliest, flowDl)
			const timeoutMs = effective === Infinity ? undefined : Math.max(0, effective - Date.now())
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
		}

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

		// Identify which agent is asking. The agent's slang `name` is its task
		// title (set as `initialTitle` when spawned), so the user sees the same
		// label that appears in the workflow's swimlane / task list.
		const agentName = [...this.flowState.agents.values()].find((a) => a.taskId === childTaskId)?.name

		// Emit followup ask as the SAME JSON shape AskFollowupQuestionTool
		// sends (line 43): { question, suggest: [{ answer, mode }] }.
		// ChatRow.tsx:528 parses followup asks with safeJsonParse<FollowUpData>,
		// so a plain string would render degraded and lose suggestion buttons.
		const asker = agentName ? `Agent \`${agentName}\`` : "Agent"
		const followUpJson = {
			question: `${asker} is asking:\n> ${pendingQuestion.question}\n\nYour answer:`,
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

			// Per-stake retry budget. Precedence: an explicit per-stake
			// `retries(N)` wins; otherwise the staking agent's declared
			// `retry:` meta sets its default; otherwise the global MAX_RETRIES.
			const agentDefaultRetries = getAgentDecls(this.flowDecl).find((a) => a.name === name)?.meta?.retry
			const maxRetries = instr.op.retries ?? agentDefaultRetries ?? MAX_RETRIES

			try {
				// Freshness guard: only consume an agent's result once it has actually
				// reached a terminal lifecycle for THIS stake — otherwise its taskId
				// still carries the PREVIOUS stake's completion and validating that
				// stale result would check the wrong output.
				if (state.taskId) {
					const handle = this.backgroundChildren.get(state.taskId)
					const lifecycle = provider.taskManager.getTaskState(state.taskId)?.lifecycle
					const reachedTerminal =
						handle?.status === "completed" ||
						handle?.status === "error" ||
						handle?.status === "cancelled" ||
						lifecycle === "completed" ||
						lifecycle === "error"
					if (!reachedTerminal) {
						// The agent didn't finish. Distinguish the two reasons:
						const dispatchedAt = this.stakeDispatchedAt.get(name)
						const timedOut =
							!!instr.op.timeout &&
							instr.op.timeout > 0 &&
							dispatchedAt !== undefined &&
							Date.now() >= dispatchedAt + instr.op.timeout * 1000

						if (timedOut) {
							// An EXPLICIT per-stake `timeout(N)` expired — a genuine failed
							// try. Re-dispatch up to `retries`, then error.
							state.retryCount++
							state.sendingTo = undefined
							if (state.retryCount > maxRetries) {
								workflowLog.error(
									`[WorkflowTask#${this.taskId}] Agent '${name}' stake '${instr.op.call.name}' timed out (timeout(${instr.op.timeout})s) — exhausted ${maxRetries} retries`,
								)
								await this.sayProgress(
									`❌ Agent \`${name}\` timed out on \`${instr.op.call.name}\` (\`timeout(${instr.op.timeout})\`s) after ${maxRetries} ${maxRetries === 1 ? "retry" : "retries"} and was marked **errored**.`,
								)
								state.status = "error"
							} else {
								await this.sayProgress(
									`⏱️ Agent \`${name}\` exceeded its \`timeout(${instr.op.timeout})\`s on \`${instr.op.call.name}\` (retry ${state.retryCount}/${maxRetries}); re-dispatching.`,
								)
								// Leave opIndex on this stake and mark idle so the next round
								// re-dispatches it through the normal advance → stake path.
								state.status = "idle"
							}
							continue
						}

						// No explicit per-stake timeout — the wait ended for a FLOW-LEVEL
						// reason (the `time(N)` budget was hit or the user stopped). A
						// running agent is *trying*; never retry, fail, or read its stale
						// completion. Skip it and let the budget/abort handling terminate.
						workflowLog.info(
							`[WorkflowTask#${this.taskId}] #TRACE Agent '${name}' stake '${instr.op.call.name}' still in flight (lifecycle=${lifecycle ?? "unknown"}) — wait ended on a flow-level limit/abort, not a per-stake timeout; leaving it running`,
						)
						continue
					}
				}

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
					if (state.retryCount > maxRetries) {
						workflowLog.error(
							`[WorkflowTask#${this.taskId}] Agent '${name}' exceeded max retries (${maxRetries}) for output validation:\n${validationError}`,
						)
						// Surface the terminal validation failure to the chat — not
						// just the logs — so the user can see WHY the agent errored
						// (and, downstream, why the flow may deadlock).
						await this.sayProgress(
							`❌ Agent \`${name}\` failed output-contract validation after ${maxRetries} ${maxRetries === 1 ? "retry" : "retries"} and was marked **errored**:\n\n${validationError}`,
						)
						state.status = "error"
						state.sendingTo = undefined
					} else {
						workflowLog.info(
							`[WorkflowTask#${this.taskId}] Agent '${name}' output validation failed (retry ${state.retryCount}/${maxRetries}): ${validationError}`,
						)
						// Surface each retry to the chat too, so a struggling agent
						// is visible as it happens rather than silently in the logs.
						await this.sayProgress(
							`⚠️ Agent \`${name}\` output didn't match its schema (retry ${state.retryCount}/${maxRetries}); re-prompting:\n\n${validationError}`,
						)
						state.status = "idle"
						// Re-prompt the agent with the validation error — do NOT advance opIndex
						const retryPrompt = `\n\nYour previous response was invalid:\n${validationError}\n\nPlease retry the operation by placing ONLY a valid JSON object in your attempt_completion result (no other text, no markdown fences).`
						// Keep THIS stake's contract applied on the retry (don't clear it).
						await this.resumeAgentTask(name, retryPrompt, outputSchema)
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
				state.sendingTo = undefined // result routed; no longer in flight
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
				await this.sayProgress(
					`❌ Failed to read agent \`${name}\`'s result: ${error instanceof Error ? error.message : String(error)} — marking it errored.`,
				)
				state.status = "error"
				state.sendingTo = undefined
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
		// Resolve `${…}` placeholders in the reason against flow params + the
		// agent's bindings (e.g. ${design_dir}/${design_filename}).
		const reason = instr.op.reason
			? interpolatePure(instr.op.reason, state, this.flowState)
			: `Agent '${agentName}' needs your input.`
		const humanRef = instr.op.target || "Human"
		workflowLog.info(
			`[WorkflowTask#${this.taskId}] Escalation from '${agentName}', awaiting human input: ${reason}`,
		)
		// Record the escalation request in mailboxHistory so the Sequence diagram
		// draws an arrow from the agent to @Human (that view is built entirely from
		// mailboxHistory). Push + notify before blocking on the human so the arrow
		// shows while we wait, not only after the reply.
		this.flowState.mailboxHistory.push({
			from: agentName,
			to: humanRef,
			value: reason,
			timestamp: Date.now(),
			funcName: "escalate",
		})
		this.notifySlangEditor()
		// Emit the followup as the JSON FollowUpData shape the webview expects —
		// ChatRow parses followup text with safeJsonParse<FollowUpData> and renders
		// `question`, so a raw string would show the "Shofer has a question" header
		// with an empty body in the Events tab. Three flavours, by what the op declares:
		//   - `form`    → a typed input form (full ask_followup_question widgets);
		//                 answers are delivered as one coerced object (DotAccess-able).
		//   - `choices` → suggestion buttons (multiple-choice sign-off, no typing).
		//   - neither   → free-text followup (WorkflowView shows the answer textbox).
		const choices = instr.op.choices
		const form = instr.op.form
		let response: unknown
		if (form && form.length > 0) {
			// Build the paramForm the webview renders (same shape flow-param
			// collection uses), ask, then coerce each answer to its declared type so
			// the bound object is usable via DotAccess (e.g. `answers.replicas > 5`).
			const paramForm = form.map((f) => {
				const type = f.paramType === "number" || f.paramType === "boolean" ? f.paramType : "string"
				return {
					name: f.name,
					type,
					...(f.default !== undefined ? { default: f.default } : {}),
					...(f.description ? { description: f.description } : {}),
					...(f.widget ? { widget: f.widget } : {}),
					...(f.options ? { options: f.options } : {}),
					...(f.min !== undefined ? { min: f.min } : {}),
					...(f.max !== undefined ? { max: f.max } : {}),
					...(f.step !== undefined ? { step: f.step } : {}),
				}
			})
			const { text } = await this.ask("followup", JSON.stringify({ question: reason, paramForm }))
			let submitted: Record<string, unknown> = {}
			try {
				const parsed = JSON.parse(text ?? "{}")
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) submitted = parsed
			} catch {
				// Non-JSON answer (older client / plain reply) — fall through to defaults.
			}
			const answers: Record<string, unknown> = {}
			for (const f of form) {
				const v = submitted[f.name]
				// The form submits strings for some widgets — coerce to the declared
				// type so numbers/booleans are real values, not strings.
				answers[f.name] = typeof v === "string" ? coerceParam(v, f.paramType) : v
			}
			// Replay the form read-only after a reload (no chat echo on objectResponse).
			await this.markFollowupFormAnswered(answers as Record<string, string | number | boolean | string[]>)
			response = answers
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] Escalation from '${agentName}' answered via form: ${JSON.stringify(answers)}`,
			)
		} else {
			const followUp =
				choices && choices.length > 0
					? { question: reason, suggest: choices.map((answer) => ({ answer })) }
					: { question: reason }
			const { text } = await this.ask("followup", JSON.stringify(followUp))
			response = text ?? ""
			workflowLog.info(
				`[WorkflowTask#${this.taskId}] Escalation from '${agentName}' answered (${(text ?? "").length} chars)`,
			)
		}
		const replyTs = Date.now()
		// Deliver the reply to the transient mailbox (for the agent's await/consume)
		// AND record it in mailboxHistory so the Sequence diagram draws the return
		// arrow from @Human back to the agent.
		this.flowState.mailbox.push({
			from: humanRef,
			to: agentName,
			value: response,
			timestamp: replyTs,
			funcName: "escalate",
		})
		this.flowState.mailboxHistory.push({
			from: humanRef,
			to: agentName,
			value: response,
			timestamp: replyTs,
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
		// Stamp the runState with this task's id. The WorkflowView consumes the
		// viz fields through *global* ExtensionState keys that any live workflow
		// writes to; the tag lets it scope a runState to the task it is showing.
		const runState = { ...serializeFlowState(this.flowState), taskId: this.taskId }

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
				if (meta) {
					meta.taskId = this.taskId
					provider.postConfigUpdate("workflowVizMeta", meta)
				}

				// Structure-only HTML (no live runState baked in) so it is
				// byte-identical to the re-seed produced by getWorkflowVizSnapshot()
				// — the two must agree or switching between them reloads the iframe.
				// The live runState rides the workflowVizRunState field below and is
				// forwarded into the iframe via postMessage, so badges still appear.
				const html = buildWorkflowVizHtml(this.slangSource, this.flowState, {})
				if (html) {
					provider.postConfigUpdate("workflowVizHtml", html)
					this._vizHtmlPushed = true
				}
			}
			provider.postConfigUpdate("workflowVizRunState", runState)
		}
	}

	/**
	 * Snapshot of this workflow's visualization (header metadata + diagram HTML +
	 * runtime state), all stamped with this task's id. Used by
	 * `getStateToPostToWebview()` to re-seed the viz on task switch so the
	 * focused workflow's diagrams are restored even if a background workflow was
	 * the last to push through the global viz keys. Returns `undefined` if the
	 * slang source can't be rendered.
	 */
	public getWorkflowVizSnapshot():
		| { html: string; meta: WorkflowVizMeta | undefined; runState: Record<string, unknown> }
		| undefined {
		const runState = { ...serializeFlowState(this.flowState), taskId: this.taskId }
		// Bake a structure-only payload (no live runState) into the HTML so this
		// snapshot is byte-stable for a given task across full state pushes. This
		// re-seed runs on every getStateToPostToWebview(); if the HTML embedded the
		// live runState it would change every push and force SlangViz to reload the
		// iframe (losing zoom/pan). The live runState is still returned below and
		// forwarded via postMessage on load, so runtime badges appear immediately.
		const html = buildWorkflowVizHtml(this.slangSource, this.flowState, {})
		if (!html) return undefined
		const meta = buildWorkflowVizMeta(this.slangSource)
		if (meta) meta.taskId = this.taskId
		return { html, meta, runState }
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
			// Push the terminal FlowState to the viz so the swimlane reflects the
			// final status immediately — in particular this stops the
			// currently-executing-op marker from blinking once the flow is no longer
			// running (converged / deadlock / budget_exceeded / error).
			this.notifySlangEditor()

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

			// Authoritative final viz push. Per-round updates ride a lightweight
			// `postConfigUpdate("workflowVizRunState", …)` delta, and `setState`
			// above only emits `parallelTasksUpdated` — neither re-seeds the diagrams
			// from a full snapshot. Without a closing full push, the terminal round's
			// state changes (e.g. an agent advancing to `committed` after a final
			// escalation) can be left unrendered if the single delta races an
			// in-flight `postInitState` carrying a pre-terminal snapshot, freezing the
			// topology/sequence/swimlane at a non-final state. postInitState() is the
			// documented "completion reset" push and re-seeds the viz from the now-
			// terminal flowState, so it is the definitive last word.
			await provider.postInitState()
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
	/**
	 * Worktree directory the whole workflow runs in. When set, the WorkflowTask
	 * and every agent it spawns operate inside this worktree (see
	 * {@link WorkflowTask.spawnAgentTask}). Falls back to the workspace root.
	 */
	cwd?: string,
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
		// Run the workflow root inside the selected worktree (if any); child
		// agents inherit this via spawnAgentTask.
		cwd,
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
