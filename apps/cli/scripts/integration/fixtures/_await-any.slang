-- await-any: await from @any and * (wildcard) sources.
-- @any accepts from any single sender; * accepts from anyone including @out.
-- The Listener awaits TWICE, so the Broadcaster must emit two messages: each
-- await consumes exactly one mailbox entry (`@any` the first, `*` the second).
flow "await-any" (topic: "string") {
  title: "Await Wildcard Sources"
  description: "Tests await from @any and * wildcard sources."

  agent Broadcaster {
    mode: "code"
    role: "Send to all."

    stake announce(message: topic) -> @all
    stake followup(message: topic) -> @all

    commit
  }

  agent Listener {
    mode: "code"
    role: "Listen for messages from any source."

    await first <- @any
    await second <- *

    commit
  }

  converge when: all_committed
  budget: rounds(10), time(60)
}
