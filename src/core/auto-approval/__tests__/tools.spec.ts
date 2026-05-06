import { describe, it, expect } from "vitest"

import { getToolGroupForSayTool, isReadOnlyToolAction, isWriteToolAction } from "../tools"
import type { ClineSayTool } from "@roo-code/types"

function makeSayTool(tool: string): ClineSayTool {
	return { tool } as ClineSayTool
}

describe("getToolGroupForSayTool", () => {
	describe("list_files (and its UI variants)", () => {
		it("should resolve listFiles as read group", () => {
			expect(getToolGroupForSayTool(makeSayTool("listFiles"))).toBe("read")
		})

		it("should resolve listFilesTopLevel as read group", () => {
			expect(getToolGroupForSayTool(makeSayTool("listFilesTopLevel"))).toBe("read")
		})

		it("should resolve listFilesRecursive as read group", () => {
			expect(getToolGroupForSayTool(makeSayTool("listFilesRecursive"))).toBe("read")
		})
	})

	describe("read_file variants", () => {
		it("should resolve readFile as read group", () => {
			expect(getToolGroupForSayTool(makeSayTool("readFile"))).toBe("read")
		})
	})

	describe("write tools", () => {
		it("should resolve newFileCreated as write group", () => {
			expect(getToolGroupForSayTool(makeSayTool("newFileCreated"))).toBe("write")
		})

		it("should resolve editedExistingFile as write group", () => {
			expect(getToolGroupForSayTool(makeSayTool("editedExistingFile"))).toBe("write")
		})
	})

	describe("uncategorized tools", () => {
		it("should return uncategorized for unknown tool names", () => {
			expect(getToolGroupForSayTool(makeSayTool("someUnknownTool"))).toBe("uncategorized")
		})
	})

	describe("browser tools", () => {
		it("should resolve browser_ prefixed tools as browser group", () => {
			expect(getToolGroupForSayTool(makeSayTool("browser_navigate"))).toBe("browser")
		})
	})

	describe("ide_ tools", () => {
		it("should resolve ide_ prefixed tools as execute group", () => {
			expect(getToolGroupForSayTool(makeSayTool("ide_open_file"))).toBe("execute")
		})
	})
})

describe("isReadOnlyToolAction", () => {
	it("should return false for listFilesRecursive when SAY_TOOL_TO_NATIVE_NAME has the mapping (regression test)", () => {
		expect(isReadOnlyToolAction(makeSayTool("listFilesRecursive"))).toBe(true)
	})

	it("should return false for listFilesTopLevel when SAY_TOOL_TO_NATIVE_NAME has the mapping (regression test)", () => {
		expect(isReadOnlyToolAction(makeSayTool("listFilesTopLevel"))).toBe(true)
	})
})

describe("isWriteToolAction", () => {
	it("should return true for newFileCreated", () => {
		expect(isWriteToolAction(makeSayTool("newFileCreated"))).toBe(true)
	})

	it("should return false for listFilesRecursive", () => {
		expect(isWriteToolAction(makeSayTool("listFilesRecursive"))).toBe(false)
	})
})
