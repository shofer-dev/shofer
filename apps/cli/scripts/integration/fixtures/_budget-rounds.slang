-- budget-rounds: tight round budget that the flow will exhaust.
-- The token budget is generous so the limiting factor is rounds.
flow "budget-rounds" (task: "string") {
  title: "Round Budget Exhaustion"
  description: "Tests budget: rounds(N) — flow exits with budget_exceeded when round limit is reached."

  agent Worker {
    mode: "code"
    role: "Do some work."

    stake do_work(
      instructions: "Do some work and report back."
    ) -> @out

    commit
  }

  converge when: @Worker.committed
  budget: rounds(1), tokens(100000)
}
