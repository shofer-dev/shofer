import { describe, it, expect } from "vitest"

import { getToolGroupForSayTool, isReadOnlyToolAction, isWriteToolAction } from "../tools.js"
import { getDynamicToolGroups, toolGroupRegistry } from "../../tool-groups/category-registry.js"
import type { ShoferSayTool } from "@shofer/types"

function makeSayTool(tool: string): ShoferSayTool {
	return { tool } as ShoferSayTool
}

beforeEach(() => {
	toolGroupRegistry.reset()
})

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

		// `browser` is a dynamic category and inference is its LAST-RESORT birth, so
		// firing it must at least leave a toggle behind.
		it("registers the browser category when the prefix inference fires", () => {
			expect(getDynamicToolGroups()).not.toContain("browser")
			getToolGroupForSayTool(makeSayTool("browser_navigate"))
			expect(getDynamicToolGroups()).toContain("browser")
		})
	})

	describe("ide_ tools", () => {
		it("should resolve ide_ prefixed tools as execute group", () => {
			expect(getToolGroupForSayTool(makeSayTool("ide_open_file"))).toBe("execute")
		})

		// `execute` stays builtin; inference must not mint a category for it.
		it("registers nothing for the ide_ inference", () => {
			getToolGroupForSayTool(makeSayTool("ide_open_file"))
			expect(getDynamicToolGroups()).toEqual([])
		})
	})

	// The Tool-Group Dual-Resolution Rule, one layer down: visibility
	// (`filterPrivateToolsForMode`) reads a private tool's DECLARED group, so the
	// approval path must read the same declaration rather than guessing from the
	// name — otherwise a `salesforce` tool is visible as salesforce and gated as
	// `uncategorized`, its toggle on and the tool still asking.
	describe("groups declared elsewhere and recorded in the registry", () => {
		it("resolves a private tool to the group its provider declared", () => {
			toolGroupRegistry.registerToolMapping("crm_close_deal", "salesforce")
			expect(getToolGroupForSayTool(makeSayTool("crm_close_deal"))).toBe("salesforce")
		})

		it("beats the prefix inference — a declaration is a fact, a prefix is a guess", () => {
			toolGroupRegistry.registerToolMapping("browser_export_report", "salesforce")
			expect(getToolGroupForSayTool(makeSayTool("browser_export_report"))).toBe("salesforce")
		})

		it("does not override a native tool's own group", () => {
			toolGroupRegistry.registerToolMapping("readFile", "salesforce")
			expect(getToolGroupForSayTool(makeSayTool("readFile"))).toBe("read")
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
