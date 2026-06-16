/**
 * Unit tests for the pure-function Slang interpreter
 * (src/core/workflow/slang-interpreter.ts).
 *
 * These tests exercise the extracted VM — advanceAgent, evalExpr, consumeMail,
 * routeOutput, checkConverge, allAgentsCommitted, committedCount, toBool —
 * with plain data fixtures. No ShoferProvider, Task, or VS Code API mocks
 * are needed.
 *
 * Vitest globals (describe/it/expect) are available globally per the Test
 * Layout Rule in AGENTS.md. Naming convention: *.test.ts (Node env).
 */

import {
	advanceAgent,
	allAgentsCommitted,
	checkConverge,
	committedCount,
	consumeMail,
	evalExpr,
	interpolate,
	formatEmittedValue,
	type AdvanceResult,
	type EmittedMessage,
	type Instr,
	routeOutput,
	toBool,
} from "../slang-interpreter"
import type { AgentState, FlowState, MailboxEntry } from "../slang-types"
import type { Expr, FlowDecl, StakeOp } from "../slang-ast"

// ── Test fixture helpers ──

function freshAgent(name: string, opIndex = 0): AgentState {
	return {
		name,
		taskId: `task-${name}`,
		status: "idle",
		opIndex,
		bindings: new Map(),
		retryCount: 0,
	}
}

function freshFlowState(overrides?: Partial<FlowState>): FlowState {
	return {
		flowName: "test-flow",
		params: {},
		agents: new Map(),
		round: 1,
		tokensUsed: 0,
		status: "running",
		mailbox: [],
		mailboxHistory: [],
		...overrides,
	}
}

function makeFlowDecl(overrides?: Partial<FlowDecl>): FlowDecl {
	return {
		type: "FlowDecl",
		name: "test-flow",
		body: [],
		span: { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } },
		...overrides,
	}
}

function strExpr(value: string): Expr {
	return { type: "StringLit", value, span: dummySpan() }
}

function numExpr(value: number): Expr {
	return { type: "NumberLit", value, span: dummySpan() }
}

function boolExpr(value: boolean): Expr {
	return { type: "BoolLit", value, span: dummySpan() }
}

function identExpr(name: string): Expr {
	return { type: "Ident", name, span: dummySpan() }
}

function agentRef(name: string): Expr {
	return { type: "AgentRef", name, span: dummySpan() }
}

function dotAccess(obj: Expr, property: string): Expr {
	return { type: "DotAccess", object: obj, property, span: dummySpan() }
}

function binExpr(op: string, left: Expr, right: Expr): Expr {
	return { type: "BinaryExpr", op, left, right, span: dummySpan() } as Expr
}

function dummySpan() {
	return { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } }
}

function stakeOp(name: string, args: StakeOp["call"]["args"] = [], recipients: StakeOp["recipients"] = []): StakeOp {
	return {
		type: "StakeOp",
		call: { type: "FuncCall", name, args, span: dummySpan() },
		recipients,
		span: dummySpan(),
	}
}

function commitInstr(condition?: Expr, value?: Expr): Instr {
	return { kind: "commit", op: { type: "CommitOp", condition, value, span: dummySpan() } }
}

function stakeInstr(op: StakeOp): Instr {
	return { kind: "stake", op }
}

function escalateInstr(reason?: string, condition?: Expr): Instr {
	return { kind: "escalate", op: { type: "EscalateOp", target: "Human", reason, condition, span: dummySpan() } }
}

function awaitInstr(binding: string, sources: string[]): Instr {
	return {
		kind: "await",
		op: {
			type: "AwaitOp",
			binding,
			sources: sources.map((s) => ({ ref: s })),
			options: {},
			span: dummySpan(),
		},
	}
}

function letInstr(name: string, value: Expr): Instr {
	return { kind: "let", op: { type: "LetOp", name, value, span: dummySpan() } }
}

function setInstr(name: string, value: Expr): Instr {
	return { kind: "set", op: { type: "SetOp", name, value, span: dummySpan() } }
}

function logInstr(value?: Expr, condition?: Expr): Instr {
	return { kind: "log", op: { type: "LogOp", value, condition, span: dummySpan() } }
}

function errorInstr(value?: Expr, condition?: Expr): Instr {
	return { kind: "error", op: { type: "ErrorOp", value, condition, span: dummySpan() } }
}

