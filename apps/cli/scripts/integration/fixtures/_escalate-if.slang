-- escalate-if: conditional escalation gated by an expression.
-- The escalate only fires when the condition is truthy.
flow "escalate-if" (limit: "number") {
  title: "Conditional Escalate"
  description: "Tests escalate @Human with if guard."

  agent Worker {
    mode: "code"
    role: "Check a value and escalate only if over the limit."

    stake do_work(
      value: limit
    ) -> @out
      output: { result: "string" }

    escalate @Human reason: "Value exceeded the limit." if limit > 5

    commit
  }

  converge when: @Worker.committed
  budget: rounds(5), time(60)
}
