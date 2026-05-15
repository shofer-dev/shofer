// pnpm --filter @shofer/types test src/__tests__/message.test.ts

import {
	shoferAsks,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	isAgentRunningAsk,
	isAutoApprovableAsk,
} from "../message.js"

describe("ask messages", () => {
	// The four ask-state categorizers (idle / interactive / resumable / agent-running)
	// describe how the agent loop *behaves* while the ask is outstanding. Every
	// `ShoferAsk` must belong to exactly one of them.
	//
	// `isAutoApprovableAsk` is a *separate* policy (does the host short-circuit
	// the ask?) and is intentionally orthogonal — it is NOT part of this
	// partition. Conflating it with state classification is exactly what the
	// old `nonBlockingAsks` mistake did.
	const stateCategorizers = [
		{ name: "idle", fn: isIdleAsk },
		{ name: "interactive", fn: isInteractiveAsk },
		{ name: "resumable", fn: isResumableAsk },
		{ name: "agent-running", fn: isAgentRunningAsk },
	] as const

	test("every ask belongs to exactly one state category", () => {
		for (const ask of shoferAsks) {
			const matches = stateCategorizers.filter(({ fn }) => fn(ask)).map(({ name }) => name)
			expect(
				matches,
				`${ask} should belong to exactly one state category, found: [${matches.join(", ")}]`,
			).toHaveLength(1)
		}
	})

	test("every auto-approvable ask is also an agent-running ask", () => {
		// Auto-approval short-circuits the ask without user input, so the agent
		// loop must keep running. An auto-approvable ask that paused the agent
		// would deadlock the loop: the host returns synthetic yesButtonClicked,
		// no user is asked, but downstream consumers (CLI agent-state, UI) think
		// the agent is waiting for input.
		for (const ask of shoferAsks) {
			if (isAutoApprovableAsk(ask)) {
				expect(isAgentRunningAsk(ask), `${ask} is auto-approvable but not agent-running`).toBe(true)
			}
		}
	})
})
