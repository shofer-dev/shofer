-- output-schema: structured output contracts with field validation.
-- The agent must return JSON matching the declared schema or get retried
-- (max 3 retries).
flow "output-schema" (topic: "string") {
  title: "Output Schema Validation"
  description: "Tests output: { field: type } contracts — agent must produce valid JSON or get retried."

  agent Worker {
    mode: "code"
    role: "Produce structured output about a topic. Your attempt_completion must be ONLY a valid JSON object with exactly the fields declared in the output contract."

    stake analyze(
      topic: topic
    ) -> @out
      output: { summary: "string", confidence: "number", tags: "string" }

    commit
  }

  converge when: @Worker.committed
  budget: rounds(5), tokens(10000)
}
