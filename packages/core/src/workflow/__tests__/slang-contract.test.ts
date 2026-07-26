/**
 * Output contract tests.
 *
 * The distinction under test is the reason `where` exists at all: layer 1 checks
 * the SHAPE, layer 2 checks the ANSWER. A JSON schema can express the first and
 * structurally cannot express the second, so a spec that needs "score must be
 * above 7" has nowhere else to say it.
 */

import { describe, it, expect } from "vitest"

import { parse } from "../slang-parser-upstream.js"
import { validateContract, checkContract, contractFeedback } from "../slang-contract.js"
import type { AgentDecl, StakeOp } from "../slang-ast.js"
import type { AgentState, FlowState } from "../slang-types.js"

/** Extract the first stake of the first agent in a spec. */
function stakeOf(source: string): StakeOp {
	const flow = parse(source).flows[0]!
	const agent = flow.body.find((n) => n.type === "AgentDecl") as AgentDecl
	const stake = agent.operations.find((op) => op.type === "StakeOp") as StakeOp
	expect(stake).toBeDefined()
	return stake
}

/** A minimal state pair for evaluating a predicate. */
function states(): { state: AgentState; flowState: FlowState } {
	const state: AgentState = {
		name: "A",
		taskId: "A",
		status: "running",
		opIndex: 0,
		bindings: new Map(),
		retryCount: 0,
	}
	return {
		state,
		flowState: {
			flowName: "f",
			params: {},
			agents: new Map([["A", state]]),
			round: 0,
			tokensUsed: 0,
			status: "running",
			mailbox: [],
			mailboxHistory: [],
		},
	}
}

const WITH_WHERE = `flow "f" {
  agent A {
    role: "r"
    stake review(diff: "d") -> @out
      output: { score: "number", verdict: "string" } where score > 7
    commit
  }
  converge when: @A.committed
}`

describe("the where clause", () => {
	it("parses as a contextual keyword, attached to the stake", () => {
		const stake = stakeOf(WITH_WHERE)
		expect(stake.output).toBeDefined()
		expect(stake.where).toBeDefined()
	})

	it("does not reserve `where` as a keyword elsewhere", () => {
		// Parsed contextually, so a spec already using `where` as an identifier
		// must keep working — that is the whole reason it is not a keyword.
		const source = `flow "f" {
  agent A {
    role: "r"
    let where = "a place"
    stake go(x: where) -> @out
    commit
  }
  converge when: @A.committed
}`
		expect(() => parse(source)).not.toThrow()
	})
})

describe("layer 1 — structural", () => {
	const stake = stakeOf(WITH_WHERE)

	it("accepts a well-formed result", () => {
		const check = validateContract('{"score": 9, "verdict": "ship"}', stake.output)
		expect(check.ok).toBe(true)
	})

	it("tolerates a markdown fence, which models add unbidden", () => {
		// Failing this would burn a retry on punctuation rather than substance.
		const check = validateContract('```json\n{"score": 9, "verdict": "ship"}\n```', stake.output)
		expect(check.ok).toBe(true)
	})

	it("names the missing field, so the reprompt can be specific", () => {
		const check = validateContract('{"verdict": "ship"}', stake.output)
		expect(check.ok).toBe(false)
		if (!check.ok) {
			expect(check.layer).toBe("structural")
			expect(check.error).toContain("score")
		}
	})

	it("rejects a field of the wrong type", () => {
		const check = validateContract('{"score": "nine", "verdict": "ship"}', stake.output)
		expect(check.ok).toBe(false)
		if (!check.ok) expect(check.error).toContain("number")
	})

	it("rejects a non-object", () => {
		expect(validateContract("[1,2]", stake.output).ok).toBe(false)
		expect(validateContract("not json", stake.output).ok).toBe(false)
	})
})

describe("layer 2 — semantic", () => {
	const stake = stakeOf(WITH_WHERE)

	it("passes a result satisfying the predicate", () => {
		const { state, flowState } = states()
		const check = checkContract(stake, '{"score": 9, "verdict": "ship"}', state, flowState)
		expect(check.ok).toBe(true)
	})

	it("REJECTS a structurally perfect result that violates the predicate", () => {
		// The case a JSON schema cannot express, and the reason this layer exists.
		const { state, flowState } = states()
		const check = checkContract(stake, '{"score": 3, "verdict": "ship"}', state, flowState)
		expect(check.ok).toBe(false)
		if (!check.ok) expect(check.layer).toBe("semantic")
	})

	it("does not mutate the agent's own bindings", () => {
		// Result fields shadow bindings for the check only; a validation that
		// leaked them would silently change what later operations evaluate.
		const { state, flowState } = states()
		checkContract(stake, '{"score": 9, "verdict": "ship"}', state, flowState)
		expect(state.bindings.has("score")).toBe(false)
	})

	it("is skipped when the structural layer already failed", () => {
		// Order matters: `where score > 7` may assume `score` is a number only
		// because layer 1 established it.
		const { state, flowState } = states()
		const check = checkContract(stake, '{"verdict": "ship"}', state, flowState)
		expect(check.ok).toBe(false)
		if (!check.ok) expect(check.layer).toBe("structural")
	})
})

describe("feedback", () => {
	it("distinguishes the two failures, because they need different corrections", () => {
		const structural = contractFeedback({ ok: false, layer: "structural", error: 'missing required field "score"' })
		const semantic = contractFeedback({ ok: false, layer: "semantic", error: "violates where" })
		expect(structural).toContain("score")
		expect(semantic).toContain("where")
		expect(semantic).not.toEqual(structural)
	})
})
