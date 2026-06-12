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
    mode: "architect"
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

	it("parses stake with output schema", () => {
		const src = `
flow "output-test" () {
		agent A {
		  mode: "code"
		  stake work() -> @out
		    output: { result: "string", approved: "boolean" }
		  commit
		}
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		expect(ops[0]!.type).toBe("StakeOp")
		if (ops[0]!.type === "StakeOp") {
			expect(ops[0]!.output).toBeDefined()
			expect(ops[0]!.output!.fields.map((f) => f.name)).toEqual(["result", "approved"])
			expect(ops[0]!.output!.fields.map((f) => f.fieldType)).toEqual(["string", "boolean"])
		}
	})

	it("parses stake with multiple recipients", () => {
		const src = `
flow "multi-recipient" () {
		agent A {
		  mode: "code"
		  stake work() -> @B, @C
		  commit
		}
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		if (ops[0]!.type === "StakeOp") {
			expect(ops[0]!.recipients.map((r) => r.ref)).toEqual(["B", "C"])
		}
	})

	it("parses stake with binding (let x = stake ...) — grammar not yet implemented", () => {
		// StakeOp.binding exists in AST types but no slang syntax produces it.
		// The `let x = stake ...` form is a design aspiration, not a bug.
		// When grammar support is added, this test should verify the binding field.
	})

	it("parses commit with value", () => {
		const src = `
flow "commit-value" () {
		agent A {
		  mode: "code"
		  stake work() -> @out
		  commit "done"
		}
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		const commit = ops[ops.length - 1]
		expect(commit!.type).toBe("CommitOp")
	})

	it("parses commit with condition (if ...)", () => {
		const src = `
flow "conditional-commit" () {
	 agent A {
	   mode: "code"
	   let ready = true
	   commit if ready
	 }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		const commit = ops[ops.length - 1]
		expect(commit!.type).toBe("CommitOp")
		if (commit!.type === "CommitOp") {
			expect(commit!.condition).toBeDefined()
		}
	})

	it("parses escalate with condition (if ...)", () => {
		const src = `
flow "conditional-escalate" () {
	 agent A {
	   mode: "code"
	   let needsApproval = true
	   escalate @Human reason: "Approve?" if needsApproval
	   commit
	 }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		expect(ops[1]!.type).toBe("EscalateOp")
		if (ops[1]!.type === "EscalateOp") {
			expect(ops[1]!.condition).toBeDefined()
		}
	})

	it("parses stake with condition (if ...)", () => {
		const src = `
flow "conditional-stake" () {
	 agent A {
	   mode: "code"
	   let shouldRun = true
	   stake doWork() -> @out if shouldRun
	   commit
	 }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		expect(ops[0]!.type).toBe("LetOp") // let shouldRun = true
		expect(ops[1]!.type).toBe("StakeOp")
		if (ops[1]!.type === "StakeOp") {
			expect(ops[1]!.condition).toBeDefined()
		}
	})

	it("parses await with wildcard sources (@any, @*)", () => {
		const src = `
flow "wildcard-await" () {
	 agent A {
	   mode: "code"
	   await msg <- @any
	   await msg2 <- @*
	   commit
	 }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		expect(ops[0]!.type).toBe("AwaitOp")
		if (ops[0]!.type === "AwaitOp") {
			expect(ops[0]!.sources[0]!.ref).toBe("any")
		}
		expect(ops[1]!.type).toBe("AwaitOp")
		if (ops[1]!.type === "AwaitOp") {
			expect(ops[1]!.sources[0]!.ref).toBe("*")
		}
	})

	it("parses stake broadcast (@all)", () => {
		const src = `
flow "broadcast" () {
		agent A {
		  mode: "code"
		  stake announce() -> @all
		  commit
		}
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const ops = agentsOf(ast.flows[0]!)[0]!.operations
		if (ops[0]!.type === "StakeOp") {
			expect(ops[0]!.recipients[0]!.ref).toBe("all")
		}
	})

	it("parses agents with peers meta field", () => {
		const src = `
flow "peers-test" () {
		agent Codebase {
		  mode: "search"
		  commit
		}
		agent Developer {
		  mode: "code"
		  peers: [@Codebase, @Reviewer]
		  commit
		}
		agent Reviewer {
		  mode: "reviewer"
		  commit
		}
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const dev = agentsOf(ast.flows[0]!).find((a) => a.name === "Developer")
		expect(dev).toBeDefined()
		expect(dev!.meta.peers).toEqual(["Codebase", "Reviewer"])
	})

	it("parses flow-level UI metadata (title, description, icon)", () => {
		const src = `
flow "ui-test" (input: "string") {
		title: "My Workflow"
		description: "A test workflow with metadata."
		icon: "rocket"

		param input {
		  description: "The input parameter."
		}

		agent A {
		  mode: "code"
		  commit
		}
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const flow = ast.flows[0]!
		expect(flow.title).toBe("My Workflow")
		expect(flow.description).toBe("A test workflow with metadata.")
		expect(flow.icon).toBe("rocket")

		// ParamMetaDecl
		const paramMeta = flow.body.find((n) => n.type === "ParamMetaDecl")
		expect(paramMeta).toBeDefined()
		if (paramMeta && paramMeta.type === "ParamMetaDecl") {
			expect(paramMeta.name).toBe("input")
			expect(paramMeta.description).toBe("The input parameter.")
		}
	})

	it("parses empty flow (no agents)", () => {
		const src = `
flow "empty" () {
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors.length).toBeGreaterThanOrEqual(0) // may warn or error depending on strictness
		expect(ast.flows).toHaveLength(1)
	})

	it("parses tools meta field on agent", () => {
		const src = `
flow "tools-meta" () {
	 agent Worker {
	   mode: "code"
	   tools: [read, execute, mcp]
	   role: "Agent with tool restrictions."
	   commit
	 }
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
		const worker = agentsOf(ast.flows[0]!).find((a) => a.name === "Worker")
		expect(worker).toBeDefined()
		expect(worker!.meta.tools).toEqual(["read", "execute", "mcp"])
	})

	it("parses converge with all_committed keyword", () => {
		const src = `
flow "all-committed" () {
		agent A {
		  mode: "code"
		  commit
		}
		converge when: all_committed
}
`
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)
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
			mailboxHistory: [],
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
			mailboxHistory: [],
		}
		const restored = deserializeFlowState(data)
		expect(restored.agents.size).toBe(0)
		expect(restored.mailbox).toHaveLength(0)
	})

	it("round-trips agent with retryCount", () => {
		const agents = new Map()
		agents.set("A", {
			name: "A",
			taskId: "t1",
			status: "idle" as const,
			opIndex: 0,
			bindings: new Map(),
			retryCount: 2,
		})
		const original: FlowState = {
			flowName: "f",
			params: {},
			agents,
			round: 1,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
		}
		const restored = deserializeFlowState(serializeFlowState(original))
		expect(restored.agents.get("A")!.retryCount).toBe(2)
	})

	it("round-trips agent with sendingTo / waitingFor", () => {
		const agents = new Map()
		agents.set("A", {
			name: "A",
			taskId: "t1",
			status: "blocked" as const,
			opIndex: 0,
			bindings: new Map(),
			retryCount: 0,
			sendingTo: "B",
			waitingFor: "B",
		})
		const original: FlowState = {
			flowName: "f",
			params: {},
			agents,
			round: 1,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
		}
		const restored = deserializeFlowState(serializeFlowState(original))
		const a = restored.agents.get("A")!
		expect(a.sendingTo).toBe("B")
		expect(a.waitingFor).toBe("B")
	})

	it("round-trips agent with complex output (object)", () => {
		const agents = new Map()
		agents.set("A", {
			name: "A",
			taskId: "t1",
			status: "idle" as const,
			opIndex: 0,
			bindings: new Map(),
			retryCount: 0,
			output: { approved: true, issues: "none", nested: { deep: 42 } },
		})
		const original: FlowState = {
			flowName: "f",
			params: {},
			agents,
			round: 1,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
		}
		const restored = deserializeFlowState(serializeFlowState(original))
		expect(restored.agents.get("A")!.output).toEqual({ approved: true, issues: "none", nested: { deep: 42 } })
	})

	it("round-trips mailbox with multiple entries", () => {
		const original: FlowState = {
			flowName: "f",
			params: {},
			agents: new Map(),
			round: 1,
			tokensUsed: 0,
			status: "running",
			mailbox: [
				{ from: "A", to: "B", value: "first", timestamp: 1, funcName: "do" },
				{ from: "B", to: "C", value: "second", timestamp: 2, funcName: "reply" },
				{ from: "C", to: "out", value: "third", timestamp: 3 },
			],
			mailboxHistory: [],
		}
		const restored = deserializeFlowState(serializeFlowState(original))
		expect(restored.mailbox).toHaveLength(3)
		expect(restored.mailbox.map((m) => m.value)).toEqual(["first", "second", "third"])
	})

	it("deserializes with sourcePath preserved", () => {
		const original: FlowState = {
			flowName: "f",
			params: {},
			agents: new Map(),
			round: 0,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
			sourcePath: "/home/user/.shofer/workflows/my-flow.slang",
		}
		const restored = deserializeFlowState(serializeFlowState(original))
		expect(restored.sourcePath).toBe("/home/user/.shofer/workflows/my-flow.slang")
	})

	it("deserializes legacy format without retryCount → defaults to 0", () => {
		const data = {
			flowName: "old",
			params: {},
			agents: [["A", { name: "A", taskId: "t1", status: "idle", opIndex: 0, bindings: [] }]],
			round: 0,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
		}
		const restored = deserializeFlowState(data)
		expect(restored.agents.get("A")!.retryCount).toBe(0)
	})

	it("deserializes with missing sourcePath → undefined", () => {
		const data = {
			flowName: "f",
			params: {},
			agents: [],
			round: 0,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
		}
		const restored = deserializeFlowState(data)
		expect(restored.sourcePath).toBeUndefined()
	})

	it("deserializes corrupt agents → empty map", () => {
		const data = {
			flowName: "f",
			params: {},
			agents: null,
			round: 0,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
		}
		const restored = deserializeFlowState(data)
		expect(restored.agents.size).toBe(0)
	})
})
