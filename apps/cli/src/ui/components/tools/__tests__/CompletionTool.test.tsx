import { render } from "ink-testing-library"

import { CompletionTool } from "../CompletionTool.js"

describe("CompletionTool", () => {
	it("renders the result for attempt_completion", () => {
		const { lastFrame } = render(<CompletionTool toolData={{ tool: "attempt_completion", result: "All done." }} />)
		expect(lastFrame()).toContain("All done.")
	})

	it("renders the question for ask_followup_question", () => {
		const { lastFrame } = render(
			<CompletionTool toolData={{ tool: "ask_followup_question", question: "Which file?" }} />,
		)
		expect(lastFrame()).toContain("Which file?")
	})

	it("recognises the camelCase Question tool name", () => {
		const { lastFrame } = render(
			<CompletionTool toolData={{ tool: "askFollowupQuestion", question: "Which one?" }} />,
		)
		expect(lastFrame()).toContain("Which one?")
	})

	it("falls back to content when neither result nor question is set", () => {
		const { lastFrame } = render(<CompletionTool toolData={{ tool: "attempt_completion", content: "body" }} />)
		expect(lastFrame()).toContain("body")
	})

	it("prefers result over question and content", () => {
		const { lastFrame } = render(
			<CompletionTool
				toolData={{ tool: "attempt_completion", result: "the result", question: "q", content: "c" }}
			/>,
		)
		const output = lastFrame()

		expect(output).toContain("the result")
		expect(output).not.toContain("the question")
	})

	it("renders nothing when there is no content at all", () => {
		const { lastFrame } = render(<CompletionTool toolData={{ tool: "attempt_completion" }} />)
		expect(lastFrame()).toBe("")
	})

	it("sanitizes tabs", () => {
		const { lastFrame } = render(<CompletionTool toolData={{ tool: "attempt_completion", result: "a\n\tb" }} />)
		const output = lastFrame()

		expect(output).not.toContain("\t")
		expect(output).toContain("    b")
	})

	it("renders a multi-line result as one Text per line", () => {
		const { lastFrame } = render(
			<CompletionTool toolData={{ tool: "attempt_completion", result: "one\ntwo\nthree" }} />,
		)
		const output = lastFrame()

		expect(output).toContain("one")
		expect(output).toContain("two")
		expect(output).toContain("three")
	})

	it("truncates past 15 lines and reports the remainder", () => {
		const result = Array.from({ length: 25 }, (_, i) => `r${i}`).join("\n")
		const { lastFrame } = render(<CompletionTool toolData={{ tool: "attempt_completion", result }} />)
		const output = lastFrame()

		expect(output).toContain("r0")
		expect(output).toContain("10 more lines")
	})
})
