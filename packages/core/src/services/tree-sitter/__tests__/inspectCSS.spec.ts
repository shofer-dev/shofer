import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { cssQuery } from "../queries/index.js"
import sampleCSSContent from "./fixtures/sample-css.js"

describe("CSS Tree-sitter Parser", () => {
	const testOptions = {
		language: "css",
		wasmFile: "tree-sitter-css.wasm",
		queryString: cssQuery,
		extKey: "css",
	}

	it("should properly parse CSS structures", async () => {
		// First run inspectTreeStructure to get query structure output
		await inspectTreeStructure(sampleCSSContent, "css")

		// Then run testParseSourceCodeDefinitions to get line numbers
		const result = await testParseSourceCodeDefinitions("test.css", sampleCSSContent, testOptions)
		expect(result).toBeDefined()
		if (!result) {
			throw new Error("No result returned from parser")
		}
		expect(result).toMatch(/\d+--\d+ \|/)
		expect(result.split("\n").length).toBeGreaterThan(1)
	})
})
