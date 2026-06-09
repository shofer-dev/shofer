-- stake-all: broadcast to every other agent via -> @all.
-- Each other agent receives a copy of the stake result.
flow "stake-all" (message: "string") {
  title: "Broadcast Stake"
  description: "Tests stake routing to @all — result delivered to every other agent."

  agent Sender {
    mode: "code"
    role: "Broadcast a message to all agents."

    stake broadcast(
      msg: message
    ) -> @all

    commit
  }

  agent ReceiverA {
    mode: "code"
    role: "Receive broadcast."
    await msg <- @Sender
    commit
  }

  agent ReceiverB {
    mode: "code"
    role: "Receive broadcast."
    await msg <- @Sender
    commit
  }

  converge when: all_committed
  budget: rounds(10), time(60)
}
