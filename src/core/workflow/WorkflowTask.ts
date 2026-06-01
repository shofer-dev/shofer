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
	type MailboxEntry,
	deserializeFlowState,
	serializeFlowState,
} from "./slang-types"
import { parseSlang, validateSlangAST } from "./slang-parser"
import type { FlowDecl as UpstreamFlowDecl, AgentDecl as UpstreamAgentDecl, Operation, Expr } from "./slang-ast"
import { exprAsString, exprAsNumber } from "./slang-ast"

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

/** Serialize an expression for comparison in conditions. */
function exprToString(expr: Expr): string {
	switch (expr.type) {
		case "Ident":
			return expr.name
		case "StringLit":
			return expr.value
		case "AgentRef":
			return `@${expr.name}`
		case "DotAccess":
			return `${exprToString(expr.object)}.${expr.property}`
		case "BoolLit":
			return String(expr.value)
		case "NumberLit":
			return String(expr.value)
		case "BinaryExpr":
			return `${exprToString(expr.left)} ${expr.op} ${exprToString(expr.right)}`
		default:
			return ""
	}
}

// ─── Types ──

export interface WorkflowTaskOptions extends TaskOptions {
	slangSource: string
	flowDecl: UpstreamFlowDecl
	flowState?: FlowState
	flowParams?: Record<string, unknown>
}

interface RoundContext {
	readyAgents: string[]
	dispatchMessages: Map<string, string>
}

// ── Constants ──

const DEFAULT_BUDGET_TOKENS = 300000
const DEFAULT_BUDGET_ROUNDS = 30

// ── WorkflowTask ──

export class WorkflowTask extends Task {
	readonly slangSource: string
	readonly flowDecl: UpstreamFlowDecl
	flowState: FlowState
	private slangLoopStarted = false

