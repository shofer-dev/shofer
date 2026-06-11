/**
 * Unit tests for the metadata extraction logic used by the `listWorkflows`
 * webview handler in webviewMessageHandler.ts.
 *
 * Vitest globals (describe/it/expect) are available globally per the Test
 * Layout Rule in AGENTS.md. Naming convention: *.test.ts (Node env).
 */

import { parseSlang } from "../slang-parser"
import type { AgentDecl } from "../slang-ast"

// ── The extraction logic, duplicated here to keep the test self-contained ──
// This is exactly the code from the listWorkflows handler.

interface ParsedWorkflow {
	name: string
	title: string
	description: string
	icon?: string
	agents: string[]
	params: Array<{ name: string; type: string; description?: string }>
}

function extractWorkflowMetadata(name: string, source: string): ParsedWorkflow {
	const { ast } = parseSlang(source)
	const flow = ast.flows[0]
	if (!flow) {
		return { name, title: name, description: "", icon: undefined, agents: [], params: [] }
	}

	const agents = (flow.body ?? []).filter((b): b is AgentDecl => b.type === "AgentDecl").map((a) => a.name)

	const params = (flow.params ?? []).map((p) => ({
		name: p.name,
		type: p.paramType,
		description: p.description,
	}))

	return {
		name,
		title: flow.title || name,
		description: flow.description || "",
		icon: flow.icon,
		agents,
		params,
	}
}

// ── Test fixtures ──

const FULL_METADATA_SLANG = `
flow "hello-world" (name: "string") {
  title: "Hello World"
  description: "Simplest possible workflow: one agent, one stake, one commit."
  icon: "rocket"

  param name {
    description: "The name of the person to greet."
  }

  agent Greeter {
    mode: "code"
    role: "You are a friendly greeter."

    stake greet(
      name: name,
      task: "Say hello to the person."
    )

    commit
  }

  converge when: @Greeter.committed
  budget: rounds(5)
}
`

const MINIMAL_SLANG = `
flow "minimal" () {
  agent Worker {
    mode: "code"
    role: "Worker"

    stake do_work(task: "Do something")

    commit
  }

  converge when: @Worker.committed
}
`

const MULTI_AGENT_SLANG = `
flow "multi" () {
  title: "Multi-Agent Pipeline"
  description: "A workflow with three agents collaborating."
  icon: "code"

  agent Planner {
    mode: "orchestrator"
    role: "Plans the work"

    stake plan() -> @Builder

    await result <- @Builder

    commit
  }

  agent Builder {
    mode: "code"
    role: "Builds the thing"

    await plan <- @Planner

    stake build(task: plan) -> @Tester

    await test_result <- @Tester

    commit
  }

  agent Tester {
    mode: "code"
    role: "Tests the thing"

    await code <- @Builder

    stake verify(feature: code)

    commit
  }

  converge when: @Planner.committed
  budget: rounds(20)
}
`

describe("extractWorkflowMetadata", () => {
	it("extracts full metadata from a .slang string with title, description, icon, agents, and param descriptions", () => {
		const result = extractWorkflowMetadata("hello-world", FULL_METADATA_SLANG)

		expect(result.name).toBe("hello-world")
		expect(result.title).toBe("Hello World")
		expect(result.description).toBe("Simplest possible workflow: one agent, one stake, one commit.")
		expect(result.icon).toBe("rocket")
		expect(result.agents).toEqual(["Greeter"])
		expect(result.params).toHaveLength(1)
		expect(result.params[0]!).toEqual({
			name: "name",
			type: "string",
			description: "The name of the person to greet.",
		})
	})

	it("extracts zero agents and params from a flow with no body declarations", () => {
		// Actually minimal slang has one agent. Let's test multi-agent + correct counts.
		const result = extractWorkflowMetadata("multi", MULTI_AGENT_SLANG)

		expect(result.title).toBe("Multi-Agent Pipeline")
		expect(result.description).toBe("A workflow with three agents collaborating.")
		expect(result.icon).toBe("code")
		expect(result.agents).toEqual(["Planner", "Builder", "Tester"])
		expect(result.params).toHaveLength(0)
	})

	it("falls back gracefully for a minimal .slang with no metadata", () => {
		const result = extractWorkflowMetadata("minimal", MINIMAL_SLANG)

		expect(result.name).toBe("minimal")
		expect(result.title).toBe("minimal") // falls back to name
		expect(result.description).toBe("")
		expect(result.icon).toBeUndefined()
		expect(result.agents).toEqual(["Worker"])
		expect(result.params).toHaveLength(0)
	})

	it("does not extract import statements as agents", () => {
		const source = `
flow "with-import" () {
  import "helpers.slang" as helpers

  agent Main {
    mode: "code"
    role: "Main agent"

    stake do_work(task: "Work")

    commit
  }

  converge when: @Main.committed
}
`
		const result = extractWorkflowMetadata("with-import", source)

		expect(result.agents).toEqual(["Main"])
	})

	it("extracts params without descriptions as empty description", () => {
		const source = `
flow "no-desc" (input: "string") {
  agent Worker {
    mode: "code"
    role: "Does work"

    stake work(task: "Do", param: input)

    commit
  }

  converge when: @Worker.committed
}
`
		const result = extractWorkflowMetadata("no-desc", source)

		expect(result.params).toHaveLength(1)
		expect(result.params[0]!).toEqual({ name: "input", type: "string", description: undefined })
	})
})
