import { render } from "ink-testing-library"

import { resetNerdFontCache } from "../../Icon.js"
import { FileWriteTool } from "../FileWriteTool.js"

describe("FileWriteTool", () => {
	beforeEach(() => {
		process.env.SHOFER_NERD_FONT = "0"
		resetNerdFontCache()
	})

	afterEach(() => {
		delete process.env.SHOFER_NERD_FONT
		resetNerdFontCache()
	})

	describe("header", () => {
		it("renders the display name and path", () => {
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff", path: "src/a.ts" }} />)
			const output = lastFrame()

			expect(output).toContain("Diff")
			expect(output).toContain("src/a.ts")
		})

		it("renders without a path", () => {
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff" }} />)
			expect(lastFrame()).toContain("Diff")
		})

		it("marks newFileCreated as NEW", () => {
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "newFileCreated", path: "a.ts" }} />)
			expect(lastFrame()).toContain("NEW")
		})

		it("marks write_to_file as NEW", () => {
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "write_to_file", path: "a.ts" }} />)
			expect(lastFrame()).toContain("NEW")
		})

		it("does not mark an edit as NEW", () => {
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "editedExistingFile", path: "a.ts" }} />)
			expect(lastFrame()).not.toContain("NEW")
		})

		it("renders the diff-stats badge", () => {
			const { lastFrame } = render(
				<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts", diffStats: { added: 4, removed: 2 } }} />,
			)
			const output = lastFrame()

			expect(output).toContain("+4")
			expect(output).toContain("-2")
		})

		it("renders the protected badge", () => {
			const { lastFrame } = render(
				<FileWriteTool toolData={{ tool: "apply_diff", path: ".shofer/x", isProtected: true }} />,
			)
			expect(lastFrame()).toContain("protected")
		})

		it("renders the outside-workspace badge", () => {
			const { lastFrame } = render(
				<FileWriteTool toolData={{ tool: "apply_diff", path: "/etc/x", isOutsideWorkspace: true }} />,
			)
			expect(lastFrame()).toContain("outside workspace")
		})
	})

	describe("diff hunk rendering", () => {
		it("renders the hunk header and its +/- lines", () => {
			const diff = ["@@ -1,3 +1,3 @@", " keep", "-old", "+new"].join("\n")
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts", diff }} />)
			const output = lastFrame()

			expect(output).toContain("@@ -1,3 +1,3 @@")
			expect(output).toContain("+new")
			expect(output).toContain("-old")
			expect(output).toContain("keep")
		})

		it("caps a hunk at eight lines and reports the remainder", () => {
			const lines = Array.from({ length: 12 }, (_, i) => `+add${i}`)
			const diff = ["@@ -1 +1 @@", ...lines].join("\n")
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts", diff }} />)
			const output = lastFrame()

			expect(output).toContain("add0")
			expect(output).toContain("4 more lines in hunk")
		})

		it("caps the display at two hunks and reports the remainder", () => {
			const diff = ["@@ -1 +1 @@", "+a", "@@ -2 +2 @@", "+b", "@@ -3 +3 @@", "+c", "@@ -4 +4 @@", "+d"].join("\n")
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts", diff }} />)
			const output = lastFrame()

			expect(output).toContain("2 more hunks")
		})

		it("sanitizes tabs inside the diff", () => {
			const diff = ["@@ -1 +1 @@", "+\tindented"].join("\n")
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts", diff }} />)
			expect(lastFrame()).not.toContain("\t")
		})
	})

	describe("raw diff fallback", () => {
		it("renders unparseable diff content verbatim", () => {
			const { lastFrame } = render(
				<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts", diff: "not a real diff" }} />,
			)
			expect(lastFrame()).toContain("not a real diff")
		})

		it("truncates the raw fallback past 15 lines", () => {
			const diff = Array.from({ length: 25 }, (_, i) => `raw${i}`).join("\n")
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts", diff }} />)
			const output = lastFrame()

			expect(output).toContain("raw0")
			expect(output).toContain("10 more lines")
		})

		it("renders no diff section when there is no diff at all", () => {
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts" }} />)
			const output = lastFrame()

			expect(output).not.toContain("@@")
			expect(output).not.toContain("more lines")
		})
	})

	describe("batch diffs", () => {
		it("renders the file count and each path", () => {
			const { lastFrame } = render(
				<FileWriteTool toolData={{ tool: "apply_diff", batchDiffs: [{ path: "a.ts" }, { path: "b.ts" }] }} />,
			)
			const output = lastFrame()

			expect(output).toContain("(2 files)")
			expect(output).toContain("a.ts")
			expect(output).toContain("b.ts")
		})

		it("renders per-file diff stats when present", () => {
			const { lastFrame } = render(
				<FileWriteTool
					toolData={{
						tool: "apply_diff",
						batchDiffs: [{ path: "a.ts", diffStats: { added: 9, removed: 3 } }],
					}}
				/>,
			)
			const output = lastFrame()

			expect(output).toContain("+9")
			expect(output).toContain("-3")
		})

		it("caps the list at eight files and reports the overflow", () => {
			const batchDiffs = Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.ts` }))
			const { lastFrame } = render(<FileWriteTool toolData={{ tool: "apply_diff", batchDiffs }} />)
			const output = lastFrame()

			expect(output).toContain("(11 files)")
			expect(output).toContain("and 3 more files")
			expect(output).not.toContain("f10.ts")
		})

		it("falls through to the single-file layout when the batch is empty", () => {
			const { lastFrame } = render(
				<FileWriteTool toolData={{ tool: "apply_diff", path: "a.ts", batchDiffs: [] }} />,
			)
			const output = lastFrame()

			expect(output).not.toContain("files)")
			expect(output).toContain("a.ts")
		})
	})
})
