/**
 * Slang dependency resolver — vendored from @riktar/slang (MIT).
 * Source: https://github.com/riktar/slang/blob/master/src/resolver.ts
 *
 * Analyzes a parsed flow to determine execution order, detect deadlocks,
 * and perform static analysis (warnings about missing converge, unknown refs, etc.).
 */

import { toolGroups } from "@shofer/types"

import type { FlowDecl, AgentDecl, Operation } from "./slang-ast"

const VALID_TOOL_GROUPS = new Set<string>(toolGroups)

export interface AgentDep {
	name: string
	awaitsFrom: string[]
	stakesTo: string[]
	isReady: boolean
	initialAwaitsFrom: string[]
}

export interface DepGraph {
	agents: Map<string, AgentDep>
	ready: string[]
	blocked: string[]
}

export function resolveDeps(flow: FlowDecl): DepGraph {
	const agentNodes = flow.body.filter((n): n is AgentDecl => n.type === "AgentDecl")
	const agents = new Map<string, AgentDep>()

	for (const agent of agentNodes) {
		const awaitsFrom: string[] = []
		const stakesTo: string[] = []
		const initialAwaitsFrom: string[] = []
		let firstOpIsAwait = false
		let seenNonAwait = false

		for (let i = 0; i < agent.operations.length; i++) {
			const op = agent.operations[i]!
			collectDeps(op, awaitsFrom, stakesTo)
			if (i === 0 && op.type === "AwaitOp") {
				firstOpIsAwait = true
			}
			if (!seenNonAwait && op.type === "AwaitOp") {
				for (const s of op.sources) {
					if (s.ref !== "*" && s.ref !== "any") initialAwaitsFrom.push(s.ref)
				}
			} else {
				seenNonAwait = true
			}
		}

		agents.set(agent.name, {
			name: agent.name,
			awaitsFrom: [...new Set(awaitsFrom)],
			stakesTo: [...new Set(stakesTo)],
			isReady: !firstOpIsAwait,
			initialAwaitsFrom: [...new Set(initialAwaitsFrom)],
		})
	}

	const ready: string[] = []
	const blocked: string[] = []
	for (const [name, dep] of agents) {
		if (dep.isReady) ready.push(name)
		else blocked.push(name)
	}

	return { agents, ready, blocked }
}

function collectDeps(op: Operation, awaitsFrom: string[], stakesTo: string[]): void {
	switch (op.type) {
		case "AwaitOp":
			for (const s of op.sources) {
				if (s.ref !== "*" && s.ref !== "any") awaitsFrom.push(s.ref)
			}
			break
		case "StakeOp":
			for (const r of op.recipients) {
				if (r.ref !== "all" && r.ref !== "out") stakesTo.push(r.ref)
			}
			break
		case "WhenBlock":
			for (const inner of op.body) collectDeps(inner, awaitsFrom, stakesTo)
			if (op.elseBlock) {
				for (const inner of op.elseBlock.body) collectDeps(inner, awaitsFrom, stakesTo)
			}
			break
		case "RepeatBlock":
			for (const inner of op.body) collectDeps(inner, awaitsFrom, stakesTo)
			break
	}
}

export function detectDeadlocks(graph: DepGraph): string[][] {
	const cycles: string[][] = []
	const visited = new Set<string>()

	for (const name of graph.blocked) {
		if (visited.has(name)) continue
		const path: string[] = []
		const inPath = new Set<string>()

		function dfs(current: string): boolean {
			if (inPath.has(current)) {
				const cycleStart = path.indexOf(current)
				cycles.push(path.slice(cycleStart))
				return true
			}
			if (visited.has(current)) return false
			visited.add(current)
			inPath.add(current)
			path.push(current)
			const dep = graph.agents.get(current)
			if (dep) {
				for (const awaited of dep.initialAwaitsFrom) {
					const awaitedDep = graph.agents.get(awaited)
					if (awaitedDep && !awaitedDep.isReady) dfs(awaited)
				}
			}
			path.pop()
			inPath.delete(current)
			return false
		}
		dfs(name)
	}

	return cycles
}

// ─── Extended Static Analysis ───

export interface FlowDiagnostic {
	level: "error" | "warning"
	message: string
}

/** Refs that denote wildcards / external sinks rather than peer agents. */
const NON_PEER_REFS = new Set(["out", "all", "any", "*", "human"])

