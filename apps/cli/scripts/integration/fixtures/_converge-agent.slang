-- converge-agent: converge when a specific agent commits.
-- The flow terminates based on one designated agent's state.
flow "converge-agent" (task: "string") {
  title: "Converge on Specific Agent"
  description: "Tests converge when: @Orchestrator.committed — only the orchestrator signals done."

  agent Orchestrator {
    mode: "code"
    role: "Orchestrator. Signals when flow is done."

    stake coordinate(task: task) -> @Worker

    await result <- @Worker

    commit
  }

  agent Worker {
    mode: "code"
    role: "Worker. Does the work."
    await assignment <- @Orchestrator
    stake do_work(task: assignment) -> @Orchestrator
    commit
  }

  converge when: @Orchestrator.committed
  budget: rounds(10), time(60)
}
