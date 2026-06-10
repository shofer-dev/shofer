-- budget-tokens: tight token budget that the flow will exhaust.
-- The flow terminates with budget_exceeded after aggregate agent token
-- usage crosses the budget limit. The rounds budget is generous so the
-- limiting factor is tokens.
--
-- The budget is deliberately set BELOW the cost of a single stake so the
-- first dispatched agent's token usage trips the mid-round budget check
-- before the agent can commit. (Each spawned agent LLM turn reports ~110
-- tokens, so tokens(50) is exceeded after the very first stake.)
flow "budget-tokens" (task: "string") {
  title: "Token Budget Exhaustion"
  description: "Tests budget: tokens(N) — flow exits with budget_exceeded when aggregate tokens cross the limit."

  agent Worker {
    mode: "code"
    role: "Do some work that will consume tokens. The tight token budget will be the limiting factor."

    stake do_work(
      instructions: "Do some work and report back."
    ) -> @out
      output: { result: "string" }

    commit
  }

  converge when: @Worker.committed
  budget: rounds(50), tokens(50), time(120)
}
