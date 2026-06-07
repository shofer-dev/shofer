-- list-arg: list literal as stake argument.
-- Tests: ["a", "b", "c"] list literal in stake call + output schema.
flow "list-arg" (topic: "string", query: "string") {
  title: "List Arguments"
  description: "Tests list literal arguments in stake calls."

  agent Worker {
    mode: "code"
    role: "Process a query with a list of tags."

    stake process(
      name: topic,
      query: query,
      labels: ["urgent", "research", "active"]
    ) -> @out
      output: { result: "string", tags_used: "number" }

    commit
  }

  converge when: @Worker.committed
  budget: rounds(5), tokens(5000)
}
