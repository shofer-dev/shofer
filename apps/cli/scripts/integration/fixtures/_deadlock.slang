-- deadlock: an agent awaits from a source that never produces output.
-- The flow deadlocks because B awaits from A but nothing ever stakes to B.
-- (A is waiting for an await that reciprocates B's wait — the circular form.)
-- This is parse-valid but will deadlock at runtime.
flow "deadlock" (topic: "string") {
  title: "Deadlock Detection"
  description: "Tests deadlock: two agents each await from the other simultaneously — no one can make progress."

  agent AgentA {
    mode: "code"
    role: "Deadlocks: awaits from B before producing anything."

    await first <- @AgentB

    stake do_work(
      topic: topic
    ) -> @AgentB

    commit
  }

  agent AgentB {
    mode: "code"
    role: "Deadlocks: awaits from A before producing anything."

    await first <- @AgentA

    stake do_work(
      topic: topic
    ) -> @AgentA

    commit
  }

  converge when: all_committed
  budget: rounds(5), time(60)
}
