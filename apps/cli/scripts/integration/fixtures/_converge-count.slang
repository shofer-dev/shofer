-- converge-count: converge when at least N agents have committed.
-- Useful when you don't need ALL agents to finish, just a quorum.
flow "converge-count" (task: "string") {
  title: "Converge by Count"
  description: "Tests converge when: committed_count >= 1 — completes after first agent commits."

  agent FastWorker {
    mode: "code"
    role: "Fast worker."
    stake do_fast(task: task) -> @out
    commit
  }

  agent SlowWorker {
    mode: "code"
    role: "Slow worker — may never finish but flow still converges."
    await blocking_signal <- @FastWorker
    commit
  }

  converge when: committed_count >= 1
  budget: rounds(10), tokens(20000)
}
