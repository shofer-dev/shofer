import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { cppQuery } from "../queries/index.js"
import sampleCppContent from "./fixtures/sample-cpp.js"

describe("C++ Tree-sitter Parser", () => {
	const testOptions = {
		language: "cpp",
		wasmFile: "tree-sitter-cpp.wasm",
		queryString: cppQuery,
		extKey: "cpp",
	}

	it("should properly parse structures", async () => {
		// First run inspectTreeStructure to get query structure output
		await inspectTreeStructure(sampleCppContent, "cpp")

		// Then run testParseSourceCodeDefinitions to get line numbers
		const result = await testParseSourceCodeDefinitions("test.cpp", sampleCppContent, testOptions)
		expect(result).toBeDefined()
		expect(result).toMatch(/\d+--\d+ \|/)
	})
})