function jumpInstr(target: number): Instr {
	return { kind: "jump", target }
}

function branchInstr(cond: Expr, jumpWhen: boolean, target: number): Instr {
	return { kind: "branch", cond, jumpWhen, target }
}

// ══════════════════════════════════════════════════════════════════════
// toBool
// ══════════════════════════════════════════════════════════════════════

describe("toBool", () => {
	it("returns true for non-empty string", () => expect(toBool("hello")).toBe(true))
	it("returns false for empty string", () => expect(toBool("")).toBe(false))
	it("returns true for non-zero number", () => expect(toBool(42)).toBe(true))
	it("returns false for zero", () => expect(toBool(0)).toBe(false))
	it("returns true for true", () => expect(toBool(true)).toBe(true))
	it("returns false for false", () => expect(toBool(false)).toBe(false))
	it("returns true for non-null object", () => expect(toBool({})).toBe(true))
	it("returns false for null", () => expect(toBool(null)).toBe(false))
	it("returns false for undefined", () => expect(toBool(undefined)).toBe(false))
})

// ══════════════════════════════════════════════════════════════════════
// evalExpr — literals
// ══════════════════════════════════════════════════════════════════════

describe("evalExpr — literals", () => {
	const state = freshAgent("A")
	const fs = freshFlowState()

	it("evaluates StringLit", () => expect(evalExpr(strExpr("abc"), state, fs)).toBe("abc"))
	it("evaluates NumberLit", () => expect(evalExpr(numExpr(42), state, fs)).toBe(42))
	it("evaluates BoolLit true", () => expect(evalExpr(boolExpr(true), state, fs)).toBe(true))
	it("evaluates BoolLit false", () => expect(evalExpr(boolExpr(false), state, fs)).toBe(false))
})

describe("string interpolation", () => {
	it("substitutes flow params and bound values, incl. dot-access", () => {
		const state = freshAgent("A")
		state.bindings.set("answers", { region: "us" })
		const fs = freshFlowState({ params: { design_dir: "plans", design_filename: "feature-design.md" } })
		expect(interpolate("Write to ${design_dir}/${design_filename}", state, fs)).toBe(
			"Write to plans/feature-design.md",
		)
		expect(interpolate("Region: ${answers.region}", state, fs)).toBe("Region: us")
		// number/builtin coercion
		expect(interpolate("round ${round}", state, freshFlowState({ round: 3 }))).toBe("round 3")
	})

	it("leaves unresolved placeholders verbatim and is a no-op for plain strings", () => {
		const state = freshAgent("A")
		const fs = freshFlowState()
		expect(interpolate("hello, no braces", state, fs)).toBe("hello, no braces")
		expect(interpolate("missing ${nope}", state, fs)).toBe("missing ${nope}")
	})

	it("flows through StringLit evaluation (stake args interpolate)", () => {
		const fs = freshFlowState({ params: { design_filename: "x.md" } })
		expect(evalExpr(strExpr("file=${design_filename}"), freshAgent("A"), fs)).toBe("file=x.md")
	})
})

// ══════════════════════════════════════════════════════════════════════
// evalExpr — Ident / bindings / params / builtins
// ══════════════════════════════════════════════════════════════════════

describe("evalExpr — Ident resolution", () => {
	it("resolves from agent bindings", () => {
		const state = freshAgent("A")
		state.bindings.set("x", 10)
		expect(evalExpr(identExpr("x"), state, freshFlowState())).toBe(10)
	})

	it("falls back to flow params", () => {
		const fs = freshFlowState({ params: { feature: "login" } })
		expect(evalExpr(identExpr("feature"), freshAgent("A"), fs)).toBe("login")
	})

	it("bindings take priority over flow params", () => {
		const state = freshAgent("A")
		state.bindings.set("feature", "from-binding")
		const fs = freshFlowState({ params: { feature: "from-param" } })
		expect(evalExpr(identExpr("feature"), state, fs)).toBe("from-binding")
	})

	it("built-in: all_committed (none committed)", () => {
		const fs = freshFlowState()
		expect(evalExpr(identExpr("all_committed"), freshAgent("A"), fs)).toBe(true) // empty map → all committed (vacuously true)
	})

	it("built-in: all_committed (one running)", () => {
		const fs = freshFlowState()
		fs.agents.set("A", { ...freshAgent("A"), status: "committed" })
		fs.agents.set("B", { ...freshAgent("B"), status: "running" })
		expect(evalExpr(identExpr("all_committed"), freshAgent("A"), fs)).toBe(false)
	})

	it("built-in: committed_count", () => {
		const fs = freshFlowState()
		fs.agents.set("A", { ...freshAgent("A"), status: "committed" })
		fs.agents.set("B", { ...freshAgent("B"), status: "running" })
		fs.agents.set("C", { ...freshAgent("C"), status: "committed" })
		expect(evalExpr(identExpr("committed_count"), freshAgent("A"), fs)).toBe(2)
	})

	it("built-in: round", () => {
		const fs = freshFlowState({ round: 7 })
		expect(evalExpr(identExpr("round"), freshAgent("A"), fs)).toBe(7)
	})

	it("unknown Ident returns undefined", () => {
		expect(evalExpr(identExpr("nonexistent"), freshAgent("A"), freshFlowState())).toBeUndefined()
	})
})

