/**
 * Unit tests for the Slang parser.
 *
 * These assert against the canonical upstream AST produced by `parseSlang`
 * (a `Program` of `FlowDecl`s whose `body` holds `AgentDecl`s and
 * converge/budget statements, with each agent's `operations` being the
 * discriminated `Operation` union). See slang-ast.ts.
 *
 * Vitest globals (describe/it/expect) are available globally per the Test
 * Layout Rule in AGENTS.md. Naming convention: *.test.ts (Node env).
 */

import { parseSlang, validateSlangAST } from "../slang-parser"
import type { AgentDecl, BudgetStmt, ConvergeStmt, FlowDecl } from "../slang-ast"

// ── Test helpers ──

/** Extract the agent declarations from a flow body. */
function agentsOf(flow: FlowDecl): AgentDecl[] {
	return flow.body.filter((n): n is AgentDecl => n.type === "AgentDecl")
}

/** Extract budget values (rounds / tokens) from a flow body. */
function budgetOf(flow: FlowDecl): { rounds?: number; tokens?: number } {
	const stmt = flow.body.find((n): n is BudgetStmt => n.type === "BudgetStmt")
	const out: { rounds?: number; tokens?: number } = {}
	if (!stmt) return out
	for (const item of stmt.items) {
		const value = item.value.type === "NumberLit" ? item.value.value : undefined
		if (item.kind === "rounds") out.rounds = value
		else if (item.kind === "tokens") out.tokens = value
	}
	return out
}

/** Extract the converge condition statement from a flow body. */
function convergeOf(flow: FlowDecl): ConvergeStmt | undefined {
	return flow.body.find((n): n is ConvergeStmt => n.type === "ConvergeStmt")
}

// ── Minimal valid slang ──

const MINIMAL_SLANG = `
flow "test-flow" (input: "string") {
  agent TestAgent {
    mode: "code"
    role: "Test role"

    stake do_work(task: "Do something", feature: input) -> @out
      output: { result: "string", approved: "boolean" }

    await response <- @out

    commit
  }

  converge when: @TestAgent.committed
  budget: rounds(10), tokens(50000)
}
`

// ── Multi-agent slang (genuinely deadlock-free: helpers stake back) ──

const MULTI_AGENT_SLANG = `
flow "multi-agent" () {
  agent Architect {
    mode: "orchestrator"
    role: "Senior architect"

    stake explore() -> @Codebase

    await findings <- @Codebase

    stake implement(design: findings) -> @Developer

    await result <- @Developer

    commit
  }

  agent Codebase {
    mode: "search"
    role: "Explorer"

    await task <- @Architect

    stake report() -> @Architect

    commit
  }

  agent Developer {
    mode: "code"
    role: "Developer"

    await design <- @Architect

    stake submit() -> @Architect

    commit
  }

  converge when: @Architect.committed
  budget: rounds(20), tokens(100000)
}
`

// ── Escalate ──

const ESCALATE_SLANG = `
flow "escalate-test" () {
  agent AskUser {
    mode: "code"
    role: "Asks user"

    escalate @Human reason: "Please approve this"
    await response <- @Human

    commit
  }
}
`

