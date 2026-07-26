/**
 * `call` — the deterministic twin of `stake`.
 *
 * The property under test is that `call` BLOCKS exactly as `stake` does. It is
 * tempting to treat a "deterministic function" as something the VM could just
 * evaluate, and that would be wrong: the whole point is that the work happens
 * outside the interpreter, in registered code the dispatcher selects and places
 * in a trust domain. The VM must hand it out and wait, or the placement decision
 * has nowhere to live.
 */

import { describe, it, expect } from "vitest"

import { parse } from "../slang-parser-upstream.js"
import { advanceAgent, compileAgentProgram } from "../slang-interpreter.js"
import type { AgentDecl, CallOp } from "../slang-ast.js"
import type { AgentState, FlowState } from "../slang-types.js"

/** Parse a one-agent spec and return its agent declaration. */
function agentOf(body: string): AgentDecl {
	const source = `flow "f" {
  agent A {
    role: "r"
${body}
  }
  converge when: @A.committed
}`
	const flow = parse(source).flows[0]!
	return flow.body.find((n) => n.type === "AgentDecl") as AgentDecl
}

/** Fresh interpreter state for one agent. */
function states(name = "A"): { state: AgentState; flowState: FlowState } {
	const state: AgentState = {
		name,
		taskId: name,
		status: "idle",
		opIndex: 0,
		bindings: new Map(),
		retryCount: 0,
	}
	return {
		state,
		flowState: {
			flowName: "f",
			params: {},
			agents: new Map([[name, state]]),
			round: 0,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
		},
	}
}

describe("parsing", () => {
	it("reads a call with arguments and routing", () => {
		const agent = agentOf(`    call summarize(text: "hello") -> @out
    commit`)
		const op = agent.operations.find((o) => o.type === "CallOp") as CallOp
		expect(op).toBeDefined()
		expect(op.call.name).toBe("summarize")
		expect(op.call.args).toHaveLength(1)
		expect(op.recipients.map((r) => r.ref)).toEqual(["out"])
	})

	it("routes to a named agent, like a stake", () => {
		const agent = agentOf(`    call fetch(url: "u") -> @Reviewer
    commit`)
		const op = agent.operations.find((o) => o.type === "CallOp") as CallOp
		expect(op.recipients.map((r) => r.ref)).toEqual(["Reviewer"])
	})

	it("does not reserve `call` as a keyword", () => {
		// Parsed contextually (`call ident(`), so a spec already using `call` as a
		// variable keeps working — the same courtesy `where` and `requires:` get.
		const source = `flow "f" {
  agent A {
    role: "r"
    let call = "a phone call"
    stake go(x: call) -> @out
    commit
  }
  converge when: @A.committed
}`
		expect(() => parse(source)).not.toThrow()
	})

	it("still parses a stake, whose recipient parsing it now shares", () => {
		// Guard for the extraction: stake and call route identically, so one helper
		// serves both, and a regression there would break stake silently.
		const agent = agentOf(`    stake go(x: "1") -> @Alpha, @Beta
    commit`)
		const op = agent.operations.find((o) => o.type === "StakeOp")
		expect(op).toBeDefined()
		expect((op as { recipients: { ref: string }[] }).recipients.map((r) => r.ref)).toEqual(["Alpha", "Beta"])
	})
})

describe("execution", () => {
	it("BLOCKS, handing the call out rather than evaluating it", () => {
		// The VM cannot run a registered function: the dispatcher selects it and
		// places it in a trust domain, and that decision lives outside here.
		const agent = agentOf(`    call summarize(text: "hello") -> @out
    commit`)
		const program = compileAgentProgram(agent)
		const { state, flowState } = states()

		const adv = advanceAgent(program, state, flowState.mailbox, flowState)
		expect(adv.type).toBe("call")
		if (adv.type === "call") expect(adv.op.call.name).toBe("summarize")
	})

	it("advances past the call once the dispatcher has answered", () => {
		const agent = agentOf(`    call summarize(text: "hello") -> @out
    commit`)
		const program = compileAgentProgram(agent)
		const { state, flowState } = states()

		expect(advanceAgent(program, state, flowState.mailbox, flowState).type).toBe("call")
		// The executor records the result and steps the PC, exactly as for a stake.
		state.opIndex++
		const next = advanceAgent(program, state, flowState.mailbox, flowState)
		expect(["committed", "end"]).toContain(next.type)
	})

	it("interleaves with stakes in declaration order", () => {
		const agent = agentOf(`    call prepare(x: "1") -> @out
    stake decide(y: "2") -> @out
    commit`)
		const program = compileAgentProgram(agent)
		const { state, flowState } = states()

		expect(advanceAgent(program, state, flowState.mailbox, flowState).type).toBe("call")
		state.opIndex++
		expect(advanceAgent(program, state, flowState.mailbox, flowState).type).toBe("stake")
	})
})
