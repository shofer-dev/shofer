-- tools-meta: tools: [group_a, group_b] agent meta.
-- Tests the tools: meta field with multiple ToolGroup names.
-- Currently parsed but not yet wired (the spawned Task still gets full
-- mode access), so only parsing is tested here.
flow "tools-meta" (topic: "string") {
  title: "Tools Meta Field"
  description: "Tests tools: [read, execute] agent meta — parsed and stored on AST."

  agent Worker {
    mode: "code"
    tools: [read, execute, mcp]
    role: "Agent with restricted tool groups (parsed, not yet wired)."

    stake analyze(topic: topic) -> @out

    commit
  }

  converge when: @Worker.committed
  budget: rounds(5), tokens(5000)
}
