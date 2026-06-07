-- repeat-until: loop with an until condition.
-- Tests: repeat-until, set inside loop body.
flow "repeat-until" (topic: "string") {
  title: "Repeat-Until Loop"
  description: "Tests repeat-until with set inside the loop body."

  agent Looper {
    mode: "code"
    role: "Run a loop that increments and exits."

    let done = false
    let counter = 0

    repeat until done {
      stake ping(
        status: "ITERATION"
      ) -> @out
        output: { iteration: "number" }

      set counter = 1

      when counter > 0 {
        set done = true
      }
    }

    commit
  }

  converge when: @Looper.committed
  budget: rounds(10), tokens(10000)
}
