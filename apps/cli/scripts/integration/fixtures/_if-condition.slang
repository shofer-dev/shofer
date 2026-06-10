-- if-condition: conditional stake with if guard.
-- The stake only fires when the condition is truthy.
flow "if-condition" (flag: "boolean") {
  title: "Conditional Stake"
  description: "Tests stake with if guard — stake only executes when condition is true."

  agent Conditional {
    mode: "code"
    role: "Only stake when flag is true."

    stake do_work(
      instructions: "Always run — no guard."
    ) -> @out
      output: { result: "string" }

    stake guarded_work(
      instructions: "Only run when flag_input is true."
    ) -> @out if flag
      output: { result: "string" }

    commit if flag
  }

  converge when: @Conditional.committed
  budget: rounds(5), time(60)
}
