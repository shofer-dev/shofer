import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { htmlQuery } from "../queries/index.js"
import { sampleHtmlContent } from "./fixtures/sample-html.js"

describe("inspectHtml", () => {
	const testOptions = {
		language: "html",
		wasmFile: "tree-sitter-html.wasm",
		queryString: htmlQuery,
		extKey: "html",
	}

	it("should inspect HTML tree structure", async () => {
		// Should execute without error
		await expect(inspectTreeStructure(sampleHtmlContent, "html")).resolves.not.toThrow()
	})

	it("should parse HTML definitions", async () => {
		const result = await testParseSourceCodeDefinitions("test.html", sampleHtmlContent, testOptions)
		expect(result).toBeDefined()
		expect(result).toMatch(/\d+--\d+ \| </)
	})
})
