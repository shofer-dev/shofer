-- when-otherwise: conditional branching with both branches.
-- Tests: when with contains check, when-otherwise, nested when in otherwise.
flow "when-otherwise" (text: "string") {
  title: "When-Otherwise Branching"
  description: "Tests when-otherwise with contains, nested when, and set in both branches."

  agent Router {
    mode: "code"
    role: "Route something based on a condition."

    let approved = false
    let rejected = false

    when text contains "DONE" {
      set approved = true
    } otherwise {
      set rejected = true
      when text == "" {
        set approved = false
      }
    }

    stake report(
      approved: approved,
      rejected: rejected
    ) -> @out
      output: { approved: "boolean", rejected: "boolean" }

    commit
  }

  converge when: @Router.committed
  budget: rounds(5), time(60)
}