	constructor(options: WorkflowTaskOptions) {
		const flowName = options.flowDecl.name
		super({ ...options, startTask: false, initialMode: flowName })

		this.slangSource = options.slangSource
		this.flowDecl = options.flowDecl

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

	async start(): Promise<void> {
		if (this.slangLoopStarted) return
		this.slangLoopStarted = true
		try {
			this.emit(ShoferEventName.TaskStarted, this.taskId)
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

		while (this.flowState.round < budgetRounds && !this.abort) {
			this.flowState.round++

			const ctx = this.buildRoundContext()
			if (ctx.readyAgents.length === 0) {
				if (this.checkConverge() || this.allAgentsCommitted()) {
					await this.handleConverge()
					return
				}
				this.flowState.status = "deadlock"
				outputError(`[WorkflowTask#${this.taskId}] Deadlock at round ${this.flowState.round}`)
				await this.emitTaskCompleted("poor")
				return
			}

			this.resolveMailboxes()
			const escalated = await this.checkEscalate(ctx)
			if (escalated) continue

			await this.dispatchAgents(ctx)
			await this.waitForAgentResults(ctx.readyAgents)
			this.resolveMailboxes()

			if (this.checkConverge()) {
				await this.handleConverge()
				return
			}
			await this.persistCheckpoint()
		}

		if (this.flowState.round >= budgetRounds) {
			this.flowState.status = "budget_exceeded"
			await this.abortBackgroundChildren()
			await this.emitTaskCompleted("poor")
		}
	}

	// ── Round Context ──

	private buildRoundContext(): RoundContext {
		const ctx: RoundContext = { readyAgents: [], dispatchMessages: new Map() }
		for (const agentDecl of getAgentDecls(this.flowDecl)) {
			const agentState = this.flowState.agents.get(agentDecl.name)
			if (!agentState) continue
			if (agentState.status === "committed" || agentState.status === "error") continue

			const op = agentDecl.operations[agentState.opIndex]
			if (!op) continue

			if (this.isAgentReady(agentState, op)) {
				ctx.readyAgents.push(agentDecl.name)
				ctx.dispatchMessages.set(agentDecl.name, this.buildDispatchPrompt(agentDecl, agentState, op))
			}
		}
		return ctx
	}

	private isAgentReady(agentState: AgentState, op: Operation): boolean {
		switch (op.type) {
			case "StakeOp":
			case "LetOp":
			case "SetOp":
			case "CommitOp":
				return agentState.status !== "running"
			case "AwaitOp":
				return this.hasMailFor(agentState.name, op.sources[0]?.ref || "any")
			case "EscalateOp":
				return this.flowState.status !== "escalated"
			case "RepeatBlock":
			case "WhenBlock":
				return true
			default:
				return false
		}
	}

	private hasMailFor(recipient: string, source: string): boolean {
		return this.flowState.mailbox.some(
			(e) => e.to === recipient && (source === "any" || source === "*" || e.from === source),
		)
	}

	// ── Dispatch ──

	private buildDispatchPrompt(agentDecl: UpstreamAgentDecl, agentState: AgentState, op: Operation): string {
		switch (op.type) {
			case "StakeOp": {
				let prompt = `Execute: ${op.call.name}`
				if (op.call.args.length > 0) {
					const args: Record<string, unknown> = {}
					for (const arg of op.call.args) {
						const key = arg.name || String(Object.keys(args).length)
						args[key] = this.resolveExprValue(arg.value, agentState)
					}
					prompt += `\n\nArguments:\n${JSON.stringify(args, null, 2)}`
				}
				if (agentState.bindings.size > 0) {
					prompt += `\n\nCurrent context:\n${JSON.stringify(Object.fromEntries(agentState.bindings), null, 2)}`
				}
				if (op.output) {
					prompt += `\n\nYour response MUST include a JSON object with:\n`
					for (const f of op.output.fields) {
						prompt += `  - ${f.name} (${f.fieldType})\n`
					}
					prompt += `\nInclude this JSON in your attempt_completion result.`
				}
				const peers = this.getPeerResources(agentDecl.name)
				if (peers.length > 0) {
					prompt += `\n\nPEER RESOURCES:\n`
					for (const p of peers) prompt += `- ${p.name} (task ID: ${p.taskId}) — ${p.role}\n`
				}
				return prompt
			}
			case "AwaitOp": {
				const sources = op.sources.map((s) => s.ref).join(",")
				const mail = this.flowState.mailbox.find(
					(e) =>
						e.to === agentDecl.name &&
						(sources.includes(e.from) || sources.includes("any") || sources.includes("*")),
				)
				if (mail) {
					this.flowState.mailbox = this.flowState.mailbox.filter((e) => e !== mail)
					agentState.bindings.set(op.binding, mail.value)
					return `Received from @${mail.from}: ${JSON.stringify(mail.value)}`
				}
				return `Waiting for input from @${sources}...`
			}
			case "CommitOp":
				return "Your work is complete. Call attempt_completion."
			default:
				return "Continue execution."
		}
	}

	private resolveExprValue(expr: Expr, agentState: AgentState): unknown {
		switch (expr.type) {
			case "StringLit":
				return expr.value
			case "NumberLit":
				return expr.value
			case "BoolLit":
				return expr.value
			case "Ident":
				if (agentState.bindings.has(expr.name)) return agentState.bindings.get(expr.name)
				if (expr.name in this.flowState.params) return this.flowState.params[expr.name]
				return expr.name
			case "AgentRef":
				return `@${expr.name}`
			default:
				return JSON.stringify(expr)
		}
	}

	private getPeerResources(agentName: string): Array<{ name: string; taskId: string; role: string }> {
		const resources: Array<{ name: string; taskId: string; role: string }> = []
		for (const [name, agentState] of this.flowState.agents) {
			if (name === agentName) continue
			if (agentState.taskId && agentState.status !== "committed") {
				const decl = getAgentDecls(this.flowDecl).find((a) => a.name === name)
				const mode = (decl?.meta as any)?.mode || "unknown"
				if (mode === "search" || mode === "browser") {
					resources.push({ name, taskId: agentState.taskId, role: decl?.meta?.role || `Agent '${name}'` })
				}
			}
		}
		return resources
	}

	// ── Dispatch Agents ──

	private async dispatchAgents(ctx: RoundContext): Promise<void> {
		for (const agentName of ctx.readyAgents) {
			const agentState = this.flowState.agents.get(agentName)
			if (!agentState) continue
			const prompt = ctx.dispatchMessages.get(agentName)
			if (!prompt) continue

			if (!agentState.taskId) {
				await this.spawnAgentTask(agentName, prompt)
			} else {
				await this.resumeAgentTask(agentName, prompt)
			}
			agentState.status = "running"
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
			})
			if (task) {
				this.backgroundChildren.set(task.taskId, {
					taskId: task.taskId,
					status: "running",
					startTime: Date.now(),
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
			const agentTask = (provider as any).getManagedTaskInstance?.(agentState.taskId)
			if (agentTask) {
				agentTask.messageQueueService.addMessage(prompt)
			} else {
				const { historyItem } = await provider.getTaskWithId(agentState.taskId)
				await provider.createTaskWithHistoryItem(historyItem)
				const rehydrated = (provider as any).getManagedTaskInstance?.(agentState.taskId)
				if (rehydrated) rehydrated.messageQueueService.addMessage(prompt)
			}
		} catch (error) {
			outputError(`[WorkflowTask#${this.taskId}] Failed to resume agent '${agentName}':`, error)
		}
	}

	// ── Wait ──

	private async waitForAgentResults(agentNames: string[]): Promise<void> {
		const provider = this.providerRef.deref()
		if (!provider) return

		const taskIds = agentNames.map((n) => this.flowState.agents.get(n)?.taskId).filter(Boolean) as string[]
		if (taskIds.length === 0) return

		const startTime = Date.now()
		const timeoutMs = 300_000
		while (Date.now() - startTime < timeoutMs && !this.abort) {
			let allDone = true
			for (const taskId of taskIds) {
				const handle = this.backgroundChildren.get(taskId)
				if (!handle) continue
				try {
					const { historyItem } = await provider.getTaskWithId(taskId)
					const lc = historyItem.taskState?.lifecycle
					if (lc === "completed") handle.status = "completed"
					else if (lc === "error") handle.status = "error"
					else allDone = false
				} catch {
					allDone = false
				}
			}
			if (allDone) break
			await new Promise((r) => setTimeout(r, 500))
		}

		for (const name of agentNames) {
			const agentState = this.flowState.agents.get(name)
			const agentDecl = getAgentDecls(this.flowDecl).find((a) => a.name === name)
			if (!agentState || !agentDecl) continue
			const op = agentDecl.operations[agentState.opIndex]
			if (!op || op.type !== "StakeOp") continue

			try {
				const { historyItem } = await provider.getTaskWithId(agentState.taskId)
				let result: unknown = historyItem.completionResultSummary
				if (typeof result === "string") {
					try {
						result = JSON.parse(result)
					} catch {
						/* as-is */
					}
				}
				agentState.output = result
				agentState.status = "idle"

				if (op.recipients.length > 0) {
					const target = op.recipients[0]!.ref
					this.flowState.mailbox.push({
						from: name,
						to: target,
						value: result,
						timestamp: Date.now(),
						funcName: op.call.name,
					})
					const targetAgent = this.flowState.agents.get(target)
					if (targetAgent?.waitingFor === name) targetAgent.waitingFor = undefined
				}
				agentState.opIndex++
			} catch (error) {
				outputError(`[WorkflowTask#${this.taskId}] Failed to read result for '${name}':`, error)
				agentState.status = "error"
			}
		}
	}

	// ── Mailbox ──

	private resolveMailboxes(): void {
		for (const [name, agentState] of this.flowState.agents) {
			if (agentState.status === "blocked") {
				const agentDecl = getAgentDecls(this.flowDecl).find((a) => a.name === name)
				if (!agentDecl) continue
				const op = agentDecl.operations[agentState.opIndex]
				if (op?.type === "AwaitOp") {
					const sources = op.sources.map((s) => s.ref)
					if (sources.some((s) => this.hasMailFor(name, s))) {
						agentState.status = "idle"
						agentState.waitingFor = undefined
					}
				}
			}
		}
	}

	// ── Escalate ──

	private async checkEscalate(ctx: RoundContext): Promise<boolean> {
		for (const agentName of ctx.readyAgents) {
			const agentDecl = getAgentDecls(this.flowDecl).find((a) => a.name === agentName)
			const agentState = this.flowState.agents.get(agentName)
			if (!agentDecl || !agentState) continue
			const op = agentDecl.operations[agentState.opIndex]
			if (!op || op.type !== "EscalateOp") continue

			this.flowState.status = "escalated"
			const reason = op.reason || `Agent '${agentName}' needs your input.`
			await this.ask("followup", reason)

			const response = this.askResponseText || ""
			this.askResponse = undefined
			this.askResponseText = undefined

			this.flowState.mailbox.push({
				from: "Human",
				to: agentName,
				value: response,
				timestamp: Date.now(),
				funcName: "escalate",
			})
			agentState.opIndex++
			agentState.status = "idle"
			this.flowState.status = "running"
			return true
		}
		return false
	}

	// ── Converge ──

	private checkConverge(): boolean {
		const convergeExpr = getConvergeExpr(this.flowDecl)
		if (!convergeExpr) return this.allAgentsCommitted()

		if (convergeExpr.type === "DotAccess" && convergeExpr.object.type === "AgentRef") {
			const agentName = convergeExpr.object.name
			return this.flowState.agents.get(agentName)?.status === "committed"
		}
		return this.allAgentsCommitted()
	}

	private allAgentsCommitted(): boolean {
		for (const [, s] of this.flowState.agents) {
			if (s.status !== "committed") return false
		}
		return true
	}

	private async handleConverge(): Promise<void> {
		this.flowState.status = "converged"
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

	private async abortBackgroundChildren(): Promise<void> {
		for (const [taskId, handle] of this.backgroundChildren) {
			handle.status = "cancelled"
			const provider = this.providerRef.deref()
			if (provider) {
				try {
					await provider.cancelTask()
				} catch {
					/* best effort */
				}
			}
		}
		this.backgroundChildren.clear()
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
