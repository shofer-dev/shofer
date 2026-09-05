import { render } from "ink-testing-library"

import { resetNerdFontCache } from "../../Icon.js"
import { FileReadTool } from "../FileReadTool.js"

describe("FileReadTool", () => {
	beforeEach(() => {
		process.env.SHOFER_NERD_FONT = "0"
		resetNerdFontCache()
	})

	afterEach(() => {
		delete process.env.SHOFER_NERD_FONT
		resetNerdFontCache()
	})

	describe("single file read", () => {
		it("renders the display name and path", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "src/index.ts", content: "a\nb" }} />,
			)
			const output = lastFrame()

			expect(output).toContain("Read")
			expect(output).toContain("src/index.ts")
		})

		it("renders without a path", () => {
			const { lastFrame } = render(<FileReadTool toolData={{ tool: "read_file" }} />)
			expect(lastFrame()).toContain("Read")
		})

		it("flags a file outside the workspace", () => {
			const { lastFrame } = render(
				<FileReadTool
					toolData={{ tool: "read_file", path: "/etc/hosts", isOutsideWorkspace: true, content: "x\ny" }}
				/>,
			)
			expect(lastFrame()).toContain("outside workspace")
		})

		it("renders multi-line file content inside a bordered box", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "a.ts", content: "const a = 1\nconst b = 2" }} />,
			)
			const output = lastFrame()

			expect(output).toContain("const a = 1")
			expect(output).toContain("const b = 2")
		})

		it("sanitizes tabs in content", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "a.ts", content: "x\n\tindented" }} />,
			)
			const output = lastFrame()

			expect(output).not.toContain("\t")
			expect(output).toContain("    indented")
		})

		it("truncates content past 12 lines and reports the remainder", () => {
			const content = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n")
			const { lastFrame } = render(<FileReadTool toolData={{ tool: "read_file", path: "a.ts", content }} />)
			const output = lastFrame()

			expect(output).toContain("line0")
			expect(output).toContain("8 more lines")
			expect(output).not.toContain("line19")
		})

		it("renders a directory listing as flat lines for a list tool", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "list_files", path: "src/", content: "a.ts\nb.ts" }} />,
			)
			const output = lastFrame()

			expect(output).toContain("List Files")
			expect(output).toContain("a.ts")
			expect(output).toContain("b.ts")
		})

		it("also treats the camelCase List tool as a listing", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "listFilesRecursive", path: "src/", content: "a.ts\nb.ts" }} />,
			)
			expect(lastFrame()).toContain("List Files (Recursive)")
		})
	})

	describe("isActualContent gating", () => {
		it("suppresses content when it equals the path", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "src/a.ts", content: "src/a.ts" }} />,
			)
			const output = lastFrame() ?? ""

			// The path renders once in the header, and not again as content.
			expect(output.match(/src\/a\.ts/g)).toHaveLength(1)
		})

		it("suppresses content that merely ends with the path", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "a.ts", content: "/abs/dir/a.ts" }} />,
			)
			expect(lastFrame()).not.toContain("/abs/dir/a.ts")
		})

		it("suppresses a single-line absolute POSIX path", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "x", content: "/usr/local/bin/thing" }} />,
			)
			expect(lastFrame()).not.toContain("/usr/local/bin/thing")
		})

		it("suppresses a single-line Windows drive path", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "x", content: "C:\\Users\\me\\file.txt" }} />,
			)
			expect(lastFrame()).not.toContain("C:")
		})

		it("shows a long single-line string as content", () => {
			const long = "z".repeat(250)
			const { lastFrame } = render(<FileReadTool toolData={{ tool: "read_file", path: "x", content: long }} />)
			expect(lastFrame()).toContain("zzz")
		})

		it("suppresses a short single-line relative string that is not path-shaped", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "x", content: "short blurb" }} />,
			)
			// No newline, not long enough, not path-prefixed → not content.
			expect(lastFrame()).not.toContain("short blurb")
		})

		it("renders nothing extra when content is absent", () => {
			const { lastFrame } = render(<FileReadTool toolData={{ tool: "read_file", path: "a.ts" }} />)
			expect(lastFrame()).toContain("a.ts")
		})
	})

	describe("batch file reads", () => {
		it("renders the file count and each path", () => {
			const { lastFrame } = render(
				<FileReadTool
					toolData={{
						tool: "read_file",
						batchFiles: [{ path: "a.ts" }, { path: "b.ts" }],
					}}
				/>,
			)
			const output = lastFrame()

			expect(output).toContain("(2 files)")
			expect(output).toContain("a.ts")
			expect(output).toContain("b.ts")
		})

		it("renders a line snippet when present", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", batchFiles: [{ path: "a.ts", lineSnippet: "1-20" }] }} />,
			)
			expect(lastFrame()).toContain("1-20")
		})

		it("flags a batch entry outside the workspace", () => {
			const { lastFrame } = render(
				<FileReadTool
					toolData={{ tool: "read_file", batchFiles: [{ path: "/etc/x", isOutsideWorkspace: true }] }}
				/>,
			)
			expect(lastFrame()).toContain("outside workspace")
		})

		it("caps the list at ten files and reports the overflow", () => {
			const batchFiles = Array.from({ length: 14 }, (_, i) => ({ path: `f${i}.ts` }))
			const { lastFrame } = render(<FileReadTool toolData={{ tool: "read_file", batchFiles }} />)
			const output = lastFrame()

			expect(output).toContain("(14 files)")
			expect(output).toContain("and 4 more files")
			expect(output).not.toContain("f13.ts")
		})

		it("falls through to the single-file layout when the batch is empty", () => {
			const { lastFrame } = render(
				<FileReadTool toolData={{ tool: "read_file", path: "a.ts", batchFiles: [] }} />,
			)
			const output = lastFrame()

			expect(output).not.toContain("files)")
			expect(output).toContain("a.ts")
		})
	})
})
