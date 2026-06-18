/**
 * Unit tests for the Slang dependency resolver and static analyzer
 * (src/core/workflow/slang-resolver.ts).
 *
 * These test resolveDeps, detectDeadlocks, and analyzeFlow — all pure
 * functions that take AST nodes and return plain objects. No mocks needed.
 *
 * Vitest globals (describe/it/expect) are available globally per the Test
 * Layout Rule in AGENTS.md. Naming convention: *.test.ts (Node env).
 */

import { resolveDeps, detectDeadlocks, analyzeFlow, type AgentDep, type DepGraph } from "../slang-resolver"
import type { FlowDecl, AgentDecl, Operation } from "../slang-ast"

// ── Fixture helpers ──

function dummySpan() {
	return { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } }
}

function stakeOp(name: string, recipients: string[]): Operation {
	return {
		type: "StakeOp",
		call: { type: "FuncCall", name, args: [], span: dummySpan() },
		recipients: recipients.map((r) => ({ ref: r })),
		span: dummySpan(),
	}
}

function awaitOp(binding: string, sources: string[]): Operation {
	return {
		type: "AwaitOp",
		binding,
		sources: sources.map((s) => ({ ref: s })),
		options: {},
		span: dummySpan(),
	}
}

function commitOp(): Operation {
	return { type: "CommitOp", span: dummySpan() }
}

function escalateOp(reason?: string): Operation {
	return { type: "EscalateOp", target: "Human", reason, span: dummySpan() }
}

function agent(name: string, ops: Operation[], meta?: AgentDecl["meta"]): AgentDecl {
	return {
		type: "AgentDecl",
		name,
		meta: meta ?? {},
		operations: ops,
		span: dummySpan(),
	}
}

function flow(name: string, agents: AgentDecl[], extra?: Array<{ type: string } & Record<string, unknown>>): FlowDecl {
	const body: any[] = [...agents]
	if (extra) body.push(...extra)
	return {
		type: "FlowDecl",
		name,
		body,
		span: dummySpan(),
	}
}

function converge(conditionStr?: string): any {
	return {
		type: "ConvergeStmt",
		condition: conditionStr
			? { type: "Ident", name: conditionStr, span: dummySpan() }
			: { type: "BoolLit", value: true, span: dummySpan() },
		span: dummySpan(),
	}
}

function budget(items: Array<{ kind: string; value: number }>): any {
	return {
		type: "BudgetStmt",
		items: items.map((i) => ({ kind: i.kind, value: { type: "NumberLit", value: i.value, span: dummySpan() } })),
		span: dummySpan(),
	}
}

// ══════════════════════════════════════════════════════════════════════
// resolveDeps
// ══════════════════════════════════════════════════════════════════════

