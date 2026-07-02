import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { phpQuery } from "../queries/index.js"
import samplePhpContent from "./fixtures/sample-php.js"

describe("inspectPhp", () => {
	const testOptions = {
		language: "php",
		wasmFile: "tree-sitter-php.wasm",
		queryString: phpQuery,
		extKey: "php",
	}

	it("should inspect PHP tree structure", async () => {
		const result = await inspectTreeStructure(samplePhpContent, "php")
		expect(result).toBeDefined()
	})

	it("should parse PHP definitions", async () => {
		const result = await testParseSourceCodeDefinitions("test.php", samplePhpContent, testOptions)
		expect(result).toBeDefined()
		expect(result).toMatch(/\d+--\d+ \|/) // Verify line number format
	})
})
