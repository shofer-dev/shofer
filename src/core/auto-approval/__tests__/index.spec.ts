import { checkAutoApproval } from "../index"

// Minimal enabled state — auto-approval master gate on, every category toggle off.
// Individual tests turn on only the toggle under test.
const enabledState = { autoApprovalEnabled: true } as any

describe("checkAutoApproval", () => {
	describe("inter-task questions (ask_followup_question routed to parent)", () => {
		// A background child routes its question UP to the parent via
		// askApproval("tool", { tool: "askFollowupQuestion", ... }). No human is
		// interrupted (the parent answers via answer_subtask_question), so this is
		// unconditionally approved regardless of any toggle.
		it("approves askFollowupQuestion even with no followup toggle", async () => {
			const result = await checkAutoApproval({
				state: enabledState,
				ask: "tool",
				text: JSON.stringify({ tool: "askFollowupQuestion", question: "Which file?" }),
			})

			expect(result).toEqual({ decision: "approve" })
		})

		it("approves askFollowupQuestion even when alwaysAllowFollowupQuestions is false", async () => {
			const result = await checkAutoApproval({
				state: { autoApprovalEnabled: true, alwaysAllowFollowupQuestions: false } as any,
				ask: "tool",
				text: JSON.stringify({ tool: "askFollowupQuestion", question: "Which file?" }),
			})

			expect(result).toEqual({ decision: "approve" })
		})
	})

	describe("user-directed questions (followup ask)", () => {
		// A question directed at the USER flows through the `followup` ask category,
		// which remains gated by alwaysAllowFollowupQuestions.
		it("asks when alwaysAllowFollowupQuestions is off", async () => {
			const result = await checkAutoApproval({
				state: enabledState,
				ask: "followup",
				text: JSON.stringify({ question: "Pick one", suggest: [{ answer: "a" }] }),
			})

			expect(result).toEqual({ decision: "ask" })
		})

		it("times out (auto-selects) when toggle on and a timeout is configured", async () => {
			const result = await checkAutoApproval({
				state: {
					autoApprovalEnabled: true,
					alwaysAllowFollowupQuestions: true,
					followupAutoApproveTimeoutMs: 5000,
				} as any,
				ask: "followup",
				text: JSON.stringify({ question: "Pick one", suggest: [{ answer: "a" }] }),
			})

			expect(result.decision).toBe("timeout")
		})
	})

	it("asks for everything when the master gate is off", async () => {
		const result = await checkAutoApproval({
			state: { autoApprovalEnabled: false } as any,
			ask: "tool",
			text: JSON.stringify({ tool: "askFollowupQuestion", question: "Which file?" }),
		})

		expect(result).toEqual({ decision: "ask" })
	})
})