// ══════════════════════════════════════════════════════════════════════
// evalExpr — DotAccess on AgentRef
// ══════════════════════════════════════════════════════════════════════

describe("evalExpr — DotAccess on AgentRef", () => {
	it("@AgentRef.committed — true when committed", () => {
		const fs = freshFlowState()
		fs.agents.set("B", { ...freshAgent("B"), status: "committed" })
		expect(evalExpr(dotAccess(agentRef("B"), "committed"), freshAgent("A"), fs)).toBe(true)
	})

	it("@AgentRef.committed — false when not committed", () => {
		const fs = freshFlowState()
		fs.agents.set("B", { ...freshAgent("B"), status: "running" })
		expect(evalExpr(dotAccess(agentRef("B"), "committed"), freshAgent("A"), fs)).toBe(false)
	})

	it("@AgentRef.status — returns status string", () => {
		const fs = freshFlowState()
		fs.agents.set("B", { ...freshAgent("B"), status: "blocked" })
		expect(evalExpr(dotAccess(agentRef("B"), "status"), freshAgent("A"), fs)).toBe("blocked")
	})

	it("@AgentRef.output — returns agent output", () => {
		const fs = freshFlowState()
		fs.agents.set("B", { ...freshAgent("B"), output: { approved: true } })
		expect(evalExpr(dotAccess(agentRef("B"), "output"), freshAgent("A"), fs)).toEqual({ approved: true })
	})

	it("@AgentRef with unknown property returns undefined", () => {
		const fs = freshFlowState()
		fs.agents.set("B", freshAgent("B"))
		expect(evalExpr(dotAccess(agentRef("B"), "unknownProp"), freshAgent("A"), fs)).toBeUndefined()
	})

	it("@AgentRef for missing agent returns undefined", () => {
		expect(evalExpr(dotAccess(agentRef("Missing"), "committed"), freshAgent("A"), freshFlowState())).toBeUndefined()
	})
})

// ══════════════════════════════════════════════════════════════════════
// evalExpr — DotAccess on object values
// ══════════════════════════════════════════════════════════════════════

describe("evalExpr — DotAccess on evaluated objects", () => {
	it("accesses property on an evaluated object", () => {
		const state = freshAgent("A")
		state.bindings.set("result", { approved: true, issues: "none" })
		expect(evalExpr(dotAccess(identExpr("result"), "approved"), state, freshFlowState())).toBe(true)
		expect(evalExpr(dotAccess(identExpr("result"), "issues"), state, freshFlowState())).toBe("none")
	})

	it("returns undefined for non-object base", () => {
		const state = freshAgent("A")
		state.bindings.set("x", "string-value")
		expect(evalExpr(dotAccess(identExpr("x"), "anything"), state, freshFlowState())).toBeUndefined()
	})
})

// ══════════════════════════════════════════════════════════════════════
// evalExpr — BinaryExpr
// ══════════════════════════════════════════════════════════════════════

