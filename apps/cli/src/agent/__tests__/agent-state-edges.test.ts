// pnpm --filter @shofer/cli test src/agent/__tests__/agent-state-edges.test.ts

import type { ShoferMessage } from "@shofer/types"

import {
	detectAgentState,
	isAgentWaitingForInput,
	isAgentRunning,
	isContentStreaming,
	AgentLoopState,
} from "../agent-state.js"

/**
 * The corners of the state detector: the required-action and description tables
 * for asks the main suite does not reach, the sparse-array guards, and the three
 * one-line convenience predicates.
 */

const say = (overrides: Partial<ShoferMessage> = {}): ShoferMessage =>
	({ ts: 1, type: "say", say: "text", text: "hi", ...overrides }) as unknown as ShoferMessage

const ask = (askType: string, overrides: Partial<ShoferMessage> = {}): ShoferMessage =>
	({ ts: 2, type: "ask", ask: askType, text: "", partial: false, ...overrides }) as unknown as ShoferMessage

describe("detectAgentState required actions and descriptions", () => {
	const cases: Array<{ ask: string; action: string; description: RegExp }> = [
		{ ask: "followup", action: "answer", description: /follow-up question/ },
		{ ask: "command", action: "approve", description: /execute a command/ },
		{ ask: "tool", action: "approve", description: /file operation/ },
		{ ask: "use_mcp_server", action: "approve", description: /MCP server/ },
		{ ask: "command_output", action: "continue_or_abort", description: /Command is running/ },
		{ ask: "api_req_failed", action: "retry_or_new_task", description: /API request failed/ },
		{ ask: "mistake_limit_reached", action: "proceed_or_new_task", description: /Too many errors/ },
		{ ask: "completion_result", action: "start_task", description: /completed successfully/ },
		{ ask: "resume_task", action: "resume_or_abandon", description: /paused/ },
		{ ask: "resume_completed_task", action: "start_new_task", description: /Previously completed/ },
		{ ask: "auto_approval_max_req_reached", action: "start_new_task", description: /Auto-approval limit/ },
	]

	for (const testCase of cases) {
		it(`maps ${testCase.ask} to ${testCase.action}`, () => {
			const info = detectAgentState([say(), ask(testCase.ask)])
			expect(info.requiredAction).toBe(testCase.action)
			expect(info.description).toMatch(testCase.description)
		})
	}

	it("falls back to the generic action and descriptions for an unmapped ask", () => {
		const info = detectAgentState([say(), ask("budget_limit")])
		expect(info.requiredAction).toBe("none")
		expect(info.description).toBe("Agent is waiting for user input.")
	})

	it("describes an unmapped idle ask generically", () => {
		// An idle ask with no description branch of its own.
		const info = detectAgentState([say(), ask("api_req_deleted")])
		expect(info.description).toBeTruthy()
	})
})

describe("detectAgentState guards", () => {
	it("reports no task for an empty or missing array", () => {
		expect(detectAgentState([]).state).toBe(AgentLoopState.NO_TASK)
		expect(detectAgentState(undefined as unknown as ShoferMessage[]).state).toBe(AgentLoopState.NO_TASK)
	})

	it("reports no task when the last entry is a hole", () => {
		const sparse = [say(), undefined] as unknown as ShoferMessage[]
		const info = detectAgentState(sparse)
		expect(info.state).toBe(AgentLoopState.NO_TASK)
		expect(info.requiredAction).toBe("start_new_task")
	})

	it("skips holes while scanning backwards for the last api request", () => {
		const sparse = [
			say({ ts: 1, say: "api_req_started", text: undefined }),
			undefined,
			say({ ts: 3, say: "text", text: "still working" }),
		] as unknown as ShoferMessage[]

		expect(detectAgentState(sparse).isStreaming).toBe(true)
	})

	it("treats an unparsable api_req_started payload as finished", () => {
		const messages = [say({ ts: 1, say: "api_req_started", text: "not json" }), say({ ts: 2, text: "done" })]
		expect(detectAgentState(messages).isStreaming).toBe(false)
	})
})

describe("agent state convenience predicates", () => {
	it("answers the three quick questions", () => {
		const waiting = [say(), ask("followup")]
		const running = [say({ ts: 1, text: "working" })]
		const streaming = [say({ ts: 1, text: "partial", partial: true })]

		expect(isAgentWaitingForInput(waiting)).toBe(true)
		expect(isAgentWaitingForInput(running)).toBe(false)

		expect(isAgentRunning(running)).toBe(true)
		expect(isAgentRunning(waiting)).toBe(false)

		expect(isContentStreaming(streaming)).toBe(true)
		expect(isContentStreaming(running)).toBe(false)
	})
})
