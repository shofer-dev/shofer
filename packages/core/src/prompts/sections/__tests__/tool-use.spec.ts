import { getSharedToolUseSection } from "../tool-use.js"

describe("getSharedToolUseSection", () => {
	it("should include native tool-calling instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("provider-native tool-calling mechanism")
		expect(section).toContain("Do not include XML markup or examples")
	})

	it("should include multiple tools per message guidance", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("You must call at least one tool per assistant response")
		expect(section).toContain("Prefer calling as many tools as are reasonably needed")
	})

	it("should NOT include single tool per message restriction", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("You must use exactly one tool call per assistant response")
		expect(section).not.toContain("Do not call zero tools or more than one tool")
	})

	it("should NOT include XML formatting instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("<actual_tool_name>")
		expect(section).not.toContain("</actual_tool_name>")
	})

	// A mode that stubs most of its tools must SAY so: a model shown a stub with
	// an empty `properties` map otherwise concludes the tool takes no arguments.
	describe("when the mode tiers its tool schemas", () => {
		it("states the deferred-schema protocol and names describe_tools", () => {
			const section = getSharedToolUseSection(true)

			expect(section).toContain("describe_tools")
			expect(section).toContain("not because they take none")
			expect(section).toContain("Do not guess a stubbed tool's arguments")
		})

		it("is byte-identical to the untiered section for false and for absent", () => {
			expect(getSharedToolUseSection(false)).toEqual(getSharedToolUseSection())
			expect(getSharedToolUseSection()).not.toContain("describe_tools")
		})
	})
})
