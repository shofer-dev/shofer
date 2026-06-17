// npx vitest run core/prompts/sections/__tests__/capabilities.spec.ts

import { getCapabilitiesSection } from "../capabilities"

/**
 * The CAPABILITIES section must not advertise tools the agent doesn't have.
 * For workflow agents with a `.slang` `tools:` restriction (passed as the
 * effective `groups` set), a `[questions]`-only coordinator must NOT be told it
 * can read/write/execute — that prose is what invites the model to hallucinate
 * read_file/list_files/execute_command that aren't in its native tool catalog.
 */
const CWD = "/ws"

describe("getCapabilitiesSection — tool-group gating", () => {
	it("unrestricted (groups undefined) renders the full prose verbatim", () => {
		const s = getCapabilitiesSection(CWD)
		expect(s).toContain("execute CLI commands")
		expect(s).toContain("list_files tool")
		expect(s).toContain("read and write files")
		expect(s).toContain("execute_command tool")
	})

	it("[questions]-only coordinator is not told it can read/write/execute", () => {
		const s = getCapabilitiesSection(CWD, undefined, new Set(["questions"]))
		expect(s).not.toContain("execute_command")
		expect(s).not.toContain("list_files")
		expect(s).not.toMatch(/read and write files|read files|write files/)
		// It still gets the env-details overview, the follow-up ability, and an
		// explicit "you are a coordinator, don't call file/command tools" note.
		expect(s).toContain("ask follow-up questions")
		expect(s.toLowerCase()).toContain("coordination agent")
	})

	it("read-only agent mentions reading but not writing or executing", () => {
		const s = getCapabilitiesSection(CWD, undefined, new Set(["read", "questions"]))
		expect(s).toContain("list_files")
		expect(s).toContain("read files")
		expect(s).not.toContain("execute_command")
		expect(s).not.toContain("write files")
		expect(s).not.toContain("read and write files")
	})

	it("read+write+execute agent mentions all three", () => {
		const s = getCapabilitiesSection(CWD, undefined, new Set(["read", "write", "execute", "questions"]))
		expect(s).toContain("execute_command")
		expect(s).toContain("list_files")
		expect(s).toContain("read and write files")
		expect(s).not.toContain("coordination agent")
	})

	it("MCP line appears only when an mcpHub is passed", () => {
		const withMcp = getCapabilitiesSection(CWD, {} as any, new Set(["questions"]))
		expect(withMcp).toContain("MCP servers")
		const without = getCapabilitiesSection(CWD, undefined, new Set(["questions"]))
		expect(without).not.toContain("MCP servers")
	})
})
