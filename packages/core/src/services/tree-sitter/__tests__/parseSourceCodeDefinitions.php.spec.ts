import { testParseSourceCodeDefinitions, inspectTreeStructure } from "./helpers.js"
import { phpQuery } from "../queries/index.js"
import samplePhpContent from "./fixtures/sample-php.js"

describe("parseSourceCodeDefinitionsForFile with PHP", () => {
	// PHP test options
	const phpOptions = {
		language: "php",
		wasmFile: "tree-sitter-php.wasm",
		queryString: phpQuery,
		extKey: "php",
	}

	it("should inspect PHP tree structure", async () => {
		await inspectTreeStructure(samplePhpContent, "php")
	})

	it("should parse PHP definitions", async () => {
		await testParseSourceCodeDefinitions("test.php", samplePhpContent, phpOptions)
	})
})
