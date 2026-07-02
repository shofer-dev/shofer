import { inspectTreeStructure, testParseSourceCodeDefinitions, debugLog } from "./helpers.js"
import { vueQuery } from "../queries/vue.js"
import { sampleVue } from "./fixtures/sample-vue.js"

describe("Vue Parser", () => {
	const testOptions = {
		language: "vue",
		wasmFile: "tree-sitter-vue.wasm",
		queryString: vueQuery,
		extKey: "vue",
	}

	it("should inspect Vue tree structure", async () => {
		await inspectTreeStructure(sampleVue, "vue")
	})

	it("should parse Vue definitions", async () => {
		const result = await testParseSourceCodeDefinitions("test.vue", sampleVue, testOptions)
		debugLog("Vue parse result:", result)
	})
})
