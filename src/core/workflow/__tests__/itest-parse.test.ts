/**
 * Smoke test: verify itest.slang parses without errors.
 *
 * This tests that every Slang construct exercised by the integration-test
 * slang file is accepted by the parser. The test asserts zero parse errors
 * (well-formed) so the file can be used as a parse-only integration test.
 */

import { readFileSync } from "fs"
import { resolve } from "path"
import { parseSlang, validateSlangAST } from "../slang-parser"

describe("slang file parse smoke test", () => {
	it("parses implement-feature.slang with zero parse errors", () => {
		// implement-feature.slang is shipped under src/media/workflows/
		const src = readFileSync(
			resolve(__dirname, "..", "..", "..", "media", "workflows", "implement-feature.slang"),
			"utf-8",
		)
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)

		// The flow should have 3 agents: Architect, Developer, Reviewer
		expect(ast.flows).toHaveLength(1)
		const flow = ast.flows[0]!
		expect(flow.name).toBe("implement-feature")

		const agents = flow.body.filter((n): n is typeof n & { type: "AgentDecl" } => n.type === "AgentDecl")
		expect(agents).toHaveLength(3)
		expect(agents.map((a) => a.name)).toEqual(["Architect", "Developer", "Reviewer"])

		// One warning allowed: "no budget statement" since the built-in
		// workflows intentionally omit it (budget constraints are optional).
		const warnings = validateSlangAST(ast)
		const nonBudgetWarnings = warnings.filter((w) => !w.includes("no budget"))
		expect(nonBudgetWarnings).toHaveLength(0)
	})
})
