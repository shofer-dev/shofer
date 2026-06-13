// pnpm --filter shofer test integrations/misc/__tests__/export-json.spec.ts

import { describe, it, expect } from "vitest"

import { buildJsonTrace } from "../export-json"

describe("buildJsonTrace — workflow export", () => {
	it("captures flowState + the UI event log when a workflow makes no LLM calls", () => {
		// Serialized slang FlowState (as persisted in HistoryItem.flowState): the
		// state machine + the data passing through it.
		const flowState = {
			flowName: "implement-feature",
			status: "completed",
			round: 3,
			params: { feature: "x" },
			agents: [["coder", { status: "committed", bindings: [["out", "done"]] }]],
			mailbox: [],
			mailboxHistory: [{ from: "coder", to: "reviewer", text: "please review" }],
		}
		const uiMessages = [
			{ type: "say", say: "text", ts: 1, text: "⚙️ Initializing workflow" },
			{ type: "say", say: "peer_message", ts: 2, text: "peer-to-peer — excluded" },
			{ type: "ask", ask: "followup", ts: 3, text: "which option?" },
			{ type: "say", say: "text", ts: 4, text: "✅ Workflow completed" },
		]

		const slangSource = 'flow "implement-feature" {\n  agent coder { ... }\n}'
		const trace = buildJsonTrace("wf-1", "implement-feature", "code", "2026-06-13T00:00:00.000Z", [], uiMessages, {
			isWorkflow: true,
			flowState,
			slangSource,
		})

		expect(trace.isWorkflow).toBe(true)
		expect(trace.calls).toEqual([])
		expect(trace.flowState).toEqual(flowState)
		// slangSource + flowState.mailboxHistory together reproduce the sequence diagram.
		expect(trace.slangSource).toBe(slangSource)
		expect((trace.flowState as any).mailboxHistory).toHaveLength(1)
		// The state-transition / status log: peer_message excluded, order preserved.
		expect(trace.events?.map((e) => e.ts)).toEqual([1, 3, 4])
		expect(trace.events?.find((e) => e.ts === 3)?.ask).toBe("followup")
		expect(trace.totalCalls).toBe(0)
	})

	it("omits workflow fields for a normal (non-workflow) task", () => {
		const apiHistory = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		] as any

		const trace = buildJsonTrace("t-1", "hi", "code", "2026-06-13T00:00:00.000Z", apiHistory, [])

		expect(trace.isWorkflow).toBeUndefined()
		expect(trace.flowState).toBeUndefined()
		expect(trace.events).toBeUndefined()
		expect(trace.calls.length).toBe(1)
	})
})