describe("parseSlang", () => {
	it("parses a minimal valid slang file without errors", () => {
		const { ast, errors } = parseSlang(MINIMAL_SLANG)
		expect(errors).toHaveLength(0)
		expect(ast.flows).toHaveLength(1)

		const flow = ast.flows[0]!
		expect(flow.name).toBe("test-flow")
		expect(flow.params).toHaveLength(1)
		expect(flow.params![0]!.name).toBe("input")
		expect(flow.params![0]!.paramType).toBe("string")

		const agents = agentsOf(flow)
		expect(agents).toHaveLength(1)
		expect(agents[0]!.name).toBe("TestAgent")
		expect((agents[0]!.meta as { mode?: string }).mode).toBe("code")
		expect(agents[0]!.meta.role).toBe("Test role")

		// Constraints
		const converge = convergeOf(flow)
		expect(converge).toBeDefined()
		expect(converge!.condition.type).toBe("DotAccess")
		expect(budgetOf(flow).rounds).toBe(10)
		expect(budgetOf(flow).tokens).toBe(50000)
	})

	it("parses agent operations correctly", () => {
		const { ast, errors } = parseSlang(MINIMAL_SLANG)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations

		// First op: stake do_work -> @out with output schema
		expect(ops[0]!.type).toBe("StakeOp")
		const stakeOp = ops[0]!
		if (stakeOp.type === "StakeOp") {
			expect(stakeOp.call.name).toBe("do_work")
			expect(stakeOp.recipients.map((r) => r.ref)).toEqual(["out"])
			expect(stakeOp.output?.fields.map((f) => f.name)).toEqual(["result", "approved"])
			expect(stakeOp.output?.fields.map((f) => f.fieldType)).toEqual(["string", "boolean"])
			expect(stakeOp.call.args.map((a) => a.name)).toEqual(["task", "feature"])
		}

		// Second op: await
		expect(ops[1]!.type).toBe("AwaitOp")
		if (ops[1]!.type === "AwaitOp") {
			expect(ops[1]!.binding).toBe("response")
			expect(ops[1]!.sources.map((s) => s.ref)).toEqual(["out"])
		}

		// Third op: commit
		expect(ops[2]!.type).toBe("CommitOp")
	})

	it("parses multi-agent workflow without errors", () => {
		const { ast, errors } = parseSlang(MULTI_AGENT_SLANG)
		expect(errors).toHaveLength(0)
		expect(ast.flows).toHaveLength(1)

		const agents = agentsOf(ast.flows[0]!)
		expect(agents).toHaveLength(3)
		expect(agents.map((a) => a.name)).toEqual(["Architect", "Codebase", "Developer"])
	})

	it("parses escalate @Human", () => {
		const { ast, errors } = parseSlang(ESCALATE_SLANG)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations

		expect(ops[0]!.type).toBe("EscalateOp")
		if (ops[0]!.type === "EscalateOp") {
			expect(ops[0]!.target).toBe("Human")
			expect(ops[0]!.reason).toBe("Please approve this")
		}
	})

	it("returns errors for invalid syntax", () => {
		const { errors } = parseSlang("this is not valid slang {")
		expect(errors.length).toBeGreaterThan(0)
	})

	it("parses let and set operations", () => {
		const src = `
flow "vars-test" () {
  agent VarAgent {
    mode: "code"
    role: "Test"

    let x = 5
    set x = "hello"

    commit
  }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		expect(ops[0]!.type).toBe("LetOp")
		expect(ops[1]!.type).toBe("SetOp")
	})

	it("parses repeat-until and when-otherwise blocks", () => {
		const src = `
flow "control-test" () {
  agent CtrlAgent {
    mode: "code"
    role: "Control flow test"

    let done = false
    repeat until done {
      stake check() -> @out

      when done {
        commit
      } otherwise {
        stake redo() -> @out
      }
    }

    commit
  }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		expect(ops[0]!.type).toBe("LetOp")
		expect(ops[1]!.type).toBe("RepeatBlock")
	})
})

describe("validateSlangAST", () => {
	it("warns about missing commit in an agent with operations", () => {
		const src = `
flow "no-commit" () {
  agent BadAgent {
    mode: "code"
    stake work() -> @out
  }
}
`
		const { ast, errors } = parseSlang(src)
		// Parse should succeed even with missing commit
		expect(errors).toHaveLength(0)

		const warnings = validateSlangAST(ast)
		expect(warnings.length).toBeGreaterThan(0)
		expect(warnings.some((w) => w.includes("no commit"))).toBe(true)
	})

	it("warns about unknown stake targets", () => {
		const src = `
flow "bad-target" () {
  agent A {
    mode: "code"
    stake work() -> @NonExistent
    commit
  }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)

		const warnings = validateSlangAST(ast)
		expect(warnings.some((w) => w.includes("NonExistent"))).toBe(true)
	})

	it("produces no warnings for a well-formed multi-agent flow", () => {
		const { ast, errors } = parseSlang(MULTI_AGENT_SLANG)
		expect(errors).toHaveLength(0)

		const warnings = validateSlangAST(ast)
		expect(warnings).toHaveLength(0)
	})
})

// ── Serialization tests ──

import { serializeFlowState, deserializeFlowState, type FlowState } from "../slang-types"

describe("FlowState serialization", () => {
	function makeFlowState(): FlowState {
		const agents = new Map()
		agents.set("Agent1", {
			name: "Agent1",
			taskId: "task-123",
			status: "running" as const,
			opIndex: 0,
			bindings: new Map([["feature", "test-feature"]]),
		})
		agents.set("Agent2", {
			name: "Agent2",
			taskId: "task-456",
			status: "idle" as const,
			opIndex: 0,
			bindings: new Map(),
		})

		return {
			flowName: "test-flow",
			params: { feature: "test-feature" },
			agents,
			round: 3,
			tokensUsed: 15000,
			status: "running",
			mailbox: [
				{
					from: "Agent1",
					to: "Agent2",
					value: { result: "done" },
					timestamp: 1234567890,
					funcName: "do_work",
				},
			],
			sourcePath: "/test/flow.slang",
		}
	}

	it("round-trips through serialize → deserialize", () => {
		const original = makeFlowState()
		const serialized = serializeFlowState(original)
		const restored = deserializeFlowState(serialized)

		expect(restored.flowName).toBe(original.flowName)
		expect(restored.params).toEqual(original.params)
		expect(restored.round).toBe(original.round)
		expect(restored.tokensUsed).toBe(original.tokensUsed)
		expect(restored.status).toBe(original.status)
		expect(restored.sourcePath).toBe(original.sourcePath)

		// Check agents
		expect(restored.agents.size).toBe(2)
		const agent1 = restored.agents.get("Agent1")
		expect(agent1).toBeDefined()
		expect(agent1!.taskId).toBe("task-123")
		expect(agent1!.status).toBe("running")
		expect(agent1!.bindings.get("feature")).toBe("test-feature")

		// Check mailbox
		expect(restored.mailbox).toHaveLength(1)
		expect(restored.mailbox[0]!.from).toBe("Agent1")
		expect(restored.mailbox[0]!.value).toEqual({ result: "done" })
	})

	it("deserializes an empty flow state", () => {
		const data = {
			flowName: "empty",
			params: {},
			agents: [],
			round: 0,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
		}
		const restored = deserializeFlowState(data)
		expect(restored.agents.size).toBe(0)
		expect(restored.mailbox).toHaveLength(0)
	})
})
