import { render } from "ink-testing-library"

import { resetNerdFontCache } from "../../Icon.js"
import { GenericTool } from "../GenericTool.js"

describe("GenericTool", () => {
	beforeEach(() => {
		process.env.SHOFER_NERD_FONT = "0"
		resetNerdFontCache()
	})

	afterEach(() => {
		delete process.env.SHOFER_NERD_FONT
		resetNerdFontCache()
	})

	describe("header", () => {
		it("renders the mapped display name", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "update_todo_list" }} />)
			expect(lastFrame()).toContain("Update TODO List")
		})

		it("falls back to the raw tool name when unmapped", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "mystery_tool" }} />)
			expect(lastFrame()).toContain("mystery_tool")
		})
	})

	describe("path", () => {
		it("renders the path row", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x", path: "src/a.ts" }} />)
			const output = lastFrame()

			expect(output).toContain("path:")
			expect(output).toContain("src/a.ts")
		})

		it("renders the outside-workspace badge", () => {
			const { lastFrame } = render(
				<GenericTool toolData={{ tool: "x", path: "/etc/x", isOutsideWorkspace: true }} />,
			)
			expect(lastFrame()).toContain("outside workspace")
		})

		it("renders the protected badge", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x", path: ".shofer/y", isProtected: true }} />)
			expect(lastFrame()).toContain("protected")
		})

		it("omits the path row when absent", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x" }} />)
			expect(lastFrame()).not.toContain("path:")
		})
	})

	describe("mode", () => {
		it("renders the mode row", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x", mode: "architect" }} />)
			const output = lastFrame()

			expect(output).toContain("mode:")
			expect(output).toContain("architect")
		})

		it("omits the mode row when absent", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x" }} />)
			expect(lastFrame()).not.toContain("mode:")
		})
	})

	describe("content resolution", () => {
		it("prefers toolData.content", () => {
			const { lastFrame } = render(
				<GenericTool toolData={{ tool: "x", content: "from content", reason: "from reason" }} />,
			)
			const output = lastFrame()

			expect(output).toContain("from content")
			expect(output).not.toContain("from reason")
		})

		it("falls back to toolData.reason", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x", reason: "why it happened" }} />)
			expect(lastFrame()).toContain("why it happened")
		})

		it("extracts content from JSON rawContent", () => {
			const { lastFrame } = render(
				<GenericTool toolData={{ tool: "x" }} rawContent={JSON.stringify({ content: "json content" })} />,
			)
			expect(lastFrame()).toContain("json content")
		})

		it("extracts output from JSON rawContent", () => {
			const { lastFrame } = render(
				<GenericTool toolData={{ tool: "x" }} rawContent={JSON.stringify({ output: "json output" })} />,
			)
			expect(lastFrame()).toContain("json output")
		})

		it("extracts result from JSON rawContent", () => {
			const { lastFrame } = render(
				<GenericTool toolData={{ tool: "x" }} rawContent={JSON.stringify({ result: "json result" })} />,
			)
			expect(lastFrame()).toContain("json result")
		})

		it("extracts reason from JSON rawContent", () => {
			const { lastFrame } = render(
				<GenericTool toolData={{ tool: "x" }} rawContent={JSON.stringify({ reason: "json reason" })} />,
			)
			expect(lastFrame()).toContain("json reason")
		})

		it("renders nothing extra when the JSON carries no content-like field", () => {
			const { lastFrame } = render(
				<GenericTool toolData={{ tool: "x" }} rawContent={JSON.stringify({ unrelated: 1 })} />,
			)
			expect(lastFrame()).toContain("x")
		})

		it("uses non-JSON rawContent verbatim", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x" }} rawContent="plain raw text" />)
			expect(lastFrame()).toContain("plain raw text")
		})

		it("sanitizes tabs from raw content", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x" }} rawContent={"a\n\tb"} />)
			const output = lastFrame()

			expect(output).not.toContain("\t")
			expect(output).toContain("    b")
		})

		it("truncates past 12 lines and reports the remainder", () => {
			const content = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n")
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x", content }} />)
			const output = lastFrame()

			expect(output).toContain("l0")
			expect(output).toContain("8 more lines")
		})

		it("adds a top margin when a path is also rendered", () => {
			const { lastFrame } = render(<GenericTool toolData={{ tool: "x", path: "a.ts", content: "body" }} />)
			const output = lastFrame()

			expect(output).toContain("a.ts")
			expect(output).toContain("body")
		})
	})
})
