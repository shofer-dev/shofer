-- ============================================================================
-- Flow: question_relay
--
-- Tests the question relay feature (WI4): an agent calls
-- ask_followup_question mid-stake. Because the agent is a background
-- child of the WorkflowTask, the question is routed to the executor,
-- which relays it to the user via this.ask("followup", …). The user
-- answers, the reply is fed back via resolvePendingParentQuestion,
-- and the agent continues to completion.
--
-- Unlike simple2.slang (single agent, ask → research → complete),
-- this flow has TWO agents that can both use ask_followup_question:
--
--   - Researcher asks the user for scope clarification before
--     starting research.
--   - Writer may ask for clarification if the findings are ambiguous.
--
-- Both questions surface at the workflow level (WorkflowView), not
-- inside the agent's own chat panel. The workflow event-driven wait
-- helper catches managedTask:needs-parent-input and calls
-- relayChildQuestion to handle each one.
-- ============================================================================

flow "question_relay" (topic: "string") {
  title: "Question Relay Test"
  description: "Tests multi-agent question relay: both\nResearcher and Writer can ask the user for\nclarification mid-stake. Questions surface\nat the workflow level."
  icon: "help"

  param topic {
    description: "The topic to research and write about\n(e.g. 'Rust', 'PostgreSQL')."
  }

  agent Coordinator {
    mode: "orchestrator"
    role: "You coordinate a simple research-and-write pipeline. Delegate to Researcher, then Writer."

    -- Phase 1: Research
    -- The Researcher will call ask_followup_question to ask
    -- "What specific aspect should I focus on?"
    stake research(
      topic: topic,
      task: "Research this topic. IMPORTANT: Before you do ANY research, use ask_followup_question to ask 'What specific aspect of this topic should I focus on?' After receiving the answer, produce 3 findings tailored to that aspect. Use attempt_completion with the findings."
    ) -> @Researcher

    await findings <- @Researcher

    -- Phase 2: Writing
    -- The Writer may also call ask_followup_question if needed.
    stake write_article(
      topic: topic,
      findings: findings,
      task: "Write a 2-3 paragraph article about the topic incorporating the findings. If the findings are ambiguous or you need more detail, use ask_followup_question to ask the user. Use attempt_completion with the finished article."
    ) -> @Writer

    await article <- @Writer

    commit
  }

  agent Researcher {
    mode: "code"
    role: "You are a researcher. Before researching, you MUST use ask_followup_question to ask the user what aspect to focus on. After getting the answer, produce concise, relevant findings."

    await task <- @Coordinator

    -- The agent will call ask_followup_question here — the
    -- WorkflowTask relays it to the user and feeds the answer back.
    stake produce_findings(
      topic: topic,
      findings: "3 key findings tailored to the user's requested aspect."
    ) -> @Coordinator
      output: { findings: "string" }

    commit
  }

  agent Writer {
    mode: "code"
    role: "You are a writer. Write a brief article based on the provided findings. If you need clarification from the user, call ask_followup_question. Use attempt_completion with the finished article."

    await assignment <- @Coordinator

    stake write(
      topic: topic,
      instructions: "Write a 2-3 paragraph article incorporating the findings. If you need more info, call ask_followup_question. Use attempt_completion with the article."
    ) -> @Coordinator
      output: { article: "string" }

    commit
  }

  converge when: @Coordinator.committed
  budget: rounds(20), time(300)
}