describe("evalExpr — BinaryExpr", () => {
	const state = freshAgent("A")
	const fs = freshFlowState()

	it("== equality (true)", () => expect(evalExpr(binExpr("==", numExpr(5), numExpr(5)), state, fs)).toBe(true))
	it("== equality (false)", () => expect(evalExpr(binExpr("==", numExpr(5), numExpr(3)), state, fs)).toBe(false))
	it("!= inequality", () => expect(evalExpr(binExpr("!=", numExpr(5), numExpr(3)), state, fs)).toBe(true))
	it("> greater than", () => expect(evalExpr(binExpr(">", numExpr(5), numExpr(3)), state, fs)).toBe(true))
	it(">= greater or equal", () => expect(evalExpr(binExpr(">=", numExpr(5), numExpr(5)), state, fs)).toBe(true))
	it("< less than", () => expect(evalExpr(binExpr("<", numExpr(3), numExpr(5)), state, fs)).toBe(true))
	it("<= less or equal", () => expect(evalExpr(binExpr("<=", numExpr(5), numExpr(5)), state, fs)).toBe(true))
	it("&& both true", () => expect(evalExpr(binExpr("&&", boolExpr(true), boolExpr(true)), state, fs)).toBe(true))
	it("&& one false", () => expect(evalExpr(binExpr("&&", boolExpr(true), boolExpr(false)), state, fs)).toBe(false))
	it("|| one true", () => expect(evalExpr(binExpr("||", boolExpr(false), boolExpr(true)), state, fs)).toBe(true))
	it("|| both false", () => expect(evalExpr(binExpr("||", boolExpr(false), boolExpr(false)), state, fs)).toBe(false))
	it("contains — string match", () =>
		expect(evalExpr(binExpr("contains", strExpr("hello world"), strExpr("world")), state, fs)).toBe(true))
	it("contains — string no match", () =>
		expect(evalExpr(binExpr("contains", strExpr("hello world"), strExpr("xyz")), state, fs)).toBe(false))
	it("contains — array match", () =>
		expect(
			evalExpr(
				{
					type: "BinaryExpr",
					op: "contains",
					left: { type: "ListLit", elements: [strExpr("a"), strExpr("b")], span: dummySpan() },
					right: strExpr("a"),
					span: dummySpan(),
				},
				state,
				fs,
			),
		).toBe(true))
	it("contains — array no match", () =>
		expect(
			evalExpr(
				{
					type: "BinaryExpr",
					op: "contains",
					left: { type: "ListLit", elements: [strExpr("a"), strExpr("b")], span: dummySpan() },
					right: strExpr("c"),
					span: dummySpan(),
				},
				state,
				fs,
			),
		).toBe(false))
})

// ══════════════════════════════════════════════════════════════════════
// consumeMail
// ══════════════════════════════════════════════════════════════════════

describe("consumeMail", () => {
	it("returns the first matching entry by recipient and source", () => {
		const mailbox: MailboxEntry[] = [
			{ from: "A", to: "B", value: "msg1", timestamp: 1 },
			{ from: "C", to: "B", value: "msg2", timestamp: 2 },
		]
		const entry = consumeMail(mailbox, "B", ["A"])
		expect(entry).toBeDefined()
		expect(entry!.value).toBe("msg1")
		expect(mailbox).toHaveLength(1)
	})

	it("matches with 'any' wildcard source", () => {
		const mailbox: MailboxEntry[] = [{ from: "X", to: "B", value: "msg", timestamp: 1 }]
		const entry = consumeMail(mailbox, "B", ["any"])
		expect(entry).toBeDefined()
		expect(entry!.value).toBe("msg")
	})

	it("matches with '*' wildcard source", () => {
		const mailbox: MailboxEntry[] = [{ from: "X", to: "B", value: "msg", timestamp: 1 }]
		const entry = consumeMail(mailbox, "B", ["*"])
		expect(entry).toBeDefined()
	})

	it("returns undefined when no match", () => {
		const mailbox: MailboxEntry[] = [{ from: "X", to: "B", value: "msg", timestamp: 1 }]
		const entry = consumeMail(mailbox, "B", ["A"])
		expect(entry).toBeUndefined()
		expect(mailbox).toHaveLength(1)
	})

	it("returns undefined when mailbox is empty", () => {
		expect(consumeMail([], "A", ["B"])).toBeUndefined()
	})

	it("consumes the first match when multiple entries match", () => {
		const mailbox: MailboxEntry[] = [
			{ from: "A", to: "B", value: "first", timestamp: 1 },
			{ from: "A", to: "B", value: "second", timestamp: 2 },
		]
		const entry = consumeMail(mailbox, "B", ["A"])
		expect(entry!.value).toBe("first")
		expect(mailbox).toHaveLength(1)
		expect(mailbox[0]!.value).toBe("second")
	})
})

