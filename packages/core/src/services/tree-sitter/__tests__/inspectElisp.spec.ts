import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { elispQuery } from "../queries/elisp.js"
import sampleElispContent from "./fixtures/sample-elisp.js"

describe("inspectElisp", () => {
	const testOptions = {
		language: "elisp",
		wasmFile: "tree-sitter-elisp.wasm",
		queryString: elispQuery,
		extKey: "el",
	}

	it("should validate Elisp tree structure inspection", async () => {
		const result = await inspectTreeStructure(sampleElispContent, "elisp")
		expect(result).toBeDefined()
		expect(result.length).toBeGreaterThan(0)
	})

	it("should validate Elisp definitions parsing", async () => {
		const result = await testParseSourceCodeDefinitions("test.el", sampleElispContent, testOptions)
		expect(result).toBeDefined()
		expect(result).toMatch(/\d+--\d+ \|/) // Verify line number format

		// Verify some sample content is parsed
		expect(result).toMatch(/defun test-function/)
		expect(result).toMatch(/defmacro test-macro/)
	})
})
