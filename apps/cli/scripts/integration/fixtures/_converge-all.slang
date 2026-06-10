-- converge-all: converge when all agents have committed.
-- Most common converge form — the flow exits only when every agent is done.
flow "converge-all" (task: "string") {
  title: "Converge All Agents"
  description: "Tests converge when: all_committed — two agents must both commit."

  agent WorkerA {
    mode: "code"
    role: "Worker A."
    stake do_a(task: task) -> @out
      output: { result: "string" }
    commit
  }

  agent WorkerB {
    mode: "code"
    role: "Worker B."
    stake do_b(task: task) -> @out
      output: { result: "string" }
    commit
  }

  converge when: all_committed
  budget: rounds(10), time(60)
}
