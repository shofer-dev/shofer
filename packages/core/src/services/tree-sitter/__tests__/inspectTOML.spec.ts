import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { tomlQuery } from "../queries/index.js"
import { sampleToml } from "./fixtures/sample-toml.js"

describe("inspectTOML", () => {
	const testOptions = {
		language: "toml",
		wasmFile: "tree-sitter-toml.wasm",
		queryString: tomlQuery,
		extKey: "toml",
	}

	it("should inspect TOML tree structure", async () => {
		await inspectTreeStructure(sampleToml, "toml")
	})

	it("should parse TOML definitions", async () => {
		await testParseSourceCodeDefinitions("test.toml", sampleToml, testOptions)
	})
})
