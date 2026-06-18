// npx vitest run core/workflow/__tests__/orchestrator-tool-scope.test.ts
import * as fs from "fs"
import * as path from "path"

import { parseSlang, validateSlangAST } from "../slang-parser"
import { analyzeFlow } from "../slang-resolver"

/**
 * The orchestrating agents in the shipped workflows MUST declare a `tools:`
 * restriction that excludes `mode` (switch_mode) and `subtasks` (new_task) —
 * the two escape hatches an architect-mode orchestrator used to try to do the
 * workers' job itself (investigate / write code) instead of coordinating.
 * See docs/workflow_design.md and slang_specs.md (`tools:` wiring).
 */
const DIR = path.resolve(__dirname, "../../../media/workflows")

describe("shipped workflow orchestrator tool scope", () => {
	for (const [file, agentName] of [
		["implement-feature.slang", "Architect"],
		["debug.slang", "Architect"],
	] as const) {
		it(`${file} parses cleanly with no error diagnostics`, () => {
			const src = fs.readFileSync(path.join(DIR, file), "utf8")
			const { ast, errors } = parseSlang(src)
			expect(errors).toEqual([])
			expect(validateSlangAST(ast)).toEqual([])
			for (const f of (ast as any).flows) {
				expect(analyzeFlow(f).filter((d: any) => d.level === "error")).toEqual([])
			}
		})

		it(`${file}: ${agentName} is tool-scoped and cannot switch_mode or spawn subtasks`, () => {
			const src = fs.readFileSync(path.join(DIR, file), "utf8")
			const flow = (parseSlang(src).ast as any).flows[0]
			const agent = flow.body.find((n: any) => n.type === "AgentDecl" && n.name === agentName)
			const tools: string[] | undefined = agent?.meta?.tools
			expect(tools).toBeDefined() // a restriction is declared at all
			expect(tools).not.toContain("mode") // no switch_mode escape hatch
			expect(tools).not.toContain("subtasks") // cannot spawn its own children
			expect(tools).not.toContain("execute") // orchestrator never runs commands
		})
	}
})
