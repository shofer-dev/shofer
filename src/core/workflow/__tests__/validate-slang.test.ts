/**
 * Unit tests for validateSlangProgram utility.
 *
 * Vitest globals (describe/it/expect) are available globally per the Test
 * Layout Rule in AGENTS.md. Naming convention: *.test.ts (Node env).
 */

import { validateSlangProgram } from "../validate-slang"

// ── Valid source (minimal flow) ──

const VALID_SOURCE = `
flow "test-flow" (input: "string") {
  agent TestAgent {
    mode: "code"

    stake do_work(task: "Do something")
    commit
  }

  converge when: @TestAgent.committed
  budget: rounds(10), tokens(50000)
}
`

describe("validateSlangProgram", () => {
	it("returns valid=true and no diagnostics for a well-formed flow", () => {
		const result = validateSlangProgram(VALID_SOURCE)
		expect(result.valid).toBe(true)
		expect(result.errors).toHaveLength(0)
		expect(result.structuralErrors).toHaveLength(0)
	})

	it("returns warnings for a flow with no converge statement", () => {
		const src = `
flow "no-converge" () {
  agent A {
    mode: "code"
    stake do()
    commit
  }
}
`
		const result = validateSlangProgram(src)
		expect(result.valid).toBe(true) // warnings don't invalidate
		expect(result.structuralErrors).toHaveLength(0)
		expect(result.warnings.length).toBeGreaterThan(0)
		expect(result.warnings.some((w) => w.includes("no converge"))).toBe(true)
	})

	it("returns warnings for an agent with no commit", () => {
		const src = `
flow "no-commit" () {
  agent A {
    mode: "code"
    stake do()
  }
  converge when: all_committed
}
`
		const result = validateSlangProgram(src)
		expect(result.valid).toBe(true)
		expect(result.warnings.some((w) => w.includes("no commit"))).toBe(true)
	})

	it("returns structural errors for unknown stake recipients", () => {
		const src = `
flow "bad-stake" () {
  agent A {
    mode: "code"
    stake do() -> @NoSuchAgent
    commit
  }
  converge when: @A.committed
}
`
		const result = validateSlangProgram(src)
		expect(result.valid).toBe(false)
		expect(result.structuralErrors.length).toBeGreaterThan(0)
		expect(result.structuralErrors.some((e) => e.includes("stakes to unknown agent"))).toBe(true)
	})

	it("returns structural errors for unknown await sources", () => {
		const src = `
flow "bad-await" () {
  agent A {
    mode: "code"
    await msg <- @NoSuchAgent
    commit
  }
  converge when: @A.committed
}
`
		const result = validateSlangProgram(src)
		expect(result.valid).toBe(false)
		expect(result.structuralErrors.length).toBeGreaterThan(0)
		expect(result.structuralErrors.some((e) => e.includes("awaits from unknown agent"))).toBe(true)
	})

	it("handles empty input gracefully", () => {
		const result = validateSlangProgram("")
		expect(result.valid).toBe(false)
		expect(result.errors.length).toBeGreaterThan(0)
	})

	it("handles garbage input gracefully", () => {
		const result = validateSlangProgram("not a valid slang program { @@@")
		expect(result.valid).toBe(false)
		expect(result.errors.length).toBeGreaterThan(0)
	})

	it("passes through parse errors from the parser", () => {
		const src = `
flow "flow-a" () {
  agent A {
    mode: "code"
    stake do() -> @B
  }
}
`
		const result = validateSlangProgram(src)
		// Agent A has no commit (warning), and @B doesn't exist (structural error)
		expect(result.valid).toBe(false)
	})
})
