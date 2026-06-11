-- named-args: named arguments in stake call.
-- Tests: named-only arguments with mixed types (string, number, boolean, list).
flow "named-args" (topic: "string", num_value: "number") {
  title: "Named Arguments"
  description: "Tests named arguments in stake calls."

  agent Client {
    mode: "code"
    role: "Test argument passing styles."

    stake named_only(
      name: topic,
      value: num_value,
      urgent: true,
      tags: ["a", "b"]
    ) -> @Worker

    await r1 <- @Worker

    commit
  }

  agent Worker {
    mode: "code"
    role: "Receive and acknowledge."
    await assignment <- @Client
    stake ack(task: assignment) -> @Client
    commit
  }

  converge when: @Client.committed
  budget: rounds(10), time(300)
}