describe("resolveDeps", () => {
	it("linear A→B→C: A starts ready, B and C await first", () => {
		const f = flow("linear", [
			agent("A", [stakeOp("work", ["B"]), commitOp()]),
			agent("B", [awaitOp("msg", ["A"]), stakeOp("forward", ["C"]), commitOp()]),
			agent("C", [awaitOp("msg", ["B"]), commitOp()]),
		])
		const g = resolveDeps(f)
		expect(g.ready).toEqual(["A"])
		expect(g.blocked.sort()).toEqual(["B", "C"].sort())

		const a = g.agents.get("A")!
		expect(a.stakesTo).toEqual(["B"])
		expect(a.awaitsFrom).toEqual([])
		expect(a.initialAwaitsFrom).toEqual([])

		const b = g.agents.get("B")!
		expect(b.stakesTo).toEqual(["C"])
		expect(b.initialAwaitsFrom).toEqual(["A"])

		const c = g.agents.get("C")!
		expect(c.initialAwaitsFrom).toEqual(["B"])
	})

	it("agent starting with stake is ready", () => {
		const f = flow("s", [agent("A", [stakeOp("do", ["B"]), commitOp()])])
		const g = resolveDeps(f)
		expect(g.ready).toEqual(["A"])
		expect(g.blocked).toEqual([])
	})

	it("agent starting with await is blocked", () => {
		const f = flow("s", [agent("A", [awaitOp("msg", ["B"]), commitOp()])])
		const g = resolveDeps(f)
		expect(g.ready).toEqual([])
		expect(g.blocked).toEqual(["A"])
	})

	it("multiple agents, some ready some blocked", () => {
		const f = flow("multi", [
			agent("Architect", [stakeOp("explore", ["Codebase"]), awaitOp("findings", ["Codebase"]), commitOp()]),
			agent("Codebase", [awaitOp("task", ["Architect"]), stakeOp("report", ["Architect"]), commitOp()]),
			agent("Developer", [awaitOp("design", ["Architect"]), stakeOp("implement", ["Reviewer"]), commitOp()]),
		])
		const g = resolveDeps(f)
		expect(g.ready).toEqual(["Architect"])
		expect(g.blocked.sort()).toEqual(["Codebase", "Developer"].sort())
	})

	it("deduplicates awaitsFrom and stakesTo", () => {
		const f = flow("dup", [
			agent("A", [
				stakeOp("a", ["B"]),
				stakeOp("b", ["B"]),
				awaitOp("x", ["C"]),
				awaitOp("y", ["C"]),
				commitOp(),
			]),
		])
		const g = resolveDeps(f)
		const a = g.agents.get("A")!
		expect(a.stakesTo).toEqual(["B"])
		expect(a.awaitsFrom).toEqual(["C"])
	})

	it("wildcard sources/recipients excluded from deps", () => {
		const f = flow("wild", [
			agent("A", [stakeOp("broadcast", ["all"]), stakeOp("output", ["out"]), commitOp()]),
			agent("B", [awaitOp("msg", ["any"]), awaitOp("msg2", ["*"]), commitOp()]),
		])
		const g = resolveDeps(f)
		const a = g.agents.get("A")!
		expect(a.stakesTo).toEqual([])

		const b = g.agents.get("B")!
		expect(b.awaitsFrom).toEqual([])
	})

	it("initialAwaitsFrom only covers consecutive awaits at start", () => {
		const f = flow("partial", [
			agent("A", [
				awaitOp("x", ["B"]),
				awaitOp("y", ["C"]),
				stakeOp("work", ["D"]),
				awaitOp("z", ["E"]),
				commitOp(),
			]),
		])
		const g = resolveDeps(f)
		const a = g.agents.get("A")!
		// initialAwaitsFrom: only B and C (consecutive awaits before first non-await)
		expect(a.initialAwaitsFrom.sort()).toEqual(["B", "C"].sort())
		// awaitsFrom: all unique awaits in the program
		expect(a.awaitsFrom.sort()).toEqual(["B", "C", "E"].sort())
	})

	it("isReady false when first op is await", () => {
		const f = flow("awaitFirst", [agent("A", [awaitOp("msg", ["B"]), stakeOp("reply", ["B"]), commitOp()])])
		const g = resolveDeps(f)
		expect(g.agents.get("A")!.isReady).toBe(false)
	})

	it("isReady true when first op is stake", () => {
		const f = flow("stakeFirst", [agent("A", [stakeOp("go", ["B"]), awaitOp("msg", ["B"]), commitOp()])])
		const g = resolveDeps(f)
		expect(g.agents.get("A")!.isReady).toBe(true)
	})
})

// ══════════════════════════════════════════════════════════════════════
// detectDeadlocks
// ══════════════════════════════════════════════════════════════════════

describe("detectDeadlocks", () => {
	function g(agents: Map<string, AgentDep>, blocked: string[]): DepGraph {
		return { agents, ready: [], blocked }
	}

	it("direct cycle: A awaits B, B awaits A", () => {
		const agents = new Map<string, AgentDep>([
			["A", { name: "A", awaitsFrom: ["B"], stakesTo: [], isReady: false, initialAwaitsFrom: ["B"] }],
			["B", { name: "B", awaitsFrom: ["A"], stakesTo: [], isReady: false, initialAwaitsFrom: ["A"] }],
		])
		const cycles = detectDeadlocks(g(agents, ["A", "B"]))
		expect(cycles.length).toBeGreaterThan(0)
		// Cycle path: [start, ..., repeated] — node before the repeated entry.
		// A awaits B, B awaits A → in path A→B, B's initialAwaitsFrom is A which is inPath.
		// Cycle returned: ["A","B"]. Check for that.
		const flat = cycles.map((c) => c.join("→"))
		expect(flat.some((c) => c === "A→B" || c === "B→A")).toBe(true)
	})

	it("three-node cycle: A→B, B→C, C→A", () => {
		const agents = new Map<string, AgentDep>([
			["A", { name: "A", awaitsFrom: ["B"], stakesTo: [], isReady: false, initialAwaitsFrom: ["B"] }],
			["B", { name: "B", awaitsFrom: ["C"], stakesTo: [], isReady: false, initialAwaitsFrom: ["C"] }],
			["C", { name: "C", awaitsFrom: ["A"], stakesTo: [], isReady: false, initialAwaitsFrom: ["A"] }],
		])
		const cycles = detectDeadlocks(g(agents, ["A", "B", "C"]))
		expect(cycles.length).toBeGreaterThan(0)
	})

	it("no deadlock: A awaits B, B is ready (starts with stake)", () => {
		const agents = new Map<string, AgentDep>([
			["A", { name: "A", awaitsFrom: ["B"], stakesTo: [], isReady: false, initialAwaitsFrom: ["B"] }],
			["B", { name: "B", awaitsFrom: [], stakesTo: ["A"], isReady: true, initialAwaitsFrom: [] }],
		])
		const cycles = detectDeadlocks(g(agents, ["A"]))
		expect(cycles).toHaveLength(0)
	})

	it("no deadlock: A awaits B, but B awaits C (not in blocked list)", () => {
		const agents = new Map<string, AgentDep>([
			["A", { name: "A", awaitsFrom: ["B"], stakesTo: [], isReady: false, initialAwaitsFrom: ["B"] }],
			[
				"B",
				{
					name: "B",
					awaitsFrom: ["C"],
					stakesTo: ["A"],
					isReady: false,
					initialAwaitsFrom: ["C"],
				},
			],
			// C is not in blocked — it's ready
		])
		// Only A is blocked; B is also blocked but only its initialAwaitsFrom=C which is not blocked
		const cycles = detectDeadlocks(g(agents, ["A"]))
		// A's initialAwaitsFrom is B, B is blocked but its initialAwaitsFrom is C which isn't blocked → no cycle
		expect(cycles).toHaveLength(0)
	})

	it("no deadlock: empty graph", () => {
		expect(detectDeadlocks({ agents: new Map(), ready: [], blocked: [] })).toHaveLength(0)
	})
})

