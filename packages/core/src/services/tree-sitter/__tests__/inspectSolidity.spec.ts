import { debugLog, inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { solidityQuery } from "../queries/index.js"
import { sampleSolidity } from "./fixtures/sample-solidity.js"

describe("inspectSolidity", () => {
	const testOptions = {
		language: "solidity",
		wasmFile: "tree-sitter-solidity.wasm",
		queryString: solidityQuery,
		extKey: "sol",
	}

	it("should inspect Solidity tree structure", async () => {
		const result = await inspectTreeStructure(sampleSolidity, "solidity")
		expect(result).toBeDefined()
		debugLog("Tree Structure:", result)
	})

	it("should parse Solidity definitions", async () => {
		const result = await testParseSourceCodeDefinitions("test.sol", sampleSolidity, testOptions)
		expect(result).toBeDefined()
		expect(result).toMatch(/\d+--\d+ \|/)
		debugLog("Parse Result:", result)
	})
})
