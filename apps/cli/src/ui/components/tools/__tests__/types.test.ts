import { getToolCategory } from "../types.js"

describe("tools/types getToolCategory", () => {
	it.each([
		"readFile",
		"read_file",
		"loadSkill",
		"skill_load",
		"listFilesTopLevel",
		"listFilesRecursive",
		"list_files",
	])("classifies %s as file-read", (toolName) => {
		expect(getToolCategory(toolName)).toBe("file-read")
	})

	it.each(["editedExistingFile", "appliedDiff", "apply_diff", "newFileCreated", "write_to_file", "writeToFile"])(
		"classifies %s as file-write",
		(toolName) => {
			expect(getToolCategory(toolName)).toBe("file-write")
		},
	)

	it.each(["grepSearch", "grep_search", "ragSearch", "rag_search"])("classifies %s as search", (toolName) => {
		expect(getToolCategory(toolName)).toBe("search")
	})

	it.each(["execute_command", "executeCommand"])("classifies %s as command", (toolName) => {
		expect(getToolCategory(toolName)).toBe("command")
	})

	it.each(["switchMode", "switch_mode", "newTask", "new_task", "finishTask"])("classifies %s as mode", (toolName) => {
		expect(getToolCategory(toolName)).toBe("mode")
	})

	it.each(["attempt_completion", "attemptCompletion", "ask_followup_question", "askFollowupQuestion"])(
		"classifies %s as completion",
		(toolName) => {
			expect(getToolCategory(toolName)).toBe("completion")
		},
	)

	it.each(["update_todo_list", "browser_action", "", "unknown"])("classifies %s as other", (toolName) => {
		expect(getToolCategory(toolName)).toBe("other")
	})
})