// ══════════════════════════════════════════════════════════════════════
// analyzeFlow — warnings
// ══════════════════════════════════════════════════════════════════════

describe("analyzeFlow — warnings", () => {
	it("missing converge → warning", () => {
		const f = flow("no-converge", [agent("A", [stakeOp("work", ["B"]), commitOp()])])
		const diags = analyzeFlow(f)
		expect(diags.some((d) => d.level === "warning" && d.message.includes("no converge"))).toBe(true)
	})

	it("missing budget → warning", () => {
		const f = flow("no-budget", [agent("A", [commitOp()])], [converge()])
		const diags = analyzeFlow(f)
		expect(diags.some((d) => d.level === "warning" && d.message.includes("no budget"))).toBe(true)
	})

	it("agent with no commit → warning", () => {
		const f = flow("no-commit", [agent("A", [stakeOp("work", ["out"])])])
		const diags = analyzeFlow(f)
		expect(diags.some((d) => d.level === "warning" && d.message.includes("no commit"))).toBe(true)
	})

	it("well-formed flow → no warnings or errors", () => {
		const f = flow(
			"good",
			[agent("A", [commitOp()])],
			[
				converge(),
				budget([
					{ kind: "rounds", value: 10 },
					{ kind: "tokens", value: 5000 },
				]),
			],
		)
		const diags = analyzeFlow(f)
		expect(diags).toHaveLength(0)
	})

	it("unknown tools: group → warning", () => {
		const f = flow(
			"bad-tools",
			[agent("A", [commitOp()], { tools: ["read", "bogus_group"] })],
			[converge(), budget([{ kind: "rounds", value: 10 }])],
		)
		const diags = analyzeFlow(f)
		expect(diags.some((d) => d.level === "warning" && d.message.includes('unknown tool group "bogus_group"'))).toBe(
			true,
		)
	})

	it("valid tools: groups → no tool-group warning", () => {
		const f = flow(
			"ok-tools",
			[agent("A", [commitOp()], { tools: ["read", "write", "questions"] })],
			[converge(), budget([{ kind: "rounds", value: 10 }])],
		)
		const diags = analyzeFlow(f)
		expect(diags.some((d) => d.message.includes("unknown tool group"))).toBe(false)
	})

	it("orphan agent: produces output no one awaits → warning", () => {
		const f = flow(
			"orphan",
			[
				agent("A", [stakeOp("work", ["B"]), commitOp()]),
				agent("B", [awaitOp("msg", ["A"]), commitOp()]),
				agent("C", [stakeOp("orphanWork", ["A"]), commitOp()]), // A doesn't await C
			],
			[converge(), budget([{ kind: "rounds", value: 10 }])],
		)
		const diags = analyzeFlow(f)
		expect(
			diags.some(
				(d) => d.level === "warning" && d.message.includes("C") && d.message.includes("no agent awaits"),
			),
		).toBe(true)
	})

	it("agent with stake to @out only → not orphaned", () => {
		const f = flow(
			"to-out",
			[agent("A", [stakeOp("report", ["out"]), commitOp()])],
			[converge(), budget([{ kind: "rounds", value: 10 }])],
		)
		const diags = analyzeFlow(f)
		// No orphan warning for A
		expect(diags.filter((d) => d.message.includes("no agent awaits"))).toHaveLength(0)
	})

	it("nested awaits/stakes in WhenBlock counted for orphan detection", () => {
		const f = flow(
			"nested-when",
			[
				agent("A", [commitOp()]),
				agent("B", [
					{
						type: "WhenBlock",
						condition: { type: "BoolLit", value: true, span: dummySpan() },
						body: [stakeOp("innerWork", ["A"])],
						span: dummySpan(),
					},
					commitOp(),
				]),
			],
			[converge(), budget([{ kind: "rounds", value: 10 }])],
		)
		const diags = analyzeFlow(f)
		// B stakes to A (inside WhenBlock) — A awaits nobody, B awaits nobody.
		// The orphan check is: does B stake to an agent AND nobody awaits from B?
		// B stakes to A, nobody awaits B → B IS orphaned.
		expect(
			diags.some(
				(d) => d.level === "warning" && d.message.includes("B") && d.message.includes("no agent awaits"),
			),
		).toBe(true)
	})

	it("nested awaits/stakes in RepeatBlock counted for orphan detection", () => {
		const f = flow(
			"nested-repeat",
			[
				agent("A", [commitOp()]),
				agent("B", [
					{
						type: "RepeatBlock",
						condition: { type: "BoolLit", value: false, span: dummySpan() },
						body: [stakeOp("loopWork", ["A"])],
						span: dummySpan(),
					},
					commitOp(),
				]),
			],
			[converge(), budget([{ kind: "rounds", value: 10 }])],
		)
		const diags = analyzeFlow(f)
		// B stakes to A (in RepeatBlock), nobody awaits B → B is orphaned.
		expect(
			diags.some(
				(d) => d.level === "warning" && d.message.includes("B") && d.message.includes("no agent awaits"),
			),
		).toBe(true)
	})
})