// ══════════════════════════════════════════════════════════════════════
// routeOutput
// ══════════════════════════════════════════════════════════════════════

describe("routeOutput", () => {
	it("routes to a specific agent", () => {
		const mailbox: MailboxEntry[] = []
		const agents = new Map<string, AgentState>([
			["B", freshAgent("B")],
			["C", freshAgent("C")],
		])
		routeOutput(mailbox, agents, "A", stakeOp("work", [], [{ ref: "B" }]), { result: "ok" })
		expect(mailbox).toHaveLength(1)
		expect(mailbox[0]!.to).toBe("B")
		expect(mailbox[0]!.from).toBe("A")
		expect(mailbox[0]!.value).toEqual({ result: "ok" })
		expect(mailbox[0]!.funcName).toBe("work")
	})

	it("routes to @out", () => {
		const mailbox: MailboxEntry[] = []
		routeOutput(mailbox, new Map(), "A", stakeOp("done", [], [{ ref: "out" }]), "finished")
		expect(mailbox).toHaveLength(1)
		expect(mailbox[0]!.to).toBe("out")
	})

	it("routes to @all (excluding sender)", () => {
		const mailbox: MailboxEntry[] = []
		const agents = new Map<string, AgentState>([
			["A", freshAgent("A")],
			["B", freshAgent("B")],
			["C", freshAgent("C")],
		])
		routeOutput(mailbox, agents, "A", stakeOp("broadcast", [], [{ ref: "all" }]), "hi")
		expect(mailbox).toHaveLength(2)
		expect(mailbox.map((m) => m.to).sort()).toEqual(["B", "C"])
	})

	it("routes to multiple specific agents", () => {
		const mailbox: MailboxEntry[] = []
		const agents = new Map<string, AgentState>([
			["B", freshAgent("B")],
			["C", freshAgent("C")],
		])
		routeOutput(mailbox, agents, "A", stakeOp("multi", [], [{ ref: "B" }, { ref: "C" }]), "data")
		expect(mailbox).toHaveLength(2)
		expect(mailbox.map((m) => m.to).sort()).toEqual(["B", "C"])
	})

	it("preserves metadata (timestamp, funcName)", () => {
		const mailbox: MailboxEntry[] = []
		const before = Date.now()
		routeOutput(mailbox, new Map(), "A", stakeOp("myFunc", [], [{ ref: "B" }]), "v")
		expect(mailbox[0]!.timestamp).toBeGreaterThanOrEqual(before)
		expect(mailbox[0]!.funcName).toBe("myFunc")
	})
})

// ══════════════════════════════════════════════════════════════════════
// allAgentsCommitted / committedCount
// ══════════════════════════════════════════════════════════════════════

describe("allAgentsCommitted", () => {
	it("returns true for empty map", () => {
		expect(allAgentsCommitted(new Map())).toBe(true)
	})

	it("returns true when all agents committed", () => {
		const agents = new Map<string, AgentState>([
			["A", { ...freshAgent("A"), status: "committed" }],
			["B", { ...freshAgent("B"), status: "committed" }],
		])
		expect(allAgentsCommitted(agents)).toBe(true)
	})

	it("returns false when any agent is not committed", () => {
		const agents = new Map<string, AgentState>([
			["A", { ...freshAgent("A"), status: "committed" }],
			["B", { ...freshAgent("B"), status: "running" }],
		])
		expect(allAgentsCommitted(agents)).toBe(false)
	})
})

describe("committedCount", () => {
	it("returns 0 for empty map", () => {
		expect(committedCount(new Map())).toBe(0)
	})

	it("counts committed agents", () => {
		const agents = new Map<string, AgentState>([
			["A", { ...freshAgent("A"), status: "committed" }],
			["B", { ...freshAgent("B"), status: "running" }],
			["C", { ...freshAgent("C"), status: "committed" }],
			["D", { ...freshAgent("D"), status: "blocked" }],
		])
		expect(committedCount(agents)).toBe(2)
	})
})

// ══════════════════════════════════════════════════════════════════════
// checkConverge
// ══════════════════════════════════════════════════════════════════════

