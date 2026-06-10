-- commit-if: conditional commit gated by an expression.
-- The agent only signals completion when the condition is truthy.
flow "commit-if" (flag: "boolean") {
  title: "Conditional Commit"
  description: "Tests commit with if guard — agent only commits when condition is true."

  agent Worker {
    mode: "code"
    role: "Do work and only commit if flag is true."

    stake do_work(
      instructions: "Do the work."
    ) -> @out
      output: { result: "string" }

    let result = true

    commit "worker-done" if result && flag
  }

  converge when: @Worker.committed
  budget: rounds(5), time(60)
}
