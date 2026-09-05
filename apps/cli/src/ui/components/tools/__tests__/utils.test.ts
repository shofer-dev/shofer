import {
	truncateText,
	sanitizeContent,
	formatDiffStats,
	getToolDisplayName,
	getToolIconName,
	formatPath,
	parseDiff,
} from "../utils.js"

describe("tools/utils", () => {
	describe("truncateText", () => {
		it("returns the text untouched when under the limit", () => {
			const result = truncateText("a\nb\nc", 10)
			expect(result).toEqual({ text: "a\nb\nc", truncated: false, totalLines: 3, hiddenLines: 0 })
		})

		it("returns untouched when exactly at the limit", () => {
			const result = truncateText("a\nb\nc", 3)
			expect(result.truncated).toBe(false)
			expect(result.totalLines).toBe(3)
			expect(result.hiddenLines).toBe(0)
		})

		it("truncates and reports the hidden line count", () => {
			const result = truncateText("1\n2\n3\n4\n5", 2)
			expect(result).toEqual({ text: "1\n2", truncated: true, totalLines: 5, hiddenLines: 3 })
		})

		it("defaults to a limit of 10 lines", () => {
			const text = Array.from({ length: 15 }, (_, i) => `line${i}`).join("\n")
			const result = truncateText(text)
			expect(result.truncated).toBe(true)
			expect(result.hiddenLines).toBe(5)
			expect(result.text.split("\n")).toHaveLength(10)
		})

		it("treats an empty string as one line", () => {
			const result = truncateText("", 10)
			expect(result).toEqual({ text: "", truncated: false, totalLines: 1, hiddenLines: 0 })
		})
	})

	describe("sanitizeContent", () => {
		it("replaces tabs with four spaces", () => {
			expect(sanitizeContent("a\tb")).toBe("a    b")
		})

		it("strips carriage returns", () => {
			expect(sanitizeContent("a\r\nb\rc")).toBe("a\nbc")
		})

		it("handles both together", () => {
			expect(sanitizeContent("\ta\r\n\tb")).toBe("    a\n    b")
		})

		it("leaves clean text alone", () => {
			expect(sanitizeContent("plain text")).toBe("plain text")
		})
	})

	describe("formatDiffStats", () => {
		it("prefixes the counts with + and -", () => {
			expect(formatDiffStats({ added: 3, removed: 7 })).toEqual({ added: "+3", removed: "-7" })
		})

		it("handles zeroes", () => {
			expect(formatDiffStats({ added: 0, removed: 0 })).toEqual({ added: "+0", removed: "-0" })
		})
	})

	describe("getToolDisplayName", () => {
		it.each([
			["readFile", "Read"],
			["read_file", "Read"],
			["skill", "Load Skill"],
			["listFilesTopLevel", "List Files"],
			["listFilesRecursive", "List Files (Recursive)"],
			["list_files", "List Files"],
			["editedExistingFile", "Edit"],
			["appliedDiff", "Diff"],
			["apply_diff", "Diff"],
			["newFileCreated", "Create File"],
			["write_to_file", "Write File"],
			["writeToFile", "Write File"],
			["grepSearch", "Search Files"],
			["grep_search", "Search Files"],
			["ragSearch", "Codebase Search"],
			["rag_search", "Codebase Search"],
			["execute_command", "Execute Command"],
			["executeCommand", "Execute Command"],
			["switchMode", "Switch Mode"],
			["switch_mode", "Switch Mode"],
			["newTask", "New Task"],
			["new_task", "New Task"],
			["finishTask", "Finish Task"],
			["attempt_completion", "Task Complete"],
			["attemptCompletion", "Task Complete"],
			["ask_followup_question", "Question"],
			["askFollowupQuestion", "Question"],
			["update_todo_list", "Update TODO List"],
			["updateTodoList", "Update TODO List"],
		])("maps %s to %s", (toolName, expected) => {
			expect(getToolDisplayName(toolName)).toBe(expected)
		})

		it("falls back to the raw name for an unknown tool", () => {
			expect(getToolDisplayName("some_unknown_tool")).toBe("some_unknown_tool")
		})
	})

	describe("getToolIconName", () => {
		it.each([
			["readFile", "file"],
			["read_file", "file"],
			["skill", "file"],
			["listFilesTopLevel", "folder"],
			["listFilesRecursive", "folder"],
			["list_files", "folder"],
			["editedExistingFile", "file-edit"],
			["appliedDiff", "diff"],
			["apply_diff", "diff"],
			["newFileCreated", "file-edit"],
			["write_to_file", "file-edit"],
			["writeToFile", "file-edit"],
			["grepSearch", "search"],
			["grep_search", "search"],
			["ragSearch", "search"],
			["rag_search", "search"],
			["execute_command", "terminal"],
			["executeCommand", "terminal"],
			["switchMode", "switch"],
			["switch_mode", "switch"],
			["newTask", "switch"],
			["new_task", "switch"],
			["finishTask", "check"],
			["attempt_completion", "check"],
			["attemptCompletion", "check"],
			["ask_followup_question", "question"],
			["askFollowupQuestion", "question"],
			["update_todo_list", "check"],
			["updateTodoList", "check"],
		])("maps %s to the %s icon", (toolName, expected) => {
			expect(getToolIconName(toolName)).toBe(expected)
		})

		it("falls back to the gear icon for an unknown tool", () => {
			expect(getToolIconName("mystery_tool")).toBe("gear")
		})
	})

	describe("formatPath", () => {
		it("returns the bare path with no badges", () => {
			expect(formatPath("src/a.ts")).toBe("src/a.ts")
		})

		it("appends the outside-workspace badge", () => {
			expect(formatPath("/etc/hosts", true)).toBe("/etc/hosts (outside workspace)")
		})

		it("appends the protected badge", () => {
			expect(formatPath(".shofer/x", false, true)).toBe(".shofer/x (protected)")
		})

		it("joins both badges", () => {
			expect(formatPath("/x", true, true)).toBe("/x (outside workspace, protected)")
		})
	})

	describe("parseDiff", () => {
		it("returns no hunks for content with no @@ header", () => {
			expect(parseDiff("just some text\nwith lines")).toEqual([])
		})

		it("parses a single hunk with added, removed and context lines", () => {
			const diff = ["@@ -1,3 +1,3 @@", " context", "-removed", "+added"].join("\n")
			const hunks = parseDiff(diff)

			expect(hunks).toHaveLength(1)
			expect(hunks[0]!.header).toBe("@@ -1,3 +1,3 @@")
			expect(hunks[0]!.lines).toEqual([
				{ type: "context", content: "context" },
				{ type: "removed", content: "removed" },
				{ type: "added", content: "added" },
			])
		})

		it("parses multiple hunks", () => {
			const diff = ["@@ -1 +1 @@", "+one", "@@ -5 +5 @@", "-two"].join("\n")
			const hunks = parseDiff(diff)

			expect(hunks).toHaveLength(2)
			expect(hunks[0]!.lines).toEqual([{ type: "added", content: "one" }])
			expect(hunks[1]!.lines).toEqual([{ type: "removed", content: "two" }])
		})

		it("ignores the +++ and --- file markers inside a hunk", () => {
			const diff = ["@@ -1 +1 @@", "+++ b/file.ts", "--- a/file.ts", "+real"].join("\n")
			const hunks = parseDiff(diff)

			expect(hunks[0]!.lines).toEqual([{ type: "added", content: "real" }])
		})

		it("treats a blank line inside a hunk as empty context", () => {
			const hunks = parseDiff(["@@ -1 +1 @@", "", "+x"].join("\n"))
			expect(hunks[0]!.lines[0]).toEqual({ type: "context", content: "" })
		})

		it("preserves a bare space line as empty context", () => {
			const hunks = parseDiff(["@@ -1 +1 @@", " "].join("\n"))
			expect(hunks[0]!.lines[0]).toEqual({ type: "context", content: "" })
		})

		it("drops lines that appear before the first hunk header", () => {
			const hunks = parseDiff(["diff --git a/x b/x", "index abc..def", "@@ -1 +1 @@", "+x"].join("\n"))
			expect(hunks).toHaveLength(1)
			expect(hunks[0]!.lines).toEqual([{ type: "added", content: "x" }])
		})
	})
})