describe("checkConverge", () => {
	it("returns true when converge condition (@A.committed) is met", () => {
		const flowDecl = makeFlowDecl({
			body: [
				{
					type: "ConvergeStmt",
					condition: dotAccess(agentRef("Architect"), "committed"),
					span: dummySpan(),
				},
			],
		})
		const fs = freshFlowState()
		fs.agents.set("Architect", { ...freshAgent("Architect"), status: "committed" })
		expect(checkConverge(flowDecl, fs)).toBe(true)
	})

	it("returns false when converge condition (@A.committed) is not met", () => {
		const flowDecl = makeFlowDecl({
			body: [
				{
					type: "ConvergeStmt",
					condition: dotAccess(agentRef("Architect"), "committed"),
					span: dummySpan(),
				},
			],
		})
		const fs = freshFlowState()
		fs.agents.set("Architect", { ...freshAgent("Architect"), status: "running" })
		expect(checkConverge(flowDecl, fs)).toBe(false)
	})

	it("falls back to allAgentsCommitted when no converge statement", () => {
		const flowDecl = makeFlowDecl({ body: [] })
		const fs = freshFlowState()
		// empty → all committed (vacuously true)
		expect(checkConverge(flowDecl, fs)).toBe(true)

		fs.agents.set("A", { ...freshAgent("A"), status: "running" })
		expect(checkConverge(flowDecl, fs)).toBe(false)
	})
})

// ══════════════════════════════════════════════════════════════════════
// advanceAgent
// ══════════════════════════════════════════════════════════════════════

