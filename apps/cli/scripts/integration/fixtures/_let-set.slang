-- let-set: variable declaration and reassignment.
-- Tests: let, set, variable usage in stake args and conditions.
flow "let-set" (initial_count: "number") {
  title: "Let & Set Variables"
  description: "Tests let (declare), set (reassign), and variable usage in expressions."

  agent Vars {
    mode: "code"
    role: "Test let and set operations."

    let counter = initial_count
    let active = true

    when active {
      set counter = 1
    }

    stake report(
      value: counter,
      flag: active
    ) -> @out
      output: { value: "number", flag: "boolean" }

    commit
  }

  converge when: @Vars.committed
  budget: rounds(5), tokens(5000)
}
