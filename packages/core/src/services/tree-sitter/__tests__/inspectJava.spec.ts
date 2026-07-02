import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { javaQuery } from "../queries/index.js"
import sampleJavaContent from "./fixtures/sample-java.js"

describe("inspectJava", () => {
	const testOptions = {
		language: "java",
		wasmFile: "tree-sitter-java.wasm",
		queryString: javaQuery,
		extKey: "java",
	}

	it("should inspect Java tree structure", async () => {
		const result = await inspectTreeStructure(sampleJavaContent, "java")
		expect(result).toBeTruthy()
	})

	it("should parse Java definitions", async () => {
		const result = await testParseSourceCodeDefinitions("test.java", sampleJavaContent, testOptions)
		expect(result).toBeTruthy()
		expect(result).toMatch(/\d+--\d+ \| /) // Verify line number format
	})
})