describe("advanceAgent", () => {
	it("empty program → returns end", () => {
		const state = freshAgent("A")
		const result = advanceAgent([], state, [], freshFlowState())
		expect(result.type).toBe("end")
	})

	it("let instruction: sets binding and advances opIndex", () => {
		const state = freshAgent("A")
		const program: Instr[] = [letInstr("x", numExpr(42)), commitInstr()]
		const result = advanceAgent(program, state, [], freshFlowState())
		expect(state.bindings.get("x")).toBe(42)
		expect(result.type).toBe("committed")
	})

	it("set instruction: updates existing binding", () => {
		const state = freshAgent("A")
		state.bindings.set("x", 10)
		const program: Instr[] = [setInstr("x", numExpr(99)), commitInstr()]
		advanceAgent(program, state, [], freshFlowState())
		expect(state.bindings.get("x")).toBe(99)
	})

	it("jump instruction: jumps to target", () => {
		const state = freshAgent("A")
		// jump(2) → skip let x=5 → commit
		const program: Instr[] = [jumpInstr(2), letInstr("x", numExpr(5)), commitInstr()]
		const result = advanceAgent(program, state, [], freshFlowState())
		expect(state.bindings.has("x")).toBe(false) // skipped
		expect(result.type).toBe("committed")
	})

	it("branch: condition true + jumpWhen=true → jumps", () => {
		const state = freshAgent("A")
		// branch(true, jumpWhen=true) → jump to target 2 → commit
		const program: Instr[] = [branchInstr(boolExpr(true), true, 2), letInstr("x", numExpr(1)), commitInstr()]
		const result = advanceAgent(program, state, [], freshFlowState())
		expect(state.bindings.has("x")).toBe(false)
		expect(result.type).toBe("committed")
	})

	it("branch: condition true + jumpWhen=false → falls through", () => {
		const state = freshAgent("A")
		// branch(true, jumpWhen=false) → fall through to let → commit
		const program: Instr[] = [branchInstr(boolExpr(true), false, 2), letInstr("x", numExpr(1)), commitInstr()]
		const result = advanceAgent(program, state, [], freshFlowState())
		expect(state.bindings.get("x")).toBe(1)
		expect(result.type).toBe("committed")
	})

	it("branch: condition false + jumpWhen=true → falls through", () => {
		const state = freshAgent("A")
		// branch(false, jumpWhen=true) → fall through
		const program: Instr[] = [branchInstr(boolExpr(false), true, 2), letInstr("x", numExpr(1)), commitInstr()]
		const result = advanceAgent(program, state, [], freshFlowState())
		expect(state.bindings.get("x")).toBe(1)
		expect(result.type).toBe("committed")
	})

	it("branch: condition false + jumpWhen=false → jumps", () => {
		const state = freshAgent("A")
		// branch(false, jumpWhen=false) → jump to target 2 → commit
		const program: Instr[] = [branchInstr(boolExpr(false), false, 2), letInstr("x", numExpr(1)), commitInstr()]
		const result = advanceAgent(program, state, [], freshFlowState())
		expect(state.bindings.has("x")).toBe(false)
		expect(result.type).toBe("committed")
	})

	it("commit (no condition) → returns committed", () => {
		const state = freshAgent("A")
		const result = advanceAgent([commitInstr()], state, [], freshFlowState())
		expect(result.type).toBe("committed")
		expect(state.status).toBe("committed")
	})

	it("commit with value → stores output", () => {
		const state = freshAgent("A")
		const result = advanceAgent(
			[{ kind: "commit", op: { type: "CommitOp", value: strExpr("done"), span: dummySpan() } }],
			state,
			[],
			freshFlowState(),
		)
		expect(result.type).toBe("committed")
		expect(state.output).toBe("done")
	})

	it("conditional commit — condition true → commits", () => {
		const state = freshAgent("A")
		state.bindings.set("ready", true)
		const result = advanceAgent([commitInstr(identExpr("ready"))], state, [], freshFlowState())
		expect(result.type).toBe("committed")
	})

	it("conditional commit — condition false → skips, continues", () => {
		const state = freshAgent("A")
		state.bindings.set("ready", false)
		// commit(when: ready) → skip → fall off end
		const result = advanceAgent([commitInstr(identExpr("ready"))], state, [], freshFlowState())
		expect(result.type).toBe("end")
		expect(state.status).toBe("idle") // not committed
	})

	it("stake → returns { type: 'stake', op }", () => {
		const state = freshAgent("A")
		const sop = stakeOp("doWork", [], [{ ref: "B" }])
		const result = advanceAgent([stakeInstr(sop)], state, [], freshFlowState())
		expect(result.type).toBe("stake")
		if (result.type === "stake") {
			expect(result.op.call.name).toBe("doWork")
			expect(result.op.recipients[0]!.ref).toBe("B")
		}
	})

	it("escalate (no condition) → returns { type: 'escalate', op }", () => {
		const state = freshAgent("A")
		const result = advanceAgent([escalateInstr("Need approval")], state, [], freshFlowState())
		expect(result.type).toBe("escalate")
		if (result.type === "escalate") {
			expect(result.op.reason).toBe("Need approval")
		}
	})

	it("conditional escalate — condition false → skips", () => {
		const state = freshAgent("A")
		state.bindings.set("needsApproval", false)
		const result = advanceAgent(
			[escalateInstr("Need approval", identExpr("needsApproval")), commitInstr()],
			state,
			[],
			freshFlowState(),
		)
		expect(result.type).toBe("committed") // skipped escalation, hit commit
	})

	it("conditional escalate — condition true → escalates", () => {
		const state = freshAgent("A")
		state.bindings.set("needsApproval", true)
		const result = advanceAgent(
			[escalateInstr("Need approval", identExpr("needsApproval"))],
			state,
			[],
			freshFlowState(),
		)
		expect(result.type).toBe("escalate")
	})

	it("await — mailbox has entry → satisfied, advances", () => {
		const state = freshAgent("A")
		const mailbox: MailboxEntry[] = [{ from: "B", to: "A", value: "result", timestamp: 1 }]
		const result = advanceAgent([awaitInstr("msg", ["B"]), commitInstr()], state, mailbox, freshFlowState())
		expect(state.bindings.get("msg")).toBe("result")
		expect(result.type).toBe("committed")
		expect(mailbox).toHaveLength(0) // consumed
	})

	it("await — mailbox empty → returns { type: 'await' }", () => {
		const state = freshAgent("A")
		const result = advanceAgent([awaitInstr("msg", ["B"])], state, [], freshFlowState())
		expect(result.type).toBe("await")
		expect(state.waitingFor).toBe("B")
	})

	it("await — mailbox entry from different sender → no match, blocks", () => {
		const state = freshAgent("A")
		const mailbox: MailboxEntry[] = [{ from: "C", to: "A", value: "wrong", timestamp: 1 }]
		const result = advanceAgent([awaitInstr("msg", ["B"])], state, mailbox, freshFlowState())
		expect(result.type).toBe("await")
		expect(mailbox).toHaveLength(1) // not consumed
	})

	it("exceed MAX_CONTROL_FLOW_STEPS → status=error, returns end", () => {
		const state = freshAgent("A")
		// infinite loop: jump(0) → jump to self forever
		const program: Instr[] = [jumpInstr(0)]
		const result = advanceAgent(program, state, [], freshFlowState())
		expect(result.type).toBe("end")
		expect(state.status).toBe("error")
	})

	it("let → set → let → commit: multiple non-blocking before commit", () => {
		const state = freshAgent("A")
		const program: Instr[] = [
			letInstr("a", numExpr(1)),
			setInstr("a", numExpr(2)),
			letInstr("b", numExpr(3)),
			commitInstr(),
		]
		const result = advanceAgent(program, state, [], freshFlowState())
		expect(state.bindings.get("a")).toBe(2)
		expect(state.bindings.get("b")).toBe(3)
		expect(result.type).toBe("committed")
	})
})

