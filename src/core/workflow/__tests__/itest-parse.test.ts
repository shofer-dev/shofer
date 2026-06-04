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

describe("itest.slang parse smoke test", () => {
	it("parses itest.slang with zero parse errors", () => {
		// __dirname is …/extensions/shofer/src/core/workflow/__tests__
		// Going up 6 levels (../../../../../..) reaches the workspace root.
		const workspaceRoot = resolve(__dirname, "..", "..", "..", "..", "..", "..")
		const src = readFileSync(resolve(workspaceRoot, ".shofer/workflows/itest.slang"), "utf-8")
		const { ast, errors } = parseSlang(src)
		expect(errors).toHaveLength(0)

		// The flow should have 5 agents: Orchestrator, Worker, Analyst, Developer, Reviewer
		expect(ast.flows).toHaveLength(1)
		const flow = ast.flows[0]!
		expect(flow.name).toBe("slang-itest")

		const agents = flow.body.filter((n): n is typeof n & { type: "AgentDecl" } => n.type === "AgentDecl")
		expect(agents).toHaveLength(5)
		expect(agents.map((a) => a.name)).toEqual(["Orchestrator", "Worker", "Analyst", "Developer", "Reviewer"])

		// Zero structural warnings
		const warnings = validateSlangAST(ast)
		expect(warnings).toHaveLength(0)
	})
})
