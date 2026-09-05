import { render } from "ink-testing-library"

import { resetNerdFontCache } from "../../Icon.js"
import { SearchTool } from "../SearchTool.js"

describe("SearchTool", () => {
	beforeEach(() => {
		process.env.SHOFER_NERD_FONT = "0"
		resetNerdFontCache()
	})

	afterEach(() => {
		delete process.env.SHOFER_NERD_FONT
		resetNerdFontCache()
	})

	describe("header", () => {
		it("renders the display name", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "grep_search" }} />)
			expect(lastFrame()).toContain("Search Files")
		})

		it("renders the match count derived from non-blank result lines", () => {
			const { lastFrame } = render(
				<SearchTool toolData={{ tool: "grep_search", content: "a.ts:1:x\n\nb.ts:2:y" }} />,
			)
			expect(lastFrame()).toContain("(2 matches)")
		})

		it("omits the match count when there is no content", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "grep_search" }} />)
			expect(lastFrame()).not.toContain("matches)")
		})

		it("uses the codebase-search display name for rag_search", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "rag_search" }} />)
			expect(lastFrame()).toContain("Codebase Search")
		})
	})

	describe("search parameters", () => {
		it("renders the regex", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "grep_search", regex: "foo.*bar" }} />)
			const output = lastFrame()

			expect(output).toContain("regex:")
			expect(output).toContain("foo.*bar")
		})

		it("renders the query", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "rag_search", query: "how does auth work" }} />)
			const output = lastFrame()

			expect(output).toContain("query:")
			expect(output).toContain("how does auth work")
		})

		it("renders the path scope", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "grep_search", path: "src/" }} />)
			const output = lastFrame()

			expect(output).toContain("path:")
			expect(output).toContain("src/")
		})

		it("renders the file pattern", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "grep_search", filePattern: "*.ts" }} />)
			const output = lastFrame()

			expect(output).toContain("pattern:")
			expect(output).toContain("*.ts")
		})

		it("renders every parameter together", () => {
			const { lastFrame } = render(
				<SearchTool toolData={{ tool: "grep_search", regex: "r", query: "q", path: "p", filePattern: "fp" }} />,
			)
			const output = lastFrame()

			expect(output).toContain("regex:")
			expect(output).toContain("query:")
			expect(output).toContain("path:")
			expect(output).toContain("pattern:")
		})

		it("omits every parameter row when none is set", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "grep_search" }} />)
			const output = lastFrame()

			expect(output).not.toContain("regex:")
			expect(output).not.toContain("query:")
			expect(output).not.toContain("path:")
			expect(output).not.toContain("pattern:")
		})
	})

	describe("results", () => {
		it("highlights file:line:context matches", () => {
			const { lastFrame } = render(
				<SearchTool toolData={{ tool: "grep_search", content: "src/a.ts:42:const x = 1" }} />,
			)
			const output = lastFrame()

			expect(output).toContain("Results:")
			expect(output).toContain("src/a.ts")
			expect(output).toContain("42")
			expect(output).toContain("const x = 1")
		})

		it("renders a plain line that does not match the file:line pattern", () => {
			const { lastFrame } = render(
				<SearchTool toolData={{ tool: "grep_search", content: "no structure here" }} />,
			)
			expect(lastFrame()).toContain("no structure here")
		})

		it("truncates past 15 lines and reports the remainder", () => {
			const content = Array.from({ length: 25 }, (_, i) => `hit${i}`).join("\n")
			const { lastFrame } = render(<SearchTool toolData={{ tool: "grep_search", content }} />)
			const output = lastFrame()

			expect(output).toContain("hit0")
			expect(output).toContain("10 more results")
		})

		it("sanitizes tabs in results", () => {
			const { lastFrame } = render(
				<SearchTool toolData={{ tool: "grep_search", content: "a.ts:1:\tindented" }} />,
			)
			expect(lastFrame()).not.toContain("\t")
		})

		it("renders no results section when content is empty", () => {
			const { lastFrame } = render(<SearchTool toolData={{ tool: "grep_search", regex: "x" }} />)
			expect(lastFrame()).not.toContain("Results:")
		})
	})
})