// ══════════════════════════════════════════════════════════════════════
// advanceAgent — log / error / commit emitted messages
// ══════════════════════════════════════════════════════════════════════

describe("formatEmittedValue", () => {
	it("returns strings verbatim", () => expect(formatEmittedValue("hi")).toBe("hi"))
	it("JSON-encodes objects", () => expect(formatEmittedValue({ a: 1 })).toBe('{"a":1}'))
	it("stringifies numbers/booleans", () => {
		expect(formatEmittedValue(42)).toBe("42")
		expect(formatEmittedValue(true)).toBe("true")
	})
	it("maps null/undefined to empty string", () => {
		expect(formatEmittedValue(null)).toBe("")
		expect(formatEmittedValue(undefined)).toBe("")
	})
})

describe("advanceAgent — emitted messages", () => {
	it("log: pushes a message, advances, and continues to the next op", () => {
		const state = freshAgent("A")
		const emitted: EmittedMessage[] = []
		const result = advanceAgent(
			[logInstr(strExpr("hello")), commitInstr()],
			state,
			[],
			freshFlowState(),
			undefined,
			emitted,
		)
		expect(result.type).toBe("committed")
		expect(emitted).toEqual([{ kind: "log", message: "hello" }])
	})

	it("log: skipped when its `if` guard is false", () => {
		const state = freshAgent("A")
		state.bindings.set("verbose", false)
		const emitted: EmittedMessage[] = []
		const result = advanceAgent(
			[logInstr(strExpr("noisy"), identExpr("verbose")), commitInstr()],
			state,
			[],
			freshFlowState(),
			undefined,
			emitted,
		)
		expect(result.type).toBe("committed")
		expect(emitted).toHaveLength(0)
	})

	it("error: emits a message and returns { type: 'error' }, marking the agent error", () => {
		const state = freshAgent("A")
		const emitted: EmittedMessage[] = []
		const result = advanceAgent(
			[errorInstr(strExpr("boom")), commitInstr()],
			state,
			[],
			freshFlowState(),
			undefined,
			emitted,
		)
		expect(result.type).toBe("error")
		expect(state.status).toBe("error")
		expect(state.opIndex).toBe(1) // advanced past the error op
		expect(emitted).toEqual([{ kind: "error", message: "boom" }])
	})

	it("error: skipped when its `if` guard is false → falls through", () => {
		const state = freshAgent("A")
		state.bindings.set("fail", false)
		const emitted: EmittedMessage[] = []
		const result = advanceAgent(
			[errorInstr(strExpr("boom"), identExpr("fail")), commitInstr()],
			state,
			[],
			freshFlowState(),
			undefined,
			emitted,
		)
		expect(result.type).toBe("committed")
		expect(emitted).toHaveLength(0)
	})

	it("commit with value: emits a commit message and stores output", () => {
		const state = freshAgent("A")
		const emitted: EmittedMessage[] = []
		const result = advanceAgent(
			[{ kind: "commit", op: { type: "CommitOp", value: strExpr("all done"), span: dummySpan() } }],
			state,
			[],
			freshFlowState(),
			undefined,
			emitted,
		)
		expect(result.type).toBe("committed")
		expect(state.output).toBe("all done")
		expect(emitted).toEqual([{ kind: "commit", message: "all done" }])
	})

	it("commit without value: emits nothing", () => {
		const state = freshAgent("A")
		const emitted: EmittedMessage[] = []
		advanceAgent([commitInstr()], state, [], freshFlowState(), undefined, emitted)
		expect(emitted).toHaveLength(0)
	})
})
