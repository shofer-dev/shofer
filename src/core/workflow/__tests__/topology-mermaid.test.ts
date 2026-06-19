/**
 * Unit tests for the pure `topologyToMermaid()` renderer
 * (src/core/workflow/slang-types.ts).
 *
 * It turns the current `flowState.agents` Map into a fenced ```mermaid
 * flowchart for inline display in the Events feed — mirroring the edge logic of
 * the (removed) Topology tab: running agents draw outbound `stake` edges to
 * their `sendingTo` targets, blocked agents draw inbound `await` edges from
 * their `waitingFor` sources.
 *
 * Vitest globals (describe/it/expect) are available globally per the Test
 * Layout Rule in AGENTS.md. Naming convention: *.test.ts (Node env).
 */

import { topologyToMermaid, type AgentState } from "../slang-types"

function agent(name: string, over: Partial<AgentState> = {}): AgentState {
	return {
		name,
		taskId: `task-${name}`,
		status: "idle",
		opIndex: 0,
		bindings: new Map(),
		retryCount: 0,
		...over,
	}
}

function agentsMap(...list: AgentState[]): Map<string, AgentState> {
	return new Map(list.map((a) => [a.name, a]))
}

describe("topologyToMermaid", () => {
	it("returns an empty string when there are no agents", () => {
		expect(topologyToMermaid(new Map())).toBe("")
	})

	it("wraps the diagram in a ```mermaid fenced flowchart block", () => {
		const out = topologyToMermaid(agentsMap(agent("Solo")))
		expect(out.startsWith("```mermaid\n")).toBe(true)
		expect(out.trimEnd().endsWith("```")).toBe(true)
		expect(out).toContain("flowchart LR")
	})

	it("emits one node per agent with the status-matched class and op detail", () => {
		const out = topologyToMermaid(
			agentsMap(
				agent("Orchestrator", { status: "running", opIndex: 3 }),
				agent("Dev1", { status: "blocked", opIndex: 2 }),
				agent("Dev2", { status: "committed" }),
			),
		)
		// Node ids are positional (a0, a1, …); labels carry the real names.
		expect(out).toContain('a0["Orchestrator<br/>running · op 3"]:::running')
		expect(out).toContain('a1["Dev1<br/>blocked · op 2"]:::blocked')
		expect(out).toContain('a2["Dev2<br/>committed"]:::committed')
		// classDefs match agentStatusColor() (blocked is purple, not yellow).
		expect(out).toContain("classDef blocked fill:#a855f7")
		expect(out).toContain("classDef running fill:#22c55e")
	})

	it("draws a solid stake edge from a running agent to each sendingTo target", () => {
		const out = topologyToMermaid(
			agentsMap(agent("A", { status: "running", sendingTo: "B,C" }), agent("B"), agent("C")),
		)
		// A=a0, B=a1, C=a2
		expect(out).toContain("a0 -->|stake| a1")
		expect(out).toContain("a0 -->|stake| a2")
	})

	it("draws a dashed await edge from each waitingFor source into a blocked agent", () => {
		const out = topologyToMermaid(agentsMap(agent("A"), agent("B", { status: "blocked", waitingFor: "A" })))
		// A=a0, B=a1: edge points source → blocked agent
		expect(out).toContain("a0 -.->|await| a1")
	})

	it("ignores edges to/from unknown agents (e.g. Human / @out)", () => {
		const out = topologyToMermaid(agentsMap(agent("A", { status: "running", sendingTo: "Human,@out" })))
		expect(out).not.toContain("-->|stake|")
	})

	it("dedupes identical edges", () => {
		const out = topologyToMermaid(agentsMap(agent("A", { status: "running", sendingTo: "B,B" }), agent("B")))
		const matches = out.match(/a0 -->\|stake\| a1/g) ?? []
		expect(matches.length).toBe(1)
	})
})
