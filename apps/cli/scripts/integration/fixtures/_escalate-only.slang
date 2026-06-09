-- escalate-only: static escalate @Human in the advance phase.
-- The executor handles this BEFORE dispatch — it never spawns a Task.
-- Validates: escalate @Human, reason:, await from @Human.
flow "escalate-only" (question: "string") {
  title: "Escalate-Only Test"
  description: "Tests static escalate @Human with await @Human."
  icon: "question"

  agent Asker {
    mode: "code"
    role: "Ask the user something via escalate."

    escalate @Human reason: "Please answer this question: what is your name?"
    await response <- @Human

    commit
  }

  converge when: @Asker.committed
  budget: rounds(5), time(60)
}