// ══════════════════════════════════════════════════════════════════════
// analyzeFlow — errors
// ══════════════════════════════════════════════════════════════════════

describe("analyzeFlow — errors", () => {
	it("stake to unknown agent → error", () => {
		const f = flow("bad-stake", [agent("A", [stakeOp("work", ["NoSuchAgent"]), commitOp()])])
		const diags = analyzeFlow(f)
		expect(diags.some((d) => d.level === "error" && d.message.includes("stakes to unknown agent"))).toBe(true)
	})

	it("await from unknown agent → error", () => {
		const f = flow("bad-await", [agent("A", [awaitOp("msg", ["NoSuchAgent"]), commitOp()])])
		const diags = analyzeFlow(f)
		expect(diags.some((d) => d.level === "error" && d.message.includes("awaits from unknown agent"))).toBe(true)
	})

	it("await from @Human → not an error", () => {
		const f = flow("human-await", [agent("A", [awaitOp("msg", ["Human"]), commitOp()])])
		const diags = analyzeFlow(f)
		expect(diags.filter((d) => d.level === "error")).toHaveLength(0)
	})

	it("peers: @out wildcard → error", () => {
		const f = flow("bad-peers", [agent("A", [commitOp()]), agent("B", [commitOp()], { peers: ["out"] })])
		const diags = analyzeFlow(f)
		expect(
			diags.some((d) => d.level === "error" && d.message.includes("peers") && d.message.includes("@out")),
		).toBe(true)
	})

	it("peers: @all wildcard → error", () => {
		const f = flow("bad-peers-all", [agent("A", [commitOp()]), agent("B", [commitOp()], { peers: ["all"] })])
		const diags = analyzeFlow(f)
		expect(
			diags.some((d) => d.level === "error" && d.message.includes("peers") && d.message.includes("@all")),
		).toBe(true)
	})

	it("peers: @any wildcard → error", () => {
		const f = flow("bad-peers-any", [agent("A", [commitOp()]), agent("B", [commitOp()], { peers: ["any"] })])
		const diags = analyzeFlow(f)
		expect(
			diags.some((d) => d.level === "error" && d.message.includes("peers") && d.message.includes("@any")),
		).toBe(true)
	})

	it("peers: @Human → error", () => {
		const f = flow("bad-peers-human", [agent("A", [commitOp()]), agent("B", [commitOp()], { peers: ["Human"] })])
		const diags = analyzeFlow(f)
		expect(
			diags.some((d) => d.level === "error" && d.message.includes("peers") && d.message.includes("@Human")),
		).toBe(true)
	})

	it("peers: unknown agent → error", () => {
		const f = flow("bad-peers-unknown", [
			agent("A", [commitOp()]),
			agent("B", [commitOp()], { peers: ["NonExistent"] }),
		])
		const diags = analyzeFlow(f)
		expect(diags.some((d) => d.level === "error" && d.message.includes("@NonExistent"))).toBe(true)
	})

	it("peers: valid known agent → no error", () => {
		const f = flow("good-peers", [agent("A", [commitOp()]), agent("B", [commitOp()], { peers: ["A"] })])
		const diags = analyzeFlow(f)
		expect(diags.filter((d) => d.level === "error")).toHaveLength(0)
	})
})
