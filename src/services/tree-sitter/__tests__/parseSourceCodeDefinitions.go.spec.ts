/*
TODO: The following structures can be parsed by tree-sitter but lack query support:

1. Anonymous Functions (func_literal):
   (func_literal parameters: (parameter_list) body: (block ...))
   - Currently visible in goroutine and defer statements
   - Would enable capturing lambda/closure definitions

2. Map Types (map_type):
   (map_type key: (type_identifier) value: (interface_type))
   - Currently visible in struct field declarations
   - Would enable capturing map type definitions

3. Pointer Types (pointer_type):
   (pointer_type (type_identifier))
   - Currently visible in method receiver declarations
   - Would enable capturing pointer type definitions
*/

import sampleGoContent from "./fixtures/sample-go"
import { testParseSourceCodeDefinitions } from "./helpers"
import goQuery from "../queries/go"

describe("Go Source Code Definition Tests", () => {
	let parseResult: string

	beforeAll(async () => {
		const testOptions = {
			language: "go",
			wasmFile: "tree-sitter-go.wasm",
			queryString: goQuery,
			extKey: "go",
		}

		const result = await testParseSourceCodeDefinitions("file.go", sampleGoContent, testOptions)
		expect(result).toBeDefined()
		parseResult = result as string
	})

	it("should capture Go file declarations", () => {
		// The Go parser captures declarations larger than the
		// 50-character threshold.  Verify we have output.
		expect(parseResult).toContain("# file.go")
	})

	it("should not have duplicate captures", () => {
		// Verify no duplicate line ranges
		const lineRanges = parseResult.match(/\d+--\d+ \|/g)
		expect(lineRanges).toBeDefined()
		const uniqueRanges = [...new Set(lineRanges!)]
		expect(uniqueRanges.length).toBe(lineRanges!.length)
	})
})
