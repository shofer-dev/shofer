// Deprecated: Tests for the old SearchAndReplaceTool.
// Full edit tool tests are in editTool.spec.ts.
// This file only verifies the backward-compatible re-export.

import { searchAndReplaceTool } from "../SearchAndReplaceTool.js"
import { editTool } from "../EditTool.js"

describe("SearchAndReplaceTool re-export", () => {
	it("exports searchAndReplaceTool as an alias for editTool", () => {
		expect(searchAndReplaceTool).toBeDefined()
		expect(searchAndReplaceTool).toBe(editTool)
	})
})
