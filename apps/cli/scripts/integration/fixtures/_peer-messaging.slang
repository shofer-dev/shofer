-- ============================================================================
-- Flow: peer_messaging
--
-- Demonstrates declared peers: and least-privilege peer scoping.
--
--   - Researcher declares `peers: [@Writer]` so it can query the Writer
--     directly via send_message_to_task while the Writer is working.
--   - The Writer does NOT declare Researcher in its peers: list, so
--     Writer→Researcher send_message_to_task calls are denied at the
--     tool guard (directional least-privilege). Sync responses via the
--     pending-resolver path work regardless of direction.
--   - The Coordinator uses the executor mailbox (stake/await), not
--     direct messaging.
-- ============================================================================

flow "peer_messaging" (topic: "string") {
  title: "Peer Messaging Demo"
  description: "Demonstrates declared peers and least-privilege\npeer scoping.\n\nResearcher can message Writer directly.\nWriter cannot initiate to Researcher.\nCoordinator uses executor mailbox only."
  icon: "people"

  param topic {
    description: "The topic to research and write about\n(e.g. 'Rust', 'PostgreSQL')."
  }

  agent Coordinator {
    mode: "orchestrator"
    role: "You coordinate research and writing. Delegate to the Researcher for findings and the Writer for prose. You do NOT research or write yourself."

    stake research(
      topic: topic,
      task: "Research this topic and produce 3 key findings with brief explanations. Use attempt_completion with the findings."
    ) -> @Researcher

    await findings <- @Researcher

    stake write_article(
      topic: topic,
      findings: findings,
      task: "Write a 2-3 paragraph article about the topic incorporating the provided findings. Write in a clear, engaging style. If you receive a message from the Researcher via send_message_to_task, incorporate that context. Use attempt_completion with the finished article."
    ) -> @Writer

    await article <- @Writer

    stake finalize(
      findings: findings,
      article: article,
      task: "Combine the research findings and the article into a brief final summary. Use attempt_completion with the combined result."
    )

    commit
  }

  agent Researcher {
    mode: "code"
    role: "You are a researcher. Produce concise findings about the topic. You may also message the Writer directly via send_message_to_task to share useful context — use the task ID from the 'PEER RESOURCES' block in your prompt."
    peers: [@Writer]

    await task <- @Coordinator

    stake produce_findings(
      topic: topic,
      findings: "3 key findings with brief explanations."
    ) -> @Coordinator
      output: { findings: "string" }

    commit
  }

  agent Writer {
    mode: "code"
    role: "You are a writer. Produce clear, engaging prose based on the provided research findings. If you receive a message from the Researcher via send_message_to_task, incorporate that context. Use attempt_completion with the finished article."

    await assignment <- @Coordinator

    stake write(
      topic: topic,
      instructions: "Write a 2-3 paragraph article incorporating the findings. Use attempt_completion with the article."
    ) -> @Coordinator
      output: { article: "string" }

    commit
  }

  converge when: @Coordinator.committed
  budget: rounds(20), tokens(100000)
}
