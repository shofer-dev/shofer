-- await-human: escalate + await from @Human combo.
-- Escalate pauses the flow, user answers, reply comes as @Human mail.
flow "await-human" (topic: "string") {
  title: "Await from Human"
  description: "Tests escalate @Human + await response <- @Human combo."

  agent Asker {
    mode: "code"
    role: "Escalate to ask the user, then await their reply."

    stake report(
      topic: topic
    ) -> @out
      output: { result: "string" }

    escalate @Human reason: "Please review the report. Type 'ACK' to approve."

    await response <- @Human

    when response contains "ACK" {
      let approved = true
    }

    commit
  }

  converge when: @Asker.committed
  budget: rounds(5), time(300)
}
