/**
 * Unit tests for the Slang parser.
 *
 * Vitest globals (describe/it/expect) are available globally per
 * the Test Layout Rule in AGENTS.md.
 *
 * Naming convention: *.test.ts (Node env) per AGENTS.md.
 */

import { parseSlang, validateSlangAST } from "../slang-parser"
import type { SlangAST } from "../slang-types"

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

// ── Multi-agent slang ──

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

    await task <- @any

    commit
  }

  agent Developer {
    mode: "code"
    role: "Developer"

    await design <- @Architect

    commit
  }

  converge when: @Architect.committed
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
		const flow = ast.flows[0]
		expect(flow.name).toBe("test-flow")
		expect(flow.params).toHaveLength(1)
		expect(flow.params[0].name).toBe("input")
		expect(flow.params[0].type).toBe("string")
		expect(flow.agents).toHaveLength(1)
		expect(flow.agents[0].name).toBe("TestAgent")
		expect(flow.agents[0].mode).toBe("code")
		expect(flow.agents[0].role).toBe("Test role")
		// Verify constraints
		expect(flow.constraints.convergeWhen).toBe("@TestAgent.committed")
		expect(flow.constraints.budgetRounds).toBe(10)
		expect(flow.constraints.budgetTokens).toBe(50000)
	})

	it("parses agent operations correctly", () => {
		const { ast, errors } = parseSlang(MINIMAL_SLANG)
		expect(errors).toHaveLength(0)
		const agent = ast.flows[0].agents[0]
		const ops = agent.ops

		// First op: stake do_work -> @out with output schema
		expect(ops[0].kind).toBe("stake")
		const stakeOp = ops[0]
		if (stakeOp.kind === "stake") {
			expect(stakeOp.funcName).toBe("do_work")
			expect(stakeOp.target).toBe("out")
			expect(stakeOp.output).toEqual({ result: "string", approved: "boolean" })
			expect(stakeOp.args).toHaveProperty("task")
			expect(stakeOp.args).toHaveProperty("feature")
		}

		// Second op: await
		expect(ops[1].kind).toBe("await")
		if (ops[1].kind === "await") {
			expect(ops[1].binding).toBe("response")
			expect(ops[1].source).toBe("out")
		}

		// Third op: commit
		expect(ops[2].kind).toBe("commit")
	})

	it("parses multi-agent workflow without errors", () => {
		const { ast, errors } = parseSlang(MULTI_AGENT_SLANG)
		expect(errors).toHaveLength(0)
		expect(ast.flows).toHaveLength(1)
		expect(ast.flows[0].agents).toHaveLength(3)

		const names = ast.flows[0].agents.map((a) => a.name)
		expect(names).toEqual(["Architect", "Codebase", "Developer"])
	})

	it("parses escalate @Human", () => {
		const { ast, errors } = parseSlang(ESCALATE_SLANG)
		expect(errors).toHaveLength(0)
		const ops = ast.flows[0].agents[0].ops

		expect(ops[0].kind).toBe("escalate")
		if (ops[0].kind === "escalate") {
			expect(ops[0].recipient).toBe("Human")
			expect(ops[0].reason).toBe("Please approve this")
		}
	})

	it("returns errors for invalid syntax", () => {
		const { ast, errors } = parseSlang("this is not valid slang {")
		expect(errors.length).toBeGreaterThan(0)
	})

	it("parses let and set operations", () => {
		const src = `
flow "vars-test" () {
  agent VarAgent {
    mode: "code"
    role: "Test"

    let x = stake get_value() -> @out
    set x = "hello"

    commit
  }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = ast.flows[0].agents[0].ops
		expect(ops[0].kind).toBe("let")
		expect(ops[1].kind).toBe("set")
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
        stake retry() -> @out
      }
    }

    commit
  }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = ast.flows[0].agents[0].ops
		expect(ops[1].kind).toBe("repeat")
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
		expect(restored.mailbox[0].from).toBe("Agent1")
		expect(restored.mailbox[0].value).toEqual({ result: "done" })
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