export function analyzeFlow(flow: FlowDecl): FlowDiagnostic[] {
	const diagnostics: FlowDiagnostic[] = []
	const agentNodes = flow.body.filter((n): n is AgentDecl => n.type === "AgentDecl")
	const agentNames = new Set(agentNodes.map((a) => a.name))

	const hasConverge = flow.body.some((n) => n.type === "ConvergeStmt")
	if (!hasConverge) {
		diagnostics.push({
			level: "warning",
			message: "Flow has no converge statement — will stop only when all agents commit or budget is exceeded",
		})
	}

	const hasBudget = flow.body.some((n) => n.type === "BudgetStmt")
	if (!hasBudget) {
		diagnostics.push({
			level: "warning",
			message: "Flow has no budget statement — default is unlimited (no enforcement)",
		})
	}

	for (const agent of agentNodes) {
		let hasCommit = false

		for (const op of agent.operations) {
			checkOperation(op)
		}

		if (!hasCommit) {
			diagnostics.push({
				level: "warning",
				message: `Agent "${agent.name}" has no commit — it will never signal completion`,
			})
		}

		// Validate declared tool groups: each must be one of the 9 ToolGroup
		// names. Unknown names fail closed at spawn (the agent silently loses
		// those tools), so surface a warning rather than letting a typo quietly
		// over-restrict the agent.
		if (agent.meta.tools && agent.meta.tools.length > 0) {
			for (const group of agent.meta.tools) {
				if (!VALID_TOOL_GROUPS.has(group)) {
					diagnostics.push({
						level: "warning",
						message: `Agent "${agent.name}" declares unknown tool group "${group}" in tools: — valid groups are ${[...VALID_TOOL_GROUPS].join(", ")}. It will be ignored (the agent loses those tools).`,
					})
				}
			}
		}

		// Validate declared peers: every @ref must resolve to a known agent.
		if (agent.meta.peers && agent.meta.peers.length > 0) {
			for (const peerName of agent.meta.peers) {
				const lower = peerName.toLowerCase()
				if (NON_PEER_REFS.has(lower)) {
					diagnostics.push({
						level: "error",
						message: `Agent "${agent.name}" declares wildcard/external sink "@${peerName}" in peers: — only concrete agents are allowed`,
					})
				} else if (!agentNames.has(peerName)) {
					diagnostics.push({
						level: "error",
						message: `Agent "${agent.name}" declares unknown agent "@${peerName}" in peers:`,
					})
				}
			}
		}

		function checkOperation(op: Operation): void {
			if (op.type === "StakeOp") {
				for (const r of op.recipients) {
					if (r.ref !== "out" && r.ref !== "all" && !agentNames.has(r.ref)) {
						diagnostics.push({
							level: "error",
							message: `Agent "${agent.name}" stakes to unknown agent "@${r.ref}"`,
						})
					}
				}
			} else if (op.type === "AwaitOp") {
				for (const s of op.sources) {
					// "*"/"any" are wildcards; "human" is the escalation pseudo-agent
					// (the reply to an `escalate @Human` arrives as mail from @Human).
					if (s.ref !== "*" && s.ref !== "any" && s.ref.toLowerCase() !== "human" && !agentNames.has(s.ref)) {
						diagnostics.push({
							level: "error",
							message: `Agent "${agent.name}" awaits from unknown agent "@${s.ref}"`,
						})
					}
				}
			} else if (op.type === "CommitOp") {
				hasCommit = true
			} else if (op.type === "WhenBlock") {
				for (const inner of op.body) checkOperation(inner)
				if (op.elseBlock) {
					for (const inner of op.elseBlock.body) checkOperation(inner)
				}
			} else if (op.type === "RepeatBlock") {
				for (const inner of op.body) checkOperation(inner)
			}
		}
	}

	// Orphan detection — recurse into when/repeat blocks so awaits and stakes
	// nested in control flow are counted (a top-level-only scan would flag an
	// agent that is only awaited from inside a loop as a false-positive orphan).
	const awaitedAgents = new Set<string>()
	const collectAwaits = (op: Operation): void => {
		if (op.type === "AwaitOp") {
			for (const s of op.sources) {
				if (s.ref !== "*" && s.ref !== "any") awaitedAgents.add(s.ref)
			}
		} else if (op.type === "WhenBlock") {
			for (const inner of op.body) collectAwaits(inner)
			if (op.elseBlock) for (const inner of op.elseBlock.body) collectAwaits(inner)
		} else if (op.type === "RepeatBlock") {
			for (const inner of op.body) collectAwaits(inner)
		}
	}
	for (const agent of agentNodes) {
		for (const op of agent.operations) collectAwaits(op)
	}

	for (const agent of agentNodes) {
		let stakesToAgents = false
		let stakesToOut = false
		const collectStakes = (op: Operation): void => {
			if (op.type === "StakeOp") {
				for (const r of op.recipients) {
					if (r.ref === "out") stakesToOut = true
					else if (r.ref !== "all") stakesToAgents = true
				}
			} else if (op.type === "WhenBlock") {
				for (const inner of op.body) collectStakes(inner)
				if (op.elseBlock) for (const inner of op.elseBlock.body) collectStakes(inner)
			} else if (op.type === "RepeatBlock") {
				for (const inner of op.body) collectStakes(inner)
			}
		}
		for (const op of agent.operations) collectStakes(op)

		if (stakesToAgents && !awaitedAgents.has(agent.name) && !stakesToOut) {
			diagnostics.push({
				level: "warning",
				message: `Agent "${agent.name}" produces output but no agent awaits from it`,
			})
		}
	}

	return diagnostics
}
