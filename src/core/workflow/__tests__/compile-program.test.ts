/**
 * Unit tests for the control-flow compiler (compileAgentProgram) —
 * lowers structured when/repeat to flat jump/branch instructions.
 *
 * Vitest globals (describe/it/expect) are available globally per the Test
 * Layout Rule in AGENTS.md. Naming convention: *.test.ts (Node env).
 */

import { compileAgentProgram } from "../slang-interpreter"
import type { AgentDecl } from "../slang-ast"

// ── Fixture helpers ──

function dummySpan() {
	return { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } }
}

function agent(name: string, ops: AgentDecl["operations"]): AgentDecl {
	return { type: "AgentDecl", name, meta: {}, operations: ops, span: dummySpan() }
}

function stakeOp(name: string): any {
	return {
		type: "StakeOp",
		call: { type: "FuncCall", name, args: [], span: dummySpan() },
		recipients: [{ ref: "out" }],
		span: dummySpan(),
	}
}

function awaitOp(binding: string, sources: string[]): any {
	return {
		type: "AwaitOp",
		binding,
		sources: sources.map((s) => ({ ref: s })),
		options: {},
		span: dummySpan(),
	}
}

function commitOp(): any {
	return { type: "CommitOp", span: dummySpan() }
}

function escalateOp(reason?: string): any {
	return { type: "EscalateOp", target: "Human", reason, span: dummySpan() }
}

function letOp(name: string, value: any): any {
	return { type: "LetOp", name, value, span: dummySpan() }
}

function setOp(name: string, value: any): any {
	return { type: "SetOp", name, value, span: dummySpan() }
}

function whenBlock(condition: any, body: any[], elseBody?: any[]): any {
	const block: any = {
		type: "WhenBlock",
		condition,
		body,
		span: dummySpan(),
	}
	if (elseBody) block.elseBlock = { type: "ElseBlock", body: elseBody, span: dummySpan() }
	return block
}

function repeatBlock(condition: any, body: any[]): any {
	return {
		type: "RepeatBlock",
		condition,
		body,
		span: dummySpan(),
	}
}

function boolExpr(value: boolean): any {
	return { type: "BoolLit", value, span: dummySpan() }
}

// ══════════════════════════════════════════════════════════════════════
// compileAgentProgram
// ══════════════════════════════════════════════════════════════════════

describe("compileAgentProgram", () => {
	it("linear stake→await→commit", () => {
		const a = agent("A", [stakeOp("doWork"), awaitOp("msg", ["B"]), commitOp()])
		const instrs = compileAgentProgram(a)
		expect(instrs.map((i) => i.kind)).toEqual(["stake", "await", "commit"])
	})

	it("let and set instructions", () => {
		const a = agent("A", [
			letOp("x", { type: "NumberLit", value: 5, span: dummySpan() }),
			setOp("x", { type: "StringLit", value: "hello", span: dummySpan() }),
			commitOp(),
		])
		const instrs = compileAgentProgram(a)
		expect(instrs.map((i) => i.kind)).toEqual(["let", "set", "commit"])
	})

	it("escalate", () => {
		const a = agent("A", [escalateOp("Need input"), commitOp()])
		const instrs = compileAgentProgram(a)
		expect(instrs.map((i) => i.kind)).toEqual(["escalate", "commit"])
	})

	it("when without else: branch → body → (no jump) → commit", () => {
		const a = agent("A", [whenBlock(boolExpr(true), [stakeOp("yes")]), commitOp()])
		const instrs = compileAgentProgram(a)

		// branch(C, jumpWhen=false) [0] → skip body to target when false
		// stake (body)              [1]
		// commit                    [2]  (no trailing jump — when w/o else falls through)
		expect(instrs.map((i) => i.kind)).toEqual(["branch", "stake", "commit"])

		if (instrs[0]!.kind === "branch") {
			expect(instrs[0]!.jumpWhen).toBe(false)
			expect(instrs[0]!.target).toBe(2) // past body = commit
		}
	})

	it("when-otherwise: branch → thenBody → jump → elseBody → commit", () => {
		const a = agent("A", [whenBlock(boolExpr(true), [stakeOp("yes")], [stakeOp("no")]), commitOp()])
		const instrs = compileAgentProgram(a)

		// branch(C, false) [0]
		// stake (then)   [1]
		// jump(end)      [2]
		// stake (else)   [3]
		// commit         [4]  ← after else body, jumpEnd.target = instrs.length (4)
		expect(instrs.map((i) => i.kind)).toEqual(["branch", "stake", "jump", "stake", "commit"])

		if (instrs[0]!.kind === "branch") {
			expect(instrs[0]!.target).toBe(3) // start of else block
		}
		if (instrs[2]!.kind === "jump") {
			expect(instrs[2]!.target).toBe(4) // past else body = commit
		}
	})

	it("repeat-until: branch → body → jump(loop)", () => {
		const a = agent("A", [repeatBlock(boolExpr(false), [stakeOp("loop")]), commitOp()])
		const instrs = compileAgentProgram(a)

		// branch(C, jumpWhen=true) [0]  — exit when true
		// stake (body)              [1]
		// jump(loopStart=0)         [2]
		// commit                    [3]
		expect(instrs[0]!.kind).toBe("branch")
		if (instrs[0]!.kind === "branch") {
			expect(instrs[0]!.jumpWhen).toBe(true)
			expect(instrs[0]!.target).toBe(3) // exit target = past body+jump = commit
		}
		expect(instrs[1]!.kind).toBe("stake")
		expect(instrs[2]!.kind).toBe("jump")
		if (instrs[2]!.kind === "jump") {
			expect(instrs[2]!.target).toBe(0) // loop back to branch
		}
		expect(instrs[3]!.kind).toBe("commit")
	})

	it("nested when inside repeat", () => {
		const a = agent("A", [
			repeatBlock(boolExpr(false), [whenBlock(boolExpr(true), [stakeOp("inner")])]),
			commitOp(),
		])
		const instrs = compileAgentProgram(a)
		// branch(repeat) [0]
		// branch(when)   [1]
		// stake(inner)   [2]
		// jump(loop=0)   [3]  (when w/o else has no trailing jump, so only repeat's loop jump)
		// commit         [4]
		expect(instrs.map((i) => i.kind)).toEqual(["branch", "branch", "stake", "jump", "commit"])
	})

	it("empty agent → empty instruction list", () => {
		const a = agent("A", [])
		const instrs = compileAgentProgram(a)
		expect(instrs).toHaveLength(0)
	})

	it("commit with condition → commit instr (condition handled at runtime)", () => {
		const a = agent("A", [
			{
				type: "CommitOp",
				condition: { type: "BoolLit", value: false, span: dummySpan() },
				span: dummySpan(),
			},
		])
		const instrs = compileAgentProgram(a)
		expect(instrs).toHaveLength(1)
		expect(instrs[0]!.kind).toBe("commit")
	})

	it("conditional escalate → escalate instr (condition handled at runtime)", () => {
		const a = agent("A", [
			{
				type: "EscalateOp",
				target: "Human",
				reason: "Approve?",
				condition: { type: "BoolLit", value: false, span: dummySpan() },
				span: dummySpan(),
			},
			commitOp(),
		])
		const instrs = compileAgentProgram(a)
		expect(instrs[0]!.kind).toBe("escalate")
	})
})
