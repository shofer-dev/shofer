import {
	getToolRenderer,
	getToolCategory,
	FileReadTool,
	FileWriteTool,
	SearchTool,
	CommandTool,
	ModeTool,
	CompletionTool,
	GenericTool,
	truncateText,
	sanitizeContent,
} from "../index.js"

describe("tools/index", () => {
	describe("getToolRenderer", () => {
		it.each([
			["read_file", FileReadTool],
			["apply_diff", FileWriteTool],
			["grep_search", SearchTool],
			["execute_command", CommandTool],
			["switch_mode", ModeTool],
			["attempt_completion", CompletionTool],
		])("returns the specialised renderer for %s", (toolName, expected) => {
			expect(getToolRenderer(toolName)).toBe(expected)
		})

		it("returns GenericTool for an unclassified tool", () => {
			expect(getToolRenderer("something_new")).toBe(GenericTool)
		})
	})

	it("re-exports the category classifier", () => {
		expect(getToolCategory("read_file")).toBe("file-read")
	})

	it("re-exports the utilities", () => {
		expect(sanitizeContent("a\tb")).toBe("a    b")
		expect(truncateText("a", 1).truncated).toBe(false)
	})
})
