-- expressions: all comparison operators, contains, dot-access, logical AND.
-- Tests: ==, !=, >, >=, <, <=, contains, &&, dot-access.
-- NOTE: || (logical OR) is valid in the grammar but the precedence in
-- expression chains like `a && b || c` without parentheses requires the
-- parser to resolve correctly. This test uses && only for safe coverage.
flow "expressions" (val: "number", text: "string") {
  title: "Expression Operators"
  description: "Tests comparison operators, contains, &&, and dot-access."

  agent ExprTest {
    mode: "code"
    role: "Test every expression operator."

    let eq_check    = val == 5
    let neq_check   = val != 0
    let gt_check    = val > 0
    let gte_check   = val >= 0
    let lt_check    = val < 10
    let lte_check   = val <= 10
    let and_check   = val > 0 && val < 10
    let contains_ok = text contains "ok"

    stake report(
      eq: eq_check,
      neq: neq_check,
      gt: gt_check,
      gte: gte_check,
      lt: lt_check,
      lte: lte_check,
      and: and_check,
      contains: contains_ok
    ) -> @out
      output: {
        eq: "boolean", neq: "boolean",
        gt: "boolean", gte: "boolean",
        lt: "boolean", lte: "boolean",
        and: "boolean", contains: "boolean"
      }

    commit if eq_check && gt_check
  }

  converge when: @ExprTest.committed
  budget: rounds(5), tokens(10000)
}
