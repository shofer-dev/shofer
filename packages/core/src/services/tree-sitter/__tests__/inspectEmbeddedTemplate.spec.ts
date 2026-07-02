import { inspectTreeStructure, testParseSourceCodeDefinitions } from "./helpers.js"
import { embeddedTemplateQuery } from "../queries/index.js"
import sampleEmbeddedTemplateContent from "./fixtures/sample-embedded_template.js"

describe("inspectEmbeddedTemplate", () => {
	const testOptions = {
		language: "embedded_template",
		wasmFile: "tree-sitter-embedded_template.wasm",
		queryString: embeddedTemplateQuery,
		extKey: "erb", // Match the file extension we're using
	}

	it("should inspect embedded template tree structure", async () => {
		const result = await inspectTreeStructure(sampleEmbeddedTemplateContent, "embedded_template")
		expect(result).toBeTruthy()
	})

	it("should parse embedded template definitions", async () => {
		const result = await testParseSourceCodeDefinitions("test.erb", sampleEmbeddedTemplateContent, testOptions)
		expect(result).toBeTruthy()
		expect(result).toMatch(/\d+--\d+ \|/) // Verify line number format
	})
})
